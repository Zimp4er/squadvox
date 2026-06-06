'use strict';

const SERVER = 'https://squadvox.ru';
const WS_URL  = 'wss://squadvox.ru';

// ── State ────────────────────────────────────────────────────────────────────

const state = {
  token:        null,
  username:     null,
  turnCreds:    null,
  turnHost:     'squadvox.ru',
  ws:           null,
  peers:        new Map(),
  localStream:  null,
  rawStream:    null,
  isMuted:      false,
  isDeafened:   false,
  isInCall:     false,
  noiseEnabled: true,
  pttEnabled:   false,
  pttMode:      'hold',   // 'hold' | 'toggle'
  pttKey:       'CapsLock',
  pttActive:    false,
  outputDevice: '',
  soundsEnabled: true,
  chatUnread:   0,
  view:         'home',
};

// Per-peer audio routing (GainNode for per-user volume)
const _peerAudio = new Map(); // username -> { ctx, gain }

// ── Helpers ───────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

function setStatus(text) {
  const el = $('status-text'); if (el) el.textContent = text;
  const vs = $('vbar-state');  if (vs) vs.textContent = text;
  const cs = $('conn-status-text'); if (cs) cs.textContent = text;
}

function setOnline(on) {
  const el = $('conn-status');
  if (el) el.className = `conn-dot ${on ? 'online' : 'offline'}`;
  const dot = $('footer-status-dot');
  if (dot) dot.className = `footer-status-dot ${on ? 'online' : ''}`;
}

// Consistent color from a string (for avatar fallbacks)
function nameColor(name) {
  const palette = ['#4dabf7','#748ffc','#da77f2','#f783ac','#ff8787','#ffd43b','#69db7c','#38d9a9'];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffff;
  return palette[h % palette.length];
}

// Build an avatar element: tries img, falls back to initial
function makeAvatarEl(username, cls = 'avatar') {
  const wrap = document.createElement('div');
  wrap.className = cls;
  wrap.style.background = nameColor(username);

  const img = document.createElement('img');
  img.src = `${SERVER}/avatar/${encodeURIComponent(username)}`;
  img.alt = username[0].toUpperCase();
  img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:inherit;display:block;';
  img.onerror = () => {
    img.remove();
    wrap.textContent = username[0].toUpperCase();
  };
  wrap.appendChild(img);
  return wrap;
}

// Set avatar image in an existing avatar element (updates it in place)
function refreshAvatar(el, username) {
  if (!el) return;
  el.style.background = nameColor(username);
  el.textContent = '';
  const img = document.createElement('img');
  img.src = `${SERVER}/avatar/${encodeURIComponent(username)}?t=${Date.now()}`;
  img.alt = username[0].toUpperCase();
  img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:inherit;display:block;';
  img.onerror = () => { img.remove(); el.textContent = username[0].toUpperCase(); };
  el.appendChild(img);
}

// ── Sound effects (Web Audio API, no external files) ─────────────────────────

function playSound(type) {
  if (!state.soundsEnabled) return;
  try {
    const ctx = new AudioContext();
    const freqs = type === 'join' ? [523.25, 659.25] : [659.25, 523.25];
    freqs.forEach((freq, i) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t = ctx.currentTime + i * 0.14;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.22, t + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
      osc.start(t); osc.stop(t + 0.35);
    });
    setTimeout(() => ctx.close(), 1000);
  } catch {}
}

// ── RNNoise ───────────────────────────────────────────────────────────────────

let _audioCtx         = null;
let _rnnoiseNode      = null;
let _gateNode         = null;
let _audioCtxHeartbeat = null;

const GATE_OPEN  = -50;
const GATE_CLOSE = -55;
const GATE_HOLD  = 150;

class RnnoiseWorkletNode extends AudioWorkletNode {
  constructor(ctx, { maxChannels, wasmBinary }) {
    super(ctx, '@sapphi-red/web-noise-suppressor/rnnoise', { processorOptions: { maxChannels, wasmBinary } });
  }
  destroy() { this.port.postMessage('destroy'); }
}

class NoiseGateWorkletNode extends AudioWorkletNode {
  constructor(ctx, { openThreshold, closeThreshold, holdMs, maxChannels }) {
    super(ctx, '@sapphi-red/web-noise-suppressor/noise-gate', {
      processorOptions: { openThreshold, closeThreshold, holdMs, maxChannels },
    });
  }
}

async function applyNoiseSuppression(rawStream) {
  if (!state.noiseEnabled) return rawStream;
  try {
    if (!_audioCtx || _audioCtx.state === 'closed') _audioCtx = new AudioContext({ sampleRate: 48000 });
    await _audioCtx.resume();
    // Keep the noise-suppression AudioContext alive (browsers may suspend it)
    if (_audioCtxHeartbeat) clearInterval(_audioCtxHeartbeat);
    _audioCtxHeartbeat = setInterval(() => {
      if (_audioCtx && _audioCtx.state === 'suspended') _audioCtx.resume().catch(() => {});
    }, 2000);
    if (!_audioCtx._rnLoaded) {
      await _audioCtx.audioWorklet.addModule('./rnnoise-worklet.js');
      await _audioCtx.audioWorklet.addModule('./noisegate-worklet.js');
      _audioCtx._rnLoaded = true;
    }
    const simd = await WebAssembly.validate(
      new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11])
    );
    const wasmBinary = await fetch(simd ? './rnnoise_simd.wasm' : './rnnoise.wasm').then(r => r.arrayBuffer());
    if (_rnnoiseNode) { _rnnoiseNode.destroy(); _rnnoiseNode = null; }
    const src    = _audioCtx.createMediaStreamSource(rawStream);
    _rnnoiseNode = new RnnoiseWorkletNode(_audioCtx, { wasmBinary, maxChannels: 1 });
    _gateNode    = new NoiseGateWorkletNode(_audioCtx, { openThreshold: GATE_OPEN, closeThreshold: GATE_CLOSE, holdMs: GATE_HOLD, maxChannels: 1 });
    const dest   = _audioCtx.createMediaStreamDestination();
    src.connect(_rnnoiseNode); _rnnoiseNode.connect(_gateNode); _gateNode.connect(dest);
    return dest.stream;
  } catch(err) {
    console.warn('RNNoise unavailable:', err); return rawStream;
  }
}

