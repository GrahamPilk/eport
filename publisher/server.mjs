#!/usr/bin/env node
// Tiny zero-dependency publish API for the site.
//
//   POST   /api/posts          create/replace a post (JSON or raw Markdown)
//   GET    /api/posts          list posts
//   DELETE /api/posts/:slug    delete a post
//   POST   /api/rebuild        rebuild now
//   POST   /api/github         GitHub push webhook → git pull + rebuild (HMAC verified)
//   GET    /api/health
//
// Auth: "Authorization: Bearer $PUBLISH_TOKEN" (GitHub hook uses $GITHUB_WEBHOOK_SECRET).
// Builds go to $RELEASES/<timestamp>; $RELEASES/current is swapped atomically, so the
// live site never serves a half-built folder. Caddy/Nginx serve $RELEASES/current.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const env = process.env;
const PORT = Number(env.PORT || 8787);
const HOST = env.HOST || '127.0.0.1';
const SITE_DIR = path.resolve(env.SITE_DIR || process.cwd());
const RELEASES = path.resolve(env.RELEASES || '/srv/site');
const TOKEN = env.PUBLISH_TOKEN || '';
const GH_SECRET = env.GITHUB_WEBHOOK_SECRET || '';
const GIT_SYNC = env.GIT_SYNC === '1'; // commit + push posts that arrive via the API
const KEEP = Number(env.KEEP_RELEASES || 3);
const POSTS = path.join(SITE_DIR, 'src/content/blog');
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;

if (TOKEN.length < 32) { console.error('PUBLISH_TOKEN must be set (>= 32 chars). Try: openssl rand -hex 32'); process.exit(1); }

