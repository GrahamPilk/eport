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
Write an NDEF **URI record** to each card: `https://grahampilkington.com/?c=01`, `?c=02`, …
The home page shows "Card 01 · thanks for tapping". NTAG213 (144 bytes) is plenty.
`https://` is stored as a 1-byte prefix, so keep the rest short. Lock the cards after writing (NFC Tools → "Lock tag") so nobody rewrites them.

## Writing posts

### The editor: `grahampilkington.com/admin`
A private editor built into the publish server. One owner, no database.

- **Login:** password + 6-digit code from an authenticator app (2FA). 5 wrong tries per IP locks it for 15 min; codes can't be reused.
- **Write:** Markdown with a toolbar (Ctrl/Cmd+B, I, K), live preview using the site's own renderer, autosave to the device so a closed tab loses nothing.
- **Images:** button, paste or drag-drop. Metadata (GPS) is stripped; tick **1-bit** to dither them to match the site.
- **Publish / Save draft / Delete:** the site rebuilds in ~2 s and the status light goes solid when it's live. Drafts are saved but not public.
- With `GIT_SYNC=1` every save is committed and pushed to GitHub, so the repo stays the source of truth and you can roll back anything.
- Works on your phone (list → editor, sticky publish bar).

Set it up once on the VPS:
```bash
npm run admin:setup     # asks for a password, prints ADMIN_PASSWORD_HASH, ADMIN_TOTP_SECRET and tokens
```
Paste the output into `/etc/site-publisher.env`, add the setup key to your authenticator app, then `systemctl restart site-publisher`.

Try it locally: put the same lines in `.env`, run `npm run admin:dev`, open http://localhost:8787/admin.

**Extra lock (optional, free):** Cloudflare Zero Trust → Access → add an application for `grahampilkington.com/admin*` and `/api/login`, policy "emails: your address". Then nobody can even reach the login form without a one-time code sent to your email.

### Other ways in
1. **git push:** add a `.md` file to `src/content/blog/` and push. The GitHub webhook makes the VPS pull and rebuild.
2. **API** (for scripts, Shortcuts, or Sentinel later):
   ```bash
   curl -X POST https://grahampilkington.com/api/posts \
     -H "Authorization: Bearer $PUBLISH_TOKEN" -H 'Content-Type: application/json' \
     -d '{"title":"Hello","description":"…","tags":["x"],"body":"Markdown here"}'
   SITE=https://grahampilkington.com PUBLISH_TOKEN=… scripts/publish.sh my-post.md   # raw Markdown file
   ```
   Also `GET /api/posts`, `GET|DELETE /api/posts/:slug`, `POST /api/rebuild`, `GET /api/health`. Add `?wait=1` to block until live.

Builds land in `/srv/site/<timestamp>` and `/srv/site/current` is swapped atomically: the live site never serves a half-built folder, and the last 3 builds are kept (`ln -sfn /srv/site/<old> /srv/site/current` to roll back).

## Deploy (VPS + Cloudflare)

### 1. Cloudflare
1. Domain: `grahampilkington.com` (Cloudflare Registrar, DNS already on Cloudflare).
2. DNS → add `A @ <VPS IPv4>` and `A www <VPS IPv4>` (plus `AAAA` if you have IPv6), **Proxied** (orange cloud).
3. SSL/TLS → Overview → **Full (strict)**.
4. SSL/TLS → Origin Server → **Create certificate** (15 years, `grahampilkington.com, *.grahampilkington.com`). Save as `origin.pem` / `origin.key`.
5. SSL/TLS → Edge Certificates → Always Use HTTPS **on**, Min TLS 1.2, HSTS optional once things work.
6. Speed → turn **off** Rocket Loader (it rewrites inline scripts and breaks the intro). Auto Minify is fine.
7. Caching → Cache Rules: cache everything for `/_astro/*` and `/fonts/*`; leave `/api/*` bypassed (default).

### 1b. Email (free)
Cloudflare → Email → Email Routing: forward `hello@grahampilkington.com` to your real inbox. That's the address the site shows.

### 2. VPS (Debian/Ubuntu)
```bash
# as root
apt install -y caddy git
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs
adduser --disabled-password site && mkdir -p /srv/site && chown site /srv/site
mkdir -p /etc/caddy/certs   # put origin.pem + origin.key here, chmod 600, chown caddy

# as site
su - site
git clone https://github.com/GrahamPilk/eport.git site && cd site && npm ci
# (for GIT_SYNC=1 add a deploy key with write access: GitHub repo → Settings → Deploy keys)

# as root again
cp deploy/Caddyfile /etc/caddy/Caddyfile
npm run admin:setup   # then paste its output into /etc/site-publisher.env and chmod 600 it
cp deploy/publisher.service /etc/systemd/system/site-publisher.service
systemctl daemon-reload && systemctl enable --now site-publisher caddy
curl -X POST -H "Authorization: Bearer <token>" localhost:8787/api/rebuild   # first build
```
Firewall: allow 22, 80, 443 only. Optional hardening: only accept 443 from [Cloudflare IP ranges](https://www.cloudflare.com/ips/).

### 3. GitHub webhook (for git-push publishing)
Repo → Settings → Webhooks → Add: `https://grahampilkington.com/api/github`, content type `application/json`, secret = `GITHUB_WEBHOOK_SECRET`, "Just the push event".

`deploy/nginx.conf` is there if you prefer Nginx over Caddy.

## Design rules (keep it from looking generic)
- Only `--ink` and `--paper`. No opacity, no shadows except hard 1-bit offsets, no gradients except dither masks (`.d25 .d50 .d75`).
- Motion is stepped (`steps()`), never eased fades. Hover = hard invert.
- Pixel font (Silkscreen) only for labels/metadata at small sizes; everything you read is Atkinson Hyperlegible.
- 8px spacing grid, one measure for prose (66ch).