function destroyNoise() {
  if (_audioCtxHeartbeat) { clearInterval(_audioCtxHeartbeat); _audioCtxHeartbeat = null; }
  if (_rnnoiseNode) { _rnnoiseNode.destroy(); _rnnoiseNode = null; }
  _gateNode = null;
  if (_audioCtx) { _audioCtx.close(); _audioCtx = null; }
}

// ── VAD ───────────────────────────────────────────────────────────────────────

const _vad = new Map();

function startVAD(username, stream) {
  stopVAD(username);
  try {
    const ctx = new AudioContext();
    ctx.resume().catch(() => {});
    const src      = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
    const data     = new Uint8Array(analyser.frequencyBinCount);
    const interval = setInterval(() => {
      analyser.getByteFrequencyData(data);
      const avg  = data.reduce((a, b) => a + b, 0) / data.length;
      const tile = $(`pt-${username}`);
      if (tile) tile.classList.toggle('speaking', avg > 8);
    }, 100);
    _vad.set(username, { ctx, interval });
  } catch {}
}

function stopVAD(username) {
  const v = _vad.get(username);
  if (!v) return;
  clearInterval(v.interval); v.ctx?.close(); _vad.delete(username);
  $(`pt-${username}`)?.classList.remove('speaking');
}

function stopAllVAD() {
  for (const u of [..._vad.keys()]) stopVAD(u);
}

// ── Session ───────────────────────────────────────────────────────────────────

function saveSession(data) {
  localStorage.setItem('sv_token',     data.token);
  localStorage.setItem('sv_username',  data.username);
  localStorage.setItem('sv_turnCreds', JSON.stringify(data.turnCreds || null));
  localStorage.setItem('sv_turnHost',  data.turnHost || 'squadvox.ru');
}

function loadSession() {
  const token = localStorage.getItem('sv_token');
  if (!token) return false;
  state.token     = token;
  state.username  = localStorage.getItem('sv_username');
  state.turnCreds = JSON.parse(localStorage.getItem('sv_turnCreds'));
  state.turnHost  = localStorage.getItem('sv_turnHost') || 'squadvox.ru';
  return true;
}

function clearSession() {
  ['sv_token','sv_username','sv_turnCreds','sv_turnHost'].forEach(k => localStorage.removeItem(k));
}

function showMain() {
  $('login-screen').style.display = 'none';
  $('main-screen').style.display  = 'flex';
  $('self-name').textContent = state.username || '';
  refreshAvatar($('self-avatar'), state.username);
  refreshAvatar($('vbar-avatar'), state.username);
  $('vbar-name').textContent = state.username || '';
  loadSettingsFromStorage();
  setView('home');
}

function showLogin() {
  clearSession();
  $('main-screen').style.display  = 'none';
  $('login-screen').style.display = 'flex';
  $('login-error').textContent    = '';
  $('password-input').value       = '';
}

// ── Views ─────────────────────────────────────────────────────────────────────

function setView(view) {
  ['home', 'chat', 'server', 'voice'].forEach(v => {
    const el = $(`view-${v}`); if (el) el.style.display = v === view ? '' : 'none';
  });

  const homeOnly = view === 'home';
  $('sidebar-home').style.display   = homeOnly ? '' : 'none';
  $('sidebar-server').style.display = homeOnly ? 'none' : '';

  $('btn-home').classList.toggle('active',   view === 'home');
  $('btn-chat').classList.toggle('active',   view === 'chat');
  $('btn-server').classList.toggle('active', view === 'server' || view === 'voice');
  $('ch-text-general')?.classList.toggle('active', view === 'chat');

  state.view = view;

  if (view === 'chat') {
    state.chatUnread = 0;
    updateChatBadge(0);
    setTimeout(() => {
      const m = $('global-chat-messages');
      if (m) m.scrollTop = m.scrollHeight;
    }, 0);
  }
}

// ── Login ─────────────────────────────────────────────────────────────────────

