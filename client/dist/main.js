'use strict';

const SERVER = 'https://squadvox.ru';
const WS_URL  = 'wss://squadvox.ru';

// ── State ──────────────────────────────────────────────────────────────────────

const state = {
  token: null, username: null, turnCreds: null, turnHost: 'squadvox.ru',
  ws: null,
  peers:    new Map(),
  peerMeta: new Map(),
  rawStream: null, localStream: null,
  isMuted: false, isDeafened: false, isInCall: false,
  noiseEnabled: true, pttEnabled: false, pttMode: 'hold', pttKey: 'CapsLock',
  outputDevice: '', soundsEnabled: true, chatUnread: 0, view: 'home',
};

// ── Screen stream registry ─────────────────────────────────────────────────────

const _peerScreenStreams = new Map(); // key → {stream, label}
let _activeScreenPeer   = null;

// ── Audio output ───────────────────────────────────────────────────────────────
// One <audio> per peer-stream combo; keyed by stream.id to avoid mic/screen conflict.

function connectPeerAudio(peerName, stream) {
  const sid  = stream.id.slice(0, 8);
  const elId = `audio-${peerName}-${sid}`;
  let el = document.getElementById(elId);
  if (!el) {
    el = document.createElement('audio');
    el.id = elId; el.autoplay = true;
    el.dataset.peer = peerName;
    document.body.appendChild(el);
  }
  el.srcObject = stream;
  el.muted     = state.isDeafened;
  el.volume    = Math.min(1, parseFloat(localStorage.getItem(`sv_vol_${peerName}`) ?? '1'));
  if (el.setSinkId && state.outputDevice) el.setSinkId(state.outputDevice).catch(() => {});
  el.play().catch(e => console.warn('[audio] play():', e));
  console.log(`[audio] ${peerName} sid=${sid} tracks=${stream.getAudioTracks().length}`);
}

function removePeerAudio(peerName) {
  document.querySelectorAll(`[id^="audio-${peerName}-"]`).forEach(el => { el.srcObject = null; el.remove(); });
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

function setStatus(text) {
  [$('status-text'), $('vbar-state'), $('conn-status-text')].forEach(el => { if (el) el.textContent = text; });
}

function setOnline(on) {
  const el  = $('conn-status');      if (el)  el.className = `conn-dot ${on ? 'online' : 'offline'}`;
  const dot = $('footer-status-dot'); if (dot) dot.className = `footer-status-dot ${on ? 'online' : ''}`;
}

function nameColor(name) {
  const p = ['#4dabf7','#748ffc','#da77f2','#f783ac','#ff8787','#ffd43b','#69db7c','#38d9a9'];
  let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffff;
  return p[h % p.length];
}

function captureFirstFrame(img) {
  if (img.dataset.staticSrc) return;
  try {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth || 40; c.height = img.naturalHeight || 40;
    c.getContext('2d').drawImage(img, 0, 0);
    img.dataset.staticSrc = c.toDataURL('image/png');
    if (!img.dataset.speaking) img.src = img.dataset.staticSrc;
  } catch {}
}

function makeAvatarEl(username, cls = 'avatar') {
  const wrap = document.createElement('div');
  wrap.className = cls; wrap.style.background = nameColor(username);
  const img = document.createElement('img');
  const src = `${SERVER}/avatar/${encodeURIComponent(username)}`;
  img.crossOrigin = 'anonymous';
  img.dataset.gifSrc = src;
  img.alt = username[0].toUpperCase();
  img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:inherit;display:block;';
  img.onload  = () => captureFirstFrame(img);
  img.onerror = () => { img.remove(); wrap.textContent = username[0].toUpperCase(); };
  img.src = src;
  wrap.appendChild(img);
  return wrap;
}

function refreshAvatar(el, username) {
  if (!el) return;
  el.style.background = nameColor(username); el.textContent = '';
  const img = document.createElement('img');
  const src = `${SERVER}/avatar/${encodeURIComponent(username)}?t=${Date.now()}`;
  img.crossOrigin = 'anonymous';
  img.dataset.gifSrc = src;
  img.alt = username[0].toUpperCase();
  img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:inherit;display:block;';
  img.onload  = () => captureFirstFrame(img);
  img.onerror = () => { img.remove(); el.textContent = username[0].toUpperCase(); };
  img.src = src;
  el.appendChild(img);
}

function setAvatarSpeaking(username, speaking) {
  const sels = [
    `#pt-${username} .pt-avatar img`,
    `#ch-${username} .ch-av img`,
  ];
  if (username === state.username) sels.push('#self-avatar img', '#vbar-avatar img');
  sels.forEach(sel => {
    const img = document.querySelector(sel);
    if (!img || !img.dataset.gifSrc) return;
    if (speaking) {
      img.dataset.speaking = '1';
      if (img.src !== img.dataset.gifSrc) img.src = img.dataset.gifSrc;
    } else {
      delete img.dataset.speaking;
      if (img.dataset.staticSrc && img.src !== img.dataset.staticSrc) img.src = img.dataset.staticSrc;
    }
  });
}

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Sound effects ──────────────────────────────────────────────────────────────

function playSound(type) {
  if (!state.soundsEnabled) return;
  try {
    const ctx = new AudioContext();
    const freqs = type === 'join' ? [523.25, 659.25] : [659.25, 523.25];
    freqs.forEach((freq, i) => {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = 'sine'; osc.frequency.value = freq;
      const t = ctx.currentTime + i * 0.14;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.22, t + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
      osc.start(t); osc.stop(t + 0.35);
    });
    setTimeout(() => ctx.close(), 1000);
  } catch {}
}

// ── RNNoise ────────────────────────────────────────────────────────────────────

let _noiseCtx = null, _rnNode = null, _gateNode = null, _nsHeartbeat = null;

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
    if (!_noiseCtx || _noiseCtx.state === 'closed') _noiseCtx = new AudioContext({ sampleRate: 48000 });
    await _noiseCtx.resume();
    if (_nsHeartbeat) clearInterval(_nsHeartbeat);
    _nsHeartbeat = setInterval(() => { if (_noiseCtx?.state === 'suspended') _noiseCtx.resume().catch(() => {}); }, 2000);
    if (!_noiseCtx._loaded) {
      await _noiseCtx.audioWorklet.addModule('./rnnoise-worklet.js');
      await _noiseCtx.audioWorklet.addModule('./noisegate-worklet.js');
      _noiseCtx._loaded = true;
    }
    const simd = await WebAssembly.validate(
      new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11])
    );
    const wasmBinary = await fetch(simd ? './rnnoise_simd.wasm' : './rnnoise.wasm').then(r => r.arrayBuffer());
    if (_rnNode) { _rnNode.destroy(); _rnNode = null; }
    const src = _noiseCtx.createMediaStreamSource(rawStream);
    _rnNode   = new RnnoiseWorkletNode(_noiseCtx, { wasmBinary, maxChannels: 1 });
    _gateNode = new NoiseGateWorkletNode(_noiseCtx, { openThreshold: -50, closeThreshold: -55, holdMs: 150, maxChannels: 1 });
    const dest = _noiseCtx.createMediaStreamDestination();
    src.connect(_rnNode); _rnNode.connect(_gateNode); _gateNode.connect(dest);
    return dest.stream;
  } catch(err) {
    console.warn('[RNNoise] unavailable:', err); return rawStream;
  }
}

