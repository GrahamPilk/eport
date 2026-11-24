#!/usr/bin/env node
// One-time setup:  node publisher/setup.mjs
// Asks for your admin password, makes a 2FA secret and API tokens,
// and prints the lines to paste into /etc/site-publisher.env.
import { createInterface } from 'node:readline';
import crypto from 'node:crypto';
import { Writable } from 'node:stream';
import { hashPassword, newTotpSecret } from './auth.mjs';

// one readline that doesn't echo what you type (password prompt)
let muted = false;
const output = new Writable({ write(chunk, _enc, cb) { if (!muted) process.stdout.write(chunk); cb(); } });
const rl = createInterface({ input: process.stdin, output, terminal: !!process.stdin.isTTY });
const lines = rl[Symbol.asyncIterator](); // buffers lines, so piped input works too
async function askHidden(q) {
  process.stdout.write(q);
  muted = true;
  const answer = (await lines.next()).value ?? '';
  muted = false;
  process.stdout.write('\n');
  return answer;
}

const pw = await askHidden('Admin password (12+ characters): ');
if (pw.length < 12) { console.error('Too short.'); process.exit(1); }
if (pw !== (await askHidden('Again: '))) { console.error("Didn't match."); process.exit(1); }
rl.close();

const totp = newTotpSecret();
const host = process.env.SITE_HOST || 'grahampilkington.com';
console.log(`
Paste into /etc/site-publisher.env  (then: chmod 600, systemctl restart site-publisher)

ADMIN_PASSWORD_HASH=${hashPassword(pw)}
ADMIN_TOTP_SECRET=${totp}
PUBLISH_TOKEN=${crypto.randomBytes(32).toString('hex')}
GITHUB_WEBHOOK_SECRET=${crypto.randomBytes(32).toString('hex')}

2FA: in your authenticator app choose "enter a setup key" and paste
  ${totp}
or open this on your phone:
  otpauth://totp/${encodeURIComponent(host + ':admin')}?secret=${totp}&issuer=${encodeURIComponent(host)}
`);
