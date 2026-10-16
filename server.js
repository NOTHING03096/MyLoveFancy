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
const pinned   = [];             // { id, text, type, from, at }
const scheduled = [];            // { id, from, to, payload, at, timer }
const dailySent  = { GF091007: '', BF030609: '' };

const stats = {
  GF091007: { messages: 0, photos: 0, videos: 0, calls: 0, notes: 0 },
  BF030609: { messages: 0, photos: 0, videos: 0, calls: 0, notes: 0 }
};

function scheduleDelete(id, at) {
  const delay = Math.max(0, at - Date.now());
  setTimeout(() => {
    const i = messages.findIndex((m) => m.id === id);
    if (i !== -1) messages.splice(i, 1);
  }, delay);
}

const app = express();
app.use(express.json({ limit: '1mb' }));

function authFrom(req) {
  const token = req.headers['x-auth-token'] || (req.body && req.body.token);
  return token && sessions.get(token) ? { token, username: sessions.get(token) } : null;
}

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = USERS[username];
  if (!u || u.password !== password) return res.status(401).json({ error: 'Wrong ID or password 💔' });
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, username);
  const partner = partnerOf(username);
  res.json({
    token, username, displayName: u.name, partner, partnerName: USERS[partner].name,
    stats: stats[username]
  });
});

app.post('/api/logout', (req, res) => {
  const token = (req.body && req.body.token) || req.headers['x-auth-token'];
  if (token) sessions.delete(token);
  res.json({ ok: true });
});

app.get('/api/stats', (req, res) => {
  const a = authFrom(req);
  if (!a) return res.status(401).json({ error: 'Not logged in' });
  const me = a.username, p = partnerOf(me);
  res.json({
    me: stats[me], partner: stats[p],
    total: {
      messages: stats[me].messages + stats[p].messages,
      photos:   stats[me].photos   + stats[p].photos,
      videos:   stats[me].videos   + stats[p].videos,
      calls:    stats[me].calls    + stats[p].calls,
      notes:    stats[me].notes    + stats[p].notes
    }
  });
});

app.get('/api/pins', (req, res) => {
  const a = authFrom(req);
  if (!a) return res.status(401).json({ error: 'Not logged in' });
  res.json(pinned);
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

app.get('/api/download/:file', (req, res) => {
  const file = path.basename(req.params.file);
  const full = path.join(UPLOAD_DIR, file);
  if (!full.startsWith(UPLOAD_DIR) || !fs.existsSync(full)) return res.status(404).send('Not found');
  const niceName = req.query.name ? String(req.query.name) : file;
  res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(niceName) + '"');
  res.setHeader('Content-Type', 'application/octet-stream');
  fs.createReadStream(full).pipe(res);
});

app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '1h' }));
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e7,
  pingInterval: 15000, pingTimeout: 20000,
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

// daily quote
const DAILY_QUOTES = [
  "You are my favorite hello and my hardest goodbye 💗",
  "Every day with you feels like a warm hug ☕",
  "You make ordinary moments extraordinary ✨",
  "In your smile, I see something more beautiful than stars 🌟",
  "Loving you is my favorite thing to do ❤️",
  "You + Me = Forever 💞",
  "You're the reason my heart keeps smiling 😊"
];
function dailyQuote() {
  const day = new Date().toDateString();
  const i = day.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % DAILY_QUOTES.length;
  return DAILY_QUOTES[i];
}

// process scheduled messages
setInterval(() => {
  const now = Date.now();
  for (let i = scheduled.length - 1; i >= 0; i--) {
    const s = scheduled[i];
    if (s.at <= now) {
      const msg = {
        id: crypto.randomUUID(),
        from: s.from, to: s.to,
        type: s.payload.type || 'text',
        text: s.payload.text || '',
        caption: s.payload.caption || '',
        url: s.payload.url || '', name: s.payload.name || '',
        mime: s.payload.mime || '', size: s.payload.size || 0,
        link: s.payload.link || '',
        ttl: s.payload.ttl || '1h',
        replyTo: s.payload.replyTo || null,
        reactions: {},
        createdAt: Date.now(), seenAt: 0
      };
      messages.push(msg);
      if (msg.type === 'text') stats[s.from].messages++;
      else if (msg.type === 'image') stats[s.from].photos++;
      else if (msg.type === 'video') stats[s.from].videos++;
      emitTo(s.to, 'message:new', msg);
      emitTo(s.from, 'message:scheduledSent', { id: s.id, message: msg });
      scheduled.splice(i, 1);
    }
  }
}, 3000);

