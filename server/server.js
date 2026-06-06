'use strict';

const http      = require('http');
const fs        = require('fs');
const path      = require('path');
const WebSocket = require('ws');
const crypto    = require('crypto');

const DATA_DIR      = '/app/data';
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const AVATARS_DIR   = path.join(DATA_DIR, 'avatars');

const PORT          = process.env.PORT || 3000;
const COTURN_SECRET = process.env.COTURN_SECRET || '';
const TURN_HOST     = process.env.TURN_HOST || 'squadvox.ru';

const users = [];
for (let i = 1; i <= 10; i++) {
  const login = process.env[`USER_${i}_LOGIN`];
  const hash  = process.env[`USER_${i}_PASSWORD_HASH`];
  if (login && hash) users.push({ login, hash });
}
if (!users.length) console.warn('[WARN] No users configured');

const sessions    = new Map();
const clients     = new Map();
const channel     = new Set();
const chatHistory = []; // last 100 global messages

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

function makeTurnCreds(username) {
  const expiry = Math.floor(Date.now() / 1000) + 86400;
  const user   = `${expiry}:${username}`;
  const cred   = crypto.createHmac('sha1', COTURN_SECRET).update(user).digest('base64');
  return { username: user, credential: cred };
}

function saveSessions() {
  try {
    fs.mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true });
    const obj = {};
    for (const [t, s] of sessions) obj[t] = s;
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(obj));
  } catch(e) { console.warn('[sessions] save failed:', e.message); }
}

function loadSessions() {
  try {
    const obj = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    const now = Date.now();
    for (const [t, s] of Object.entries(obj)) {
      if (s.expires > now) sessions.set(t, s);
    }
    console.log(`[sessions] restored ${sessions.size}`);
  } catch {}
}

loadSessions();
setInterval(() => {
  const now = Date.now();
  for (const [t, s] of sessions) if (s.expires < now) sessions.delete(t);
  saveSessions();
}, 3_600_000);

const AVATAR_EXTS     = ['png', 'jpg', 'gif', 'webp', 'avif'];
const AVATAR_MIMES    = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif' };
const AVATAR_MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif' };

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }

  // ── POST /auth ────────────────────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/auth') {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 1024) req.destroy(); });
    req.on('end', () => {
      try {
        const { login, password } = JSON.parse(body);
        if (!login || !password) throw new Error('missing fields');
        const user = users.find(u => u.login === login && u.hash === sha256(String(password)));
        if (!user) {
          res.writeHead(401, { 'Content-Type': 'application/json', ...CORS });
          return res.end(JSON.stringify({ success: false, message: 'Invalid credentials' }));
        }
        const token = crypto.randomBytes(32).toString('hex');
        sessions.set(token, { username: login, expires: Date.now() + 30 * 86_400_000 });
        saveSessions();
        const turnCreds = COTURN_SECRET ? makeTurnCreds(login) : null;
        res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify({ success: true, token, username: login, turnCreds, turnHost: TURN_HOST }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify({ success: false }));
      }
    });
    return;
  }

  // ── POST /avatar (upload) ─────────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/avatar') {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 6_000_000) { req.destroy(); return; } });
    req.on('end', () => {
      try {
        const { token, data } = JSON.parse(body);
        const session = sessions.get(token);
        if (!session || session.expires < Date.now()) {
          res.writeHead(401, { 'Content-Type': 'application/json', ...CORS });
          return res.end(JSON.stringify({ success: false, message: 'Unauthorized' }));
        }
        const m = data?.match(/^data:(image\/(?:png|jpeg|gif|webp|avif));base64,(.+)$/s);
        if (!m) {
          res.writeHead(400, { 'Content-Type': 'application/json', ...CORS });
          return res.end(JSON.stringify({ success: false, message: 'Invalid image data' }));
        }
        const ext = AVATAR_MIME_EXT[m[1]] || 'png';
        const buf = Buffer.from(m[2], 'base64');
        if (buf.length > 4 * 1024 * 1024) {
          res.writeHead(400, { 'Content-Type': 'application/json', ...CORS });
          return res.end(JSON.stringify({ success: false, message: 'Image too large (max 4 MB)' }));
        }
        fs.mkdirSync(AVATARS_DIR, { recursive: true });
        for (const e of AVATAR_EXTS) {
          try { fs.unlinkSync(path.join(AVATARS_DIR, `${session.username}.${e}`)); } catch {}
        }
        fs.writeFileSync(path.join(AVATARS_DIR, `${session.username}.${ext}`), buf);
        res.writeHead(200, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify({ success: true }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json', ...CORS });
        res.end(JSON.stringify({ success: false }));
      }
    });
    return;
  }

  // ── GET /avatar/:username ─────────────────────────────────────────────────
  if (req.method === 'GET' && req.url.startsWith('/avatar/')) {
    const raw      = req.url.slice('/avatar/'.length).split('?')[0];
    const username = decodeURIComponent(raw).replace(/[^a-zA-Z0-9_.-]/g, '');
    if (!username) { res.writeHead(400, CORS); res.end(); return; }
    for (const ext of AVATAR_EXTS) {
      const fp = path.join(AVATARS_DIR, `${username}.${ext}`);
      if (fs.existsSync(fp)) {
        const data = fs.readFileSync(fp);
        res.writeHead(200, { 'Content-Type': AVATAR_MIMES[ext], 'Cache-Control': 'public, max-age=300', ...CORS });
        return res.end(data);
      }
    }
    res.writeHead(404, CORS); res.end();
    return;
  }

  res.writeHead(404); res.end();
});

