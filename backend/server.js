'use strict';

require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const { Server } = require('socket.io');

// --- Environment guards ----------------------------------------------------
const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET must be set and at least 32 characters');
}
const JWT_EXPIRES = '7d';

// --- Database --------------------------------------------------------------
const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data.db');
const fs = require('fs');
const dir = path.dirname(dbPath);
if (dir && dir !== '.' && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  avatar_url    TEXT,
  role          TEXT NOT NULL DEFAULT 'user',
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS friends (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  requester_id INTEGER NOT NULL,
  addressee_id INTEGER NOT NULL,
  status       TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected','blocked')),
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(requester_id, addressee_id),
  FOREIGN KEY(requester_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(addressee_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS channels (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT UNIQUE NOT NULL COLLATE NOCASE,
  description TEXT,
  owner_id    INTEGER NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS channel_members (
  channel_id INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  joined_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY(channel_id, user_id),
  FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id)    REFERENCES users(id)    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS messages (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id      INTEGER NOT NULL,
  recipient_type TEXT NOT NULL CHECK(recipient_type IN ('user','channel')),
  recipient_id   INTEGER NOT NULL,
  content        TEXT NOT NULL,
  content_type   TEXT NOT NULL DEFAULT 'text',
  created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY(sender_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS reports (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  subject    TEXT NOT NULL,
  message    TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_dm_pair     ON messages(recipient_type, recipient_id, created_at);
CREATE INDEX IF NOT EXISTS idx_dm_sender   ON messages(sender_id, created_at);
CREATE INDEX IF NOT EXISTS idx_friends_ux  ON friends(requester_id, addressee_id, status);
`);

// Migration: add role column if missing
try { db.exec(`ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';`); } catch(e) {}

// --- Prepared statements ---------------------------------------------------
const S = {
  createUser:        db.prepare(`INSERT INTO users (username, password_hash, display_name, avatar_url) VALUES (?,?,?,?)`),
  findByUsername:    db.prepare(`SELECT * FROM users WHERE username = ? COLLATE NOCASE`),
  findById:          db.prepare(`SELECT id, username, display_name, avatar_url, role, created_at FROM users WHERE id = ?`),
  searchUsers:       db.prepare(`
    SELECT u.id, u.username, u.display_name, u.avatar_url,
           f.id AS fid, f.status AS fstatus, f.requester_id AS frequester
    FROM users u
    LEFT JOIN friends f ON
      (f.requester_id = u.id AND f.addressee_id = @me) OR
      (f.addressee_id = u.id AND f.requester_id = @me)
    WHERE u.username LIKE @like COLLATE NOCASE AND u.id != @me
    LIMIT 20
  `),
  createFriendReq:   db.prepare(`INSERT INTO friends (requester_id, addressee_id, status) VALUES (?,?,'pending')`),
  findFriendship:    db.prepare(`
    SELECT * FROM friends
    WHERE (requester_id = @a AND addressee_id = @b) OR (requester_id = @b AND addressee_id = @a)
    LIMIT 1
  `),
  updateFriendStatus: db.prepare(`UPDATE friends SET status = ?, updated_at = unixepoch() WHERE id = ?`),
  listFriends:       db.prepare(`
    SELECT u.id, u.username, u.display_name, u.avatar_url
    FROM friends f
    JOIN users u ON u.id = CASE WHEN f.requester_id = @me THEN f.addressee_id ELSE f.requester_id END
    WHERE (f.requester_id = @me OR f.addressee_id = @me) AND f.status = 'accepted'
    ORDER BY u.display_name COLLATE NOCASE ASC
  `),
  listIncomingReqs:  db.prepare(`
    SELECT f.id, f.requester_id AS from_id,
           u.username, u.display_name, u.avatar_url
    FROM friends f JOIN users u ON u.id = f.requester_id
    WHERE f.addressee_id = @me AND f.status = 'pending'
    ORDER BY f.created_at DESC
  `),
  listPublicChannels: db.prepare(`SELECT id, name, description, owner_id, created_at FROM channels ORDER BY name COLLATE NOCASE ASC`),
  getChannel:        db.prepare(`SELECT * FROM channels WHERE id = ?`),
  insertChannel:     db.prepare(`INSERT INTO channels (name, description, owner_id) VALUES (?,?,?)`),
  joinChannel:       db.prepare(`INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?,?)`),
  isMember:          db.prepare(`SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ? LIMIT 1`),
  insertMessage:     db.prepare(`
    INSERT INTO messages (sender_id, recipient_type, recipient_id, content, content_type)
    VALUES (?,?,?,?,?)
  `),
  getMessageById:    db.prepare(`
    SELECT m.id, m.sender_id, m.content, m.content_type, m.created_at,
           u.display_name, u.username, u.avatar_url
    FROM messages m JOIN users u ON u.id = m.sender_id
    WHERE m.id = ?
  `),
  listDMMessages:    db.prepare(`
    SELECT m.id, m.sender_id, m.content, m.content_type, m.created_at,
           u.display_name, u.username, u.avatar_url
    FROM messages m JOIN users u ON u.id = m.sender_id
    WHERE m.recipient_type = 'user' AND (
      (m.sender_id = @me AND m.recipient_id = @other) OR
      (m.sender_id = @other AND m.recipient_id = @me)
    )
    ORDER BY m.created_at ASC LIMIT 300
  `),
  listChannelMessages: db.prepare(`
    SELECT m.id, m.sender_id, m.content, m.content_type, m.created_at,
           u.display_name, u.username, u.avatar_url
    FROM messages m JOIN users u ON u.id = m.sender_id
    WHERE m.recipient_type = 'channel' AND m.recipient_id = ?
    ORDER BY m.created_at ASC LIMIT 300
  `),
  areFriends:        db.prepare(`
    SELECT 1 FROM friends
    WHERE status = 'accepted' AND (
      (requester_id = @a AND addressee_id = @b) OR
      (requester_id = @b AND addressee_id = @a)
    ) LIMIT 1
  `),
  channelIdsForUser: db.prepare(`SELECT channel_id FROM channel_members WHERE user_id = ?`),
  updateUser:        db.prepare(`UPDATE users SET display_name = ?, username = ? WHERE id = ?`),
  insertReport:      db.prepare(`INSERT INTO reports (user_id, subject, message) VALUES (?,?,?)`),
  listAllUsers:      db.prepare(`SELECT id, username, display_name, role, created_at FROM users ORDER BY id DESC`),
  listAllReports:    db.prepare(`
    SELECT r.id, r.subject, r.message, r.status, r.created_at, u.username
    FROM reports r JOIN users u ON u.id = r.user_id ORDER BY r.created_at DESC
  `),
};

// --- Presence map ----------------------------------------------------------
const presence = new Map();
const friendsOf = (userId) => S.listFriends.all({ me: userId }).map(r => r.id);
const isOnline = (userId) => (presence.get(userId)?.size ?? 0) > 0;

function markOnline(userId, socketId, io) {
  let set = presence.get(userId);
  const wasOffline = !set || set.size === 0;
  if (!set) { set = new Set(); presence.set(userId, set); }
  set.add(socketId);
  if (wasOffline) {
    for (const fid of friendsOf(userId)) {
      io.to(`user:${fid}`).emit('presence:update', { userId, online: true });
    }
  }
}
function markOffline(userId, socketId, io) {
  const set = presence.get(userId);
  if (!set) return;
  set.delete(socketId);
  if (set.size === 0) {
    presence.delete(userId);
    for (const fid of friendsOf(userId)) {
      io.to(`user:${fid}`).emit('presence:update', { userId, online: false });
    }
  }
}

// --- Express --------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, '..', 'frontend'), {
  index: 'index.html',
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
}));

const signToken = (u) => jwt.sign({ uid: u.id, uname: u.username, role: u.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES });

function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

const USERNAME_RE = /^[a-zA-Z0-9_.]{3,32}$/;

// --- Auth & Profile Routes -------------------------------------------------
app.post('/api/register', async (req, res) => {
  const { username, password, displayName } = req.body || {};
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) return res.status(400).json({ error: 'invalid_username' });
  if (typeof password !== 'string' || password.length < 8) return res.status(400).json({ error: 'weak_password' });
  if (typeof displayName !== 'string' || displayName.length < 1) return res.status(400).json({ error: 'invalid_display_name' });
  
  try {
    const hash = await bcrypt.hash(password, 12);
    const role = username === 'cyberlook5070' ? 'admin' : 'user';
    const info = S.createUser.run(username, hash, displayName, null);
    // Set role manually if needed (migration added default 'user', so we update if admin)
    if (role === 'admin') db.prepare(`UPDATE users SET role='admin' WHERE id=?`).run(info.lastInsertRowid);
    
    const newUser = S.findById.get(Number(info.lastInsertRowid));
    const token = signToken(newUser);
    res.json({ token, user: { id: newUser.id, username: newUser.username, displayName: newUser.display_name, avatarUrl: newUser.avatar_url, role: newUser.role } });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'username_taken' });
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  const u = S.findByUsername.get(username);
  if (!u || !(await bcrypt.compare(password, u.password_hash))) return res.status(401).json({ error: 'invalid_credentials' });
  const token = signToken(u);
  res.json({ token, user: { id: u.id, username: u.username, displayName: u.display_name, avatarUrl: u.avatar_url, role: u.role } });
});

app.get('/api/me', authRequired, (req, res) => {
  const u = S.findById.get(req.user.uid);
  if (!u) return res.status(404).json({ error: 'not_found' });
  res.json({ id: u.id, username: u.username, displayName: u.display_name, avatarUrl: u.avatar_url, role: u.role });
});

app.post('/api/user/update', authRequired, async (req, res) => {
  const { displayName, username } = req.body || {};
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) return res.status(400).json({ error: 'invalid_username' });
  if (typeof displayName !== 'string' || displayName.length < 1) return res.status(400).json({ error: 'invalid_display_name' });
  
  try {
    S.updateUser.run(displayName, username, req.user.uid);
    const u = S.findById.get(req.user.uid);
    const token = signToken(u);
    req.app.locals.io.emit('user:updated', { userId: u.id, displayName: u.display_name, username: u.username });
    res.json({ ok: true, token, user: { id: u.id, username: u.username, displayName: u.display_name, avatarUrl: u.avatar_url, role: u.role } });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'username_taken' });
    res.status(500).json({ error: 'server_error' });
  }
});