io.on('connection', (socket) => {
  const me = socket.username;
  const partner = partnerOf(me);
  online.set(me, socket.id);

  socket.emit('messages:pending', messages.filter((m) => m.to === me && !m.hiddenForTo));
  socket.emit('stats:update', { me: stats[me], partner: stats[partner] });
  socket.emit('pins:list', pinned);
  socket.emit('scheduled:list', scheduled.filter((s) => s.from === me));

  // daily quote once per day
  const today = new Date().toDateString();
  if (dailySent[me] !== today) {
    dailySent[me] = today;
    socket.emit('daily:quote', { text: dailyQuote() });
  }

  emitTo(partner, 'presence', { user: me, online: true });
  socket.emit('presence', { user: partner, online: online.has(partner) });

  // chat
  socket.on('message:send', (payload, ack) => {
    const type = payload.type || 'text';
    const ttl  = payload.ttl || '1h';
    const msg = {
      id: crypto.randomUUID(),
      from: me, to: partner,
      type,
      text: String(payload.text || '').slice(0, 4000),
      caption: String(payload.caption || '').slice(0, 400),
      url: payload.url || '', name: payload.name || '',
      mime: payload.mime || '', size: payload.size || 0,
      link: payload.link || '',
      ttl,
      replyTo: payload.replyTo || null,
      reactions: {},
      createdAt: Date.now(), seenAt: 0
    };
    messages.push(msg);
    if (type === 'text' || type === 'link') stats[me].messages++;
    else if (type === 'image') stats[me].photos++;
    else if (type === 'video') stats[me].videos++;
    else if (type === 'voice') stats[me].notes++;

    emitTo(partner, 'message:new', msg);
    if (typeof ack === 'function') ack({ ok: true, message: msg });
    socket.emit('stats:update', { me: stats[me], partner: stats[partner] });
  });

  socket.on('message:seen', ({ ids }) => {
    if (!Array.isArray(ids)) return;
    const now = Date.now();
    const seen = [];
    for (const id of ids) {
      const m = messages.find((x) => x.id === id && x.to === me && !x.seenAt);
      if (m) {
        m.seenAt = now;
        seen.push(id);
        const ttlMs = m.ttl === '10s' ? 10000 : m.ttl === '1m' ? 60000 : 60 * 60 * 1000;
        scheduleDelete(id, now + ttlMs);
      }
    }
    if (seen.length) emitTo(partner, 'message:seen', { ids: seen, by: me });
  });

  socket.on('message:react', ({ id, emoji }) => {
    const m = messages.find((x) => x.id === id); if (!m) return;
    if (!m.reactions) m.reactions = {};
    if (m.reactions[me] === emoji) delete m.reactions[me];
    else m.reactions[me] = emoji;
    socket.emit('message:reaction', { id, reactions: m.reactions });
    emitTo(partner, 'message:reaction', { id, reactions: m.reactions });
  });

  socket.on('message:hideForMe', ({ id }) => {
    const m = messages.find((x) => x.id === id); if (!m) return;
    if (m.from === me) m.hiddenForFrom = true;
    if (m.to === me)   m.hiddenForTo = true;
    socket.emit('message:hidden', { id });
  });

  socket.on('message:deleteForAll', ({ id }) => {
    const i = messages.findIndex((x) => x.id === id);
    if (i === -1) return;
    if (messages[i].from !== me) return;
    messages.splice(i, 1);
    socket.emit('message:deleted', { id });
    emitTo(partner, 'message:deleted', { id });
  });

  // pinned love notes
  socket.on('note:pin', ({ id }) => {
    const m = messages.find((x) => x.id === id);
    if (!m) return;
    if (pinned.find((p) => p.id === id)) return;
    const item = { id, text: m.text || m.caption || '', type: m.type, from: m.from, at: Date.now() };
    pinned.unshift(item);
    if (pinned.length > 20) pinned.pop();
    io.emit('pins:list', pinned);
  });
  socket.on('note:unpin', ({ id }) => {
    const i = pinned.findIndex((p) => p.id === id);
    if (i !== -1) pinned.splice(i, 1);
    io.emit('pins:list', pinned);
  });

  // schedule
  socket.on('message:schedule', (payload, ack) => {
    const at = Number(payload.at) || 0;
    if (!at || at < Date.now()) return ack && ack({ ok: false, error: 'bad time' });
    const item = {
      id: crypto.randomUUID(),
      from: me, to: partner,
      payload: {
        type: payload.type || 'text',
        text: payload.text || '',
        caption: payload.caption || '',
        url: payload.url || '', name: payload.name || '',
        mime: payload.mime || '', size: payload.size || 0,
        link: payload.link || '',
        ttl: payload.ttl || '1h',
        replyTo: payload.replyTo || null
      },
      at
    };
    scheduled.push(item);
    socket.emit('scheduled:list', scheduled.filter((s) => s.from === me));
    if (typeof ack === 'function') ack({ ok: true, item });
  });

  socket.on('message:cancelSchedule', ({ id }) => {
    const i = scheduled.findIndex((s) => s.id === id && s.from === me);
    if (i !== -1) scheduled.splice(i, 1);
    socket.emit('scheduled:list', scheduled.filter((s) => s.from === me));
  });

  // typing
  socket.on('typing', (isTyping) => emitTo(partner, 'typing', { from: me, typing: !!isTyping }));

  // calls
  socket.on('call:invite', (data) => {
    if (!online.has(partner)) return socket.emit('call:unavailable');
    stats[me].calls++;
    socket.emit('stats:update', { me: stats[me], partner: stats[partner] });
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
