#!/usr/bin/env node
/*
 * gc-sync — keeps gilcarrasquero.com in step with Gil's Substack.
 *
 *   1. Reads the newest posts on Substack (API, with RSS as fallback).
 *   2. Reads the live essay indexes on gilcarrasquero.com to see what is already there.
 *   3. For each post that is missing, builds the English and Spanish pages
 *      (lib/generator.js — the same code used for the manual catch-up of Nov 2026).
 *   4. Creates a Netlify deploy = the CURRENT production files + the new/updated ones.
 *      Nothing else on the site is touched; every deploy can be rolled back in Netlify.
 *   5. Writes a report (report.json + the Actions run summary).
 *
 * Environment:
 *   NETLIFY_AUTH_TOKEN   Netlify personal access token (GitHub secret)       — required unless MODE=dry-run
 *   NETLIFY_SITE_ID      Netlify site id (optional; found by domain otherwise)
 *   MODE                 production (default) | draft | dry-run
 *   REFRESH              optional: Substack slugs or URLs to rebuild even if already on the site
 *   SINCE                optional: ignore posts published before this date (YYYY-MM-DD). Default 2026-05-01.
 */
'use strict';
const fs = require('fs');
const crypto = require('crypto');
const { parseHTML, DOMParser } = require('linkedom');
const G = require('../lib/generator.js');

const SUBSTACK = 'https://gilcarrasquero.substack.com';
const SITE = 'https://gilcarrasquero.com';
const DOMAIN = 'gilcarrasquero.com';
const API = 'https://api.netlify.com/api/v1';
const MODE = (process.env.MODE || 'production').trim();
const REFRESH = (process.env.REFRESH || '').split(/[\s,]+/).filter(Boolean);
const SINCE = process.env.SINCE || '2026-05-01';
const TOKEN = process.env.NETLIFY_AUTH_TOKEN;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36 gc-sync';
const TEMPLATE = { en: '/en/essays/sicily-and-us/', es: '/es/ensayos/nosotros-y-sicilia/' };

const log = (...a) => console.log('[gc-sync]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha1 = buf => crypto.createHash('sha1').update(buf).digest('hex');
const madridToday = () => G.ymd(new Date().toISOString());

async function get(url, { as = 'text', tries = 4, headers = {} } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, ...headers } });
      if (r.ok) return as === 'json' ? r.json() : as === 'buffer' ? Buffer.from(await r.arrayBuffer()) : r.text();
      last = new Error(`${url} -> HTTP ${r.status}`);
      if (r.status === 404) break;
    } catch (e) { last = e; }
    await sleep(1500 * (i + 1));
  }
  throw last;
}