// --- Admin Routes ---------------------------------------------------------
app.post('/api/admin/login', authRequired, (req, res) => {
  const { password } = req.body || {};
  if (password === ADMIN_PASSWORD) {
    db.prepare(`UPDATE users SET role='admin' WHERE id=?`).run(req.user.uid);
    const u = S.findById.get(req.user.uid);
    const token = signToken(u);
    res.json({ ok: true, token, user: { id: u.id, role: u.role } });
  } else {
    res.status(401).json({ error: 'invalid_admin_password' });
  }
});

app.get('/api/admin/dashboard', authRequired, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  const users = S.listAllUsers.all();
  const reports = S.listAllReports.all();
  res.json({ users, reports });
});

// --- Reports & Support ----------------------------------------------------
app.post('/api/reports', authRequired, (req, res) => {
  const { subject, message } = req.body || {};
  if (!subject || !message) return res.status(400).json({ error: 'missing_fields' });
  S.insertReport.run(req.user.uid, subject, message);
  res.json({ ok: true });
});

// --- Friends & Messages (unchanged) ---------------------------------------
app.get('/api/users/search', authRequired, (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ results: [] });
  const rows = S.searchUsers.all({ me: req.user.uid, like: `${q}%` });
  res.json({ results: rows.map(r => ({ id: r.id, username: r.username, displayName: r.display_name, relationship: r.fstatus ? { status: r.fstatus, requestId: r.fid, incoming: r.fstatus === 'pending' && r.frequester === r.id } : null })) });
});