const log = (...a) => console.log(new Date().toISOString(), ...a);
const safeEq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: SITE_DIR, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}\n${out.slice(-2000)}`))));
  });
}

// ── build queue: one build at a time; requests during a build coalesce into one follow-up ──
let building = null, again = false, lastBuild = { ok: null, at: null, ms: 0, error: null };
function rebuild() {
  if (building) { again = true; return building; }
  building = (async () => {
    const t = Date.now(), out = path.join(RELEASES, String(t));
    try {
      await run('npx', ['astro', 'build', '--outDir', out]);
      const tmp = path.join(RELEASES, `.current-${t}`);
      await fs.symlink(out, tmp);
      await fs.rename(tmp, path.join(RELEASES, 'current')); // atomic swap
      const old = (await fs.readdir(RELEASES)).filter((n) => /^\d+$/.test(n)).sort().slice(0, -KEEP);
      await Promise.all(old.map((n) => fs.rm(path.join(RELEASES, n), { recursive: true, force: true })));
      lastBuild = { ok: true, at: new Date().toISOString(), ms: Date.now() - t, error: null };
      log(`build ok in ${lastBuild.ms}ms → ${out}`);
    } catch (e) {
      await fs.rm(out, { recursive: true, force: true }).catch(() => {});
      lastBuild = { ok: false, at: new Date().toISOString(), ms: Date.now() - t, error: e.message.slice(0, 500) };
      log('build FAILED', e.message);
    } finally {
      building = null;
      if (again) { again = false; rebuild(); }
    }
  })();
  return building;
}

async function gitCommit(msg, files) {
  if (!GIT_SYNC) return;
  try {
    await run('git', ['add', '-A', '--', ...files]);
    await run('git', ['-c', 'user.name=publisher', '-c', 'user.email=publisher@localhost', 'commit', '-m', msg]);
    await run('git', ['push']);
  } catch (e) { log('git sync failed (post is still live):', e.message.split('\n')[0]); }
}

// ── frontmatter helpers (JSON strings are valid YAML, so no YAML lib needed) ──
const q = (s) => JSON.stringify(String(s));
function toMarkdown(p) {
  const fm = [
    `title: ${q(p.title)}`,
    `description: ${q(p.description || '')}`,
    `date: ${new Date(p.date || Date.now()).toISOString().slice(0, 10)}`,
    p.updated ? `updated: ${new Date(p.updated).toISOString().slice(0, 10)}` : null,
    `tags: [${(p.tags || []).map(q).join(', ')}]`,
    `draft: ${p.draft === true}`,
  ].filter(Boolean);
  return `---\n${fm.join('\n')}\n---\n\n${String(p.body || '').trim()}\n`;
}
const slugify = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
function parseRaw(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) return {};
  const t = /^title:\s*(.+)$/m.exec(m[1]);
  return { title: t ? t[1].trim().replace(/^["']|["']$/g, '') : undefined, hasDate: /^date:/m.test(m[1]) };
}

// ── http ──
const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('too large'), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const hits = new Map(); // naive per-IP rate limit: 30 writes / minute
function limited(ip) {
  const now = Date.now(), h = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  h.push(now); hits.set(ip, h); return h.length > 30;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress;
  try {
    if (url.pathname === '/api/health') return send(res, 200, { ok: true, building: !!building, lastBuild });

    if (url.pathname === '/api/github' && req.method === 'POST') {
      const raw = await readBody(req);
      const sig = String(req.headers['x-hub-signature-256'] || '');
      const want = 'sha256=' + crypto.createHmac('sha256', GH_SECRET).update(raw).digest('hex');
      if (!GH_SECRET || !safeEq(sig, want)) return send(res, 401, { error: 'bad signature' });
      if (req.headers['x-github-event'] === 'ping') return send(res, 200, { pong: true });
      await run('git', ['pull', '--ff-only']);
      rebuild();
      return send(res, 202, { queued: true });
    }

    // everything else needs the bearer token
    const auth = String(req.headers.authorization || '');
    if (!auth.startsWith('Bearer ') || !safeEq(auth.slice(7), TOKEN)) return send(res, 401, { error: 'unauthorized' });
    if (req.method !== 'GET' && limited(ip)) return send(res, 429, { error: 'slow down' });

    if (url.pathname === '/api/posts' && req.method === 'GET') {
      const files = (await fs.readdir(POSTS)).filter((f) => f.endsWith('.md'));
      return send(res, 200, { posts: files.map((f) => f.slice(0, -3)) });
    }

    if (url.pathname === '/api/posts' && req.method === 'POST') {
      const raw = (await readBody(req)).toString('utf8');
      const type = String(req.headers['content-type'] || '');
      let md, slug;
      if (type.includes('application/json')) {
        const p = JSON.parse(raw);
        if (!p.title || !p.body) return send(res, 400, { error: 'title and body are required' });
        slug = p.slug || slugify(p.title);
        md = toMarkdown(p);
      } else {
        // raw Markdown with frontmatter (text/markdown or text/plain)
        const meta = parseRaw(raw);
        if (!meta.title || !meta.hasDate) return send(res, 400, { error: 'frontmatter needs title and date' });
        slug = url.searchParams.get('slug') || req.headers['x-slug'] || slugify(meta.title);
        md = raw.endsWith('\n') ? raw : raw + '\n';
      }
      if (!SLUG.test(slug)) return send(res, 400, { error: 'invalid slug', slug });
      const file = path.join(POSTS, `${slug}.md`);
      const existed = await fs.stat(file).then(() => true, () => false);
      await fs.writeFile(file, md);
      log(`${existed ? 'updated' : 'created'} ${slug} from ${ip}`);
      gitCommit(`post: ${slug}`, [file]);
      const wait = url.searchParams.get('wait') === '1';
      const b = rebuild();
      if (wait) { await b; return send(res, lastBuild.ok ? 200 : 500, { slug, url: `/blog/${slug}/`, lastBuild }); }
      return send(res, existed ? 200 : 201, { slug, url: `/blog/${slug}/`, building: true });
    }

    const del = /^\/api\/posts\/([^/]+)$/.exec(url.pathname);
    if (del && req.method === 'DELETE') {
      const slug = decodeURIComponent(del[1]);
      if (!SLUG.test(slug)) return send(res, 400, { error: 'invalid slug' });
      const file = path.join(POSTS, `${slug}.md`);
      try { await fs.unlink(file); } catch { return send(res, 404, { error: 'not found' }); }
      log(`deleted ${slug}`);
      gitCommit(`delete post: ${slug}`, [file]);
      rebuild();
      return send(res, 200, { deleted: slug });
    }

    if (url.pathname === '/api/rebuild' && req.method === 'POST') { rebuild(); return send(res, 202, { queued: true }); }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    if (e.code === 413) return send(res, 413, { error: 'body too large (1 MB max)' });
    if (e instanceof SyntaxError) return send(res, 400, { error: 'invalid JSON' });
    log('error', e.message);
    send(res, 500, { error: 'internal error' });
  }
});

await fs.mkdir(RELEASES, { recursive: true });
server.listen(PORT, HOST, () => log(`publisher on http://${HOST}:${PORT} · site ${SITE_DIR} · releases ${RELEASES}`));