function destroyNoise() {
  if (_nsHeartbeat) { clearInterval(_nsHeartbeat); _nsHeartbeat = null; }
  if (_rnNode) { _rnNode.destroy(); _rnNode = null; }
  _gateNode = null;
  if (_noiseCtx) { _noiseCtx.close(); _noiseCtx = null; }
}

// ── VAD ────────────────────────────────────────────────────────────────────────

const _vad = new Map();

function startVAD(username, stream) {
  stopVAD(username);
  try {
    const ctx = new AudioContext(); ctx.resume().catch(() => {});
    const analyser = ctx.createAnalyser(); analyser.fftSize = 256;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    let prevSpeaking = false;
    const interval = setInterval(() => {
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / data.length;
      const speaking = avg > 8;
      $(`pt-${username}`)?.classList.toggle('speaking', speaking);
      $(`ch-${username}`)?.classList.toggle('speaking', speaking);
      if (speaking !== prevSpeaking) { setAvatarSpeaking(username, speaking); prevSpeaking = speaking; }
    }, 100);
    _vad.set(username, { ctx, interval });
  } catch {}
}

function stopVAD(username) {
  const v = _vad.get(username); if (!v) return;
  clearInterval(v.interval); v.ctx?.close(); _vad.delete(username);
  $(`pt-${username}`)?.classList.remove('speaking');
  $(`ch-${username}`)?.classList.remove('speaking');
  setAvatarSpeaking(username, false);
}

function stopAllVAD() { for (const u of [..._vad.keys()]) stopVAD(u); }

// ── Session ────────────────────────────────────────────────────────────────────

function saveSession(d) {
  localStorage.setItem('sv_token',     d.token);
  localStorage.setItem('sv_username',  d.username);
  localStorage.setItem('sv_turnCreds', JSON.stringify(d.turnCreds || null));
  localStorage.setItem('sv_turnHost',  d.turnHost || 'squadvox.ru');
}

function loadSession() {
  const token = localStorage.getItem('sv_token'); if (!token) return false;
  state.token    = token;
  state.username = localStorage.getItem('sv_username');
  state.turnCreds = JSON.parse(localStorage.getItem('sv_turnCreds'));
  state.turnHost  = localStorage.getItem('sv_turnHost') || 'squadvox.ru';
  return true;
}

function clearSession() {
  ['sv_token','sv_username','sv_turnCreds','sv_turnHost'].forEach(k => localStorage.removeItem(k));
}

// ── Views ──────────────────────────────────────────────────────────────────────

function showMain() {
  $('login-screen').style.display = 'none';
  $('main-screen').style.display  = 'flex';
  $('self-name').textContent = state.username || '';
  refreshAvatar($('self-avatar'), state.username);
  refreshAvatar($('vbar-avatar'), state.username);
  $('vbar-name').textContent = state.username || '';
  loadSettingsFromStorage(); setView('home');
}

function showLogin() {
  clearSession();
  $('main-screen').style.display  = 'none';
  $('login-screen').style.display = 'flex';
  $('login-error').textContent = ''; $('password-input').value = '';
}

function setView(view) {
  ['home','chat','server','voice'].forEach(v => {
    const el = $(`view-${v}`); if (el) el.style.display = v === view ? '' : 'none';
  });
  $('sidebar-home').style.display   = view === 'home' ? '' : 'none';
  $('sidebar-server').style.display = view === 'home' ? 'none' : '';
  $('btn-home').classList.toggle('active',   view === 'home');
  $('btn-chat').classList.toggle('active',   view === 'chat');
  $('btn-server').classList.toggle('active', view === 'server' || view === 'voice');
  $('ch-text-general')?.classList.toggle('active', view === 'chat');
  state.view = view;
  if (view === 'chat') {
    state.chatUnread = 0; updateChatBadge(0);
    setTimeout(() => { const m = $('global-chat-messages'); if (m) m.scrollTop = m.scrollHeight; }, 0);
  }
}

// ── Login ──────────────────────────────────────────────────────────────────────

$('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('login-btn'); btn.disabled = true;
  $('login-error').textContent = '';
  try {
    const res  = await fetch(`${SERVER}/auth`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: $('login-input').value.trim(), password: $('password-input').value }),
    });
    const data = await res.json();
    if (data.success) {
      Object.assign(state, { token: data.token, username: data.username, turnCreds: data.turnCreds, turnHost: data.turnHost || 'squadvox.ru' });
      saveSession(data); showMain(); connectWS();
    } else { $('login-error').textContent = 'Неверный логин или пароль'; }
  } catch { $('login-error').textContent = 'Ошибка подключения к серверу'; }
  finally  { btn.disabled = false; }
});

$('logout-btn').addEventListener('click', () => {
  if (state.ws) { state.ws.onclose = null; state.ws.close(); }
  if (state.isInCall) leaveChannel();
  showLogin();
});

window.addEventListener('DOMContentLoaded', () => { if (loadSession()) { showMain(); connectWS(); } });

// ── WebSocket ──────────────────────────────────────────────────────────────────

