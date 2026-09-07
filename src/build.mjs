/* Static generator for the journal.
   Design notes:
   - Dates are formatted from the LITERAL clock time in the frontmatter, never via
     Date#toLocale*. The build runs on a UTC runner; converting would shift a
     00:30 IST post back a day. Date objects are used ONLY for sorting and RSS.
   - One dependency (marked). Nothing else to rot.
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const OUT = path.join(ROOT, 'dist');
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'site.config.json'), 'utf8'));

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/* ---------- helpers ---------- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function slugify(s) {
  return String(s).toLowerCase().trim()
    .replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-')
    .replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

function parseFront(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: {}, body: raw };
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    const mm = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!mm) continue;
    let v = mm[2].trim();
    if (v.startsWith('[') && v.endsWith(']')) {
      v = v.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else {
      v = v.replace(/^["']|["']$/g, '');
      if (v === 'true') v = true;
      else if (v === 'false') v = false;
    }
    data[mm[1]] = v;
  }
  return { data, body: raw.slice(m[0].length) };
}

/* Reads Y/M/D/H/M straight out of the ISO string -- that IS the wall-clock time
   the post was written at, whatever machine renders it later. */
function clockParts(iso) {
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!m) return null;
  return {
    y: +m[1], mo: +m[2], d: +m[3],
    h: m[4] == null ? null : +m[4],
    mi: m[5] == null ? null : +m[5],
  };
}

function fmtDate(iso, withTime = true) {
  const p = clockParts(iso);
  if (!p) return String(iso);
  const dow = DAYS[new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay()];
  let s = dow + ' ' + p.d + ' ' + MONTHS[p.mo - 1] + ' ' + p.y;
  if (withTime && p.h != null) {
    s += ' · ' + String(p.h).padStart(2, '0') + ':' + String(p.mi).padStart(2, '0');
  }
  return s;
}

const monthKey = (iso) => {
  const p = clockParts(iso);
  return p ? p.y + '-' + String(p.mo).padStart(2, '0') : '0000-00';
};
const monthLabel = (k) => {
  const parts = k.split('-');
  return MONTHS[+parts[1] - 1] + ' ' + parts[0];
};

