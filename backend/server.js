'use strict';

require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const { Server } = require('socket.io');
const nodemailer = require('nodemailer');
const fs = require('fs');

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
if (!JWT_SECRET || JWT_SECRET.length < 32) throw new Error('JWT_SECRET too short');
const JWT_EXPIRES = '7d';

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data.db');
const dir = path.dirname(dbPath);
if (dir && dir !== '.' && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL COLLATE NOCASE,
  email         TEXT UNIQUE NOT NULL COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user',
  is_verified   INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS otps (
  email      TEXT PRIMARY KEY COLLATE NOCASE,
  code       TEXT NOT NULL,
  expires_at INTEGER NOT NULL
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
`);

try { db.exec(`ALTER TABLE users ADD COLUMN email TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE users ADD COLUMN is_verified INTEGER DEFAULT 1`); } catch(e) {}

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.ethereal.email',
  port: process.env.SMTP_PORT || 587,
  auth: { user: process.env.SMTP_USER || 'placeholder', pass: process.env.SMTP_PASS || 'placeholder' },
  connectionTimeout: 3000, socketTimeout: 3000
});

const S = {
  findByUsername: db.prepare(`SELECT * FROM users WHERE username = ? COLLATE NOCASE`),
  findByEmail: db.prepare(`SELECT * FROM users WHERE email = ? COLLATE NOCASE`),
  findById: db.prepare(`SELECT id, username, email, display_name, role FROM users WHERE id = ?`),
  createUser: db.prepare(`INSERT INTO users (username, email, password_hash, display_name, is_verified) VALUES (?,?,?,?,1)`),
  insertOtp: db.prepare(`INSERT OR REPLACE INTO otps (email, code, expires_at) VALUES (?,?,?)`),
  getOtp: db.prepare(`SELECT * FROM otps WHERE email = ? AND code = ? AND expires_at > unixepoch()`),
  getExistingOtp: db.prepare(`SELECT * FROM otps WHERE email = ? AND expires_at > unixepoch()`),
  deleteOtp: db.prepare(`DELETE FROM otps WHERE email = ?`),
  updateUser: db.prepare(`UPDATE users SET display_name = ?, username = ? WHERE id = ?`),
  
  listFriends: db.prepare(`
    SELECT u.id, u.username, u.display_name AS displayName
    FROM friends f
    JOIN users u ON u.id = CASE WHEN f.requester_id = @me THEN f.addressee_id ELSE f.requester_id END
    WHERE (f.requester_id = @me OR f.addressee_id = @me) AND f.status = 'accepted'
  `),
  listIncomingReqs: db.prepare(`
    SELECT f.id, f.requester_id AS fromId, u.username, u.display_name AS displayName
    FROM friends f JOIN users u ON u.id = f.requester_id
    WHERE f.addressee_id = @me AND f.status = 'pending'
  `),
  createFriendReq: db.prepare(`INSERT INTO friends (requester_id, addressee_id, status) VALUES (?,?,'pending')`),
  findFriendship: db.prepare(`SELECT * FROM friends WHERE (requester_id = @a AND addressee_id = @b) OR (requester_id = @b AND addressee_id = @a) LIMIT 1`),
  updateFriendStatus: db.prepare(`UPDATE friends SET status = ?, updated_at = unixepoch() WHERE id = ?`),
  
  searchUsers: db.prepare(`
    SELECT u.id, u.username, u.display_name AS displayName,
           f.id AS fid, f.status AS fstatus
    FROM users u
    LEFT JOIN friends f ON (f.requester_id = u.id AND f.addressee_id = @me) OR (f.addressee_id = u.id AND f.requester_id = @me)
    WHERE u.username LIKE @like COLLATE NOCASE AND u.id != @me
    LIMIT 20
  `),
  
  listChannels: db.prepare(`SELECT * FROM channels ORDER BY name ASC`),
  insertChannel: db.prepare(`INSERT INTO channels (name, description, owner_id) VALUES (?,?,?)`),
  joinChannel: db.prepare(`INSERT OR IGNORE INTO channel_members (channel_id, user_id) VALUES (?,?)`),
  isMember: db.prepare(`SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ? LIMIT 1`),
  
  insertMessage: db.prepare(`INSERT INTO messages (sender_id, recipient_type, recipient_id, content) VALUES (?,?,?,?)`),
  getMessageById: db.prepare(`SELECT m.id, m.sender_id, m.content, m.created_at, u.display_name FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ?`),
  
  listDMs: db.prepare(`
    SELECT m.id, m.sender_id, m.content, m.created_at, u.display_name
    FROM messages m JOIN users u ON u.id = m.sender_id
    WHERE m.recipient_type = 'user' AND (
      (m.sender_id = @me AND m.recipient_id = @other) OR
      (m.sender_id = @other AND m.recipient_id = @me)
    ) ORDER BY m.created_at ASC LIMIT 100
  `),
  listChannelMessages: db.prepare(`
    SELECT m.id, m.sender_id, m.content, m.created_at, u.display_name
    FROM messages m JOIN users u ON u.id = m.sender_id
    WHERE m.recipient_type = 'channel' AND m.recipient_id = ?
    ORDER BY m.created_at ASC LIMIT 100
  `),
  
  insertReport: db.prepare(`INSERT INTO reports (user_id, subject, message) VALUES (?,?,?)`),
  listAllUsers: db.prepare(`SELECT id, username, email, display_name, role, is_verified FROM users ORDER BY id DESC`),
  listAllReports: db.prepare(`SELECT r.*, u.username FROM reports r JOIN users u ON u.id = r.user_id ORDER BY r.created_at DESC`),
  channelIdsForUser: db.prepare(`SELECT channel_id FROM channel_members WHERE user_id = ?`),
};

const presence = new Map();
const isOnline = (uid) => (presence.get(uid)?.size ?? 0) > 0;
function markOnline(uid, sid) { let s = presence.get(uid); if (!s) { s = new Set(); presence.set(uid, s); } s.add(sid); }
function markOffline(uid, sid) { const s = presence.get(uid); if (s) { s.delete(sid); if (s.size === 0) presence.delete(uid); } }

const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, '..', 'frontend'), { index: 'index.html' }));

const signToken = (u) => jwt.sign({ uid: u.id, uname: u.username, role: u.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
const authRequired = (req, res, next) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); } catch { res.status(401).json({ error: 'invalid_token' }); }
};
const USERNAME_RE = /^[a-zA-Z0-9_.]{3,32}$/;

app.post('/api/auth/send-otp', async (req, res) => {
  const { email, password, username, displayName } = req.body || {};
  if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'invalid_email' });
  if (typeof password !== 'string' || password.length < 8) return res.status(400).json({ error: 'weak_password' });
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) return res.status(400).json({ error: 'invalid_username' });

  if (S.findByUsername.get(username)) return res.status(409).json({ error: 'username_taken' });
  if (S.findByEmail.get(email)) return res.status(409).json({ error: 'email_taken' });

  const existing = S.getExistingOtp.get(email);
  if (existing) {
    console.log(`\n=============================================`);
    console.log(`[OTP REUSED] for ${email} : ${existing.code}`);
    console.log(`=============================================\n`);
    return res.json({ ok: true });
  }

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  S.insertOtp.run(email, code, Math.floor(Date.now() / 1000) + 3600);
  
  console.log(`\n=============================================`);
  console.log(`[OTP CODE] for ${email} : ${code}`);
  console.log(`=============================================\n`);
  
  res.json({ ok: true });

  transporter.sendMail({
    from: '"Presence Chat" <no-reply@presencechat.com>', to: email,
    subject: 'كود تفعيل حسابك', text: `كود التفعيل الخاص بك هو: ${code}`
  }).catch(() => {});
});

app.post('/api/auth/verify-otp', async (req, res) => {
  const { email, password, username, displayName, code } = req.body || {};
  const otp = S.getOtp.get(email, code);
  if (!otp) return res.status(400).json({ error: 'invalid_code' });

  try {
    const hash = await bcrypt.hash(password, 12);
    const role = username === 'cyberlook5070' ? 'admin' : 'user';
    const info = S.createUser.run(username, email, hash, displayName);
    if (role === 'admin') db.prepare(`UPDATE users SET role='admin' WHERE id=?`).run(info.lastInsertRowid);
    S.deleteOtp.run(email);
    const u = S.findById.get(Number(info.lastInsertRowid));
    res.json({ token: signToken(u), user: { id: u.id, username: u.username, email: u.email, displayName: u.display_name, role: u.role } });
  } catch (e) { 
    console.error(e);
    res.status(500).json({ error: 'server_error' }); 
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  const u = S.findByUsername.get(username);
  if (!u || !(await bcrypt.compare(password, u.password_hash))) return res.status(401).json({ error: 'invalid_credentials' });
  res.json({ token: signToken(u), user: { id: u.id, username: u.username, email: u.email, displayName: u.display_name, role: u.role } });
});

app.get('/api/me', authRequired, (req, res) => {
  const u = S.findById.get(req.user.uid);
  if (!u) return res.status(404).json({ error: 'not_found' });
  res.json({ id: u.id, username: u.username, email: u.email, displayName: u.display_name, role: u.role });
});

app.post('/api/user/update', authRequired, (req, res) => {
  try {
    S.updateUser.run(req.body.displayName, req.body.username, req.user.uid);
    const u = S.findById.get(req.user.uid);
    res.json({ token: signToken(u), user: { id: u.id, username: u.username, email: u.email, displayName: u.display_name, role: u.role } });
  } catch (e) { res.status(409).json({ error: 'username_taken' }); }
});

app.post('/api/admin/login', authRequired, (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    db.prepare(`UPDATE users SET role='admin' WHERE id=?`).run(req.user.uid);
    const u = S.findById.get(req.user.uid);
    res.json({ token: signToken(u), user: { id: u.id, role: u.role } });
  } else res.status(401).json({ error: 'wrong_password' });
});

// --- التعديل هنا: بنجيب الصلاحية من الداتابيز مش من التوكن ---
app.get('/api/admin/dashboard', authRequired, (req, res) => {
  const dbUser = db.prepare(`SELECT role FROM users WHERE id = ?`).get(req.user.uid);
  if (!dbUser || dbUser.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  res.json({ users: S.listAllUsers.all(), reports: S.listAllReports.all() });
});

app.post('/api/reports', authRequired, (req, res) => { S.insertReport.run(req.user.uid, req.body.subject, req.body.message); res.json({ ok: true }); });

app.get('/api/users/search', authRequired, (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ results: [] });
  res.json({ results: S.searchUsers.all({ me: req.user.uid, like: `${q}%` }).map(r => ({ id: r.id, username: r.username, displayName: r.displayName, relationship: r.fstatus ? { status: r.fstatus, requestId: r.fid, incoming: false } : null })) });
});

app.get('/api/friends', authRequired, (req, res) => {
  res.json({ friends: S.listFriends.all({ me: req.user.uid }).map(f => ({ ...f, online: isOnline(f.id) })) });
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
  res.json({ channels: S.listChannels.all() });
});

app.get('/api/messages/dm/:id', authRequired, (req, res) => { res.json({ messages: S.listDMs.all({ me: req.user.uid, other: Number(req.params.id) }) }); });

app.post('/api/messages/dm/:id', authRequired, (req, res) => {
  const otherId = Number(req.params.id);
  const info = S.insertMessage.run(req.user.uid, 'user', otherId, req.body.content);
  const msg = S.getMessageById.get(Number(info.lastInsertRowid));
  req.app.locals.io.to(`user:${otherId}`).emit('message:dm', { message: msg });
  res.json({ ok: true, message: msg });
});

app.get('/api/messages/channel/:id', authRequired, (req, res) => { res.json({ messages: S.listChannelMessages.all(Number(req.params.id)) }); });

app.post('/api/messages/channel/:id', authRequired, (req, res) => {
  const channelId = Number(req.params.id);
  const info = S.insertMessage.run(req.user.uid, 'channel', channelId, req.body.content);
  const msg = S.getMessageById.get(Number(info.lastInsertRowid));
  req.app.locals.io.to(`channel:${channelId}`).emit('message:channel', { channelId, message: msg });
  res.json({ ok: true, message: msg });
});

const server = http.createServer(app);
const io = new Server(server);
app.locals.io = io;

io.use((socket, next) => {
  try { socket.data.userId = jwt.verify(socket.handshake.auth?.token, JWT_SECRET).uid; next(); } catch { next(new Error('auth_error')); }
});

io.on('connection', (socket) => {
  socket.join(`user:${socket.data.userId}`);
  markOnline(socket.data.userId, socket.id);
  socket.on('disconnect', () => markOffline(socket.data.userId, socket.id));
});

server.listen(PORT, '0.0.0.0', () => console.log(`[presence-chat] listening on :${PORT}`));
