// End-to-end test of scripts/sync.js with Substack and Netlify mocked; the live site is real.
const realFetch = global.fetch; const calls = [];
const img = 'https://substack-post-media.s3.amazonaws.com/public/images/1d001b70-05f8-4738-a2fa-5e11c5bc434c_1672x941.png';
const body = `<div class="captioned-image-container"><figure><img src="${img}" data-attrs='{"src":"${img}","alt":"cover"}'></figure></div><p>Para español, scroll hacia abajo.</p>` + '<p>' + 'English text of the essay. '.repeat(40) + '</p><div><hr></div><p>La última guerra</p><p>El individuo fuerte contra el hombre fuerte</p><p>' + 'Texto en español del ensayo. '.repeat(40) + '</p>';
const post = { slug: 'the-ultimate-war', title: 'The Ultimate War', subtitle: 'The Strong Individual vs. The Strong Man', post_date: '2026-10-04T10:17:36.526Z', canonical_url: 'https://gilcarrasquero.substack.com/p/the-ultimate-war', cover_image: img, audience: 'everyone', type: 'newsletter' };
const old = { ...post, slug: 'sicily-and-us-nosotros-y-sicilia', canonical_url: 'https://gilcarrasquero.substack.com/p/sicily-and-us-nosotros-y-sicilia', title: 'Sicily and Us | Nosotros y Sicilia' };
const json = o => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
global.fetch = async (url, opts = {}) => {
  url = String(url); const m = (opts.method || 'GET');
  if (url.includes('substack.com/api/v1/archive')) return json({ posts: [post, old] });
  if (url.includes('substack.com/api/v1/posts/the-ultimate-war')) return json({ ...post, body_html: body });
  if (url.startsWith('https://substack-post-media')) return new Response(Buffer.from('PNGDATA'), { status: 200 });
  if (url.startsWith('https://api.netlify.com')) {
    calls.push(m + ' ' + url.replace('https://api.netlify.com/api/v1', '') + (opts.body && m === 'POST' ? ' files=' + Object.keys(JSON.parse(opts.body).files).length + ' draft=' + JSON.parse(opts.body).draft : ''));
    if (url.endsWith('/sites/SITE')) return json({ id: 'SITE', published_deploy: { id: 'PUB' } });
    if (url.includes('/deploys/PUB/files')) return json([{ id: '/index.html', sha: 'a' }, { id: '/en/essays/index.html', sha: 'b' }, { id: '/images/ensayos/x.png', sha: 'c' }]);
    if (url.endsWith('/sites/SITE/deploys') && m === 'POST') { const f = JSON.parse(opts.body).files; return json({ id: 'NEW', required: Object.entries(f).filter(([p]) => !['/images/ensayos/x.png'].includes(p)).map(([, s]) => s).filter((s, i, a) => !['a','b','c'].includes(s) && a.indexOf(s) === i) }); }
    if (url.includes('/deploys/NEW/files/')) return new Response(null, { status: 204 });
    if (url.endsWith('/deploys/NEW')) return json({ id: 'NEW', state: 'ready', deploy_ssl_url: 'https://new--site.netlify.app' });
  }
  return realFetch(url, opts);
};
process.env.NETLIFY_AUTH_TOKEN = 'test'; process.env.NETLIFY_SITE_ID = 'SITE'; process.env.MODE = process.env.MODE || 'draft';
const RUN = require('path').join(__dirname, 'run'); require('fs').mkdirSync(RUN, { recursive: true }); process.chdir(RUN); 
require('../scripts/sync.js');
process.on('exit', () => { console.log('NETLIFY CALLS:\n  ' + calls.join('\n  ')); const r = require(require('path').join(process.cwd(), 'report.json')); console.log('REPORT:', JSON.stringify({ added: r.added && r.added.map(a => a.path), skipped: r.skipped, deploy: r.deploy, error: r.error })); });
