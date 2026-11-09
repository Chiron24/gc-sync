/*
 * gc-sync generator — turns Substack posts into gilcarrasquero.com essay pages.
 *
 * Runs unchanged in a browser (pass `document`) or in Node with linkedom.
 * Pure function: no network, no filesystem. Input = posts + current live files,
 * output = files to write + images to fetch + a human-readable report.
 *
 * Conventions it relies on (Gil's bilingual Substack posts):
 *   - English first, a single horizontal rule, then Spanish.
 *   - English starts with the note "Para español, scroll hacia abajo."
 *   - Spanish starts with its title line and (usually) its subtitle line.
 *   - Post title / subtitle are "English | Español" (also accepts " / " and " · ").
 * Anything that does not fit is reported and skipped, never published half-done.
 */
(function (root) {
  const SITE = 'https://gilcarrasquero.com';
  const LEAD_NOTE = /^(para espa(ñ|n)ol,?\s*(haz\s*)?scroll hacia abajo|versi(ó|o)n en espa(ñ|n)ol m(á|a)s abajo|spanish version below)/i;
  const SEP = /\s+(?:\||\/|·)\s+/;
  const MONTHS = {
    en: ['January','February','March','April','May','June','July','August','September','October','November','December'],
    es: ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'],
  };

  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const slugify = s => norm(s).replace(/ /g, '-').replace(/-+/g, '-').slice(0, 80).replace(/-$/, '');
  // Madrid calendar date without relying on Intl data being present.
  const madridParts = iso => {
    const d = new Date(iso);
    const y = d.getUTCFullYear();
    const lastSun = m => { const t = new Date(Date.UTC(y, m + 1, 0)); return t.getUTCDate() - t.getUTCDay(); };
    const start = Date.UTC(y, 2, lastSun(2), 1), end = Date.UTC(y, 9, lastSun(9), 1); // DST: last Sun Mar/Oct 01:00 UTC
    const off = (d.getTime() >= start && d.getTime() < end) ? 2 : 1;
    const m = new Date(d.getTime() + off * 3600e3);
    return { y: m.getUTCFullYear(), mo: m.getUTCMonth(), d: m.getUTCDate() };
  };
  const ymd = iso => { const p = madridParts(iso); return `${p.y}-${String(p.mo + 1).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; };
  const fmtDate = (iso, lang) => { const p = madridParts(iso); return lang === 'es' ? `${p.d} de ${MONTHS.es[p.mo]} de ${p.y}` : `${p.d} ${MONTHS.en[p.mo]} ${p.y}`; };

  // https://substackcdn.com/image/fetch/...,/https%3A%2F%2Fsubstack-post-media...png -> raw S3 URL
  const s3 = u => {
    if (!u) return null;
    u = String(u);
    if (/^https:\/\/substack-post-media\.s3\.amazonaws\.com\//.test(u)) return u.split('?')[0];
    const m = u.match(/(https?%3A%2F%2Fsubstack-post-media\.s3\.amazonaws\.com%2F[^,?\s"]+)/i);
    if (m) return decodeURIComponent(m[1]);
    const m2 = u.match(/(https:\/\/substack-post-media\.s3\.amazonaws\.com\/[^,?\s"]+)/);
    return m2 ? m2[1] : null;
  };
  const imgName = u => u.split('/').pop();
  const imgPath = u => '/images/ensayos/' + imgName(u);
  const dims = u => { const m = imgName(u).match(/_(\d+)x(\d+)\.[a-z]+$/i); return m ? [m[1], m[2]] : null; };
  const pagePath = (lang, slug) => lang === 'en' ? `/en/essays/${slug}/` : `/es/ensayos/${slug}/`;
  const idxPath = lang => lang === 'en' ? '/en/essays/' : '/es/ensayos/';
  const canon = u => String(u || '').replace(/[?#].*$/, '').replace(/\/$/, '');

  const T = {
    en: { by: 'By', essays: 'Essays', other: 'Leer en español', otherIdx: 'Ensayos en español', all: '← All essays',
          origin: (d, u) => `Originally published on Substack on ${d}. <a href="${u}" target="_blank" rel="noopener">View the original</a>.`,
          read: 'Read here →', src: 'On Substack ↗',
          coverAlt: t => `Cover image for the essay “${t}”`, bodyAlt: t => `Image from the essay “${t}”` },
    es: { by: 'Por', essays: 'Ensayos', other: 'Read in English', otherIdx: 'Essays in English', all: '← Todos los ensayos',
          origin: (d, u) => `Publicado originalmente en Substack el ${d}. <a href="${u}" target="_blank" rel="noopener">Ver el original</a>.`,
          read: 'Leer en la web →', src: 'Ver en Substack ↗',
          coverAlt: t => `Imagen de portada del ensayo «${t}»`, bodyAlt: t => `Imagen del ensayo «${t}»` },
  };

  function guessLang(text) {
    const t = ' ' + norm(text) + ' ';
    const count = re => (t.match(re) || []).length;
    const es = count(/ (el|la|los|las|que|de|del|y|una|por|para|con|no|es) /g);
    const en = count(/ (the|and|of|to|is|that|in|it|with|for|not|you) /g);
    return es > en ? 'es' : 'en';
  }

  // ---------------------------------------------------------------- body cleaning
  function cleanBody(container, doc, title, lang, images) {
    const kill = '.subscription-widget-wrap, .subscription-widget-wrap-editor, .subscription-widget, .button-wrapper, .share-dialog, .post-ufi, .digest-post-embed, [data-component-name="ButtonCreateButton"], [data-component-name="SubscribeWidgetToDOM"], .install-substack-app-embed, .comment-ref, .paywall-jump';
    container.querySelectorAll(kill).forEach(e => e.remove());

    container.querySelectorAll('.captioned-image-container, figure').forEach(box => {
      if (!box.parentNode) return;
      const img = box.querySelector('img');
      if (!img) { if (box.classList && box.classList.contains('captioned-image-container')) box.remove(); return; }
      let attrs = {};
      try { attrs = JSON.parse(img.getAttribute('data-attrs') || '{}'); } catch (e) {}
      const url = s3(attrs.src) || s3(img.getAttribute('src'));
      if (!url) throw new Error('image with unknown host: ' + img.getAttribute('src'));
      images.set(url, imgPath(url));
      const cap = box.querySelector('figcaption');
      const fig = doc.createElement('figure');
      const ni = doc.createElement('img');
      ni.setAttribute('src', imgPath(url));
      ni.setAttribute('alt', (attrs.alt && String(attrs.alt).trim()) || img.getAttribute('alt') || T[lang].bodyAlt(title));
      const d = dims(url); if (d) { ni.setAttribute('width', d[0]); ni.setAttribute('height', d[1]); }
      ni.setAttribute('loading', 'lazy');
      fig.appendChild(ni);
      if (cap && cap.textContent.trim()) { const fc = doc.createElement('figcaption'); fc.innerHTML = cap.innerHTML; fig.appendChild(fc); }
      box.replaceWith(fig);
    });
    // stray images outside figures
    container.querySelectorAll('img').forEach(img => {
      const src = img.getAttribute('src') || '';
      if (src.startsWith('/images/')) return;
      const url = s3(src);
      if (!url) throw new Error('image with unknown host: ' + src);
      images.set(url, imgPath(url));
      img.setAttribute('src', imgPath(url));
      img.removeAttribute('data-attrs');
      img.setAttribute('loading', 'lazy');
      if (!img.getAttribute('alt')) img.setAttribute('alt', T[lang].bodyAlt(title));
    });
    container.querySelectorAll('[data-attrs]').forEach(e => e.removeAttribute('data-attrs'));
    container.querySelectorAll('[data-component-name]').forEach(e => e.removeAttribute('data-component-name'));
    // empty paragraphs at the end
    let l;
    while ((l = container.lastElementChild) && /^(P|DIV)$/.test(l.tagName) && !l.textContent.trim() && !l.querySelector('img')) l.remove();
    while ((l = container.firstElementChild) && /^(P|DIV)$/.test(l.tagName) && !l.textContent.trim() && !l.querySelector('img')) l.remove();
  }

  const isRule = e => e.tagName === 'HR' || (e.tagName === 'DIV' && e.children.length === 1 && e.firstElementChild.tagName === 'HR' && !e.textContent.trim());
  const txt = e => (e ? e.textContent.replace(/\s+/g, ' ').trim() : '');
  const shortLine = e => e && txt(e).length > 0 && txt(e).length <= 180 && !e.querySelector('img');

  // ---------------------------------------------------------------- split a post
  function splitPost(post, doc) {
    const meta = {
      date: post.post_date, url: canon(post.canonical_url || `https://gilcarrasquero.substack.com/p/${post.slug}`),
      cover: s3(post.cover_image), srcSlug: post.slug,
    };
    const tParts = String(post.title || '').split(SEP);
    const sParts = String(post.subtitle || '').split(SEP);
    const box = doc.createElement('div');
    box.innerHTML = post.body_html || '';
    const kids = [...box.children];
    const rules = kids.map((e, i) => isRule(e) ? i : -1).filter(i => i >= 0);
    const noteIdx = kids.slice(0, 4).findIndex(e => LEAD_NOTE.test(txt(e)));

    if (noteIdx >= 0 && rules.length >= 1) {
      // bilingual. If there are several rules, the language break is the one followed by the Spanish title.
      let cut = rules[0];
      if (rules.length > 1) {
        const want = norm(tParts[1] || '');
        const hit = rules.find(i => want && norm(txt(kids[i + 1])) === want);
        if (hit === undefined) return { error: `several separators and none followed by the Spanish title (${rules.length})`, meta };
        cut = hit;
      }
      const en = doc.createElement('div'), es = doc.createElement('div');
      kids.slice(0, cut).forEach(e => en.appendChild(e));
      kids.slice(cut + 1).forEach(e => es.appendChild(e));
      const notes = [];
      const note = [...en.children].slice(0, 4).find(e => LEAD_NOTE.test(txt(e)));
      notes.push('EN: removed navigation note «' + txt(note) + '»'); note.remove();

      const enTitle = tParts[0].trim();
      const enSub = (sParts[0] || '').trim() || null;
      // EN body sometimes repeats title/subtitle at the top: drop them.
      for (const want of [enTitle, enSub]) {
        const first = [...en.children].find(e => txt(e) || e.querySelector('img'));
        if (want && first && !first.querySelector('img') && norm(txt(first)) === norm(want)) { notes.push('EN: removed repeated line «' + txt(first) + '»'); first.remove(); }
      }

      const esKids = () => [...es.children].filter(e => txt(e) || e.querySelector('img'));
      let first = esKids()[0];
      let esTitle;
      if (tParts[1]) {
        esTitle = tParts[1].trim();
        if (first && norm(txt(first)) === norm(esTitle)) { notes.push('ES: title line moved to page title'); first.remove(); }
        else return { error: `Spanish part does not start with its title «${esTitle}» (found «${txt(first).slice(0, 80)}»)`, meta };
      } else {
        if (!shortLine(first)) return { error: 'cannot find the Spanish title line', meta };
        esTitle = txt(first); notes.push('ES: title taken from first Spanish line «' + esTitle + '»'); first.remove();
      }
      let esSub = null;
      const second = esKids()[0];
      if (sParts[1]) {
        esSub = sParts[1].trim();
        if (second && norm(txt(second)) === norm(esSub)) { notes.push('ES: subtitle line moved to page subtitle'); second.remove(); }
      } else if (shortLine(second) && !/[.!?…»”"]$/.test(txt(second)) && txt(second).length <= 140) {
        esSub = txt(second); notes.push('ES: subtitle taken from second Spanish line «' + esSub + '»'); second.remove();
      }
      const base = { ...meta, split: true, notes };
      const vEn = { ...base, lang: 'en', title: enTitle, sub: enSub, slug: slugify(enTitle), body: en };
      const vEs = { ...base, lang: 'es', title: esTitle, sub: esSub, slug: slugify(esTitle), body: es };
      vEn.counterpart = vEs; vEs.counterpart = vEn;
      return { versions: [vEn, vEs] };
    }
    // single language
    const lang = guessLang(txt(box));
    return { versions: [{ ...meta, split: false, notes: ['single-language post, detected ' + lang], lang, title: tParts[0].trim(), sub: (sParts[0] || '').trim() || null, slug: slugify(tParts[0]), body: box }] };
  }

  // ---------------------------------------------------------------- page rendering from a live template
  function renderPage(v, template, today) {
    const t = T[v.lang];
    const other = v.counterpart ? v.counterpart.path : idxPath(v.lang === 'en' ? 'es' : 'en');
    const otherLabel = v.counterpart ? t.other : t.otherIdx;
    const dateTxt = fmtDate(v.date, v.lang);
    const title = `${v.title} — Gil Carrasquero`;
    const desc = v.sub || v.title;
    const headMeta = `<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="article">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${SITE}${v.path}">
${v.coverLocal ? `<meta property="og:image" content="${SITE}${v.coverLocal}">\n<meta name="twitter:card" content="summary_large_image">\n` : ''}<meta property="article:published_time" content="${v.date}">
<meta name="author" content="Gil Carrasquero">
<meta name="gc:source" content="${v.url}">
<meta name="gc:imported" content="${today}">
${v.counterpart ? `<link rel="alternate" hreflang="${v.counterpart.lang}" href="${SITE}${v.counterpart.path}">\n` : ''}`;
    const flags = `<span class="flags">
          <a href="${other}" title="${esc(otherLabel)}" aria-label="${esc(otherLabel)}" style="font-size:20px;line-height:1;opacity:.85;">${v.lang === 'en' ? '🇪🇸' : '🇬🇧'}</a>
        </span>`;
    const d = v.coverLocal && dims(v.coverLocal);
    const coverFig = v.hasImg || !v.coverLocal ? '' : `<figure class="cover"><img src="${v.coverLocal}"${d ? ` width="${d[0]}" height="${d[1]}"` : ''} alt="${esc(t.coverAlt(v.title))}"></figure>`;
    const article = `<article class="essay">
    <div class="kick"><a href="${idxPath(v.lang)}">${t.essays}</a></div>
    <h1>${esc(v.title)}</h1>
    ${v.sub ? `<p class="dek">${esc(v.sub)}</p>` : ''}
    <div class="meta">${t.by} Gil Carrasquero<span class="sep">·</span><time datetime="${ymd(v.date)}">${dateTxt}</time>${v.counterpart ? `<span class="sep">·</span><a href="${v.counterpart.path}" hreflang="${v.counterpart.lang}">${t.other} →</a>` : ''}</div>
    ${coverFig}
    <div class="essay-body">
${v.bodyHtml}
    </div>
    <div class="origin">
      <p>${t.origin(dateTxt, v.url)}</p>
      <p><a href="${idxPath(v.lang)}">${t.all}</a></p>
    </div>
  </article>`;
    let html = template;
    const a = html.indexOf('<title>'), b = html.indexOf('<link rel="preconnect"');
    if (a < 0 || b < 0) throw new Error('template head not recognised');
    html = html.slice(0, a) + headMeta + html.slice(b);
    html = html.replace(/<span class="flags">[\s\S]*?<\/span>/, flags);
    const s = html.indexOf('<article class="essay">'), e = html.indexOf('</article>');
    if (s < 0 || e < 0) throw new Error('template article not recognised');
    html = html.slice(0, s) + article + html.slice(e + '</article>'.length);
    return html;
  }

  function indexItem(v) {
    const t = T[v.lang]; const d = dims(v.coverLocal);
    return `<li class="essay-item">
        <a href="${v.path}"><img src="${v.coverLocal}"${d ? ` width="${d[0]}" height="${d[1]}"` : ''} loading="lazy" alt="${esc(t.coverAlt(v.title))}"></a>
        <div>
          <h2><a href="${v.path}">${esc(v.title)}</a></h2>
          ${v.sub ? `<p class="isub">${esc(v.sub)}</p>` : ''}
          <div class="idate"><time datetime="${ymd(v.date)}">${fmtDate(v.date, v.lang)}</time></div>
          <div><a class="iread" href="${v.path}">${t.read}</a><a class="isrc" href="${v.url}" target="_blank" rel="noopener">${t.src}</a></div>
        </div>
      </li>`;
  }

  const parseItems = html => {
    const ul = html.match(/<ul class="essay-list">([\s\S]*?)<\/ul>/);
    if (!ul) throw new Error('index list not found');
    return [...ul[1].matchAll(/<li class="essay-item">[\s\S]*?<\/li>/g)].map(m => ({
      html: m[0],
      href: (m[0].match(/<h2><a href="([^"]+)"/) || [])[1],
      date: (m[0].match(/datetime="([^"]+)"/) || [])[1] || '',
      src: canon((m[0].match(/class="isrc" href="([^"]+)"/) || [])[1]),
      cover: (m[0].match(/<img src="([^"]+)"/) || [])[1],
      dims: (m[0].match(/<img src="[^"]+" width="(\d+)" height="(\d+)"/) || []).slice(1),
      title: (m[0].match(/<h2><a href="[^"]+">([^<]*)<\/a>/) || [])[1],
    }));
  };
  const writeItems = (html, items) => html.replace(/<ul class="essay-list">[\s\S]*?<\/ul>/,
    '<ul class="essay-list">\n      ' + items.map(i => i.html).join('\n      ') + '\n    </ul>');

  function homeCards(items, lang) {
    const t = T[lang];
    return items.slice(0, 3).map(i => {
      const alt = t.coverAlt(i.title.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
      const date = (i.html.match(/<time[^>]*>([^<]*)<\/time>/) || [])[1];
      return `          <a class="he-card" href="${i.href}"><img src="${i.cover}"${i.dims.length ? ` width="${i.dims[0]}" height="${i.dims[1]}"` : ''} loading="lazy" alt="${esc(alt)}"><span class="he-t">${i.title}</span><span class="he-d">${date}</span></a>`;
    }).join('\n');
  }

  // ---------------------------------------------------------------- main
  /**
   * @param posts  [{slug,title,subtitle,post_date,canonical_url,cover_image,body_html}]
   * @param live   {'/index.html','/en/essays/index.html','/es/ensayos/index.html', templateEn, templateEs}
   * @param doc    a DOM Document
   * @param today  'YYYY-MM-DD'
   */
  function build({ posts, live, doc, today, force = [] }) {
    const forced = new Set(force.map(f => /^https?:/.test(f) ? canon(f) : `https://gilcarrasquero.substack.com/p/${f}`));
    const report = { added: [], skipped: [], notes: [] };
    const files = {};
    const images = new Map();
    const items = { en: parseItems(live['/en/essays/index.html']), es: parseItems(live['/es/ensayos/index.html']) };
    const have = { en: new Set(items.en.map(i => i.src)), es: new Set(items.es.map(i => i.src)) };
    const srcToPage = { en: {}, es: {} };
    for (const l of ['en', 'es']) for (const i of items[l]) if (i.src) srcToPage[l][i.src] = i.href;
    const taken = { en: new Set(items.en.map(i => i.href)), es: new Set(items.es.map(i => i.href)) };

    const versions = [];
    for (const p of posts) {
      const url = canon(p.canonical_url || `https://gilcarrasquero.substack.com/p/${p.slug}`);
      const isForced = forced.has(url);
      if (have.en.has(url) && have.es.has(url) && !isForced) continue;
      const r = splitPost(p, doc);
      if (r.error) { report.skipped.push({ post: p.title, url, why: r.error }); continue; }
      for (const v of r.versions) {
        if (have[v.lang].has(url) && isForced) {
          // refresh: rebuild at the same address, replace its index entry
          v.path = srcToPage[v.lang][url];
          items[v.lang] = items[v.lang].filter(i => i.src !== url);
          v.refreshed = true;
          versions.push(v);
          continue;
        }
        if (have[v.lang].has(url)) { if (v.counterpart) v.counterpart.counterpart = { lang: v.lang, path: srcToPage[v.lang][url] }; continue; }
        let path = pagePath(v.lang, v.slug), n = 2;
        while (taken[v.lang].has(path)) path = pagePath(v.lang, `${v.slug}-${n++}`);
        v.path = path; taken[v.lang].add(path); srcToPage[v.lang][url] = path;
        versions.push(v);
      }
    }
    for (const v of versions) {
      const local = new Map();
      cleanBody(v.body, doc, v.title, v.lang, local);
      for (const [u, pth] of local) images.set(u, pth);
      v.body.querySelectorAll('a[href]').forEach(a => {
        const h = canon(a.getAttribute('href'));
        if (srcToPage[v.lang][h]) a.setAttribute('href', srcToPage[v.lang][h]);
        else if (/^https?:/.test(a.getAttribute('href'))) { a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener'); }
      });
      v.hasImg = !!v.body.querySelector('img');
      const cover = v.cover || s3((v.body.querySelector('img') || {}).getAttribute?.('src'));
      if (v.cover) images.set(v.cover, imgPath(v.cover));
      v.coverLocal = cover ? (cover.startsWith('/images/') ? cover : imgPath(cover)) : null;
      v.bodyHtml = v.body.innerHTML;
      v.paragraphs = v.body.querySelectorAll('p').length;
      v.chars = txt(v.body).length;
      if (v.chars < 400) { report.skipped.push({ post: v.title, url: v.url, why: 'body too short after cleaning (' + v.chars + ' chars) — probably paywalled or empty' }); v.skip = true; continue; }
    }
    const live2 = versions.filter(v => !v.skip);
    for (const v of live2) {
      files[v.path + 'index.html'] = renderPage(v, v.lang === 'en' ? live.templateEn : live.templateEs, today);
      items[v.lang].push({ html: indexItem(v), href: v.path, date: ymd(v.date), src: v.url, cover: v.coverLocal, dims: dims(v.coverLocal) || [], title: esc(v.title) });
      report.added.push({ refreshed: !!v.refreshed, lang: v.lang, title: v.title, sub: v.sub, date: ymd(v.date), path: v.path, source: v.url, paragraphs: v.paragraphs, chars: v.chars, images: v.body.querySelectorAll('img').length, notes: v.notes });
    }
    if (!live2.length) return { files, images: [], report };

    for (const l of ['en', 'es']) {
      items[l].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      const p = idxPath(l) + 'index.html';
      files[p] = writeItems(live[p], items[l]);
    }
    let home = live['/index.html'];
    for (const l of ['en', 'es']) {
      const re = new RegExp(`(<div class="he-grid he-${l}">)[\\s\\S]*?(\\n\\s*<\\/div>)`);
      if (!re.test(home)) throw new Error('home essays grid not found for ' + l);
      home = home.replace(re, `$1\n${homeCards(items[l], l)}$2`);
    }
    files['/index.html'] = home;
    return { files, images: [...images.entries()].map(([url, path]) => ({ url, path })), report };
  }

  const api = { build, splitPost, fmtDate, ymd, slugify, s3, SITE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.GCSync = api;
})(typeof window !== 'undefined' ? window : globalThis);
