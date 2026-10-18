'use strict';

const crypto = require('crypto');
const { promisify } = require('util');
const { db } = require('./db');
const config = require('./config');
const { HttpError } = require('./errors');

const scrypt = promisify(crypto.scrypt);
const KEYLEN = 64;

// ---------- Passwords ----------

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN);
  return `scrypt:${salt.toString('base64')}:${hash.toString('base64')}`;
}

const HASH_RE = /^scrypt:[A-Za-z0-9+/=]{20,}:[A-Za-z0-9+/=]{80,}$/;
const isValidHash = (h) => typeof h === 'string' && HASH_RE.test(h);

async function verifyPassword(password, stored) {
  if (!isValidHash(stored)) return false;
  const [, saltB64, hashB64] = stored.split(':');
  const expected = Buffer.from(hashB64, 'base64');
  if (expected.length !== KEYLEN) return false;
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), KEYLEN);
  return crypto.timingSafeEqual(actual, expected);
}

// Verifying against a dummy hash for unknown usernames keeps response time
// the same whether or not the account exists.
let dummyHash;
async function verifyAgainstDummy(password) {
  dummyHash = dummyHash || (await hashPassword('not-a-real-password'));
  await verifyPassword(password, dummyHash);
}

// ---------- Sessions ----------
// Only a SHA-256 of the token is stored, so a leaked DB/backup holds no usable sessions.

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const expiresAt = new Date(now + config.SESSION_HOURS * 3600 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(sha256(token), userId, new Date(now).toISOString(), expiresAt);
  return { token, maxAgeSeconds: config.SESSION_HOURS * 3600 };
}

function getUserBySession(token) {
  if (!token) return null;
  return db.prepare(`
    SELECT u.id, u.username, u.role, u.must_change_password
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `).get(sha256(token), new Date().toISOString()) || null;
}

function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

function destroyUserSessions(userId, exceptToken) {
  if (exceptToken) {
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, sha256(exceptToken));
  } else {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }
}

function purgeExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date().toISOString());
}

// ---------- Cookies ----------

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    const val = part.slice(i + 1).trim();
    if (key) { try { out[key] = decodeURIComponent(val); } catch { out[key] = val; } }
  }
  return out;
}

function cookieHeader(token, maxAgeSeconds) {
  const parts = [`${config.COOKIE_NAME}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
  if (config.COOKIE_SECURE) parts.push('Secure');
  return parts.join('; ');
}

const setSessionCookie = (token, maxAgeSeconds) => cookieHeader(token, maxAgeSeconds);
const clearSessionCookie = () => cookieHeader('', 0);

// ---------- Login throttling (per client IP, in memory) ----------

class LoginLimiter {
  constructor(max = 10, windowMs = 15 * 60 * 1000) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map();
  }
  check(key) {
    const entry = this.hits.get(key);
    if (!entry) return;
    if (Date.now() > entry.resetAt) { this.hits.delete(key); return; }
    if (entry.count >= this.max) {
      const minutes = Math.ceil((entry.resetAt - Date.now()) / 60000);
      throw new HttpError(429, `Too many failed sign-in attempts. Try again in ${minutes} minute(s).`);
    }
  }
  fail(key) {
    const entry = this.hits.get(key);
    if (!entry || Date.now() > entry.resetAt) {
      this.hits.set(key, { count: 1, resetAt: Date.now() + this.windowMs });
    } else {
      entry.count += 1;
    }
  }
  reset(key) { this.hits.delete(key); }
}

module.exports = {
  hashPassword, verifyPassword, verifyAgainstDummy, isValidHash,
  createSession, getUserBySession, destroySession, destroyUserSessions, purgeExpiredSessions,
  parseCookies, setSessionCookie, clearSessionCookie,
  LoginLimiter,
};
