// Editor client. No framework, no build step.
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const loginEl = $('#login'), appEl = $('#app'), form = $('.doc');
  const F = (n) => form.elements[n];
  let csrf = '', current = null, saved = '', posts = [], previewTimer = 0, pollTimer = 0;

  // ── api ──
  async function api(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (opts.json !== undefined) { headers['content-type'] = 'application/json'; opts.body = JSON.stringify(opts.json); }
    if (opts.method && opts.method !== 'GET') headers['x-csrf'] = csrf;
    const r = await fetch(path, { ...opts, headers, credentials: 'same-origin' });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401 && !path.endsWith('/login')) { showLogin(); throw new Error('Signed out'); }
    if (!r.ok) throw new Error(data.error || `Error ${r.status}`);
    return data;
  }

  // ── login ──
  function showLogin(msg = '') {
    appEl.hidden = true; loginEl.hidden = false;
    $('.error', loginEl).textContent = msg;
    $('input[name=password]', loginEl).focus();
  }
  $('form', loginEl).addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target, btn = $('button', f), err = $('.error', f);
    err.textContent = ''; btn.disabled = true; btn.textContent = 'Checking…';
    try {
      const r = await api('/api/login', { method: 'POST', json: { password: f.password.value, code: f.code.value } });
      csrf = r.csrf; f.reset(); start();
    } catch (x) { err.textContent = x.message; f.code.value = ''; f.code.focus(); }
    finally { btn.disabled = false; btn.textContent = 'Sign in'; }
  });

  // ── list ──
  async function loadList() {
    posts = (await api('/api/posts')).posts;
    const ol = $('.posts');
    ol.replaceChildren(...posts.map((p) => {
      const li = document.createElement('li'), b = document.createElement('button');
      b.type = 'button'; b.dataset.slug = p.slug;
      b.setAttribute('aria-current', String(current?.slug === p.slug));
      const t = document.createElement('span'); t.className = 't'; t.textContent = p.title;
      const m = document.createElement('span'); m.className = 'm px'; m.textContent = (p.date || '').replaceAll('-', '.');
      if (p.draft) { const d = document.createElement('span'); d.className = 'tag'; d.textContent = 'Draft'; m.append(d); }
      b.append(t, m); li.append(b); return li;
    }));
  }
  $('.posts').addEventListener('click', (e) => { const b = e.target.closest('button[data-slug]'); if (b) open(b.dataset.slug); });

  // ── doc ──
  const today = () => new Date().toLocaleDateString('en-CA');
  const values = () => ({
    title: F('title').value.trim(), slug: F('slug').value.trim(), date: F('date').value,
    tags: F('tags').value.split(',').map((s) => s.trim()).filter(Boolean), description: F('description').value.trim(), body: F('body').value,
  });
  const snapshot = () => JSON.stringify(values());
  const dirty = () => current && snapshot() !== saved;
  const slugify = (s) => s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);

  function fill(p) {
    F('title').value = p.meta?.title || ''; F('slug').value = p.slug || ''; F('date').value = p.meta?.date || today();
    F('tags').value = (p.meta?.tags || []).join(', '); F('description').value = p.meta?.description || ''; F('body').value = p.body || '';
    autosize(F('title'));
  }
  async function open(slug) {
    if (dirty() && !confirm('Discard unsaved changes?')) return;
    try {
      const p = slug ? await api(`/api/posts/${encodeURIComponent(slug)}`) : { slug: '', meta: {}, body: '' };
      current = { slug: p.slug, isNew: !slug, draft: p.meta?.draft === true };
      fill(p); saved = snapshot();
      $('.empty').hidden = true; form.hidden = false; appEl.classList.add('editing');
      autosize(F('title'));
      $('.meta').open = !slug || innerWidth > 860; // keep the body in view on phones
      $('[data-action=delete]').hidden = !slug;
      setStatus(slug ? (current.draft ? 'Draft' : 'Published') : 'New post');
      offerRestore();
      $$('.posts button').forEach((b) => b.setAttribute('aria-current', String(b.dataset.slug === slug)));
      (slug ? F('body') : F('title')).focus({ preventScroll: true });
      if ($('.panes').dataset.view !== 'write') renderPreview();
    } catch (x) { setStatus(x.message); }
  }

  async function save(publish) {
    const v = values();
    if (!v.title) { F('title').focus(); return setStatus('Add a title first'); }
    if (!v.slug) v.slug = slugify(v.title);
    const draft = publish === undefined ? current.draft : !publish;
    setBusy(true);
    try {
      const r = await api('/api/posts', { method: 'POST', json: { ...v, draft, previous: current.slug || undefined } });
      current = { slug: r.slug, isNew: false, draft };
      F('slug').value = r.slug; saved = snapshot();
      try { localStorage.removeItem(key()); } catch {}
      $('[data-action=delete]').hidden = false;
      setStatus(draft ? 'Saved as draft (not public)' : 'Published, building…');
      await loadList();
      watchBuild(draft ? null : r.url);
    } catch (x) { setStatus(x.message); }
    finally { setBusy(false); }
  }

  async function del() {
    if (!current?.slug || !confirm(`Delete “${F('title').value}”? This removes it from the site.`)) return;
    try {
      await api(`/api/posts/${encodeURIComponent(current.slug)}`, { method: 'DELETE' });
      try { localStorage.removeItem(key()); } catch {}
      current = null; form.hidden = true; $('.empty').hidden = false; appEl.classList.remove('editing');
      await loadList(); watchBuild(null);
    } catch (x) { setStatus(x.message); }
  }

  // ── build status ──
  const bar = $('.build');
  function setBuild(state, text) { bar.dataset.state = state; $('.build-text', bar).textContent = text; }
  function watchBuild(url) {
    clearTimeout(pollTimer);
    setBuild('building', 'Building');
    const started = Date.now();
    const tick = async () => {
      try {
        const h = await (await fetch('/api/health')).json();
        if (h.building || !h.lastBuild?.at || new Date(h.lastBuild.at) < started - 500) { pollTimer = setTimeout(tick, 700); return; }
        if (h.lastBuild.ok) {
          setBuild('live', `Live · ${(h.lastBuild.ms / 1000).toFixed(1)}s`);
          if (url) setStatus('Published. ', url);
        } else {
          setBuild('error', 'Build failed');
          setStatus('Build failed. The previous version is still live. Check the Markdown, or: journalctl -u site-publisher');
        }
      } catch { pollTimer = setTimeout(tick, 1500); }
    };
    pollTimer = setTimeout(tick, 600);
  }

  // ── status line ──
  function setStatus(text, link) {
    const s = $('.status'); s.textContent = text;
    if (link) { const a = document.createElement('a'); a.href = link; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'View post ↗'; s.append(a); }
  }
  function setBusy(b) { $$('.actions .btn').forEach((x) => (x.disabled = b)); }

  // ── local autosave (survives a closed tab / dead battery) ──
  const key = () => `editor:${current?.slug || 'new'}`;
  let autosaveTimer = 0;
  form.addEventListener('input', (e) => {
    if (e.target === F('title')) { autosize(F('title')); if (current?.isNew && !F('slug').dataset.touched) F('slug').value = slugify(F('title').value); }
    if (e.target === F('slug')) F('slug').dataset.touched = '1';
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => { try { if (dirty()) localStorage.setItem(key(), JSON.stringify({ at: Date.now(), v: values() })); } catch {} }, 600);
    if (e.target === F('body') && $('.panes').dataset.view !== 'write') { clearTimeout(previewTimer); previewTimer = setTimeout(renderPreview, 350); }
  });
  function offerRestore() {
    let local = null; try { local = JSON.parse(localStorage.getItem(key()) || 'null'); } catch {}
    $('.restore').hidden = !(local && JSON.stringify(local.v) !== saved);
  }
  function restore() {
    try {
      const { v } = JSON.parse(localStorage.getItem(key()));
      fill({ slug: v.slug, meta: { title: v.title, date: v.date, tags: v.tags, description: v.description }, body: v.body });
    } catch {}
    $('.restore').hidden = true;
  }
  addEventListener('beforeunload', (e) => { if (dirty()) { e.preventDefault(); e.returnValue = ''; } });

  // ── preview (same renderer as the live site, sandboxed: no scripts run) ──
  async function renderPreview() {
    const frame = $('.preview');
    try {
      const { html } = await api('/api/preview', { method: 'POST', json: { body: F('body').value } });
      const theme = document.documentElement.dataset.theme ? ` data-theme="${document.documentElement.dataset.theme}"` : '';
      const title = F('title').value.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
      frame.srcdoc = `<!doctype html><html${theme}><head><meta charset="utf-8"><base target="_blank"><link rel="stylesheet" href="/admin/site.css">
        <style>body{display:block;padding:8px 24px 48px}h1{font-size:var(--step-3);line-height:1.05;letter-spacing:-.03em;margin:8px 0 32px}</style></head>
        <body><h1>${title}</h1><div class="prose">${html}</div></body></html>`;
    } catch (x) { frame.srcdoc = `<p>${x.message}</p>`; }
  }
  function setView(v) {
    const panes = $('.panes');
    const wide = matchMedia('(min-width: 1200px)').matches;
    panes.dataset.view = v === 'preview' && wide ? 'split' : v;
    $$('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === v)));
    if (v === 'preview') renderPreview();
  }

  // ── markdown helpers ──
  function wrap(before, after = before, placeholder = '') {
    const t = F('body'), s = t.selectionStart, e = t.selectionEnd, sel = t.value.slice(s, e) || placeholder;
    t.setRangeText(before + sel + after, s, e, 'end');
    t.setSelectionRange(s + before.length, s + before.length + sel.length);
    t.focus(); t.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function linePrefix(prefix) {
    const t = F('body'), s = t.value.lastIndexOf('\n', t.selectionStart - 1) + 1;
    t.setRangeText(prefix, s, s, 'end'); t.focus(); t.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const MD = {
    bold: () => wrap('**', '**', 'bold'), italic: () => wrap('_', '_', 'italic'), h2: () => linePrefix('## '),
    quote: () => linePrefix('> '), list: () => linePrefix('- '), code: () => wrap('\n```\n', '\n```\n', 'code'),
    link: () => { const url = prompt('Link URL', 'https://'); if (url) wrap('[', `](${url})`, 'link text'); },
  };
  $('.toolbar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-md]'); if (b) MD[b.dataset.md]();
    const tab = e.target.closest('[data-tab]'); if (tab) setView(tab.dataset.tab);
  });
  F('body').addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === 'b') { e.preventDefault(); MD.bold(); }
    if (mod && e.key === 'i') { e.preventDefault(); MD.italic(); }
    if (mod && e.key === 'k') { e.preventDefault(); MD.link(); }
  });
  addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 's' && current) { e.preventDefault(); save(); } });

  // image upload (also accepts paste and drag-drop into the body)
  async function upload(file) {
    if (!file || !file.type.startsWith('image/')) return;
    const dither = $('.dither input').checked;
    setStatus(`Uploading ${file.name}…`);
    try {
      const r = await api(`/api/uploads?name=${encodeURIComponent(file.name)}${dither ? '&dither=1' : ''}`, { method: 'POST', body: file, headers: { 'content-type': file.type } });
      wrap('\n' + r.markdown + '\n', '', '');
      setStatus(`Image added${r.dithered ? ' (1-bit)' : ''}. It shows on the site after the next build.`);
      watchBuild(null);
    } catch (x) { setStatus(x.message); }
  }
  $('.upload input').addEventListener('change', (e) => { upload(e.target.files[0]); e.target.value = ''; });
  F('body').addEventListener('paste', (e) => { const f = [...(e.clipboardData?.files || [])][0]; if (f) { e.preventDefault(); upload(f); } });
  F('body').addEventListener('drop', (e) => { const f = e.dataTransfer?.files?.[0]; if (f) { e.preventDefault(); upload(f); } });

  // ── actions ──
  document.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-action]')?.dataset.action;
    if (!a) return;
    if (a === 'new') open(null);
    if (a === 'publish') save(true);
    if (a === 'draft') save(false);
    if (a === 'delete') del();
    if (a === 'restore') restore();
    if (a === 'discard') { try { localStorage.removeItem(key()); } catch {} $('.restore').hidden = true; }
    if (a === 'back') { if (dirty() && !confirm('Discard unsaved changes?')) return; current = null; appEl.classList.remove('editing'); form.hidden = true; $('.empty').hidden = false; }
    if (a === 'logout') { await api('/api/logout', { method: 'POST' }).catch(() => {}); csrf = ''; showLogin(); }
  });

  function autosize(t) { t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; }

  // ── boot ──
  async function start() {
    loginEl.hidden = true; appEl.hidden = false;
    try { await loadList(); } catch {}
    const h = await (await fetch('/api/health')).json().catch(() => ({}));
    if (h.lastBuild?.ok === false) setBuild('error', 'Last build failed'); else setBuild('live', 'Live');
  }
  (async () => {
    try { const t = localStorage.getItem('theme'); if (t) document.documentElement.dataset.theme = t; } catch {}
    const s = await fetch('/api/session').then((r) => r.json()).catch(() => ({}));
    if (s.authed) { csrf = s.csrf; start(); }
    else showLogin(s.configured === false ? 'Login is not set up yet. Run: node publisher/setup.mjs' : '');
  })();
})();
