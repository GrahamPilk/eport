#!/usr/bin/env node
// Zero-dependency publish server for the site: owner login + editor at /admin,
// a token API for scripts/tools, and a GitHub webhook for git-push publishing.
//
//   GET  /admin                    the editor (login: password + 2FA code)
//   POST /api/login | /api/logout  GET /api/session
//   GET  /api/posts                list posts (with title/date/draft)
//   GET  /api/posts/:slug          one post: { slug, meta, body }
//   POST /api/posts                create/replace (JSON or raw Markdown)
//   DELETE /api/posts/:slug
//   POST /api/preview              Markdown → HTML (same renderer as the site)
//   POST /api/uploads?name=x.jpg   image upload (EXIF stripped; &dither=1 for 1-bit)
//   POST /api/rebuild              GET /api/health
//   POST /api/github               GitHub push webhook → git pull + rebuild (HMAC verified)
//
// Auth: browser session cookie (+ CSRF header), or "Authorization: Bearer $PUBLISH_TOKEN".
// Builds go to $RELEASES/<timestamp>; $RELEASES/current is swapped atomically.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as auth from './auth.mjs';

const env = process.env;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(env.PORT || 8787);
const HOST = env.HOST || '127.0.0.1';
const SITE_DIR = path.resolve(env.SITE_DIR || path.join(HERE, '..'));
const RELEASES = path.resolve(env.RELEASES || '/srv/site');
const TOKEN = env.PUBLISH_TOKEN || '';
const GH_SECRET = env.GITHUB_WEBHOOK_SECRET || '';
const PW_HASH = env.ADMIN_PASSWORD_HASH || '';
const TOTP = env.ADMIN_TOTP_SECRET || '';
const GIT_SYNC = env.GIT_SYNC === '1';
const KEEP = Number(env.KEEP_RELEASES || 3);
const SECURE_COOKIE = env.INSECURE_COOKIE !== '1'; // only for local http testing
const COOKIE = SECURE_COOKIE ? '__Host-sid' : 'sid';
const POSTS = path.join(SITE_DIR, 'src/content/blog');
const UPLOADS = path.join(SITE_DIR, 'public/uploads');
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;

if (TOKEN.length < 32) { console.error('PUBLISH_TOKEN must be set (>= 32 chars). Run: node publisher/setup.mjs'); process.exit(1); }
if (!PW_HASH) console.warn('ADMIN_PASSWORD_HASH not set: /admin login is disabled. Run: node publisher/setup.mjs');
if (PW_HASH && !TOTP) console.warn('ADMIN_TOTP_SECRET not set: admin login is password-only. 2FA strongly recommended.');

