'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- accounts ----------
const USERS = {
  GF091007: { password: 'piyush0907', name: 'Fancy 💗' },
  BF030609: { password: 'fancy0306',  name: 'Piyush 💙' }
};
const partnerOf = (u) => (u === 'GF091007' ? 'BF030609' : 'GF091007');

// ---------- state ----------
const sessions = new Map();      // token -> username
const online   = new Map();      // username -> socket.id
const messages = [];             // all live messages (until seenAt+1h)

// every seen message is deleted 1 hour after being seen
function scheduleDelete(id, at) {
  const delay = Math.max(0, at - Date.now());
  setTimeout(() => {
    const i = messages.findIndex((m) => m.id === id);
    if (i !== -1) messages.splice(i, 1);
  }, delay);
}

// ---------- express ----------
const app = express();
app.use(express.json({ limit: '1mb' }));

function authFrom(req) {
  const token = req.headers['x-auth-token'] || (req.body && req.body.token);
  return token && sessions.get(token) ? { token, username: sessions.get(token) } : null;
}

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = USERS[username];
  if (!u || u.password !== password) {
    return res.status(401).json({ error: 'Wrong ID or password 💔' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, username);
  const partner = partnerOf(username);
  res.json({
    token,
    username,
    displayName: u.name,
    partner,
    partnerName: USERS[partner].name
  });
});

app.post('/api/logout', (req, res) => {
  const token = (req.body && req.body.token) || req.headers['x-auth-token'];
  if (token) sessions.delete(token);
  res.json({ ok: true });
});

// ---------- uploads ----------
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = (path.extname(file.originalname) || '').slice(0, 12);
    cb(null, Date.now() + '-' + crypto.randomBytes(6).toString('hex') + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 60 * 1024 * 1024 } });

app.post('/api/upload', (req, res, next) => {
  if (!authFrom(req)) return res.status(401).json({ error: 'Not logged in' });
  next();
}, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({
    url: '/uploads/' + req.file.filename,
    name: req.file.originalname,
    mime: req.file.mimetype,
    size: req.file.size
  });
});

// ---------- download route (forces browser download) ----------
app.get('/api/download/:file', (req, res) => {
  const file = path.basename(req.params.file);
  const full = path.join(UPLOAD_DIR, file);
  if (!full.startsWith(UPLOAD_DIR) || !fs.existsSync(full)) {
    return res.status(404).send('Not found');
  }
  const niceName = req.query.name ? String(req.query.name) : file;
  res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(niceName) + '"');
  res.setHeader('Content-Type', 'application/octet-stream');
  fs.createReadStream(full).pipe(res);
});

app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '1h' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- socket.io ----------
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e7,
  pingInterval: 15000,
  pingTimeout: 20000,
  transports: ['websocket', 'polling']
});

io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  const username = token && sessions.get(token);
  if (!username) return next(new Error('unauthorized'));
  socket.username = username;
  next();
});

function emitTo(username, event, data) {
  const sid = online.get(username);
  if (sid) io.to(sid).emit(event, data);
}

io.on('connection', (socket) => {
  const me = socket.username;
  const partner = partnerOf(me);
  online.set(me, socket.id);

  // send pending (not yet seen) messages instantly
  socket.emit('messages:pending', messages.filter((m) => m.to === me && !m.seenAt));

  emitTo(partner, 'presence', { user: me, online: true });
  socket.emit('presence', { user: partner, online: online.has(partner) });

  // ---------- chat ----------
  socket.on('message:send', (payload, ack) => {
    const msg = {
      id: crypto.randomUUID(),
      from: me,
      to: partner,
      type: payload.type || 'text',
      text: String(payload.text || '').slice(0, 4000),
      url: payload.url || '',
      name: payload.name || '',
      mime: payload.mime || '',
      size: payload.size || 0,
      createdAt: Date.now(),
      seenAt: 0
    };
    messages.push(msg);
    emitTo(partner, 'message:new', msg);
    if (typeof ack === 'function') ack({ ok: true, message: msg });
  });

  // receiver says: I've seen these ids → set seenAt, tell sender, schedule delete
  socket.on('message:seen', ({ ids }) => {
    if (!Array.isArray(ids)) return;
    const now = Date.now();
    const seen = [];
    for (const id of ids) {
      const m = messages.find((x) => x.id === id && x.to === me && !x.seenAt);
      if (m) {
        m.seenAt = now;
        seen.push(id);
        scheduleDelete(id, now + 60 * 60 * 1000); // 1 hour
      }
    }
    if (seen.length) emitTo(partner, 'message:seen', { ids: seen, by: me });
  });

  socket.on('typing', (isTyping) => emitTo(partner, 'typing', { from: me, typing: !!isTyping }));

  // ---------- calls ----------
  socket.on('call:invite', (data) => {
    if (!online.has(partner)) return socket.emit('call:unavailable');
    emitTo(partner, 'call:incoming', { from: me, kind: data.kind, sdp: data.sdp });
  });
  socket.on('call:accept', (data) => emitTo(partner, 'call:accepted', { sdp: data.sdp }));
  socket.on('call:reject', () => emitTo(partner, 'call:rejected'));
  socket.on('call:end',    () => emitTo(partner, 'call:ended'));
  socket.on('webrtc:ice',  (data) => emitTo(partner, 'webrtc:ice', data));

  socket.on('disconnect', () => {
    if (online.get(me) === socket.id) {
      online.delete(me);
      emitTo(partner, 'presence', { user: me, online: false });
      emitTo(partner, 'call:ended');
    }
  });
});

server.listen(PORT, () => {
  console.log(`💕 Our Little World running → http://localhost:${PORT}`);
});