const wss = new WebSocket.Server({ server });

function sendTo(uname, msg) {
  const ws = clients.get(uname);
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(msg, exclude = null) {
  const data = JSON.stringify(msg);
  for (const [u, ws] of clients) {
    if (u !== exclude && ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

function broadcastToChannel(msg, exclude = null) {
  for (const u of channel) if (u !== exclude) sendTo(u, msg);
}

wss.on('connection', ws => {
  let username = null;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── Auth ──────────────────────────────────────────────────────────────
    if (msg.type === 'auth') {
      const session = sessions.get(msg.token);
      if (!session || session.expires < Date.now()) {
        ws.send(JSON.stringify({ type: 'auth_error' })); ws.close(); return;
      }
      username = session.username;
      // Kick existing connection for the same username (e.g. same account on two devices)
      if (clients.has(username)) {
        const oldWs = clients.get(username);
        if (oldWs !== ws && oldWs.readyState === WebSocket.OPEN) {
          try { oldWs.send(JSON.stringify({ type: 'kicked', reason: 'другое устройство' })); } catch {}
          try { oldWs.close(); } catch {}
        }
      }
      clients.set(username, ws);
      ws.send(JSON.stringify({ type: 'auth_ok', username }));
      ws.send(JSON.stringify({ type: 'chat-history', messages: chatHistory }));
      broadcast({ type: 'user_joined', username }, username);
      ws.send(JSON.stringify({
        type: 'user_list',
        users:   [...clients.keys()].filter(u => u !== username),
        channel: [...channel],
      }));
      console.log(`[+] ${username} connected (${clients.size} online)`);
      return;
    }

    if (!username) { ws.close(); return; }

    // ── Voice channel ─────────────────────────────────────────────────────
    if (msg.type === 'join-channel') {
      if (channel.has(username)) return;
      ws.send(JSON.stringify({ type: 'channel-members', users: [...channel] }));
      channel.add(username);
      broadcast({ type: 'channel-joined', username }, username); // exclude self
      console.log(`[🔊] ${username} joined channel (${channel.size})`);
      return;
    }

    if (msg.type === 'leave-channel') {
      channel.delete(username);
      broadcast({ type: 'channel-left', username });
      console.log(`[🔇] ${username} left channel (${channel.size})`);
      return;
    }

    if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }

    // ── Global chat ───────────────────────────────────────────────────────
    if (msg.type === 'chat-message' && typeof msg.text === 'string' && msg.text.trim()) {
      const text  = msg.text.trim().slice(0, 500);
      const entry = { from: username, text, ts: Date.now() };
      chatHistory.push(entry);
      if (chatHistory.length > 100) chatHistory.shift();
      broadcast({ type: 'chat-message', ...entry }, username);
      return;
    }

    // ── Relay signaling ───────────────────────────────────────────────────
    if (msg.to && clients.has(msg.to)) {
      const target = clients.get(msg.to);
      if (target.readyState === WebSocket.OPEN) {
        target.send(JSON.stringify({ ...msg, from: username }));
      }
    }
  });

  ws.on('close', () => {
    if (username) {
      clients.delete(username);
      if (channel.has(username)) {
        channel.delete(username);
        broadcast({ type: 'channel-left', username });
      }
      broadcast({ type: 'user_left', username });
      console.log(`[-] ${username} disconnected (${clients.size} online)`);
    }
  });
});

server.listen(PORT, () => console.log(`SquadVox server :${PORT}`));
