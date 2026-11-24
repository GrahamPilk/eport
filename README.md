# Personal site — 1-bit dither

Astro static site. Two colours only; greys are ordered (8×8 Bayer) dither patterns.
Mobile-first, because most visits come from NFC card taps.

## Quick start
```bash
npm install
npm run dev          # http://localhost:4321  (add ?intro to replay the intro)
npm run build        # → dist/
```

## Make it yours (10 minutes)
| What | Where |
|---|---|
| Name, role, tagline, email, links, domain | `src/site.config.mjs` |
| Blog posts | `src/content/blog/*.md` |
| Projects / case studies | `src/content/work/*.md` (`order` sets position) |
| About page copy | `src/pages/about.astro` |
| Social preview image | `node scripts/og.cjs` (re-run after changing your name) |
| Photos → 1-bit | `npm run dither -- me.jpg public/img/me.png 640` |

Post frontmatter:
```yaml
---
title: "My post"
description: "One line for lists, RSS and link previews"
date: 2026-11-24
tags: ["nfc"]
draft: false
---
```

## The intro
- Plays on the home page, **once per browser session**, ~1.5 s. Tap, click, scroll or any key skips it.
- Never plays with `prefers-reduced-motion`, without JS, or on deep links (blog posts open instantly).
- Page content is already rendered underneath, so first paint is not delayed; a CSS failsafe removes the overlay after 4.5 s even if JS dies.
- On phones the dither wave starts at the bottom edge (where the card meets the phone); on desktop from the centre.

## NFC cards
Write an NDEF **URI record** to each card: `https://example.com/?c=01`, `?c=02`, …
The home page shows "Card 01 · thanks for tapping". NTAG213 (144 bytes) is plenty.
`https://` is stored as a 1-byte prefix, so keep the rest short. Lock the cards after writing (NFC Tools → "Lock tag") so nobody rewrites them.

## Publishing posts
Three ways, pick any:

1. **git push** — add a `.md` file to `src/content/blog/`, push to GitHub. A GitHub webhook hits the VPS, which pulls and rebuilds (~2 s).
2. **API** — anything that can make an HTTP request (Sentinel, Shortcuts, n8n, a script):
   ```bash
   # JSON
   curl -X POST https://example.com/api/posts \
     -H "Authorization: Bearer $PUBLISH_TOKEN" -H 'Content-Type: application/json' \
     -d '{"title":"Hello","description":"…","tags":["x"],"body":"Markdown here"}'
   # or raw Markdown with frontmatter
   SITE=https://example.com PUBLISH_TOKEN=… scripts/publish.sh my-post.md
   ```
   Also: `GET /api/posts`, `DELETE /api/posts/:slug`, `POST /api/rebuild`, `GET /api/health`.
   Add `?wait=1` to block until the site is rebuilt. With `GIT_SYNC=1` API posts are committed and pushed back to the repo, so git stays the source of truth.
3. **Edit on GitHub.com** — same as (1), from your phone.

Builds land in `/srv/site/<timestamp>` and `/srv/site/current` is swapped atomically: the live site never serves a half-built folder, and the last 3 builds are kept for rollback (`ln -sfn /srv/site/<old> /srv/site/current`).

## Deploy (VPS + Cloudflare)

### 1. Cloudflare
1. Buy the domain in Cloudflare Registrar (DNS is set up automatically).
2. DNS → add `A @ <VPS IPv4>` and `A www <VPS IPv4>` (plus `AAAA` if you have IPv6), **Proxied** (orange cloud).
3. SSL/TLS → Overview → **Full (strict)**.
4. SSL/TLS → Origin Server → **Create certificate** (15 years, `example.com, *.example.com`). Save as `origin.pem` / `origin.key`.
5. SSL/TLS → Edge Certificates → Always Use HTTPS **on**, Min TLS 1.2, HSTS optional once things work.
6. Speed → turn **off** Rocket Loader (it rewrites inline scripts and breaks the intro). Auto Minify is fine.
7. Caching → Cache Rules: cache everything for `/_astro/*` and `/fonts/*`; leave `/api/*` bypassed (default).

### 2. VPS (Debian/Ubuntu)
```bash
# as root
apt install -y caddy git
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs
adduser --disabled-password site && mkdir -p /srv/site && chown site /srv/site
mkdir -p /etc/caddy/certs   # put origin.pem + origin.key here, chmod 600, chown caddy

# as site
su - site
git clone https://github.com/<you>/<repo>.git site && cd site && npm ci
# (for GIT_SYNC=1 add a deploy key with write access: GitHub repo → Settings → Deploy keys)

# as root again
cp deploy/Caddyfile /etc/caddy/Caddyfile        # edit the domain
cp .env.example /etc/site-publisher.env && chmod 600 /etc/site-publisher.env   # fill in tokens
cp deploy/publisher.service /etc/systemd/system/site-publisher.service
systemctl daemon-reload && systemctl enable --now site-publisher caddy
curl -X POST -H "Authorization: Bearer <token>" localhost:8787/api/rebuild   # first build
```
Firewall: allow 22, 80, 443 only. Optional hardening: only accept 443 from [Cloudflare IP ranges](https://www.cloudflare.com/ips/).

### 3. GitHub webhook (for git-push publishing)
Repo → Settings → Webhooks → Add: `https://example.com/api/github`, content type `application/json`, secret = `GITHUB_WEBHOOK_SECRET`, "Just the push event".

`deploy/nginx.conf` is there if you prefer Nginx over Caddy.

## Design rules (keep it from looking generic)
- Only `--ink` and `--paper`. No opacity, no shadows except hard 1-bit offsets, no gradients except dither masks (`.d25 .d50 .d75`).
- Motion is stepped (`steps()`), never eased fades. Hover = hard invert.
- Pixel font (Silkscreen) only for labels/metadata at small sizes; everything you read is Atkinson Hyperlegible.
- 8px spacing grid, one measure for prose (66ch).