function connectWS() {
  setStatus('Подключение...');
  const ws = new WebSocket(WS_URL); state.ws = ws;
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'auth', token: state.token }));
    state._ping = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' })); }, 25000);
  };
  ws.onmessage = e => { try { handleMessage(JSON.parse(e.data)); } catch(err) { console.error(err); } };
  ws.onclose   = () => { clearInterval(state._ping); setOnline(false); setStatus('Переподключение...'); setTimeout(connectWS, 3000); };
  ws.onerror   = () => setStatus('Ошибка соединения');
}

function send(msg) { if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(msg)); }

// ── Messages ───────────────────────────────────────────────────────────────────

async function handleMessage(msg) {
  switch (msg.type) {
    case 'auth_ok':
      setOnline(true); setStatus('Подключено');
      if (localStorage.getItem('sv_in_channel') && !state.isInCall) joinChannel();
      break;
    case 'auth_error': showLogin(); break;
    case 'kicked':
      if (state.ws) { state.ws.onclose = null; state.ws.close(); state.ws = null; }
      clearSession(); showLogin();
      $('login-error').textContent = 'Выполнен вход с другого устройства';
      break;
    case 'user_list':   renderUsers(msg.users); renderChannelMembers(msg.channel || []); break;
    case 'user_joined': addUser(msg.username); break;
    case 'user_left':   removeUser(msg.username); removeChannelMember(msg.username); closePeer(msg.username); break;
    case 'chat-history': (msg.messages || []).forEach(m => appendBothChats(m.from, m.text, m.ts, true)); break;
    case 'chat-message': appendBothChats(msg.from, msg.text, msg.ts, false); break;

    case 'channel-members':
      for (const u of msg.users) { addChannelMember(u); if (state.isInCall && !state.peers.has(u)) openPeer(u); }
      break;
    case 'channel-joined':
      addChannelMember(msg.username); playSound('join');
      if (state.isInCall && !state.peers.has(msg.username)) openPeer(msg.username);
      break;
    case 'channel-left': removeChannelMember(msg.username); closePeer(msg.username); playSound('leave'); break;

    case 'sdp':
      if (!state.isInCall) { try { await beginCall(); } catch { break; } }
      if (!state.peers.has(msg.from)) openPeer(msg.from);
      await onRemoteSdp(msg.from, msg.sdp); break;
    case 'ice':
      if (msg.candidate && state.peers.has(msg.from)) await onRemoteIce(msg.from, msg.candidate); break;
    case 'offer':
      if (!state.isInCall) { try { await beginCall(); } catch { break; } }
      if (!state.peers.has(msg.from)) openPeer(msg.from);
      await onRemoteSdp(msg.from, msg.sdp); break;
    case 'answer':
      if (state.peers.has(msg.from)) await onRemoteSdp(msg.from, msg.sdp); break;
    case 'pong': break;
  }
}

// ── Chat ───────────────────────────────────────────────────────────────────────

function appendBothChats(from, text, ts, isHistory) {
  appendChatToEl($('global-chat-messages'), from, text, ts);
  appendChatToEl($('chat-messages'),        from, text, ts);
  if (!isHistory && state.view !== 'chat') { state.chatUnread++; updateChatBadge(state.chatUnread); }
}

function appendChatToEl(container, from, text, ts) {
  if (!container) return;
  const time = new Date(ts).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  const div  = document.createElement('div'); div.className = 'chat-msg-group';
  const avEl = makeAvatarEl(from, 'avatar chat-msg-av');
  avEl.style.cssText = 'width:36px;height:36px;flex-shrink:0';
  div.innerHTML = `<div class="chat-msg-body"><div class="chat-msg-header"><span class="chat-msg-author">${escHtml(from)}</span><span class="chat-msg-time">${time}</span></div><div class="chat-msg-text">${escHtml(text)}</div></div>`;
  div.insertBefore(avEl, div.firstChild);
  container.appendChild(div); container.scrollTop = container.scrollHeight;
}

function updateChatBadge(n) {
  const b = $('chat-badge'), sb = $('chat-badge-sidebar');
  if (b)  { b.textContent  = n; b.style.display  = n > 0 ? '' : 'none'; }
  if (sb) { sb.textContent = n; sb.style.display = n > 0 ? '' : 'none'; }
}

$('global-chat-form').addEventListener('submit', e => {
  e.preventDefault();
  const input = $('global-chat-input'), text = input.value.trim(); if (!text) return;
  send({ type: 'chat-message', text });
  appendBothChats(state.username, text, Date.now(), false);
  input.value = ''; state.chatUnread = Math.max(0, state.chatUnread - 1); updateChatBadge(state.chatUnread);
});

$('chat-form').addEventListener('submit', e => {
  e.preventDefault();
  const input = $('chat-input'), text = input.value.trim(); if (!text) return;
  send({ type: 'chat-message', text });
  appendBothChats(state.username, text, Date.now(), false);
  input.value = ''; state.chatUnread = Math.max(0, state.chatUnread - 1); updateChatBadge(state.chatUnread);
});

// ── WebRTC ─────────────────────────────────────────────────────────────────────

function iceConfig() {
  const servers = [
    { urls: `stun:${state.turnHost}:3478` },
    { urls: 'stun:stun.l.google.com:19302' },
  ];
  if (state.turnCreds) servers.push(
    { urls: `turn:${state.turnHost}:3478`,               ...state.turnCreds },
    { urls: `turn:${state.turnHost}:3478?transport=tcp`, ...state.turnCreds },
    { urls: `turns:${state.turnHost}:5349?transport=tcp`,...state.turnCreds },
  );
  return { iceServers: servers };
}