const log = (...a) => console.log(new Date().toISOString(), ...a);
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: SITE_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}\n${out.slice(-2000)}`))));
  });
}

// ── build queue: one at a time; requests during a build coalesce into one follow-up ──
let building = null, again = false, lastBuild = { ok: null, at: null, ms: 0, error: null };
function rebuild() {
  if (building) { again = true; return building; }
  building = (async () => {
    const t = Date.now(), out = path.join(RELEASES, String(t));
    try {
      await run('npx', ['astro', 'build', '--outDir', out]);
      const tmp = path.join(RELEASES, `.current-${t}`);
      await fs.symlink(out, tmp);
      await fs.rename(tmp, path.join(RELEASES, 'current'));
      const old = (await fs.readdir(RELEASES)).filter((n) => /^\d+$/.test(n)).sort().slice(0, -KEEP);
      await Promise.all(old.map((n) => fs.rm(path.join(RELEASES, n), { recursive: true, force: true })));
      lastBuild = { ok: true, at: new Date().toISOString(), ms: Date.now() - t, error: null };
      log(`build ok in ${lastBuild.ms}ms`);
    } catch (e) {
      await fs.rm(out, { recursive: true, force: true }).catch(() => {});
      lastBuild = { ok: false, at: new Date().toISOString(), ms: Date.now() - t, error: e.message.slice(0, 800) };
      log('build FAILED', e.message);
    } finally {
      building = null;
      if (again) { again = false; rebuild(); }
    }
  })();
  return building;
}

let gitChain = Promise.resolve();
function gitCommit(msg, files) {
  if (!GIT_SYNC) return;
  gitChain = gitChain.then(async () => {
    try {
      await run('git', ['add', '-A', '--', ...files]);
      await run('git', ['-c', 'user.name=Site editor', '-c', 'user.email=editor@localhost', 'commit', '-m', msg]);
      await run('git', ['push']);
    } catch (e) { log('git sync failed (post is still live):', e.message.split('\n')[0]); }
  });
}

// ── frontmatter (JSON strings are valid YAML, so no YAML library needed) ──
const q = (s) => JSON.stringify(String(s));
const day = (d) => { const x = new Date(d || Date.now()); return isNaN(x) ? new Date().toISOString().slice(0, 10) : x.toISOString().slice(0, 10); };
function toMarkdown(p) {
  const tags = Array.isArray(p.tags) ? p.tags : String(p.tags || '').split(',');
  const fm = [
    `title: ${q(p.title)}`,
    `description: ${q(p.description || '')}`,
    `date: ${day(p.date)}`,
    p.updated ? `updated: ${day(p.updated)}` : null,
    `tags: [${tags.map((t) => t.trim()).filter(Boolean).map(q).join(', ')}]`,
    `draft: ${p.draft === true}`,
  ].filter(Boolean);
  return `---\n${fm.join('\n')}\n---\n\n${String(p.body || '').trim()}\n`;
}
function parseMarkdown(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(md);
  if (!m) return { meta: {}, body: md };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    try { v = JSON.parse(v); } catch {
      if (/^\[.*\]$/.test(v)) v = v.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
      else v = v.replace(/^["']|["']$/g, '');
    }
    meta[kv[1]] = v;
  }
  if (meta.date) meta.date = day(meta.date);
  return { meta, body: m[2].replace(/^\n+/, '') };
}
const slugify = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);

// ── markdown preview, using the same renderer Astro uses for the site ──
let renderer = null;
async function renderMarkdown(body) {
  if (!renderer) {
    renderer = import('@astrojs/markdown-satteri')
      .then((m) => m.createSatteriMarkdownProcessor({ shikiConfig: { theme: 'min-light' } }))
      .catch(() => ({ render: async (s) => ({ code: `<pre>${s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])}</pre>` }) }));
  }
  return (await (await renderer).render(body)).code;
}

// ── images: strip metadata (GPS!), cap size, optional 1-bit Bayer dither ──
const BAYER = [0,32,8,40,2,34,10,42,48,16,56,24,50,18,58,26,12,44,4,36,14,46,6,38,60,28,52,20,62,30,54,22,
  3,35,11,43,1,33,9,41,51,19,59,27,49,17,57,25,15,47,7,39,13,45,5,37,63,31,55,23,61,29,53,21];
function sniff(buf) {
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'webp';
  if (buf.slice(0, 6).toString() === 'GIF89a' || buf.slice(0, 6).toString() === 'GIF87a') return 'gif';
  return null;
}
async function processImage(buf, kind, dither) {
  const sharp = (await import('sharp')).default;
  if (dither) {
    const { data, info } = await sharp(buf).rotate().resize({ width: 960, withoutEnlargement: true }).greyscale().normalise()
      .raw().toBuffer({ resolveWithObject: true });
    const out = Buffer.alloc(info.width * info.height);
    for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
      const i = y * info.width + x;
      out[i] = data[i] / 255 > (BAYER[(y & 7) * 8 + (x & 7)] + 0.5) / 64 ? 255 : 0;
    }
    return { buf: await sharp(out, { raw: { width: info.width, height: info.height, channels: 1 } }).png({ palette: true, colours: 2 }).toBuffer(), ext: 'png' };
  }
  if (kind === 'gif') return { buf, ext: 'gif' }; // keep animation
  const img = sharp(buf).rotate().resize({ width: 1600, withoutEnlargement: true }); // re-encode drops EXIF
  return kind === 'png' ? { buf: await img.png().toBuffer(), ext: 'png' } : { buf: await img.webp({ quality: 82 }).toBuffer(), ext: 'webp' };
}

// ── http helpers ──
const SEC_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'x-frame-options': 'DENY',
  'x-robots-tag': 'noindex, nofollow',
};
function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...SEC_HEADERS, ...headers });
  res.end(JSON.stringify(body));
}
function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const json = async (req) => JSON.parse((await readBody(req)).toString('utf8') || '{}');
const writes = new Map(); // 60 writes / minute per IP
function limited(ip) {
  const now = Date.now(), h = (writes.get(ip) || []).filter((t) => now - t < 60_000);
  h.push(now); writes.set(ip, h); return h.length > 60;
}

// Who is calling? 'token' | 'session' | null.  Session writes also need the CSRF header + same Origin.
function whoami(req) {
  const a = String(req.headers.authorization || '');
  if (a.startsWith('Bearer ') && safeEq(a.slice(7), TOKEN)) return { kind: 'token' };
  const s = auth.getSession(req.headers.cookie);
  if (!s) return null;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) return null;
    if (!safeEq(req.headers['x-csrf'] || '', s.csrf)) return null;
  }
  return { kind: 'session', ...s };
}

const ADMIN_FILES = {
  '/admin': ['admin/index.html', 'text/html; charset=utf-8'],
  '/admin/': ['admin/index.html', 'text/html; charset=utf-8'],
  '/admin/admin.js': ['admin/admin.js', 'text/javascript; charset=utf-8'],
  '/admin/admin.css': ['admin/admin.css', 'text/css; charset=utf-8'],
  '/admin/site.css': ['../src/styles/global.css', 'text/css; charset=utf-8'],
};
const ADMIN_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.xml': 'application/xml', '.txt': 'text/plain' };
async function serveStatic(p, res) {
  const root = path.join(RELEASES, 'current');
  const clean = path.normalize(decodeURIComponent(p)).replace(/^(\.\.[/\\])+/, '');
  for (const f of [clean, path.join(clean, 'index.html'), clean + '.html']) {
    const full = path.join(root, f);
    if (!full.startsWith(root)) break;
    try {
      const st = await fs.stat(full);
      if (!st.isFile()) continue;
      res.writeHead(200, { 'content-type': TYPES[path.extname(full)] || 'application/octet-stream' });
      return res.end(await fs.readFile(full));
    } catch {}
  }
  res.writeHead(404, { 'content-type': 'text/html' });
  res.end(await fs.readFile(path.join(root, '404.html')).catch(() => 'not found'));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress);
  try {
    // ── editor static files ──
    if (req.method === 'GET' && ADMIN_FILES[url.pathname]) {
      const [file, type] = ADMIN_FILES[url.pathname];
      const body = await fs.readFile(path.join(HERE, file));
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache', 'content-security-policy': ADMIN_CSP, ...SEC_HEADERS });
      return res.end(body);
    }

    if (url.pathname === '/api/health') return send(res, 200, { ok: true, building: !!building, lastBuild });

    // ── login ──
    if (url.pathname === '/api/login' && req.method === 'POST') {
      if (!PW_HASH) return send(res, 503, { error: 'Login is not set up on the server yet.' });
      if (auth.loginBlocked(ip)) return send(res, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
      const { password = '', code = '' } = await json(req);
      const okPw = await auth.verifyPassword(password, PW_HASH);
      const okCode = TOTP ? auth.verifyTotp(TOTP, String(code).replace(/\s/g, '')) : true;
      if (!okPw || !okCode) {
        auth.recordFail(ip);
        log(`login failed from ${ip}`);
        await sleep(400 + Math.random() * 400);
        return send(res, 401, { error: 'Wrong password or code.' });
      }
      auth.clearFails(ip);
      const s = auth.createSession();
      log(`login ok from ${ip}`);
      const cookie = `${COOKIE}=${s.id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${s.maxAge}${SECURE_COOKIE ? '; Secure' : ''}`;
      return send(res, 200, { ok: true, csrf: s.csrf, twoFactor: !!TOTP }, { 'set-cookie': cookie });
    }
    if (url.pathname === '/api/session' && req.method === 'GET') {
      const s = auth.getSession(req.headers.cookie);
      return send(res, 200, s ? { authed: true, csrf: s.csrf } : { authed: false, configured: !!PW_HASH });
    }
    if (url.pathname === '/api/logout' && req.method === 'POST') {
      const s = auth.getSession(req.headers.cookie);
      if (s) auth.destroySession(s.id);
      return send(res, 200, { ok: true }, { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${SECURE_COOKIE ? '; Secure' : ''}` });
    }

    // ── GitHub webhook ──
    if (url.pathname === '/api/github' && req.method === 'POST') {
      const raw = await readBody(req, 5_000_000);
      const want = 'sha256=' + crypto.createHmac('sha256', GH_SECRET || crypto.randomBytes(32)).update(raw).digest('hex');
      if (!GH_SECRET || !safeEq(req.headers['x-hub-signature-256'] || '', want)) return send(res, 401, { error: 'bad signature' });
      if (req.headers['x-github-event'] === 'ping') return send(res, 200, { pong: true });
      await (gitChain = gitChain.then(() => run('git', ['pull', '--ff-only']).catch((e) => log('git pull failed', e.message))));
      rebuild();
      return send(res, 202, { queued: true });
    }

    // local dev only: serve the built site too, so /admin and the site share an origin (Caddy does this in production)
    if (env.SERVE_STATIC === '1' && req.method === 'GET' && !url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res);

    // ── everything below needs a session or the token ──
    if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
    const who = whoami(req);
    if (!who) return send(res, 401, { error: 'unauthorized' });
    if (req.method !== 'GET' && limited(ip)) return send(res, 429, { error: 'slow down' });

    if (url.pathname === '/api/posts' && req.method === 'GET') {
      const files = (await fs.readdir(POSTS)).filter((f) => f.endsWith('.md'));
      const posts = await Promise.all(files.map(async (f) => {
        const { meta } = parseMarkdown(await fs.readFile(path.join(POSTS, f), 'utf8'));
        return { slug: f.slice(0, -3), title: meta.title || f, date: meta.date || null, draft: meta.draft === true };
      }));
      posts.sort((a, b) => String(b.date).localeCompare(String(a.date)));
      return send(res, 200, { posts });
    }

    const one = /^\/api\/posts\/([^/]+)$/.exec(url.pathname);
    if (one) {
      const slug = decodeURIComponent(one[1]);
      if (!SLUG.test(slug)) return send(res, 400, { error: 'invalid slug' });
      const file = path.join(POSTS, `${slug}.md`);
      if (req.method === 'GET') {
        try { return send(res, 200, { slug, ...parseMarkdown(await fs.readFile(file, 'utf8')) }); }
        catch { return send(res, 404, { error: 'not found' }); }
      }
      if (req.method === 'DELETE') {
        try { await fs.unlink(file); } catch { return send(res, 404, { error: 'not found' }); }
        log(`deleted ${slug} (${who.kind})`);
        gitCommit(`Delete post: ${slug}`, [file]);
        rebuild();
        return send(res, 200, { deleted: slug });
      }
    }

    if (url.pathname === '/api/posts' && req.method === 'POST') {
      const raw = (await readBody(req)).toString('utf8');
      let md, slug, previous = url.searchParams.get('previous');
      if (String(req.headers['content-type'] || '').includes('application/json')) {
        const p = JSON.parse(raw);
        if (!p.title || !String(p.title).trim()) return send(res, 400, { error: 'A title is required.' });
        slug = p.slug || slugify(p.title);
        previous = p.previous || previous;
        md = toMarkdown(p);
      } else {
        const { meta } = parseMarkdown(raw);
        if (!meta.title || !meta.date) return send(res, 400, { error: 'frontmatter needs title and date' });
        slug = url.searchParams.get('slug') || req.headers['x-slug'] || slugify(meta.title);
        md = raw.endsWith('\n') ? raw : raw + '\n';
      }
      if (!SLUG.test(slug)) return send(res, 400, { error: 'Slug can only use a-z, 0-9 and dashes.', slug });
      const file = path.join(POSTS, `${slug}.md`);
      const existed = await fs.stat(file).then(() => true, () => false);
      await fs.writeFile(file, md);
      const touched = [file];
      // renamed in the editor: remove the old file
      if (previous && previous !== slug && SLUG.test(previous)) {
        const old = path.join(POSTS, `${previous}.md`);
        if (await fs.unlink(old).then(() => true, () => false)) touched.push(old);
      }
      log(`${existed ? 'updated' : 'created'} ${slug} (${who.kind})`);
      gitCommit(`${existed ? 'Update' : 'Add'} post: ${slug}`, touched);
      const b = rebuild();
      if (url.searchParams.get('wait') === '1') { await b; return send(res, lastBuild.ok ? 200 : 500, { slug, url: `/blog/${slug}/`, lastBuild }); }
      return send(res, existed ? 200 : 201, { slug, url: `/blog/${slug}/`, building: true });
    }

    if (url.pathname === '/api/preview' && req.method === 'POST') {
      const { body = '' } = await json(req);
      return send(res, 200, { html: await renderMarkdown(String(body)) });
    }

    if (url.pathname === '/api/uploads' && req.method === 'POST') {
      const buf = await readBody(req, 15_000_000);
      const kind = sniff(buf);
      if (!kind) return send(res, 415, { error: 'Only PNG, JPEG, WebP or GIF.' });
      const dither = url.searchParams.get('dither') === '1';
      const out = await processImage(buf, kind, dither);
      const base = slugify(path.parse(url.searchParams.get('name') || 'image').name) || 'image';
      const name = `${base}-${crypto.randomBytes(3).toString('hex')}.${out.ext}`;
      const dir = path.join(UPLOADS, new Date().toISOString().slice(0, 7));
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, name), out.buf);
      const rel = `/uploads/${path.basename(dir)}/${name}`;
      gitCommit(`Add image: ${name}`, [path.join(dir, name)]);
      rebuild();
      return send(res, 201, { url: rel, markdown: `![${base.replace(/-/g, ' ')}](${rel})`, dithered: dither });
    }

    if (url.pathname === '/api/rebuild' && req.method === 'POST') { rebuild(); return send(res, 202, { queued: true }); }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    if (e.status === 413) return send(res, 413, { error: 'Too large.' });
    if (e instanceof SyntaxError) return send(res, 400, { error: 'invalid JSON' });
    log('error', e.stack || e.message);
    send(res, 500, { error: 'internal error' });
  }
});

await fs.mkdir(RELEASES, { recursive: true });
if (!(await fs.stat(path.join(RELEASES, 'current')).then(() => true, () => false))) rebuild(); // first boot
server.listen(PORT, HOST, () => log(`publisher on http://${HOST}:${PORT} · site ${SITE_DIR} · releases ${RELEASES}`));