async function netlify(path, opts = {}) {
  const r = await fetch(API + path, { ...opts, headers: { Authorization: `Bearer ${TOKEN}`, 'User-Agent': 'gc-sync', ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`Netlify ${opts.method || 'GET'} ${path} -> ${r.status} ${(await r.text()).slice(0, 300)}`);
  return r.status === 204 ? null : r.json();
}

// ------------------------------------------------------------------ Substack
async function substackPosts() {
  try {
    const j = await get(`${SUBSTACK}/api/v1/archive?sort=new&limit=12`, { as: 'json' });
    const list = Array.isArray(j) ? j : j.posts;
    if (!Array.isArray(list)) throw new Error('unexpected archive shape');
    return { source: 'api', list: list.map(p => ({ slug: p.slug, title: p.title, subtitle: p.subtitle, post_date: p.post_date, canonical_url: p.canonical_url, cover_image: p.cover_image, audience: p.audience, type: p.type })) };
  } catch (e) {
    log('archive API failed (' + e.message + '), falling back to RSS');
    const xml = await get(`${SUBSTACK}/feed`);
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const list = [...doc.querySelectorAll('item')].map(it => {
      const pick = sel => { const n = it.querySelector(sel); return n ? n.textContent.trim() : ''; };
      const link = pick('link');
      const enc = it.querySelector('enclosure');
      const body = [...it.childNodes].find(n => n.nodeName === 'content:encoded');
      return { slug: link.split('/p/')[1], title: pick('title'), subtitle: pick('description'), post_date: new Date(pick('pubDate')).toISOString(), canonical_url: link, cover_image: enc ? enc.getAttribute('url') : null, audience: 'everyone', type: 'newsletter', body_html: body ? body.textContent : null };
    });
    return { source: 'rss', list };
  }
}
async function substackBody(p) {
  if (p.body_html) return p.body_html;
  const j = await get(`${SUBSTACK}/api/v1/posts/${p.slug}`, { as: 'json' });
  if (j.audience && j.audience !== 'everyone') throw new Error('post is not public: ' + p.slug);
  if (!j.body_html) throw new Error('no body for ' + p.slug);
  return j.body_html;
}

// ------------------------------------------------------------------ main
(async () => {
  const today = madridToday();
  log('mode', MODE, 'today', today, REFRESH.length ? 'refresh ' + REFRESH.join(',') : '');
  if (MODE !== 'dry-run' && !TOKEN) throw new Error('NETLIFY_AUTH_TOKEN is not set');

  // live site state (cache-busted)
  const bust = '?gcsync=' + Date.now();
  const live = {
    '/index.html': await get(SITE + '/' + bust),
    '/en/essays/index.html': await get(SITE + '/en/essays/' + bust),
    '/es/ensayos/index.html': await get(SITE + '/es/ensayos/' + bust),
    templateEn: await get(SITE + TEMPLATE.en + bust),
    templateEs: await get(SITE + TEMPLATE.es + bust),
  };
  const onSite = new Set([...(live['/en/essays/index.html'] + live['/es/ensayos/index.html']).matchAll(/class="isrc" href="([^"]+)"/g)].map(m => m[1].replace(/[?#].*$/, '').replace(/\/$/, '')));

  const { source, list } = await substackPosts();
  log(`substack (${source}): ${list.length} recent posts`);
  const canon = p => String(p.canonical_url || `${SUBSTACK}/p/${p.slug}`).replace(/[?#].*$/, '').replace(/\/$/, '');
  const wanted = list.filter(p =>
    p.audience === 'everyone' && (!p.type || p.type === 'newsletter') && p.post_date && p.post_date.slice(0, 10) >= SINCE &&
    new Date(p.post_date) <= new Date() &&
    (!onSite.has(canon(p)) || REFRESH.some(r => r === p.slug || canon({ canonical_url: r }) === canon(p))));
  const report = { date: new Date().toISOString(), mode: MODE, source, added: [], skipped: [], deploy: null };

  if (!wanted.length) {
    log('nothing new — the site is up to date');
    fs.writeFileSync('report.json', JSON.stringify(report, null, 2));
    return;
  }
  log('to publish:', wanted.map(p => p.title).join(' / '));
  for (const p of wanted) {
    try { p.body_html = await substackBody(p); }
    catch (e) { report.skipped.push({ post: p.title, url: canon(p), why: e.message }); p.bad = true; }
  }

  const { document } = parseHTML('<!doctype html><html><body></body></html>');
  const out = G.build({ posts: wanted.filter(p => !p.bad), live, doc: document, today, force: REFRESH });
  report.added = out.report.added;
  report.skipped.push(...out.report.skipped);
  const pages = Object.keys(out.files);
  log(`built ${report.added.length} pages, ${pages.length} files, ${out.images.length} images; skipped ${report.skipped.length}`);

  fs.mkdirSync('out', { recursive: true });
  for (const [p, html] of Object.entries(out.files)) {
    const f = 'out' + p; fs.mkdirSync(require('path').dirname(f), { recursive: true }); fs.writeFileSync(f, html);
  }

  if (!report.added.length || MODE === 'dry-run') {
    fs.writeFileSync('report.json', JSON.stringify(report, null, 2));
    log(MODE === 'dry-run' ? 'dry run — nothing deployed (pages in ./out)' : 'nothing publishable');
    return;
  }

  // ---------------------------------------------------------------- Netlify deploy
  let siteId = process.env.NETLIFY_SITE_ID;
  if (!siteId) {
    const sites = await netlify('/sites?filter=all&per_page=100');
    const s = sites.find(s => s.custom_domain === DOMAIN || (s.domain_aliases || []).some(d => d === DOMAIN || d === 'www.' + DOMAIN));
    if (!s) throw new Error('Netlify site for ' + DOMAIN + ' not found');
    siteId = s.id;
  }
  const site = await netlify(`/sites/${siteId}`);
  const pub = site.published_deploy;
  if (!pub) throw new Error('site has no published deploy');
  let current = [], page = 1;
  for (;;) { const batch = await netlify(`/deploys/${pub.id}/files?per_page=1000&page=${page}`); current = current.concat(batch); if (batch.length < 1000) break; page++; }
  log(`current production deploy ${pub.id}: ${current.length} files`);

  const manifest = Object.fromEntries(current.map(f => [f.id, f.sha]));
  const uploads = {}; // sha -> {path, buf}
  for (const [p, html] of Object.entries(out.files)) {
    const buf = Buffer.from(html, 'utf8'); const h = sha1(buf);
    manifest[p] = h; uploads[h] = { path: p, buf };
  }
  for (const im of out.images) {
    if (manifest[im.path]) continue;           // already on the site
    const buf = await get(im.url, { as: 'buffer' });
    const h = sha1(buf); manifest[im.path] = h; uploads[h] = { path: im.path, buf };
  }
  const titles = [...new Set(report.added.map(a => a.title))].join(' / ');
  const deploy = await netlify(`/sites/${siteId}/deploys`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: manifest, draft: MODE === 'draft', title: `gc-sync: ${titles}`.slice(0, 250) }),
  });
  log(`deploy ${deploy.id} created, ${deploy.required.length} files to upload`);
  for (const h of deploy.required) {
    const u = uploads[h];
    if (!u) throw new Error('Netlify asked for an unknown file ' + h);
    await netlify(`/deploys/${deploy.id}/files${encodeURI(u.path)}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: u.buf });
  }
  let d;
  for (let i = 0; i < 60; i++) { d = await netlify(`/deploys/${deploy.id}`); if (['ready', 'error'].includes(d.state)) break; await sleep(3000); }
  if (d.state !== 'ready') throw new Error(`deploy ${deploy.id} ended in state ${d.state}: ${d.error_message || ''}`);
  report.deploy = { id: d.id, state: d.state, draft: MODE === 'draft', preview: d.deploy_ssl_url, previous: pub.id };
  log(MODE === 'draft' ? `draft ready: ${d.deploy_ssl_url}` : `published to production (previous deploy ${pub.id} kept for rollback)`);

  if (MODE === 'production') {
    // verify on the real site
    await sleep(5000);
    for (const a of report.added) {
      try { const h = await get(SITE + a.path + '?gcsync=' + Date.now()); a.verified = h.includes(`<meta name="gc:source" content="${a.source}">`); }
      catch (e) { a.verified = false; }
    }
  }
  fs.writeFileSync('report.json', JSON.stringify(report, null, 2));
})().catch(e => {
  console.error('[gc-sync] FAILED:', e.stack || e.message);
  try { fs.writeFileSync('report.json', JSON.stringify({ error: e.message, date: new Date().toISOString(), mode: MODE }, null, 2)); } catch (_) {}
  process.exit(1);
});