function openPeer(peerName) {
  if (state.peers.has(peerName)) return;
  const pc   = new RTCPeerConnection(iceConfig());
  const meta = { makingOffer: false, ignoreOffer: false, polite: state.username > peerName };
  state.peers.set(peerName, pc); state.peerMeta.set(peerName, meta);

  pc.onnegotiationneeded = async () => {
    console.log(`[webrtc:${peerName}] negotiationneeded signalingState=${pc.signalingState}`);
    try {
      meta.makingOffer = true;
      const offer = await pc.createOffer();
      if (pc.signalingState !== 'stable') return;
      await pc.setLocalDescription(offer);
      send({ type: 'sdp', to: peerName, sdp: pc.localDescription });
    } catch(e) { console.error(`[webrtc:${peerName}] negotiation error:`, e); }
    finally    { meta.makingOffer = false; }
  };

  pc.onicecandidate = ({ candidate }) => { if (candidate) send({ type: 'ice', to: peerName, candidate }); };

  pc.oniceconnectionstatechange = () =>
    console.log(`[webrtc:${peerName}] ice: ${pc.iceConnectionState}`);

  pc.ontrack = ({ track, streams }) => {
    console.log(`[webrtc:${peerName}] ontrack kind=${track.kind} streams=${streams.length}`);
    if (track.kind === 'audio') {
      const s = streams[0] || new MediaStream([track]);
      connectPeerAudio(peerName, s);
      if (!_vad.has(peerName)) startVAD(peerName, s);
    } else if (track.kind === 'video') {
      const s = streams[0] || new MediaStream([track]);
      _peerScreenStreams.set(peerName, { stream: s, label: peerName });
      showScreenViewFor(peerName, s, peerName);
      track.onended = () => {
        _peerScreenStreams.delete(peerName);
        if (_activeScreenPeer === peerName) {
          const next = [..._peerScreenStreams.entries()][0];
          if (next) showScreenViewFor(next[0], next[1].stream, next[1].label);
          else hideScreenView();
        }
        updateScreenThumbs();
      };
    }
  };

  pc.onconnectionstatechange = () => {
    console.log(`[webrtc:${peerName}] conn: ${pc.connectionState}`);
    const tile = $(`pt-${peerName}`); if (!tile) return;
    tile.dataset.conn = pc.connectionState;
    const badge = tile.querySelector('.pt-conn'); if (!badge) return;
    const icons = { connecting: '⏳', failed: '❌', disconnected: '🔌' };
    badge.textContent = pc.connectionState === 'connected' ? '' : (icons[pc.connectionState] ?? '');
  };

  // FIX #1: use localStream (noise-suppressed) — was wrongly using rawStream
  const sendStream = state.localStream || state.rawStream;
  if (sendStream) {
    sendStream.getTracks().forEach(t => {
      console.log(`[webrtc:${peerName}] addTrack kind=${t.kind} enabled=${t.enabled}`);
      pc.addTrack(t, sendStream);
    });
  } else {
    console.warn(`[webrtc:${peerName}] openPeer: no stream!`);
  }
}

async function onRemoteSdp(peerName, sdp) {
  const pc = state.peers.get(peerName), meta = state.peerMeta.get(peerName);
  if (!pc || !meta) return;
  const offerCollision = sdp.type === 'offer' && (meta.makingOffer || pc.signalingState !== 'stable');
  meta.ignoreOffer = !meta.polite && offerCollision;
  if (meta.ignoreOffer) return;
  try {
    if (sdp.type === 'offer' && pc.signalingState === 'have-local-offer')
      await pc.setLocalDescription({ type: 'rollback' });
    await pc.setRemoteDescription(sdp);
    if (sdp.type === 'offer') {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send({ type: 'sdp', to: peerName, sdp: pc.localDescription });
    }
  } catch(e) { console.error(`[webrtc:${peerName}] onRemoteSdp error:`, e); }
}

async function onRemoteIce(peerName, candidate) {
  const pc = state.peers.get(peerName), meta = state.peerMeta.get(peerName);
  if (!pc) return;
  try { await pc.addIceCandidate(candidate); }
  catch(e) { if (!meta?.ignoreOffer) console.error(`[webrtc:${peerName}] ice error:`, e); }
}

function closePeer(peerName) {
  state.peers.get(peerName)?.close();
  state.peers.delete(peerName); state.peerMeta.delete(peerName);
  removePeerAudio(peerName); stopVAD(peerName);
  if (_peerScreenStreams.has(peerName)) {
    _peerScreenStreams.delete(peerName);
    if (_activeScreenPeer === peerName) hideScreenView();
    updateScreenThumbs();
  }
}

// ── Voice channel ──────────────────────────────────────────────────────────────

async function joinChannel() {
  try { await beginCall(); } catch { return; }
  send({ type: 'join-channel' });
}

function leaveChannel() {
  send({ type: 'leave-channel' }); stopScreenShare();
  for (const u of [...state.peers.keys()]) closePeer(u);
  teardownCall();
}

function renderChannelMembers(users) {
  $('channel-list').innerHTML = ''; users.forEach(addChannelMember); updateChannelCount();
}

function addChannelMember(username) {
  if (!$(`ch-${username}`)) {
    const el = document.createElement('div');
    el.className = 'ch-member-item'; el.id = `ch-${username}`;
    const av = makeAvatarEl(username, 'avatar ch-av');
    const nm = document.createElement('span');
    nm.className = 'uname'; nm.style.fontSize = '13px'; nm.textContent = username;
    el.appendChild(av); el.appendChild(nm);
    $('channel-list').appendChild(el);
    $('channel-empty').style.display = 'none'; updateChannelCount();
  }

  if (!$(`pt-${username}`)) {
    const tile = document.createElement('div');
    tile.className = 'participant-tile'; tile.id = `pt-${username}`;
    const av   = makeAvatarEl(username, 'pt-avatar');
    const name = document.createElement('div'); name.className = 'pt-name'; name.textContent = username;
    const conn = document.createElement('div'); conn.className = 'pt-conn';

    const volWrap  = document.createElement('div'); volWrap.className = 'pt-volume-wrap';
    const volLabel = document.createElement('span'); volLabel.className = 'pt-volume-label'; volLabel.textContent = '🔊';
    const slider   = document.createElement('input');
    slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.className = 'pt-volume';
    slider.value = Math.round(Math.min(100, parseFloat(localStorage.getItem(`sv_vol_${username}`) ?? '1') * 100));
    slider.addEventListener('input', () => {
      const vol = slider.value / 100;
      localStorage.setItem(`sv_vol_${username}`, vol);
      // FIX #2: target all audio elements for this peer (mic + screen have different stream IDs)
      document.querySelectorAll(`audio[data-peer="${username}"]`).forEach(el => { el.volume = vol; });
    });
    volWrap.appendChild(volLabel); volWrap.appendChild(slider);
    tile.appendChild(av); tile.appendChild(name); tile.appendChild(conn); tile.appendChild(volWrap);
    $('participant-grid').appendChild(tile);
  }
}

function removeChannelMember(username) {
  $(`ch-${username}`)?.remove(); $(`pt-${username}`)?.remove();
  if (!$('channel-list').children.length) $('channel-empty').style.display = '';
  updateChannelCount();
}