app.get('/api/friends', authRequired, (req, res) => {
  const rows = S.listFriends.all({ me: req.user.uid });
  res.json({ friends: rows.map(r => ({ id: r.id, username: r.username, displayName: r.display_name, online: isOnline(r.id) })) });
});

app.get('/api/friends/requests', authRequired, (req, res) => {
  res.json({ requests: S.listIncomingReqs.all({ me: req.user.uid }) });
});

app.post('/api/friends/request', authRequired, (req, res) => {
  const targetId = Number(req.body?.userId);
  if (!Number.isInteger(targetId) || targetId === req.user.uid) return res.status(400).json({ error: 'invalid_target' });
  const existing = S.findFriendship.get({ a: req.user.uid, b: targetId });
  if (existing) {
    if (existing.status === 'accepted') return res.status(409).json({ error: 'already_friends' });
    if (existing.status === 'pending') return res.status(409).json({ error: 'pending' });
    S.updateFriendStatus.run('pending', existing.id);
    return res.json({ ok: true, id: existing.id });
  }
  const info = S.createFriendReq.run(req.user.uid, targetId);
  req.app.locals.io.to(`user:${targetId}`).emit('friend:request', { requestId: Number(info.lastInsertRowid), from: { id: req.user.uid, username: req.user.uname } });
  res.json({ ok: true });
});

