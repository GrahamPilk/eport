// Single-owner auth: scrypt password + TOTP (authenticator app) + in-memory sessions.
import crypto from 'node:crypto';

// ── password (scrypt, N=2^15) ── stored as scrypt$N$r$p$saltB64$hashB64
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw.normalize('NFKC'), salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${h.toString('base64')}`;
}
export function verifyPassword(pw, stored) {
  return new Promise((resolve) => {
    const [kind, N, r, p, salt, hash] = String(stored || '').split('$');
    if (kind !== 'scrypt' || !hash) return resolve(false);
    const want = Buffer.from(hash, 'base64');
    crypto.scrypt(String(pw).normalize('NFKC'), Buffer.from(salt, 'base64'), want.length,
      { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem },
      (err, got) => resolve(!err && crypto.timingSafeEqual(got, want)));
  });
}

// ── TOTP (RFC 6238: SHA-1, 30 s, 6 digits) ──
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function newTotpSecret() {
  const bytes = crypto.randomBytes(20);
  let bits = '', out = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}
function b32decode(s) {
  let bits = '';
  for (const c of s.replace(/=+$/, '').toUpperCase()) {
    const v = B32.indexOf(c);
    if (v >= 0) bits += v.toString(2).padStart(5, '0');
  }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
function hotp(key, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(msg).digest(), o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}
let lastCounter = -1; // replay protection: each code works once
export function verifyTotp(secret, code, now = Date.now()) {
  if (!/^\d{6}$/.test(String(code))) return false;
  const key = b32decode(secret), c = Math.floor(now / 30000);
  for (const d of [-1, 0, 1]) {
    if (c + d > lastCounter && crypto.timingSafeEqual(Buffer.from(hotp(key, c + d)), Buffer.from(String(code)))) {
      lastCounter = c + d;
      return true;
    }
  }
  return false;
}
export const totpAt = (secret, ms = Date.now()) => hotp(b32decode(secret), Math.floor(ms / 30000)); // used by tests

// ── sessions (in memory: restarting the service logs you out, which is fine for one user) ──
const TTL = 7 * 24 * 3600 * 1000;
const sessions = new Map(); // id -> { expires, csrf }
export function createSession() {
  const id = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(18).toString('base64url');
  sessions.set(id, { expires: Date.now() + TTL, csrf });
  return { id, csrf, maxAge: TTL / 1000 };
}
export function getSession(cookieHeader) {
  const m = /(?:^|;\s*)(?:__Host-)?sid=([\w-]+)/.exec(cookieHeader || '');
  const s = m && sessions.get(m[1]);
  if (!s) return null;
  if (s.expires < Date.now()) { sessions.delete(m[1]); return null; }
  return { id: m[1], ...s };
}
export const destroySession = (id) => sessions.delete(id);

// ── brute-force guard: 5 fails / 15 min per IP, 20 fails / hour across all IPs ──
const fails = new Map();
let globalFails = [];
export function loginBlocked(ip) {
  const now = Date.now();
  globalFails = globalFails.filter((t) => now - t < 3600e3);
  const f = (fails.get(ip) || []).filter((t) => now - t < 900e3);
  fails.set(ip, f);
  return f.length >= 5 || globalFails.length >= 20;
}
export function recordFail(ip) {
  const now = Date.now();
  fails.set(ip, [...(fails.get(ip) || []), now]);
  globalFails.push(now);
}
export const clearFails = (ip) => fails.delete(ip);