function updateChannelCount() { $('channel-count').textContent = $('channel-list').children.length; }

// ── Call setup / teardown ──────────────────────────────────────────────────────

async function beginCall() {
  if (state.isInCall) return;
  const deviceId   = $('settings-mic')?.value || '';
  const constraint = deviceId ? { deviceId: { exact: deviceId } } : true;
  try {
    state.rawStream   = await navigator.mediaDevices.getUserMedia({ audio: constraint, video: false });
    state.localStream = await applyNoiseSuppression(state.rawStream);
    console.log('[call] rawStream tracks:', state.rawStream.getTracks().map(t => `${t.kind}:${t.enabled}`));
    console.log('[call] localStream is', state.localStream === state.rawStream ? 'raw (no noise suppression)' : 'noise-suppressed');
  } catch(err) {
    console.error('[call] getUserMedia failed:', err); setStatus('Нет доступа к микрофону'); throw err;
  }
  if (state.pttEnabled) setMuted(true);
  await loadAudioDevices();
  state.isInCall = true;
  localStorage.setItem('sv_in_channel', '1');
  $('voice-bar').style.display = ''; $('footer-mute-btn').style.display = '';
  setView('voice'); $('ch-voice-join').classList.add('active');
  setStatus('В канале'); addChannelMember(state.username);
  startVAD(state.username, state.rawStream);
}

function teardownCall() {
  state.rawStream?.getTracks().forEach(t => t.stop());
  state.localStream?.getTracks().forEach(t => t.stop());
  state.rawStream = null; state.localStream = null;
  destroyNoise();
  document.querySelectorAll('[id^="audio-"]').forEach(el => { el.srcObject = null; el.remove(); });
  state.isInCall = false; state.isMuted = false; state.isDeafened = false;
  $('voice-bar').style.display = 'none'; $('footer-mute-btn').style.display = 'none';
  updateMuteUI(); updateDeafenUI();
  stopScreenShare(); hideScreenView(); stopAllVAD();
  localStorage.removeItem('sv_in_channel');
  $('ch-voice-join').classList.remove('active'); removeChannelMember(state.username);
  setStatus('Подключено'); setView('server');
}

// ── Mute / Deafen ──────────────────────────────────────────────────────────────

function setMuted(muted) {
  state.isMuted = muted;
  state.rawStream?.getAudioTracks().forEach(t => { t.enabled = !muted; });
  updateMuteUI();
}

function updateMuteUI() {
  const muted = state.isMuted;
  $('mute-btn')?.classList.toggle('vc-muted', muted);
  if ($('mute-label')) $('mute-label').textContent = state.pttEnabled ? 'PTT' : 'Микрофон';
  const svg = $('mute-icon-svg');
  if (svg) svg.innerHTML = muted
    ? `<path d="M13 5V9l4.5 3L13 15v-4a5 5 0 01-8-4V5h5zM3 3L17 17l-1.4 1.4L1.6 4.4 3 3z"/><path d="M5 10a5 5 0 0010 0h2a7 7 0 01-6 6.9V19H9v-2.1A7 7 0 013 10H5z"/>`
    : `<path d="M10 2a3 3 0 00-3 3v5a3 3 0 006 0V5a3 3 0 00-3-3zm-5 8a5 5 0 0010 0h2a7 7 0 01-6 6.9V19H9v-2.1A7 7 0 013 10H5z"/>`;
  $('footer-mute-btn')?.classList.toggle('muted', muted);
}

function updateDeafenUI() {
  const d = state.isDeafened;
  $('deafen-btn')?.classList.toggle('vc-muted', d);
  const svg = $('deafen-icon-svg');
  if (svg) svg.innerHTML = d
    ? `<path d="M3 3L17 17l-1.4 1.4L3 4.4 3 3zm7-2a8 8 0 018 8h-2a6 6 0 00-9-5.2L5.6 2.4A7.9 7.9 0 0110 1zm0 19a7 7 0 01-7-7H1a9 9 0 0015.3 6.4l-1.5-1.5A7 7 0 0110 20z"/>`
    : `<path d="M10 1a8 8 0 018 8v2h-2V9a6 6 0 00-12 0v2H2V9a8 8 0 018-8zM3 13h2a5 5 0 0010 0h2a7 7 0 01-14 0z"/>`;
}

$('mute-btn').addEventListener('click', () => { if (!state.pttEnabled) setMuted(!state.isMuted); });

$('deafen-btn').addEventListener('click', () => {
  state.isDeafened = !state.isDeafened;
  document.querySelectorAll('[id^="audio-"]').forEach(el => { el.muted = state.isDeafened; });
  updateDeafenUI();
});

$('footer-mute-btn').addEventListener('click', () => {
  if (!state.isInCall || state.pttEnabled) return; setMuted(!state.isMuted);
});

// ── PTT ────────────────────────────────────────────────────────────────────────

let _capturingPTT = false;