function plainText(md) {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^>\s?/gm, '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ---------- load posts ---------- */
const POSTS_DIR = path.join(ROOT, 'content', 'posts');
fs.mkdirSync(POSTS_DIR, { recursive: true });

const posts = fs.readdirSync(POSTS_DIR)
  .filter((f) => f.endsWith('.md'))
  .map((file) => {
    const raw = fs.readFileSync(path.join(POSTS_DIR, file), 'utf8');
    const { data, body } = parseFront(raw);
    const fileDate = (file.match(/^(\d{4}-\d{2}-\d{2})/) || [])[1];
    const iso = data.date || (fileDate ? fileDate + 'T00:00' : '1970-01-01T00:00');
    const title = (data.title || '').trim();
    const text = plainText(body);
    const slug = data.slug || slugify(title) || file.replace(/\.md$/, '');
    const tags = (Array.isArray(data.tags) ? data.tags : (data.tags ? [data.tags] : []))
      .map((t) => String(t).toLowerCase().trim()).filter(Boolean);
    return {
      file, title, iso, tags, body, text, slug,
      draft: data.draft === true,
      url: '/posts/' + slug + '/',
      ts: new Date(iso).getTime() || 0,
      words: text ? text.split(/\s+/).length : 0,
      excerpt: text.slice(0, 240) + (text.length > 240 ? '…' : ''),
      html: marked.parse(body),
    };
  })
  .filter((p) => !p.draft)
  .sort((a, b) => b.ts - a.ts);

/* ---------- page shell ---------- */
function shell({ title, desc, body, canonical, extraHead = '' }) {
  const t = title ? title + ' · ' + CFG.title : CFG.title;
  const d = desc || CFG.tagline;
  return '<!doctype html>\n<html lang="en">\n<head>\n'
    + '<meta charset="utf-8">\n'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
    + '<title>' + esc(t) + '</title>\n'
    + '<meta name="description" content="' + esc(d) + '">\n'
    + '<meta property="og:title" content="' + esc(t) + '">\n'
    + '<meta property="og:description" content="' + esc(d) + '">\n'
    + '<meta property="og:type" content="website">\n'
    + (canonical ? '<link rel="canonical" href="' + esc(CFG.url + canonical) + '">\n' : '')
    + '<link rel="alternate" type="application/rss+xml" title="' + esc(CFG.title) + '" href="/feed.xml">\n'
    + '<link rel="icon" href="/icon.svg" type="image/svg+xml">\n'
    + '<link rel="apple-touch-icon" href="/icon-180.png">\n'
    + '<link rel="manifest" href="/manifest.webmanifest">\n'
    + '<meta name="theme-color" content="#262626">\n'
    + '<link rel="stylesheet" href="/style.css">\n'
    + '<script>(function(){try{var t=localStorage.getItem("theme");if(t)document.documentElement.dataset.theme=t}catch(e){}})();</script>\n'
    + extraHead
    + '</head>\n<body>\n'
    + '<header class="site">\n'
    + '  <a class="brand" href="/">' + esc(CFG.title) + '</a>\n'
    + '  <nav>\n'
    + '    <a href="/archive/">Archive</a>\n'
    + '    <a href="/search/">Search</a>\n'
    + '    <a href="/feed.xml">RSS</a>\n'
    + '    <button id="themetoggle" type="button" aria-label="Toggle theme">◐</button>\n'
    + '  </nav>\n'
    + '</header>\n<main>\n' + body + '\n</main>\n'
    + '<footer class="site">\n'
    + '  <span>' + esc(CFG.author) + '</span>\n'
    + '  <span class="sep">·</span>\n'
    + '  <a href="/archive/">' + posts.length + ' post' + (posts.length === 1 ? '' : 's') + '</a>\n'
    + '</footer>\n'
    + '<script src="/app.js"></script>\n'
    + '</body>\n</html>\n';
}

/* ---------- fragments ---------- */
const tagList = (tags) => tags.length
  ? '<div class="tags">' + tags.map((t) => '<a class="tag" href="/tags/' + esc(t) + '/">' + esc(t) + '</a>').join('') + '</div>'
  : '';

const readTime = (p) => (p.words > 400 ? ' <span class="sep">·</span> ' + Math.ceil(p.words / 220) + ' min' : '');

function feedItem(p) {
  const heading = p.title
    ? '<h2 class="pt"><a href="' + p.url + '">' + esc(p.title) + '</a></h2>'
    : '<h2 class="pt untitled"><a href="' + p.url + '">' + esc(p.excerpt.slice(0, 90) || 'Untitled') + '</a></h2>';
  return '<article class="card">\n'
    + '  <div class="meta"><a href="' + p.url + '">' + esc(fmtDate(p.iso)) + '</a>' + readTime(p) + '</div>\n'
    + '  ' + heading + '\n'
    + (p.title ? '  <p class="ex">' + esc(p.excerpt) + '</p>\n' : '')
    + '  ' + tagList(p.tags) + '\n'
    + '</article>';
}

/* ---------- write ---------- */
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const write = (rel, content) => {
  const f = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
};

/* home + pagination */
const per = CFG.perPage || 25;
const pageCount = Math.max(1, Math.ceil(posts.length / per));
for (let i = 0; i < pageCount; i++) {
  const slice = posts.slice(i * per, (i + 1) * per);
  const nav = '<nav class="pager">'
    + (i > 0 ? '<a href="' + (i === 1 ? '/' : '/page/' + i + '/') + '">← newer</a>' : '<span></span>')
    + (i < pageCount - 1 ? '<a href="/page/' + (i + 2) + '/">older →</a>' : '<span></span>')
    + '</nav>';
  const body = '<p class="tagline">' + (i === 0 ? esc(CFG.tagline) : 'Page ' + (i + 1)) + '</p>\n'
    + '<div class="feed">'
    + (slice.map(feedItem).join('\n') || '<p class="empty">Nothing here yet. Go write something.</p>')
    + '</div>\n'
    + (pageCount > 1 ? nav : '');
  write(i === 0 ? 'index.html' : 'page/' + (i + 1) + '/index.html',
    shell({ body, canonical: i === 0 ? '/' : '/page/' + (i + 1) + '/' }));
}

/* posts */
for (let i = 0; i < posts.length; i++) {
  const p = posts[i];
  const prev = posts[i + 1];
  const next = posts[i - 1];
  const label = (q) => esc((q.title || fmtDate(q.iso, false)).slice(0, 40));
  const body = '<article class="post">\n'
    + '  <div class="meta">' + esc(fmtDate(p.iso)) + (p.words > 400 ? ' <span class="sep">·</span> ' + Math.ceil(p.words / 220) + ' min read' : '') + '</div>\n'
    + (p.title ? '  <h1>' + esc(p.title) + '</h1>\n' : '')
    + '  <div class="prose">' + p.html + '</div>\n'
    + '  ' + tagList(p.tags) + '\n'
    + '</article>\n'
    + '<nav class="pager">'
    + (prev ? '<a href="' + prev.url + '">← ' + label(prev) + '</a>' : '<span></span>')
    + (next ? '<a href="' + next.url + '">' + label(next) + ' →</a>' : '<span></span>')
    + '</nav>';
  write('posts/' + p.slug + '/index.html',
    shell({ title: p.title || fmtDate(p.iso, false), desc: p.excerpt, body, canonical: p.url }));
}

/* tags */
const byTag = {};
for (const p of posts) for (const t of p.tags) (byTag[t] ||= []).push(p);
for (const [t, ps] of Object.entries(byTag)) {
  write('tags/' + t + '/index.html', shell({
    title: '#' + t,
    canonical: '/tags/' + t + '/',
    body: '<h1 class="pagetitle">#' + esc(t) + '</h1>'
      + '<p class="tagline">' + ps.length + ' post' + (ps.length === 1 ? '' : 's') + '</p>\n'
      + '<div class="feed">' + ps.map(feedItem).join('\n') + '</div>',
  }));
}

/* archive */
const byMonth = {};
for (const p of posts) (byMonth[monthKey(p.iso)] ||= []).push(p);
const cloud = Object.keys(byTag).length
  ? '<div class="tags tagcloud">' + Object.entries(byTag).sort((a, b) => b[1].length - a[1].length)
      .map(([t, ps]) => '<a class="tag" href="/tags/' + esc(t) + '/">' + esc(t) + ' <span class="n">' + ps.length + '</span></a>').join('')
    + '</div>'
  : '';
const archiveBody = '<h1 class="pagetitle">Archive</h1>\n' + cloud + '\n'
  + Object.keys(byMonth).sort().reverse().map((k) => '<section class="month">\n'
    + '  <h2>' + esc(monthLabel(k)) + '</h2>\n'
    + '  <ul>' + byMonth[k].map((p) => '<li><span class="d">'
      + String(clockParts(p.iso).d).padStart(2, '0') + '</span><a href="' + p.url + '">'
      + esc(p.title || p.excerpt.slice(0, 70) || 'Untitled') + '</a></li>').join('') + '</ul>\n'
    + '</section>').join('\n');
write('archive/index.html', shell({ title: 'Archive', body: archiveBody, canonical: '/archive/' }));

/* search */
write('search/index.html', shell({
  title: 'Search',
  canonical: '/search/',
  body: '<h1 class="pagetitle">Search</h1>\n'
    + '<input id="q" type="search" placeholder="Type to search every post…" autocomplete="off" autofocus>\n'
    + '<div id="results" class="feed"></div>',
}));
write('search.json', JSON.stringify(posts.map((p) => ({
  t: p.title, u: p.url, d: fmtDate(p.iso, false), g: p.tags, x: p.text.slice(0, 1200),
}))));

/* rss */
const rssItems = posts.slice(0, 50).map((p) => '  <item>\n'
  + '    <title>' + esc(p.title || fmtDate(p.iso, false)) + '</title>\n'
  + '    <link>' + esc(CFG.url + p.url) + '</link>\n'
  + '    <guid isPermaLink="true">' + esc(CFG.url + p.url) + '</guid>\n'
  + '    <pubDate>' + new Date(p.ts).toUTCString() + '</pubDate>\n'
  + '    <description>' + esc(p.excerpt) + '</description>\n'
  + '  </item>').join('\n');
write('feed.xml', '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<rss version="2.0"><channel>\n'
  + '  <title>' + esc(CFG.title) + '</title>\n'
  + '  <link>' + esc(CFG.url) + '</link>\n'
  + '  <description>' + esc(CFG.tagline) + '</description>\n'
  + rssItems + '\n</channel></rss>\n');

/* static passthrough */
function copyDir(src, dst) {
  if (!fs.existsSync(src)) return;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) { fs.mkdirSync(d, { recursive: true }); copyDir(s, d); }
    else fs.copyFileSync(s, d);
  }
}
copyDir(path.join(ROOT, 'public'), OUT);

/* the editor reads the repo coordinates from here, so site.config.json stays
   the single place any of this is configured */
write('admin/config.json', JSON.stringify({
  repo: CFG.repo, branch: CFG.branch, quickTags: CFG.quickTags || [], url: CFG.url,
}));

fs.copyFileSync(path.join(ROOT, 'src', 'style.css'), path.join(OUT, 'style.css'));
fs.copyFileSync(path.join(ROOT, 'src', 'app.js'), path.join(OUT, 'app.js'));
write('.nojekyll', '');
write('404.html', shell({
  title: 'Not found',
  body: '<h1 class="pagetitle">Not found</h1><p class="tagline">That page does not exist. <a href="/">Back home</a>.</p>',
}));

console.log('built ' + posts.length + ' posts -> ' + pageCount + ' feed page(s), '
  + Object.keys(byTag).length + ' tags');