$('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('login-btn');
  btn.disabled = true;
  $('login-error').textContent = '';
  try {
    const res  = await fetch(`${SERVER}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: $('login-input').value.trim(), password: $('password-input').value }),
    });
    const data = await res.json();
    if (data.success) {
      Object.assign(state, { token: data.token, username: data.username, turnCreds: data.turnCreds, turnHost: data.turnHost || 'squadvox.ru' });
      saveSession(data);
      showMain();
      connectWS();
    } else {
      $('login-error').textContent = 'Неверный логин или пароль';
    }
  } catch {
    $('login-error').textContent = 'Ошибка подключения к серверу';
  } finally {
    btn.disabled = false;
  }
});

$('logout-btn').addEventListener('click', () => {
  if (state.ws) { state.ws.onclose = null; state.ws.close(); }
  if (state.isInCall) {
    for (const u of [...state.peers.keys()]) { send({ type: 'call-end', to: u }); closePeer(u); }
    teardownCall();
  }
  showLogin();
});

// Auto-login on start
window.addEventListener('DOMContentLoaded', () => {
  if (loadSession()) {
    showMain();
    connectWS();
  }
});

// ── WebSocket ─────────────────────────────────────────────────────────────────

function connectWS() {
  setStatus('Подключение...');
  const ws = new WebSocket(WS_URL);
  state.ws = ws;
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'auth', token: state.token }));
    state._ping = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
    }, 25000);
  };
  ws.onmessage = e => { try { handleMessage(JSON.parse(e.data)); } catch(err) { console.error(err); } };
  ws.onclose   = () => {
    clearInterval(state._ping);
    setOnline(false); setStatus('Переподключение...'); setTimeout(connectWS, 3000);
  };
  ws.onerror = () => setStatus('Ошибка соединения');
}

function send(msg) {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(msg));
}

// ── Message handling ──────────────────────────────────────────────────────────

async function handleMessage(msg) {
  switch (msg.type) {

    case 'auth_ok':
      setOnline(true); setStatus('Подключено');
      if (localStorage.getItem('sv_in_channel') && !state.isInCall) joinChannel();
      break;

    case 'auth_error':
      showLogin(); break;

    case 'kicked':
      if (state.ws) { state.ws.onclose = null; state.ws.close(); state.ws = null; }
      clearSession();
      showLogin();
      $('login-error').textContent = 'Выполнен вход с другого устройства';
      break;

    case 'user_list':
      renderUsers(msg.users);
      renderChannelMembers(msg.channel || []);
      break;

    case 'user_joined':
      addUser(msg.username); break;

    case 'user_left':
      removeUser(msg.username);
      removeChannelMember(msg.username);
      closePeer(msg.username);
      break;

    case 'chat-history':
      (msg.messages || []).forEach(m => appendBothChats(m.from, m.text, m.ts, true));
      break;

    case 'chat-message':
      appendBothChats(msg.from, msg.text, msg.ts, false);
      break;

    // Voice channel
    case 'channel-members':
      for (const u of msg.users) {
        addChannelMember(u);
        send({ type: 'call-start', to: u });
        await initPeer(u, true);
      }
      break;

    case 'channel-joined':
      addChannelMember(msg.username);
      playSound('join');
      break;

    case 'channel-left':
      removeChannelMember(msg.username);
      closePeer(msg.username);
      playSound('leave');
      break;

    // WebRTC signaling
    case 'call-start':
      if (!state.isInCall) { try { await beginCall(); } catch { return; } }
      await initPeer(msg.from, false);
      break;

    case 'offer': await onOffer(msg); break;

    case 'answer':
      try { await state.peers.get(msg.from)?.setRemoteDescription(msg.sdp); } catch {}
      break;

    case 'ice':
      if (msg.candidate) try { await state.peers.get(msg.from)?.addIceCandidate(msg.candidate); } catch {}
      break;

    case 'call-end':
      closePeer(msg.from); break;

    case 'pong': break;
  }
}

// ── Chat ──────────────────────────────────────────────────────────────────────

function appendBothChats(from, text, ts, isHistory) {
  appendChatToEl($('global-chat-messages'), from, text, ts);
  appendChatToEl($('chat-messages'),        from, text, ts);

  if (!isHistory && state.view !== 'chat') {
    state.chatUnread++;
    updateChatBadge(state.chatUnread);
  }
}

function appendChatToEl(container, from, text, ts) {
  if (!container) return;
  const time = new Date(ts).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  const div  = document.createElement('div');
  div.className = 'chat-msg-group';

  const avEl = makeAvatarEl(from, 'avatar chat-msg-av');
  avEl.style.width  = '36px';
  avEl.style.height = '36px';

  div.innerHTML = `
    <div class="chat-msg-body">
      <div class="chat-msg-header">
        <span class="chat-msg-author">${escHtml(from)}</span>
        <span class="chat-msg-time">${time}</span>
      </div>
      <div class="chat-msg-text">${escHtml(text)}</div>
    </div>
  `;
  div.insertBefore(avEl, div.firstChild);
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function updateChatBadge(n) {
  const badge   = $('chat-badge');
  const sidebar = $('chat-badge-sidebar');
  if (badge)   { badge.textContent   = n; badge.style.display   = n > 0 ? '' : 'none'; }
  if (sidebar) { sidebar.textContent = n; sidebar.style.display = n > 0 ? '' : 'none'; }
}

// Global chat form
$('global-chat-form').addEventListener('submit', e => {
  e.preventDefault();
  const input = $('global-chat-input');
  const text  = input.value.trim();
  if (!text || !state.ws) return;
  send({ type: 'chat-message', text });
  appendBothChats(state.username, text, Date.now(), false);
  input.value = '';
  // Don't count own messages as unread
  state.chatUnread = Math.max(0, state.chatUnread - 1);
  updateChatBadge(state.chatUnread);
});

// Inline voice chat form
$('chat-form').addEventListener('submit', e => {
  e.preventDefault();
  const input = $('chat-input');
  const text  = input.value.trim();
  if (!text || !state.ws) return;
  send({ type: 'chat-message', text });
  appendBothChats(state.username, text, Date.now(), false);
  input.value = '';
  state.chatUnread = Math.max(0, state.chatUnread - 1);
  updateChatBadge(state.chatUnread);
});

// ── WebRTC helpers ────────────────────────────────────────────────────────────

function iceConfig() {
  const servers = [
    { urls: `stun:${state.turnHost}:3478` },
    { urls: 'stun:stun.l.google.com:19302' },
  ];
  if (state.turnCreds) {
    servers.push(
      { urls: `turn:${state.turnHost}:3478`,                 ...state.turnCreds },
      { urls: `turn:${state.turnHost}:3478?transport=tcp`,   ...state.turnCreds },
      { urls: `turns:${state.turnHost}:5349?transport=tcp`,  ...state.turnCreds },
    );
  }
  return { iceServers: servers };
}

function makePeerConnection(username, isInitiator = true) {
  const pc = new RTCPeerConnection(iceConfig());
  state.peers.set(username, pc);
  // Use rawStream (direct getUserMedia) — AudioContext-backed MediaStreamDestination
  // tracks become silently frozen by WebRTC when the context suspends.
  const streamForPeer = state.rawStream || state.localStream;
  streamForPeer.getTracks().forEach(t => pc.addTrack(t, streamForPeer));

  let negotiating = false;
  // Non-initiator skips the first onnegotiationneeded (triggered by addTrack during setup)
  // so only the initiator's side creates the first offer and avoids signaling glare.
  let skipFirst = !isInitiator;
  pc.onnegotiationneeded = async () => {
    if (skipFirst) { skipFirst = false; return; }
    if (negotiating || pc.signalingState !== 'stable') return;
    negotiating = true;
    try {
      const offer = await pc.createOffer();
      if (pc.signalingState !== 'stable') return;
      await pc.setLocalDescription(offer);
      send({ type: 'offer', to: username, sdp: offer });
    } catch {} finally { negotiating = false; }
  };
  pc.onsignalingstatechange = () => { if (pc.signalingState === 'stable') negotiating = false; };

  pc.onicecandidate = e => {
    if (e.candidate) send({ type: 'ice', to: username, candidate: e.candidate });
  };

  pc.ontrack = e => {
    if (e.track.kind === 'audio') {
      const rawStream = e.streams[0] || new MediaStream([e.track]);

      let pa = _peerAudio.get(username);
      if (!pa) {
        // First audio track: create the shared GainNode chain for this peer
        const audioCtx = new AudioContext();
        audioCtx.resume().catch(() => {});
        const gainNode = audioCtx.createGain();
        const dest     = audioCtx.createMediaStreamDestination();
        gainNode.connect(dest);
        gainNode.gain.value = parseFloat(localStorage.getItem(`sv_vol_${username}`) || '1');
        _peerAudio.set(username, { ctx: audioCtx, gain: gainNode, dest });
        pa = _peerAudio.get(username);

        let el = $(`audio-${username}`);
        if (!el) {
          el = Object.assign(document.createElement('audio'), { id: `audio-${username}`, autoplay: true });
          document.body.appendChild(el);
        }
        el.srcObject = pa.dest.stream;
        el.muted     = state.isDeafened;
        if (state.outputDevice && el.setSinkId) el.setSinkId(state.outputDevice).catch(() => {});
        el.play().catch(() => {});
      }

      // Connect this track into the shared GainNode (mixes mic + screen-share audio)
      const src = pa.ctx.createMediaStreamSource(rawStream);
      src.connect(pa.gain);
      e.track.onended = () => { try { src.disconnect(); } catch {} };

      // VAD only on the first (mic) track; screen-share audio tracks already have VAD via mic
      if (!_vad.has(username)) startVAD(username, rawStream);
    } else if (e.track.kind === 'video') {
      showScreenView(username, e.streams[0] || new MediaStream([e.track]));
      e.track.onended = () => hideScreenView();
    }
  };

  pc.onconnectionstatechange = () => {
    const icons = { connected: '🔊', connecting: '⏳', failed: '❌', disconnected: '🔌' };
    const tile  = $(`pt-${username}`);
    if (tile) {
      tile.dataset.conn = pc.connectionState;
      const badge = tile.querySelector('.pt-conn');
      if (badge) badge.textContent = icons[pc.connectionState] ?? '';
    }
  };

  return pc;
}

async function initPeer(username, initiator) {
  if (state.peers.has(username)) return;
  makePeerConnection(username, initiator);
  // onnegotiationneeded handles offer creation for initiator; non-initiator waits for offer
}

async function onOffer(msg) {
  if (!state.isInCall) { try { await beginCall(); } catch { return; } }
  if (!state.peers.has(msg.from)) makePeerConnection(msg.from, false); // non-initiator
  const pc = state.peers.get(msg.from);
  await pc.setRemoteDescription(msg.sdp);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  send({ type: 'answer', to: msg.from, sdp: answer });
}

function closePeer(username) {
  state.peers.get(username)?.close();
  state.peers.delete(username);
  $(`audio-${username}`)?.remove();
  const pa = _peerAudio.get(username);
  if (pa) { pa.ctx.close(); _peerAudio.delete(username); }
  stopVAD(username);
}

// ── Voice channel ─────────────────────────────────────────────────────────────

async function joinChannel() {
  try { await beginCall(); } catch { return; }
  send({ type: 'join-channel' });
}

function leaveChannel() {
  send({ type: 'leave-channel' });
  stopScreenShare();
  for (const u of [...state.peers.keys()]) { send({ type: 'call-end', to: u }); closePeer(u); }
  teardownCall();
}

function renderChannelMembers(users) {
  $('channel-list').innerHTML = '';
  users.forEach(addChannelMember);
  updateChannelCount();
}

function addChannelMember(username) {
  if (!$(`ch-${username}`)) {
    const el  = document.createElement('div');
    el.className = 'ch-member-item'; el.id = `ch-${username}`;
    const av  = makeAvatarEl(username, 'avatar ch-av');
    const nm  = document.createElement('span');
    nm.className = 'uname'; nm.style.fontSize = '13px'; nm.textContent = username;
    el.appendChild(av); el.appendChild(nm);
    $('channel-list').appendChild(el);
    $('channel-empty').style.display = 'none';
    updateChannelCount();
  }

  if (!$(`pt-${username}`)) {
    const tile = document.createElement('div');
    tile.className = 'participant-tile'; tile.id = `pt-${username}`;

    const av   = makeAvatarEl(username, 'pt-avatar');
    const name = document.createElement('div');
    name.className = 'pt-name'; name.textContent = username;
    const conn = document.createElement('div');
    conn.className = 'pt-conn';

    // Volume slider
    const volWrap  = document.createElement('div');
    volWrap.className = 'pt-volume-wrap';
    const volLabel = document.createElement('span');
    volLabel.className = 'pt-volume-label'; volLabel.textContent = '🔊';
    const slider   = document.createElement('input');
    slider.type = 'range'; slider.min = '0'; slider.max = '200';
    slider.value = Math.round((parseFloat(localStorage.getItem(`sv_vol_${username}`) || '1')) * 100);
    slider.className = 'pt-volume';
    slider.addEventListener('input', () => {
      const vol = slider.value / 100;
      localStorage.setItem(`sv_vol_${username}`, vol);
      const pa = _peerAudio.get(username);
      if (pa) pa.gain.gain.value = vol;
    });
    volWrap.appendChild(volLabel); volWrap.appendChild(slider);

    tile.appendChild(av); tile.appendChild(name); tile.appendChild(conn); tile.appendChild(volWrap);
    $('participant-grid').appendChild(tile);
  }
}

function removeChannelMember(username) {
  $(`ch-${username}`)?.remove();
  $(`pt-${username}`)?.remove();
  if (!$('channel-list').children.length) $('channel-empty').style.display = '';
  updateChannelCount();
}

function updateChannelCount() {
  $('channel-count').textContent = $('channel-list').children.length;
}

// ── Call management ───────────────────────────────────────────────────────────

async function beginCall() {
  const deviceId = $('settings-mic')?.value || '';
  const audioConstraint = deviceId ? { deviceId: { exact: deviceId } } : true;
  try {
    state.rawStream   = await navigator.mediaDevices.getUserMedia({ audio: audioConstraint, video: false });
    state.localStream = await applyNoiseSuppression(state.rawStream);
  } catch {
    setStatus('Нет доступа к микрофону'); throw new Error('mic denied');
  }
  if (state.pttEnabled) {
    // In PTT mode, start muted
    setMuted(true);
  }
  await loadAudioDevices();
  state.isInCall = true;
  localStorage.setItem('sv_in_channel', '1');
  $('voice-bar').style.display = '';
  $('footer-mute-btn').style.display = '';
  setView('voice');
  $('ch-voice-join').classList.add('active');
  setStatus('В канале');
  const selfName = state.username;
  if (selfName) { addChannelMember(selfName); startVAD(selfName, state.rawStream); }
}

function teardownCall() {
  state.localStream?.getTracks().forEach(t => t.stop());
  state.rawStream?.getTracks().forEach(t => t.stop());
  state.localStream = null; state.rawStream = null;
  destroyNoise();
  state.isInCall  = false;
  state.isMuted   = false;
  state.isDeafened = false;
  $('voice-bar').style.display = 'none';
  $('footer-mute-btn').style.display = 'none';
  updateMuteUI();
  updateDeafenUI();
  stopScreenShare(); hideScreenView(); stopAllVAD();
  localStorage.removeItem('sv_in_channel');
  $('ch-voice-join').classList.remove('active');
  removeChannelMember(state.username);
  setStatus('Подключено');
  setView('server');
}

// ── Mute / Deafen ─────────────────────────────────────────────────────────────

function setMuted(muted) {
  state.isMuted = muted;
  state.rawStream?.getAudioTracks().forEach(t => { t.enabled = !muted; });
  state.localStream?.getAudioTracks().forEach(t => { t.enabled = !muted; });
  updateMuteUI();
}

function updateMuteUI() {
  const muted = state.isMuted;
  const muteBtn = $('mute-btn');
  if (muteBtn) muteBtn.classList.toggle('vc-muted', muted);
  $('mute-label').textContent = state.pttEnabled ? 'PTT' : 'Микрофон';

  // Swap SVG path for muted icon
  const svg = $('mute-icon-svg');
  if (svg) {
    if (muted) {
      svg.innerHTML = `<path d="M13 5V9l4.5 3L13 15v-4a5 5 0 01-8-4V5h5zM3 3L17 17l-1.4 1.4L1.6 4.4 3 3z"/><path d="M5 10a5 5 0 0010 0h2a7 7 0 01-6 6.9V19H9v-2.1A7 7 0 013 10H5z"/>`;
    } else {
      svg.innerHTML = `<path d="M10 2a3 3 0 00-3 3v5a3 3 0 006 0V5a3 3 0 00-3-3zm-5 8a5 5 0 0010 0h2a7 7 0 01-6 6.9V19H9v-2.1A7 7 0 013 10H5z"/>`;
    }
  }

  const footerBtn = $('footer-mute-btn');
  if (footerBtn) footerBtn.classList.toggle('muted', muted);
}

function updateDeafenUI() {
  const d = state.isDeafened;
  $('deafen-btn')?.classList.toggle('vc-muted', d);
  const svg = $('deafen-icon-svg');
  if (svg) {
    if (d) {
      svg.innerHTML = `<path d="M3 3L17 17l-1.4 1.4L3 4.4 3 3zm7-2a8 8 0 018 8h-2a6 6 0 00-9-5.2L5.6 2.4A7.9 7.9 0 0110 1zm0 19a7 7 0 01-7-7H1a9 9 0 0015.3 6.4l-1.5-1.5A7 7 0 0110 20z"/>`;
    } else {
      svg.innerHTML = `<path d="M10 1a8 8 0 018 8v2h-2V9a6 6 0 00-12 0v2H2V9a8 8 0 018-8zM3 13h2a5 5 0 0010 0h2a7 7 0 01-14 0z"/>`;
    }
  }
}

$('mute-btn').addEventListener('click', () => {
  if (state.pttEnabled) return; // PTT mode: don't toggle on click (hold key instead)
  setMuted(!state.isMuted);
});

$('deafen-btn').addEventListener('click', () => {
  state.isDeafened = !state.isDeafened;
  document.querySelectorAll('[id^="audio-"]').forEach(el => { el.muted = state.isDeafened; });
  updateDeafenUI();
});

$('footer-mute-btn').addEventListener('click', () => {
  if (!state.isInCall || state.pttEnabled) return;
  setMuted(!state.isMuted);
});

// ── PTT ───────────────────────────────────────────────────────────────────────

let _capturingPTT = false;

document.addEventListener('keydown', e => {
  if (_capturingPTT) {
    e.preventDefault();
    _capturingPTT = false;
    state.pttKey  = e.code;
    localStorage.setItem('sv_ptt_key', e.code);
    const display = e.key === ' ' ? 'Space' : (e.key.length === 1 ? e.key.toUpperCase() : e.key);
    $('ptt-key-display').textContent = display;
    $('ptt-key-capture').classList.remove('capturing');
    // Re-register global shortcut for toggle mode
    if (state.pttMode === 'toggle') window.electron?.pttRegister(e.code);
    return;
  }
  if (!state.pttEnabled || state.pttMode !== 'hold' || !state.isInCall) return;
  if (e.code === state.pttKey && !e.repeat && state.isMuted) setMuted(false);
});

document.addEventListener('keyup', e => {
  if (!state.pttEnabled || state.pttMode !== 'hold' || !state.isInCall) return;
  if (e.code === state.pttKey && !state.isMuted) setMuted(true);
});

// Global shortcut toggle (fires from main process via IPC)
window.electron?.onPTTToggle(() => {
  if (!state.pttEnabled || state.pttMode !== 'toggle' || !state.isInCall) return;
  setMuted(!state.isMuted);
});

window.electron?.onPTTRegResult(ok => {
  if (!ok) console.warn('[PTT] globalShortcut registration failed for key:', state.pttKey);
});

$('ptt-key-capture').addEventListener('click', () => {
  _capturingPTT = true;
  $('ptt-key-display').textContent = 'Нажмите клавишу...';
  $('ptt-key-capture').classList.add('capturing');
});

// ── Audio devices ─────────────────────────────────────────────────────────────

async function loadAudioDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mic     = $('settings-mic');
    const speaker = $('settings-speaker');

    const currentMic  = mic?.value || '';
    const currentSpk  = speaker?.value || '';

    if (mic) {
      mic.innerHTML = '<option value="">Микрофон по умолчанию</option>';
      devices.filter(d => d.kind === 'audioinput').forEach(d => {
        const o = document.createElement('option');
        o.value = d.deviceId;
        o.textContent = d.label || `Микрофон (${d.deviceId.slice(0,8)})`;
        mic.appendChild(o);
      });
      if (currentMic) mic.value = currentMic;
    }

    if (speaker) {
      speaker.innerHTML = '<option value="">Динамик по умолчанию</option>';
      devices.filter(d => d.kind === 'audiooutput').forEach(d => {
        const o = document.createElement('option');
        o.value = d.deviceId;
        o.textContent = d.label || `Динамик (${d.deviceId.slice(0,8)})`;
        speaker.appendChild(o);
      });
      if (currentSpk) speaker.value = currentSpk;
      else if (state.outputDevice) speaker.value = state.outputDevice;
    }

    // Keep hidden compat select in sync
    const compat = $('mic-select');
    if (compat && mic) compat.value = mic.value;
  } catch(e) { console.warn('loadAudioDevices failed:', e); }
}

async function switchMicrophone(deviceId) {
  if (!state.isInCall) return;
  try {
    const constraint = deviceId ? { deviceId: { exact: deviceId } } : true;
    const newRaw  = await navigator.mediaDevices.getUserMedia({ audio: constraint, video: false });
    state.rawStream?.getTracks().forEach(t => t.stop());
    state.localStream?.getTracks().forEach(t => t.stop());
    destroyNoise();
    const newStream  = await applyNoiseSuppression(newRaw);
    const newRawTrack = newRaw.getAudioTracks()[0];
    if (newRawTrack) newRawTrack.enabled = !state.isMuted;
    for (const pc of state.peers.values()) {
      const sender = pc.getSenders().find(s => s.track?.kind === 'audio');
      if (sender) await sender.replaceTrack(newRawTrack);
    }
    state.rawStream   = newRaw;
    state.localStream = newStream;
    startVAD(state.username, newRaw);
  } catch(err) {
    setStatus('Не удалось переключить микрофон'); console.error(err);
  }
}

async function applyOutputDevice(deviceId) {
  state.outputDevice = deviceId;
  localStorage.setItem('sv_output_device', deviceId);
  for (const username of state.peers.keys()) {
    const el = $(`audio-${username}`);
    if (el && el.setSinkId) await el.setSinkId(deviceId).catch(() => {});
  }
}

$('settings-mic').addEventListener('change', () => {
  const v = $('settings-mic').value;
  localStorage.setItem('sv_mic_device', v);
  switchMicrophone(v);
});

$('settings-speaker').addEventListener('change', () => {
  const v = $('settings-speaker').value;
  applyOutputDevice(v);
});

$('settings-devices-refresh').addEventListener('click', loadAudioDevices);

// ── Screen share ──────────────────────────────────────────────────────────────

const RESOLUTIONS = {
  '720p30':  { width: 1280,  height: 720,  frameRate: 30 },
  '1080p30': { width: 1920,  height: 1080, frameRate: 30 },
  '1080p60': { width: 1920,  height: 1080, frameRate: 60 },
  '1440p30': { width: 2560,  height: 1440, frameRate: 30 },
};

let _screenStream  = null;
let _lastSourceId  = null;
let _pickerResolve = null;
let _allSources    = [];

function showSourcePicker(sources) {
  _allSources = sources;
  return new Promise(resolve => {
    _pickerResolve = resolve;
    $('picker-confirm').disabled = true;
    renderPickerSources('screen');
    $('source-picker').style.display = 'flex';
  });
}

function renderPickerSources(tab) {
  const grid     = $('source-grid');
  grid.innerHTML = '';
  const filtered = _allSources.filter(s => tab === 'screen' ? s.id.startsWith('screen:') : !s.id.startsWith('screen:'));
  filtered.forEach((src, i) => {
    const el = document.createElement('div');
    el.className = 'source-item'; el.dataset.id = src.id;
    el.innerHTML = `<img class="source-thumb" src="${src.thumbnail}" alt=""><span class="source-name">${escHtml(src.name)}</span>`;
    el.addEventListener('click', () => {
      grid.querySelectorAll('.source-item').forEach(e => e.classList.remove('selected'));
      el.classList.add('selected');
      $('picker-confirm').disabled = false;
    });
    grid.appendChild(el);
    if (i === 0) { el.classList.add('selected'); $('picker-confirm').disabled = false; }
  });
}

document.querySelectorAll('.picker-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.picker-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    renderPickerSources(tab.dataset.tab);
    $('picker-confirm').disabled = true;
  });
});

$('picker-confirm').addEventListener('click', () => {
  const sel = $('source-grid').querySelector('.source-item.selected');
  const res = $('picker-res').value;
  $('source-picker').style.display = 'none';
  _pickerResolve?.({ sourceId: sel?.dataset.id, resolution: res });
  _pickerResolve = null;
});

$('picker-cancel').addEventListener('click', () => {
  $('source-picker').style.display = 'none';
  _pickerResolve?.(null); _pickerResolve = null;
});

async function startScreenShare() {
  if (!state.isInCall) return;
  const sources = await window.electron.getSources(['screen', 'window']);
  const chosen  = await showSourcePicker(sources);
  if (!chosen?.sourceId) return;
  _lastSourceId = chosen.sourceId;
  await applyScreenShare(chosen.sourceId, chosen.resolution);
}

async function applyScreenShare(sourceId, resKey) {
  const res = RESOLUTIONS[resKey] ?? RESOLUTIONS['1080p30'];
  try {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'desktop' } },
        video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId,
          maxWidth: res.width, maxHeight: res.height, maxFrameRate: res.frameRate } },
      });
    } catch {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId,
          maxWidth: res.width, maxHeight: res.height, maxFrameRate: res.frameRate } },
      });
    }
    const videoTrack = stream.getVideoTracks()[0];
    const audioTrack = stream.getAudioTracks()[0] ?? null;
    for (const pc of state.peers.values()) {
      const vs = pc.getSenders().find(s => s.track?.kind === 'video');
      if (vs) await vs.replaceTrack(videoTrack); else pc.addTrack(videoTrack, stream);
      if (audioTrack) { const as = pc.getSenders().find(s => s.track?.id === audioTrack?.id); if (!as) pc.addTrack(audioTrack, stream); }
    }
    if (_screenStream) _screenStream.getTracks().forEach(t => t.stop());
    _screenStream = stream;
    showScreenView('Ваш экран', stream);
    $('screen-btn').classList.add('vc-streaming');
    $('screen-label-btn').textContent = resKey;
    videoTrack.onended = stopScreenShare;
  } catch(err) { console.error('Screen share error:', err); }
}

function stopScreenShare() {
  if (_screenStream) { _screenStream.getTracks().forEach(t => t.stop()); _screenStream = null; }
  _lastSourceId = null;
  $('screen-btn').classList.remove('vc-streaming');
  $('screen-label-btn').textContent = 'Стрим';
  hideScreenView();
}

$('screen-btn').addEventListener('click', async () => {
  if (!state.isInCall) return;
  if ($('screen-btn').classList.contains('vc-streaming')) stopScreenShare();
  else await startScreenShare();
});

function showScreenView(username, stream) {
  $('screen-view').style.display  = 'flex';
  $('screen-view-label').textContent = `🖥️ ${username}`;
  const video = $('screen-video');
  video.srcObject = stream; video.play().catch(() => {});
}
function hideScreenView() {
  $('screen-view').style.display = 'none'; $('screen-video').srcObject = null;
}

$('screen-fullscreen-btn').addEventListener('click', () => {
  const v = $('screen-video');
  if (v.requestFullscreen) v.requestFullscreen();
  else if (v.webkitRequestFullscreen) v.webkitRequestFullscreen();
});

// ── Ping stats ────────────────────────────────────────────────────────────────

async function getPing(pc) {
  try {
    const stats = await pc.getStats();
    for (const r of stats.values()) {
      if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.currentRoundTripTime != null)
        return Math.round(r.currentRoundTripTime * 1000);
    }
  } catch {}
  return null;
}

setInterval(async () => {
  for (const [username, pc] of state.peers) {
    const ms = await getPing(pc);
    const el = $(`pt-${username}`);
    if (!el) continue;
    const conn = el.querySelector('.pt-conn');
    if (!conn) continue;
    if (ms === null) continue; // keep connection-state icon; don't overwrite with blank
    conn.textContent = `${ms}ms`;
    conn.className   = `pt-conn peer-ping ${ms < 80 ? 'ping-good' : ms < 200 ? 'ping-ok' : 'ping-bad'}`;
  }
}, 2000);

// ── User list ─────────────────────────────────────────────────────────────────

function renderUsers(users) {
  $('user-list').innerHTML = '';
  $('friends-list').innerHTML = '';
  updateEmptyHint();
  users.forEach(addUser);
  updateOnlineCount();
}

function addUser(username) {
  if ($(`user-${username}`)) return;

  const el = document.createElement('div');
  el.className = 'user-item'; el.id = `user-${username}`; el.dataset.user = username;
  const av = makeAvatarEl(username);
  const nm = document.createElement('span'); nm.className = 'uname'; nm.textContent = username;
  const pg = document.createElement('span'); pg.className = 'peer-ping'; pg.id = `ping-${username}`;
  el.appendChild(av); el.appendChild(nm); el.appendChild(pg);
  $('user-list').appendChild(el);

  const card = document.createElement('div');
  card.className = 'friend-card'; card.id = `fc-${username}`;
  const cav = makeAvatarEl(username, 'avatar lg');
  card.innerHTML = `
    <div class="fc-info">
      <div class="fc-name">${escHtml(username)}</div>
      <div class="fc-status"><span class="status-dot online"></span>В сети</div>
    </div>
    <span class="peer-ping" id="fc-ping-${username}"></span>
  `;
  card.insertBefore(cav, card.firstChild);
  $('friends-list').appendChild(card);

  updateEmptyHint(); updateOnlineCount();
}

function removeUser(username) {
  $(`user-${username}`)?.remove();
  $(`fc-${username}`)?.remove();
  updateEmptyHint(); updateOnlineCount();
}

function updateEmptyHint() {
  const count = $('user-list').querySelectorAll('.user-item').length;
  const h  = $('empty-hint');   if (h)  h.style.display  = count ? 'none' : '';
  const h2 = $('home-empty');   if (h2) h2.style.display = count ? 'none' : '';
}

function updateOnlineCount() {
  const count = $('user-list').querySelectorAll('.user-item').length;
  const el1 = $('online-count');      if (el1) el1.textContent = count;
  const el2 = $('home-online-count'); if (el2) el2.textContent = count;
}

// ── Navigation ────────────────────────────────────────────────────────────────

$('btn-home').addEventListener('click', () => setView('home'));
$('btn-chat').addEventListener('click', () => setView('chat'));
$('btn-server').addEventListener('click', () => {
  if (state.isInCall) setView('voice'); else setView('server');
});

$('ch-voice-join').addEventListener('click', () => { if (!state.isInCall) joinChannel(); });
$('ch-text-general').addEventListener('click', () => setView('chat'));
$('end-btn').addEventListener('click', leaveChannel);

$('chat-toggle-btn').addEventListener('click', () => {
  const panel = $('chat-panel');
  const open  = panel.style.display === 'none';
  panel.style.display = open ? '' : 'none';
  $('chat-toggle-btn').classList.toggle('active', open);
});

$('chat-panel-close').addEventListener('click', () => {
  $('chat-panel').style.display = 'none';
  $('chat-toggle-btn').classList.remove('active');
});

// ── Settings overlay ──────────────────────────────────────────────────────────

function openSettings() {
  $('settings-overlay').style.display = 'flex';
  loadAudioDevices();
  loadSettingsIntoUI();
}

function closeSettings() {
  $('settings-overlay').style.display = 'none';
}

$('btn-settings').addEventListener('click', openSettings);
$('settings-close-btn').addEventListener('click', closeSettings);

document.addEventListener('keydown', e => {
  if (_capturingPTT) return;
  if (e.key === 'Escape' && $('settings-overlay').style.display !== 'none') closeSettings();
});

// Settings tabs
document.querySelectorAll('.settings-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.settings-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    ['voice','ptt','profile','notifs'].forEach(id => {
      const pane = $(`stab-${id}`);
      if (pane) pane.style.display = id === tab ? '' : 'none';
    });
    if (tab === 'profile') refreshSettingsAvatar();
  });
});

// ── Settings: persist & load ──────────────────────────────────────────────────

function loadSettingsFromStorage() {
  state.noiseEnabled = localStorage.getItem('sv_noise') !== 'false';
  state.pttEnabled   = localStorage.getItem('sv_ptt') === 'true';
  state.pttMode      = localStorage.getItem('sv_ptt_mode') || 'hold';
  state.pttKey       = localStorage.getItem('sv_ptt_key') || 'CapsLock';
  state.outputDevice = localStorage.getItem('sv_output_device') || '';
  state.soundsEnabled = localStorage.getItem('sv_sounds') !== 'false';

  if (state.pttEnabled && state.pttMode === 'toggle') {
    window.electron?.pttRegister(state.pttKey);
    window.electron?.pttSetEnabled(true);
  }
}

function loadSettingsIntoUI() {
  const noiseEl = $('settings-noise');
  const pttEl   = $('settings-ptt-enabled');
  const soundsEl = $('settings-sounds');

  if (noiseEl)  noiseEl.checked  = state.noiseEnabled;
  if (pttEl)    pttEl.checked    = state.pttEnabled;
  if (soundsEl) soundsEl.checked = state.soundsEnabled;

  const keyDisplay = $('ptt-key-display');
  if (keyDisplay) keyDisplay.textContent = state.pttKey;

  const modeEl = state.pttMode === 'toggle' ? $('ptt-mode-toggle') : $('ptt-mode-hold');
  if (modeEl) modeEl.checked = true;

  $('ptt-settings-body').style.display = state.pttEnabled ? '' : 'none';

  // Set saved mic / speaker
  const savedMic  = localStorage.getItem('sv_mic_device');
  const savedSpk  = localStorage.getItem('sv_output_device');
  if (savedMic && $('settings-mic'))     $('settings-mic').value     = savedMic;
  if (savedSpk && $('settings-speaker')) $('settings-speaker').value = savedSpk;
}

// Noise toggle
$('settings-noise').addEventListener('change', async () => {
  state.noiseEnabled = $('settings-noise').checked;
  localStorage.setItem('sv_noise', state.noiseEnabled);
  if (state.isInCall) await switchMicrophone($('settings-mic')?.value || '');
});

// PTT enabled toggle
$('settings-ptt-enabled').addEventListener('change', () => {
  state.pttEnabled = $('settings-ptt-enabled').checked;
  localStorage.setItem('sv_ptt', state.pttEnabled);
  $('ptt-settings-body').style.display = state.pttEnabled ? '' : 'none';
  window.electron?.pttSetEnabled(state.pttEnabled);
  if (state.pttEnabled && state.pttMode === 'toggle') {
    window.electron?.pttRegister(state.pttKey);
  } else if (!state.pttEnabled) {
    window.electron?.pttUnregister();
    // If muted via PTT, unmute
    if (state.isMuted && state.isInCall) setMuted(false);
  }
  updateMuteUI();
});

// PTT mode radio
document.querySelectorAll('input[name="ptt-mode"]').forEach(radio => {
  radio.addEventListener('change', () => {
    if (!radio.checked) return;
    state.pttMode = radio.value;
    localStorage.setItem('sv_ptt_mode', state.pttMode);
    if (state.pttEnabled) {
      if (state.pttMode === 'toggle') window.electron?.pttRegister(state.pttKey);
      else window.electron?.pttUnregister();
    }
  });
});

// Sounds toggle
$('settings-sounds').addEventListener('change', () => {
  state.soundsEnabled = $('settings-sounds').checked;
  localStorage.setItem('sv_sounds', state.soundsEnabled);
});

// ── Avatar upload ─────────────────────────────────────────────────────────────

function refreshSettingsAvatar() {
  const el = $('settings-avatar-el');
  if (el && state.username) refreshAvatar(el, state.username);
}

$('avatar-upload-btn').addEventListener('click', () => $('avatar-file-input').click());

$('avatar-file-input').addEventListener('change', async () => {
  const file = $('avatar-file-input').files?.[0];
  if (!file) return;

  const statusEl = $('avatar-status');
  statusEl.style.display = '';
  statusEl.style.color   = 'var(--dim)';
  statusEl.textContent   = 'Загрузка...';

  try {
    await uploadAvatar(file);
    statusEl.style.color = 'var(--green)';
    statusEl.textContent = '✓ Аватар обновлён';
    // Refresh all avatar instances for self
    refreshSettingsAvatar();
    refreshAvatar($('self-avatar'), state.username);
    refreshAvatar($('vbar-avatar'), state.username);
    const ptav = $(`pt-${state.username}`)?.querySelector('.pt-avatar');
    if (ptav) refreshAvatar(ptav, state.username);
  } catch(err) {
    statusEl.style.color = 'var(--red)';
    statusEl.textContent = `Ошибка: ${err.message}`;
  }
  $('avatar-file-input').value = '';
});

async function uploadAvatar(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async e => {
      try {
        const res  = await fetch(`${SERVER}/avatar`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: state.token, data: e.target.result }),
        });
        const json = await res.json();
        if (json.success) resolve();
        else reject(new Error(json.message || 'Ошибка сервера'));
      } catch(err) { reject(err); }
    };
    reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
    reader.readAsDataURL(file);
  });
}