document.addEventListener('keydown', e => {
  if (_capturingPTT) {
    e.preventDefault(); _capturingPTT = false;
    state.pttKey = e.code; localStorage.setItem('sv_ptt_key', e.code);
    const display = e.key === ' ' ? 'Space' : (e.key.length === 1 ? e.key.toUpperCase() : e.key);
    if ($('ptt-key-display')) $('ptt-key-display').textContent = display;
    $('ptt-key-capture').classList.remove('capturing');
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

window.electron?.onPTTToggle(() => {
  if (!state.pttEnabled || state.pttMode !== 'toggle' || !state.isInCall) return;
  setMuted(!state.isMuted);
});

window.electron?.onPTTRegResult(ok => { if (!ok) console.warn('[PTT] registration failed for:', state.pttKey); });

$('ptt-key-capture').addEventListener('click', () => {
  _capturingPTT = true;
  if ($('ptt-key-display')) $('ptt-key-display').textContent = 'Нажмите клавишу...';
  $('ptt-key-capture').classList.add('capturing');
});

// ── Audio devices ──────────────────────────────────────────────────────────────

async function loadAudioDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mic = $('settings-mic'), speaker = $('settings-speaker');
    const savedMic = mic?.value || '', savedSpk = speaker?.value || '';
    if (mic) {
      mic.innerHTML = '<option value="">Микрофон по умолчанию</option>';
      devices.filter(d => d.kind === 'audioinput').forEach(d => {
        const o = document.createElement('option');
        o.value = d.deviceId; o.textContent = d.label || `Микрофон (${d.deviceId.slice(0,8)})`; mic.appendChild(o);
      });
      if (savedMic) mic.value = savedMic;
    }
    if (speaker) {
      speaker.innerHTML = '<option value="">Динамик по умолчанию</option>';
      devices.filter(d => d.kind === 'audiooutput').forEach(d => {
        const o = document.createElement('option');
        o.value = d.deviceId; o.textContent = d.label || `Динамик (${d.deviceId.slice(0,8)})`; speaker.appendChild(o);
      });
      if (savedSpk) speaker.value = savedSpk;
      else if (state.outputDevice) speaker.value = state.outputDevice;
    }
  } catch(e) { console.warn('[devices]', e); }
}

async function switchMicrophone(deviceId) {
  if (!state.isInCall) return;
  try {
    const constraint = deviceId ? { deviceId: { exact: deviceId } } : true;
    const newRaw = await navigator.mediaDevices.getUserMedia({ audio: constraint, video: false });
    state.rawStream?.getTracks().forEach(t => t.stop());
    state.localStream?.getTracks().forEach(t => t.stop());
    destroyNoise();
    const newProcessed = await applyNoiseSuppression(newRaw);
    // FIX #1 cont.: send the processed (noise-suppressed) track
    const newTrack = (newProcessed || newRaw).getAudioTracks()[0];
    if (newTrack) newTrack.enabled = !state.isMuted;
    for (const pc of state.peers.values()) {
      const sender = pc.getSenders().find(s => s.track?.kind === 'audio');
      if (sender) await sender.replaceTrack(newTrack);
    }
    state.rawStream = newRaw; state.localStream = newProcessed;
    startVAD(state.username, newRaw);
  } catch(err) { setStatus('Не удалось переключить микрофон'); console.error(err); }
}

async function applyOutputDevice(deviceId) {
  state.outputDevice = deviceId; localStorage.setItem('sv_output_device', deviceId);
  document.querySelectorAll('[id^="audio-"]').forEach(el => { if (el.setSinkId) el.setSinkId(deviceId).catch(() => {}); });
}

$('settings-mic').addEventListener('change', () => {
  const v = $('settings-mic').value; localStorage.setItem('sv_mic_device', v); switchMicrophone(v);
});
$('settings-speaker').addEventListener('change', () => applyOutputDevice($('settings-speaker').value));
$('settings-devices-refresh').addEventListener('click', loadAudioDevices);

// ── Ping stats ─────────────────────────────────────────────────────────────────

setInterval(async () => {
  for (const [peerName, pc] of state.peers) {
    let ms = null;
    try {
      const stats = await pc.getStats();
      for (const r of stats.values())
        if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.currentRoundTripTime != null)
          { ms = Math.round(r.currentRoundTripTime * 1000); break; }
    } catch {}
    if (ms === null) continue;
    const tile = $(`pt-${peerName}`); if (!tile) continue;
    const conn = tile.querySelector('.pt-conn'); if (!conn) continue;
    conn.textContent = `${ms}ms`;
    conn.className   = `pt-conn peer-ping ${ms < 80 ? 'ping-good' : ms < 200 ? 'ping-ok' : 'ping-bad'}`;
  }
}, 2000);

// ── Screen share ───────────────────────────────────────────────────────────────

const RESOLUTIONS = {
  '720p30':  { width: 1280, height: 720,  frameRate: 30 },
  '1080p30': { width: 1920, height: 1080, frameRate: 30 },
  '1080p60': { width: 1920, height: 1080, frameRate: 60 },
  '1440p30': { width: 2560, height: 1440, frameRate: 30 },
};

let _screenStream  = null;
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
  const grid = $('source-grid'); grid.innerHTML = '';
  const filtered = _allSources.filter(s => tab === 'screen' ? s.id.startsWith('screen:') : !s.id.startsWith('screen:'));
  filtered.forEach((src, i) => {
    const el = document.createElement('div');
    el.className = 'source-item'; el.dataset.id = src.id;
    el.innerHTML = `<img class="source-thumb" src="${src.thumbnail}" alt=""><span class="source-name">${escHtml(src.name)}</span>`;
    el.addEventListener('click', () => {
      grid.querySelectorAll('.source-item').forEach(e => e.classList.remove('selected'));
      el.classList.add('selected'); $('picker-confirm').disabled = false;
    });
    grid.appendChild(el);
    if (i === 0) { el.classList.add('selected'); $('picker-confirm').disabled = false; }
  });
}

document.querySelectorAll('.picker-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.picker-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active'); renderPickerSources(tab.dataset.tab); $('picker-confirm').disabled = true;
  });
});

$('picker-confirm').addEventListener('click', () => {
  const sel = $('source-grid').querySelector('.source-item.selected');
  $('source-picker').style.display = 'none';
  _pickerResolve?.({ sourceId: sel?.dataset.id, resolution: $('picker-res').value });
  _pickerResolve = null;
});

$('picker-cancel').addEventListener('click', () => {
  $('source-picker').style.display = 'none'; _pickerResolve?.(null); _pickerResolve = null;
});

async function startScreenShare() {
  if (!state.isInCall) return;
  const sources = await window.electron.getSources(['screen', 'window']);
  const chosen  = await showSourcePicker(sources);
  if (!chosen?.sourceId) return;
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
    // Use localStream (processed) track id — that's what was actually added in openPeer
    const micTrackId = (state.localStream || state.rawStream)?.getAudioTracks()[0]?.id;

    for (const pc of state.peers.values()) {
      const vs = pc.getSenders().find(s => s.track?.kind === 'video');
      if (vs) await vs.replaceTrack(videoTrack); else pc.addTrack(videoTrack, stream);
      if (audioTrack) {
        const hasScreenAudio = pc.getSenders().some(s => s.track?.kind === 'audio' && s.track?.id !== micTrackId);
        if (!hasScreenAudio) pc.addTrack(audioTrack, stream);
      }
    }

    if (_screenStream) _screenStream.getTracks().forEach(t => t.stop());
    _screenStream = stream;

    // Register own screen in the registry
    _peerScreenStreams.set(state.username, { stream, label: 'Ваш экран' });
    showScreenViewFor(state.username, stream, 'Ваш экран');

    $('screen-btn').classList.add('vc-streaming');
    $('screen-label-btn').textContent = resKey;
    videoTrack.onended = stopScreenShare;
  } catch(err) { console.error('[screen]', err); }
}

