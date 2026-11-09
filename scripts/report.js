#!/usr/bin/env node
/*
 * Turns report.json into: the Actions run summary, a line in log/registro.md,
 * and — when there is something to tell Gil — a GitHub issue (which GitHub emails to him).
 *   - published  -> issue "Publicado en la web: …" (created and closed at once: it is a notice)
 *   - skipped    -> issue "Revisar: …" stays open until fixed (one per post, no duplicates)
 *   - failure    -> one open issue "La sincronización falló"; closed automatically on the next good run
 */
'use strict';
const fs = require('fs');
const { execFileSync } = require('child_process');

const RUN = process.env.RUN_URL || '';
const gh = args => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGh = args => { try { return gh(args); } catch (e) { console.log('gh failed:', args.join(' '), String(e.stderr || e.message).slice(0, 300)); return ''; } };
const openIssues = label => { const j = tryGh(['issue', 'list', '--state', 'open', '--label', label, '--json', 'number,title', '--limit', '50']); try { return JSON.parse(j || '[]'); } catch (_) { return []; } };
const ensureLabel = (name, color) => tryGh(['label', 'create', name, '--color', color, '--force']);

let r;
try { r = JSON.parse(fs.readFileSync('report.json', 'utf8')); }
catch (e) { r = { error: 'report.json missing — the sync step did not run to the end' }; }

const SITE = 'https://gilcarrasquero.com';
const lines = [];
const summary = [];
const stamp = (r.date || new Date().toISOString()).slice(0, 16).replace('T', ' ') + ' UTC';

if (r.error) {
  summary.push(`## ⚠️ La sincronización falló\n\n\`${r.error}\`\n\n[Ver la ejecución](${RUN})`);
} else if (!r.added || !r.added.length) {
  summary.push(r.skipped && r.skipped.length ? '## Nada publicado' : '## La web ya estaba al día');
} else {
  const where = r.mode === 'draft' ? `Borrador (sin publicar): ${r.deploy && r.deploy.preview}` : r.mode === 'dry-run' ? 'Prueba: no se publicó nada' : 'Publicado en gilcarrasquero.com';
  summary.push(`## ${where}\n`);
  for (const a of r.added) {
    const ok = a.verified === false ? ' ⚠️ no se pudo verificar en la web' : a.verified ? ' ✓' : '';
    summary.push(`- **${a.title}** (${a.lang.toUpperCase()}, ${a.date}) → ${SITE}${a.path}${ok}${a.refreshed ? ' — actualizado' : ''}`);
  }
  if (r.deploy) summary.push(`\nDeploy de Netlify \`${r.deploy.id}\` · el anterior (\`${r.deploy.previous}\`) queda para volver atrás con un clic.`);
}
if (r.skipped && r.skipped.length) {
  summary.push('\n### No publicados (necesitan revisión)');
  for (const s of r.skipped) summary.push(`- **${s.post}** — ${s.why} (${s.url})`);
}
const md = summary.join('\n');
console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');

// ---- notices (only inside GitHub Actions)
if (!process.env.GITHUB_ACTIONS) process.exit(0);
ensureLabel('publicado', '2E7D32'); ensureLabel('revisar', 'B26A00'); ensureLabel('fallo', 'C62828');

if (r.error) {
  if (!openIssues('fallo').length) {
    tryGh(['issue', 'create', '--label', 'fallo', '--title', 'La sincronización Substack → web falló',
      '--body', `${md}\n\nSeguirá intentándolo cada dos horas. Este aviso se cerrará solo cuando vuelva a funcionar.`]);
  }
} else {
  for (const i of openIssues('fallo')) tryGh(['issue', 'close', String(i.number), '--comment', `Resuelto: la sincronización volvió a funcionar (${stamp}). ${RUN}`]);
}
if (r.added && r.added.length && r.mode !== 'dry-run') {
  const titles = [...new Set(r.added.map(a => a.title))].join(' / ');
  const url = tryGh(['issue', 'create', '--label', 'publicado', '--title', `${r.mode === 'draft' ? 'Borrador listo' : 'Publicado en la web'}: ${titles}`.slice(0, 250), '--body', `${md}\n\n[Ejecución](${RUN})`]);
  const num = (url.match(/\/(\d+)$/) || [])[1];
  if (num && r.mode === 'production') tryGh(['issue', 'close', num]);
}
const already = openIssues('revisar').map(i => i.title);
for (const s of r.skipped || []) {
  const title = `Revisar: no pude publicar «${s.post}»`.slice(0, 250);
  if (already.includes(title)) continue;
  tryGh(['issue', 'create', '--label', 'revisar', '--title', title, '--body',
    `**Motivo:** ${s.why}\n\nOriginal: ${s.url}\n\nNo se publicó nada de este ensayo (ni a medias). Cuando el texto en Substack tenga la estructura habitual (inglés · separador · español con su título), el siguiente intento lo publicará solo; también se puede forzar desde *Actions → Substack → web → Run workflow* poniendo su slug en «refresh».\n\n[Ejecución](${RUN})`]);
}
// close review issues whose post is now on the site
const nowOnSite = new Set((r.added || []).map(a => a.source));
for (const i of openIssues('revisar')) {
  const m = (r.added || []).find(a => i.title.includes(a.title));
  if (m || [...nowOnSite].some(u => i.title.includes(u))) tryGh(['issue', 'close', String(i.number), '--comment', 'Ya está publicado.']);
}

// ---- history in the repo (also keeps the scheduled job alive)
if (r.added && r.added.length && r.mode === 'production') {
  fs.mkdirSync('log', { recursive: true });
  const entry = `\n## ${stamp}\n` + r.added.map(a => `- ${a.date} · ${a.lang.toUpperCase()} · [${a.title}](${SITE}${a.path})${a.refreshed ? ' (actualizado)' : ''} ← ${a.source}`).join('\n') + (r.deploy ? `\n- Netlify deploy ${r.deploy.id} (anterior: ${r.deploy.previous})` : '') + '\n';
  fs.appendFileSync('log/registro.md', entry);
  try {
    execFileSync('git', ['config', 'user.name', 'gc-sync']);
    execFileSync('git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
    execFileSync('git', ['add', 'log/registro.md']);
    execFileSync('git', ['commit', '-m', `Publicado: ${[...new Set(r.added.map(a => a.title))].join(' / ')}`.slice(0, 200)]);
    execFileSync('git', ['push']);
  } catch (e) { console.log('could not commit the log:', String(e.stderr || e.message).slice(0, 300)); }
}
