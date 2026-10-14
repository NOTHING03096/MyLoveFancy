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

const USERS = {
  GF091007: { password: 'piyush0907', name: 'Fancy 💗' },
  BF030609: { password: 'fancy0306',  name: 'Piyush 💙' }
};
const partnerOf = (u) => (u === 'GF091007' ? 'BF030609' : 'GF091007');

const sessions = new Map();
const online   = new Map();
const messages = [];

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

app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e7 });

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

  socket.emit('messages:pending', messages.filter((m) => m.to === me));

  emitTo(partner, 'presence', { user: me, online: true });
  socket.emit('presence', { user: partner, online: online.has(partner) });

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
      createdAt: Date.now()
    };
    messages.push(msg);
    emitTo(partner, 'message:new', msg);
    if (typeof ack === 'function') ack({ ok: true, message: msg });
  });

  socket.on('message:seen', ({ ids }) => {
    if (!Array.isArray(ids)) return;
    const seen = [];
    for (const id of ids) {
      const i = messages.findIndex((m) => m.id === id && m.to === me);
      if (i !== -1) { messages.splice(i, 1); seen.push(id); }
    }
    if (seen.length) emitTo(partner, 'message:seen', { ids: seen, by: me });
  });

  socket.on('typing', (isTyping) => emitTo(partner, 'typing', { from: me, typing: !!isTyping }));

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