function stopScreenShare() {
  if (_screenStream) { _screenStream.getTracks().forEach(t => t.stop()); _screenStream = null; }
  $('screen-btn').classList.remove('vc-streaming');
  $('screen-label-btn').textContent = 'Стрим';

  _peerScreenStreams.delete(state.username);
  if (_activeScreenPeer === state.username) {
    const next = [..._peerScreenStreams.entries()][0];
    if (next) showScreenViewFor(next[0], next[1].stream, next[1].label);
    else hideScreenView();
  }
  updateScreenThumbs();
}

$('screen-btn').addEventListener('click', async () => {
  if (!state.isInCall) return;
  if ($('screen-btn').classList.contains('vc-streaming')) stopScreenShare();
  else await startScreenShare();
});

// ── Screen view ────────────────────────────────────────────────────────────────

function showScreenViewFor(peerKey, stream, label) {
  _activeScreenPeer = peerKey;
  const sv = $('screen-view');
  sv.style.display = 'flex'; sv.classList.remove('minimized');
  $('screen-restore-btn').style.display = 'none';
  $('screen-view-label').textContent = `🖥️ ${label}`;
  const v = $('screen-video'); v.srcObject = stream; v.play().catch(() => {});
  // Show screen volume slider only for peers (not own share — no loopback)
  const volWrap = $('screen-vol-wrap');
  if (volWrap) volWrap.style.display = peerKey === state.username ? 'none' : 'flex';
  updateScreenVolumeSlider();
  updateScreenThumbs();
}

// FIX #5: clear last frame with v.load()
function hideScreenView() {
  $('screen-view').style.display = 'none';
  $('screen-restore-btn').style.display = 'none';
  const v = $('screen-video'); v.pause(); v.srcObject = null; v.load();
  _activeScreenPeer = null;
  updateScreenThumbs();
}

// FIX #4: minimize — hide video area, show restore button
$('screen-minimize-btn')?.addEventListener('click', () => {
  $('screen-view').style.display = 'none';
  $('screen-restore-btn').style.display = '';
});

$('screen-restore-btn')?.addEventListener('click', () => {
  if (!_activeScreenPeer) return;
  const info = _peerScreenStreams.get(_activeScreenPeer); if (!info) return;
  showScreenViewFor(_activeScreenPeer, info.stream, info.label);
});

$('screen-fullscreen-btn').addEventListener('click', () => {
  const v = $('screen-video');
  (v.requestFullscreen || v.webkitRequestFullscreen)?.call(v);
});

// FIX #3: screen volume slider
$('screen-vol-slider')?.addEventListener('input', () => {
  if (!_activeScreenPeer || _activeScreenPeer === state.username) return;
  const info = _peerScreenStreams.get(_activeScreenPeer); if (!info) return;
  const sid = info.stream.id.slice(0, 8);
  const el  = document.getElementById(`audio-${_activeScreenPeer}-${sid}`);
  if (el) el.volume = $('screen-vol-slider').value / 100;
});

function updateScreenVolumeSlider() {
  const slider = $('screen-vol-slider'); if (!slider) return;
  if (!_activeScreenPeer || _activeScreenPeer === state.username) return;
  const info = _peerScreenStreams.get(_activeScreenPeer); if (!info) return;
  const sid  = info.stream.id.slice(0, 8);
  const el   = document.getElementById(`audio-${_activeScreenPeer}-${sid}`);
  slider.value = el ? Math.round(el.volume * 100) : 100;
}

// FIX #4: thumbnail bar for multiple streams
function updateScreenThumbs() {
  const bar = $('screen-thumbs'); if (!bar) return;
  bar.innerHTML = '';
  if (_peerScreenStreams.size <= 1) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  for (const [key, { label }] of _peerScreenStreams) {
    const el = document.createElement('div');
    el.className = 'screen-thumb' + (key === _activeScreenPeer ? ' active' : '');
    el.textContent = label;
    el.addEventListener('click', () => {
      const info = _peerScreenStreams.get(key); if (info) showScreenViewFor(key, info.stream, info.label);
    });
    bar.appendChild(el);
  }
}

// ── User list ──────────────────────────────────────────────────────────────────

function renderUsers(users) {
  $('user-list').innerHTML = ''; $('friends-list').innerHTML = '';
  updateEmptyHint(); users.forEach(addUser); updateOnlineCount();
}

function addUser(username) {
  if ($(`user-${username}`)) return;
  const el = document.createElement('div');
  el.className = 'user-item'; el.id = `user-${username}`;
  el.appendChild(makeAvatarEl(username));
  const nm = document.createElement('span'); nm.className = 'uname'; nm.textContent = username;
  el.appendChild(nm); $('user-list').appendChild(el);

  const card = document.createElement('div'); card.className = 'friend-card'; card.id = `fc-${username}`;
  card.innerHTML = `<div class="fc-info"><div class="fc-name">${escHtml(username)}</div><div class="fc-status"><span class="status-dot online"></span>В сети</div></div>`;
  card.insertBefore(makeAvatarEl(username, 'avatar lg'), card.firstChild);
  $('friends-list').appendChild(card);
  updateEmptyHint(); updateOnlineCount();
}

function removeUser(username) {
  $(`user-${username}`)?.remove(); $(`fc-${username}`)?.remove();
  updateEmptyHint(); updateOnlineCount();
}

function updateEmptyHint() {
  const count = $('user-list').querySelectorAll('.user-item').length;
  const h = $('empty-hint'); if (h) h.style.display = count ? 'none' : '';
  const h2 = $('home-empty'); if (h2) h2.style.display = count ? 'none' : '';
}

function updateOnlineCount() {
  const count = $('user-list').querySelectorAll('.user-item').length;
  const a = $('online-count'); if (a) a.textContent = count;
  const b = $('home-online-count'); if (b) b.textContent = count;
}

// ── Navigation ─────────────────────────────────────────────────────────────────

$('btn-home').addEventListener('click', () => setView('home'));
$('btn-chat').addEventListener('click', () => setView('chat'));
$('btn-server').addEventListener('click', () => setView(state.isInCall ? 'voice' : 'server'));
$('ch-voice-join').addEventListener('click', () => { if (!state.isInCall) joinChannel(); });
$('ch-text-general').addEventListener('click', () => setView('chat'));
$('end-btn').addEventListener('click', leaveChannel);