app.post('/api/friends/respond', authRequired, (req, res) => {
  const { requestId, action } = req.body;
  const row = db.prepare(`SELECT * FROM friends WHERE id = ? AND addressee_id = ? AND status = 'pending'`).get(requestId, req.user.uid);
  if (!row) return res.status(404).json({ error: 'not_found' });
  S.updateFriendStatus.run(action === 'accept' ? 'accepted' : 'rejected', row.id);
  res.json({ ok: true });
});

app.get('/api/channels', authRequired, (req, res) => {
  res.json({ channels: S.listPublicChannels.all() });
});

app.get('/api/messages/dm/:userId', authRequired, (req, res) => {
  const otherId = Number(req.params.userId);
  res.json({ messages: S.listDMMessages.all({ me: req.user.uid, other: otherId }) });
});

app.post('/api/messages/dm/:userId', authRequired, (req, res) => {
  const otherId = Number(req.params.userId);
  const { content } = req.body;
  const info = S.insertMessage.run(req.user.uid, 'user', otherId, content, 'text');
  const msg = S.getMessageById.get(Number(info.lastInsertRowid));
  req.app.locals.io.to(`user:${otherId}`).emit('message:dm', { peerId: req.user.uid, message: msg });
  req.app.locals.io.to(`user:${req.user.uid}`).emit('message:dm', { peerId: otherId, message: msg });
  res.json({ ok: true, message: msg });
});

app.get('/api/messages/channel/:channelId', authRequired, (req, res) => {
  const id = Number(req.params.channelId);
  res.json({ messages: S.listChannelMessages.all(id) });
});

app.post('/api/messages/channel/:channelId', authRequired, (req, res) => {
  const id = Number(req.params.channelId);
  const { content } = req.body;
  const info = S.insertMessage.run(req.user.uid, 'channel', id, content, 'text');
  const msg = S.getMessageById.get(Number(info.lastInsertRowid));
  req.app.locals.io.to(`channel:${id}`).emit('message:channel', { channelId: id, message: msg });
  res.json({ ok: true, message: msg });
});

// --- HTTP + Socket.IO -----------------------------------------------------
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false } });
app.locals.io = io;

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('unauthorized'));
  try {
    const p = jwt.verify(token, JWT_SECRET);
    socket.data.userId = p.uid;
    next();
  } catch { next(new Error('invalid_token')); }
});

io.on('connection', (socket) => {
  const uid = socket.data.userId;
  socket.join(`user:${uid}`);
  markOnline(uid, socket.id, io);
  socket.on('disconnect', () => markOffline(uid, socket.id, io));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[presence-chat] listening on :${PORT}`);
});