$('chat-toggle-btn').addEventListener('click', () => {
  const panel = $('chat-panel'), open = panel.style.display === 'none';
  panel.style.display = open ? '' : 'none';
  $('chat-toggle-btn').classList.toggle('active', open);
});

$('chat-panel-close').addEventListener('click', () => {
  $('chat-panel').style.display = 'none'; $('chat-toggle-btn').classList.remove('active');
});

// ── Settings ───────────────────────────────────────────────────────────────────

function openSettings()  { $('settings-overlay').style.display = 'flex'; loadAudioDevices(); loadSettingsIntoUI(); }
function closeSettings() { $('settings-overlay').style.display = 'none'; }

$('btn-settings').addEventListener('click', openSettings);
$('settings-close-btn').addEventListener('click', closeSettings);
document.addEventListener('keydown', e => {
  if (_capturingPTT) return;
  if (e.key === 'Escape' && $('settings-overlay').style.display !== 'none') closeSettings();
});

document.querySelectorAll('.settings-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.settings-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    ['voice','ptt','profile','notifs'].forEach(id => {
      const pane = $(`stab-${id}`); if (pane) pane.style.display = id === tab ? '' : 'none';
    });
    if (tab === 'profile') refreshSettingsAvatar();
  });
});

function loadSettingsFromStorage() {
  state.noiseEnabled  = localStorage.getItem('sv_noise')         !== 'false';
  state.pttEnabled    = localStorage.getItem('sv_ptt')           === 'true';
  state.pttMode       = localStorage.getItem('sv_ptt_mode')      || 'hold';
  state.pttKey        = localStorage.getItem('sv_ptt_key')       || 'CapsLock';
  state.outputDevice  = localStorage.getItem('sv_output_device') || '';
  state.soundsEnabled = localStorage.getItem('sv_sounds')        !== 'false';
  if (state.pttEnabled && state.pttMode === 'toggle') {
    window.electron?.pttRegister(state.pttKey); window.electron?.pttSetEnabled(true);
  }
}

function loadSettingsIntoUI() {
  const noiseEl = $('settings-noise'), pttEl = $('settings-ptt-enabled'), soundsEl = $('settings-sounds');
  if (noiseEl)  noiseEl.checked  = state.noiseEnabled;
  if (pttEl)    pttEl.checked    = state.pttEnabled;
  if (soundsEl) soundsEl.checked = state.soundsEnabled;
  if ($('ptt-key-display')) $('ptt-key-display').textContent = state.pttKey;
  const modeEl = state.pttMode === 'toggle' ? $('ptt-mode-toggle') : $('ptt-mode-hold');
  if (modeEl) modeEl.checked = true;
  $('ptt-settings-body').style.display = state.pttEnabled ? '' : 'none';
  const savedMic = localStorage.getItem('sv_mic_device'), savedSpk = localStorage.getItem('sv_output_device');
  if (savedMic && $('settings-mic'))     $('settings-mic').value     = savedMic;
  if (savedSpk && $('settings-speaker')) $('settings-speaker').value = savedSpk;
}

$('settings-noise').addEventListener('change', async () => {
  state.noiseEnabled = $('settings-noise').checked;
  localStorage.setItem('sv_noise', state.noiseEnabled);
  if (state.isInCall) await switchMicrophone($('settings-mic')?.value || '');
});

$('settings-ptt-enabled').addEventListener('change', () => {
  state.pttEnabled = $('settings-ptt-enabled').checked;
  localStorage.setItem('sv_ptt', state.pttEnabled);
  $('ptt-settings-body').style.display = state.pttEnabled ? '' : 'none';
  window.electron?.pttSetEnabled(state.pttEnabled);
  if (state.pttEnabled && state.pttMode === 'toggle') window.electron?.pttRegister(state.pttKey);
  else if (!state.pttEnabled) { window.electron?.pttUnregister(); if (state.isMuted && state.isInCall) setMuted(false); }
  updateMuteUI();
});

document.querySelectorAll('input[name="ptt-mode"]').forEach(radio => {
  radio.addEventListener('change', () => {
    if (!radio.checked) return;
    state.pttMode = radio.value; localStorage.setItem('sv_ptt_mode', state.pttMode);
    if (state.pttEnabled) {
      if (state.pttMode === 'toggle') window.electron?.pttRegister(state.pttKey);
      else window.electron?.pttUnregister();
    }
  });
});

$('settings-sounds').addEventListener('change', () => {
  state.soundsEnabled = $('settings-sounds').checked;
  localStorage.setItem('sv_sounds', state.soundsEnabled);
});

// ── Avatar upload ──────────────────────────────────────────────────────────────

function refreshSettingsAvatar() {
  const el = $('settings-avatar-el'); if (el && state.username) refreshAvatar(el, state.username);
}

$('avatar-upload-btn').addEventListener('click', () => $('avatar-file-input').click());

$('avatar-file-input').addEventListener('change', async () => {
  const file = $('avatar-file-input').files?.[0]; if (!file) return;
  const statusEl = $('avatar-status');
  statusEl.style.display = ''; statusEl.style.color = 'var(--dim)'; statusEl.textContent = 'Загрузка...';
  try {
    await uploadAvatar(file);
    statusEl.style.color = 'var(--green)'; statusEl.textContent = '✓ Аватар обновлён';
    refreshSettingsAvatar();
    refreshAvatar($('self-avatar'), state.username);
    refreshAvatar($('vbar-avatar'), state.username);
    const ptav = $(`pt-${state.username}`)?.querySelector('.pt-avatar');
    if (ptav) refreshAvatar(ptav, state.username);
  } catch(err) { statusEl.style.color = 'var(--red)'; statusEl.textContent = `Ошибка: ${err.message}`; }
  $('avatar-file-input').value = '';
});

async function uploadAvatar(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async e => {
      try {
        const res  = await fetch(`${SERVER}/avatar`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: state.token, data: e.target.result }),
        });
        const json = await res.json();
        if (json.success) resolve(); else reject(new Error(json.message || 'Ошибка сервера'));
      } catch(err) { reject(err); }
    };
    reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
    reader.readAsDataURL(file);
  });
}
