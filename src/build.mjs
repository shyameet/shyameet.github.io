/* Static generator for the journal.
   Design notes:
   - Two halves, one site. TODAY / HABITS / FOCUS are the tracker; JOURNAL is
     the writing. Every post still belongs to exactly one SECTION.
   - Dates are formatted from the LITERAL clock time in the frontmatter, never via
     Date#toLocale*. The build runs on a UTC runner; converting would shift a
     00:30 IST post back a day. Date objects are used ONLY for sorting and RSS.
   - "Today" is the date in CFG.timezone at build time. The day page for it is
     made at 05:00 by the newday workflow, which also redeploys, so the site
     turns over to the new day on its own.
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

const SECTIONS = CFG.sections || [];
const SECTION_BY_ID = Object.fromEntries(SECTIONS.map((s) => [s.id, s]));
const FALLBACK = SECTIONS.length ? SECTIONS[SECTIONS.length - 1].id : 'blabber';
const isTaskSection = (id) => !!(SECTION_BY_ID[id] && SECTION_BY_ID[id].tasks);

/* No personal name on this site by design (2026-09-13) -- the tagline carries
   the identity instead. Text that technically cannot be blank (browser tab,
   RSS reader title, og:title) falls back to it. */
const SITE_NAME = CFG.title || CFG.tagline;
const ZONE = CFG.timezone || 'Asia/Kolkata';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const FULLDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const FULLMONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
/* the day's name as it is said at home -- Somvar is Shiva's day, and so on */
const VAAR = ['Ravivar', 'Somvar', 'Mangalvar', 'Budhvar', 'Guruvar', 'Shukravar', 'Shanivar'];
const VAAR_DEVA = ['रविवार', 'सोमवार', 'मंगलवार', 'बुधवार', 'गुरुवार', 'शुक्रवार', 'शनिवार'];
const WEEK_LETTERS = CFG.weekStartsMonday === false
  ? ['S', 'M', 'T', 'W', 'T', 'F', 'S'] : ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

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
      /* "a \"quoted\" word" -- the editor escapes quotes inside a quoted value */
      const dq = v.length > 1 && v.startsWith('"') && v.endsWith('"');
      v = v.replace(/^["']|["']$/g, '');
      if (dq) v = v.replace(/\\"/g, '"');
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

const pad2 = (n) => String(n).padStart(2, '0');
const keyOf = (iso) => {
  const p = clockParts(iso);
  return p ? p.y + '-' + pad2(p.mo) + '-' + pad2(p.d) : '';
};
const hhmm = (iso) => {
  const p = clockParts(iso);
  return p && p.h != null ? pad2(p.h) + ':' + pad2(p.mi) : '';
};

/* date keys (YYYY-MM-DD) as calendar arithmetic, done in UTC so no machine
   timezone can leak in */
const keyDate = (k) => new Date(Date.UTC(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10)));
const dateKey = (d) => d.toISOString().slice(0, 10);
const addDays = (k, n) => { const d = keyDate(k); d.setUTCDate(d.getUTCDate() + n); return dateKey(d); };
const weekdayOf = (k) => keyDate(k).getUTCDay();          // 0 = Sunday
const weekStartKey = (k) => {
  const dow = weekdayOf(k);
  return addDays(k, -(CFG.weekStartsMonday === false ? dow : (dow + 6) % 7));
};
const weekKeys = (k) => { const s = weekStartKey(k); return [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(s, i)); };

function fmtDate(iso, withTime = true) {
  const p = clockParts(iso);
  if (!p) return String(iso);
  let s = DAYS[weekdayOf(keyOf(iso))] + ' ' + p.d + ' ' + MONTHS[p.mo - 1] + ' ' + p.y;
  if (withTime && p.h != null) s += ' · ' + pad2(p.h) + ':' + pad2(p.mi);
  return s;
}
const shortDate = (iso) => {
  const p = clockParts(iso);
  return p ? p.d + ' ' + MONTHS[p.mo - 1] : '';
};
/* "Saturday 12 September" -- the heading a day gets, like a page in a diary */
function fullDate(isoOrKey) {
  const k = keyOf(isoOrKey);
  if (!k) return String(isoOrKey);
  return FULLDAYS[weekdayOf(k)] + ' ' + +k.slice(8) + ' ' + FULLMONTHS[+k.slice(5, 7) - 1];
}
const monthKey = (iso) => keyOf(iso).slice(0, 7) || '0000-00';
const monthLabel = (k) => MONTHS[+k.slice(5, 7) - 1] + ' ' + k.slice(0, 4);

/* 2h 05m / 7h / 45m / 0m */
function fmtDur(sec) {
  const m = Math.round((sec || 0) / 60);
  if (m < 60) return m + 'm';
  return Math.floor(m / 60) + 'h' + (m % 60 ? ' ' + pad2(m % 60) + 'm' : '');
}
/* the short form a grid cell has room for: 2.5h / 40m */
function fmtShort(sec) {
  const m = Math.round((sec || 0) / 60);
  if (!m) return '';
  if (m < 60) return m + 'm';
  const h = m / 60;
  return (h >= 10 ? Math.round(h) : Math.round(h * 10) / 10) + 'h';
}

function todayInZone() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
  return parts.year + '-' + parts.month + '-' + parts.day;
}
/* BUILD_TODAY=2026-09-23 pins the date -- for checking a build as it will look
   on a given morning */
const TODAY = /^\d{4}-\d{2}-\d{2}$/.test(process.env.BUILD_TODAY || '') ? process.env.BUILD_TODAY : todayInZone();

/* ---------- tasks ----------
   "- [ ] thing" / "- [x] thing". Counted so a task post shows its own
   progress without anyone keeping a tally by hand. */
const TASK_RE = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/;
function taskItems(md) {
  const items = [];
  for (const line of md.split('\n')) {
    const m = line.match(TASK_RE);
    if (m) items.push({ done: m[1] !== ' ', text: m[2].trim() });
  }
  return items;
}
function countTasks(md) {
  const items = taskItems(md);
  const done = items.filter((i) => i.done).length;
  return { done, open: items.length - done, total: items.length };
}
const norm = (s) => String(s).trim().toLowerCase();

/* marked renders checkboxes with nothing that says which task they are, so each
   one is stamped with its task text. The toggler finds the line by that text,
   not by position, so a box still hits the right line after the file changed. */
function annotateTasks(html, md) {
  const items = taskItems(md);
  let i = 0;
  return html.replace(/<input (checked="" )?disabled="" type="checkbox">/g, (m) => {
    const it = items[i++];
    return it ? m.replace('<input ', '<input data-task="' + esc(it.text) + '" ') : m;
  });
}

/* A checklist as the tracker shows it: a big round tick per line. Disabled in
   the HTML; app.js wakes them up only for whoever holds the token. */
function habitList(md) {
  const items = taskItems(md);
  if (!items.length) return '';
  return '<ul class="habits">' + items.map((it) => '<li><label>'
    + '<input type="checkbox" data-task="' + esc(it.text) + '" disabled' + (it.done ? ' checked' : '') + '>'
    + '<span class="hn">' + marked.parseInline(it.text) + '</span></label></li>').join('') + '</ul>';
}
const stripTasks = (md) => md.split('\n').filter((l) => !TASK_RE.test(l)).join('\n').trim();

function plainText(md) {
  return md
    .replace(/<details[\s\S]*?<\/details>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^>\s?/gm, '')
    /* a heading ends a sentence, or it runs into the paragraph in an excerpt */
    .replace(/^#{1,6}\s*(.+?)\s*$/gm, (_m, h) => (/[.!?:]$/.test(h) ? h : h + '.'))
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s*/gm, '')  /* task markers */
    .replace(/^\s*[-*+]\s+/gm, '')              /* list bullets */
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ---------- art ---------- */
const DEITIES = CFG.deities || [];
const ART = {};
for (const d of DEITIES) {
  const f = path.join(ROOT, 'src', 'art', d.id + '.svg');
  ART[d.id] = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n').trim() : '';
}
const deityFor = (k) => DEITIES.find((d) => d.day === weekdayOf(k)) || null;

/* ---------- load posts ---------- */
const POSTS_DIR = path.join(ROOT, 'content', 'posts');
fs.mkdirSync(POSTS_DIR, { recursive: true });

const posts = fs.readdirSync(POSTS_DIR)
  .filter((f) => f.endsWith('.md'))
  .map((file) => {
    /* Normalized to LF once, here, for every function downstream. Git's
       core.autocrlf on this machine writes CRLF into the working tree, and a
       line ending in \r silently breaks any regex capturing "rest of line"
       with (.*)$ -- \r is a line terminator in JS regex, so . can't consume
       it and $ won't match past it. */
    const raw = fs.readFileSync(path.join(POSTS_DIR, file), 'utf8').replace(/\r\n/g, '\n');
    const { data, body } = parseFront(raw);
    const fileDate = (file.match(/^(\d{4}-\d{2}-\d{2})/) || [])[1];
    const iso = data.date || (fileDate ? fileDate + 'T00:00' : '1970-01-01T00:00');
    const title = (data.title || '').trim();
    const text = plainText(body);
    const tags = (Array.isArray(data.tags) ? data.tags : (data.tags ? [data.tags] : []))
      .map((t) => String(t).toLowerCase().trim()).filter(Boolean);
    const section = SECTION_BY_ID[String(data.section || '').toLowerCase()] ? String(data.section).toLowerCase() : FALLBACK;
    /* `day:` ties a post to the day it is ABOUT when it was filed later --
       Tuesday's story told on Wednesday still belongs to Tuesday's page. */
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(data.day || '')) ? String(data.day) : keyOf(iso);
    const dateSlug = keyOf(iso) ? section + '-' + keyOf(iso) : '';
    const slug = data.slug || slugify(title) || dateSlug || file.replace(/\.md$/, '');
    return {
      file, title, iso, day, tags, body, text, slug, section,
      lesson: (data.lesson || '').trim(),
      draft: data.draft === true,
      url: '/posts/' + slug + '/',
      ts: new Date(iso).getTime() || 0,
      words: text ? text.split(/\s+/).length : 0,
      excerpt: text.slice(0, 220) + (text.length > 220 ? '…' : ''),
      html: annotateTasks(marked.parse(body), body),
      tasks: countTasks(body),
    };
  })
  .filter((p) => !p.draft)
  .sort((a, b) => b.ts - a.ts);

/* Two posts that slugify the same -- same title, or two untitled ones on one
   day -- would otherwise write to the same directory and one would vanish
   without a word. Oldest keeps the clean slug; later ones get suffixed. */
const seenSlugs = new Set();
for (const p of [...posts].reverse()) {
  let slug = p.slug;
  let n = 1;
  while (seenSlugs.has(slug)) slug = p.slug + '-' + (++n);
  if (slug !== p.slug) console.log('  slug clash: ' + p.file + ' -> ' + slug);
  seenSlugs.add(slug);
  p.slug = slug;
  p.url = '/posts/' + slug + '/';
}

const bySection = {};
for (const s of SECTIONS) bySection[s.id] = [];
for (const p of posts) (bySection[p.section] ||= []).push(p);
const journal = posts.filter((p) => !isTaskSection(p.section));

/* one day page per date (newest wins if there were ever two) */
const DAY_PAGES = new Map();
for (const p of [...(bySection.daytasks || [])].reverse()) DAY_PAGES.set(keyOf(p.iso), p);
const WEEK_PAGES = bySection.weektasks || [];

/* ---------- focus log ----------
   content/focus/YYYY-MM-DD.json, written by the timer on /focus/ one block at a
   time. The build only reads it. */
const FOCUS_DIR = path.join(ROOT, 'content', 'focus');
const FOCUS = new Map();
if (fs.existsSync(FOCUS_DIR)) {
  for (const f of fs.readdirSync(FOCUS_DIR).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x))) {
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(FOCUS_DIR, f), 'utf8')); } catch (e) {
      console.log('  focus: unreadable ' + f + ' (' + e.message + ')');
      continue;
    }
    const key = f.slice(0, 10);
    const sessions = (Array.isArray(data.sessions) ? data.sessions : [])
      .filter((s) => s && s.id && Number(s.sec) > 0 && Number(s.sec) < 86400 && clockParts(s.start))
      .sort((a, b) => String(a.start).localeCompare(String(b.start)));
    const sec = sessions.reduce((t, s) => t + Number(s.sec), 0);
    FOCUS.set(key, { sessions, sec, n: sessions.length });
  }
}
const FOCUS_TARGET = Math.round(((CFG.focus && CFG.focus.dailyTargetHours) || 7) * 3600);

/* ---------- habits ---------- */
const ROUTINE = (CFG.routine || []).map((r) => (typeof r === 'string' ? { name: r } : r));

/* true = ticked, false = on the page and not ticked, null = no page / not on it */
function doneOn(k, name) {
  const page = DAY_PAGES.get(k);
  if (!page) return null;
  const it = taskItems(page.body).find((t) => norm(t.text) === norm(name));
  return it ? it.done : null;
}

/* Consecutive days done, counted back from today. Today only counts once it is
   ticked -- an unticked morning has not broken anything yet. */
function streak(name) {
  let k = TODAY;
  if (doneOn(k, name) !== true) k = addDays(k, -1);
  let n = 0;
  while (doneOn(k, name) === true) { n++; k = addDays(k, -1); }
  return n;
}

/* ---------- small graphics ---------- */
function ring(pct, size, stroke, cls = '') {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, pct || 0));
  const h = size / 2;
  return '<svg class="ring ' + cls + '" viewBox="0 0 ' + size + ' ' + size + '" width="' + size + '" height="' + size + '" aria-hidden="true">'
    + '<circle class="ring-bg" cx="' + h + '" cy="' + h + '" r="' + r.toFixed(2) + '" stroke-width="' + stroke + '"/>'
    + '<circle class="ring-fg" cx="' + h + '" cy="' + h + '" r="' + r.toFixed(2) + '" stroke-width="' + stroke + '"'
    + ' stroke-dasharray="' + c.toFixed(2) + '" stroke-dashoffset="' + (c * (1 - v)).toFixed(2) + '"'
    + ' transform="rotate(-90 ' + h + ' ' + h + ')"/></svg>';
}

const ICON = {
  today: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.6v2.3M12 19.1v2.3M2.6 12h2.3M19.1 12h2.3M5.4 5.4 7 7M17 17l1.6 1.6M5.4 18.6 7 17M17 7l1.6-1.6"/></svg>',
  habits: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="7" cy="7" r="3.6"/><circle cx="17" cy="7" r="3.6"/><circle cx="7" cy="17" r="3.6"/><path d="m14.2 17.1 2 2 3.8-4.3"/></svg>',
  focus: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="13.4" r="7.6"/><path d="M12 13.4V9.2M9.6 2.8h4.8M12 2.8v2.9M18.3 6.3l1.4-1.4"/></svg>',
  journal: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.2 4.6c0-.9.7-1.6 1.6-1.6h12v15H6.8c-.9 0-1.6.7-1.6 1.6z"/><path d="M5.2 19.6c0 .9.7 1.4 1.6 1.4h12"/><path d="M9 7.6h6M9 10.6h4"/></svg>',
  write: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="2.8" width="6" height="11.4" rx="3"/><path d="M5.6 11.2a6.4 6.4 0 0 0 12.8 0M12 17.6v3.6M9 21.2h6"/></svg>',
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.6" cy="10.6" r="6.4"/><path d="m15.4 15.4 5 5"/></svg>',
  theme: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.4"/><path d="M12 3.6a8.4 8.4 0 0 0 0 16.8z" fill="currentColor" stroke="none"/></svg>',
};

const NAV = [
  ['today', '/', 'Today'],
  ['habits', '/habits/', 'Habits'],
  ['focus', '/focus/', 'Focus'],
  ['journal', '/journal/', 'Journal'],
  ['write', '/admin/', 'Write'],
];

/* ---------- page shell ---------- */
function shell({ title, desc, body, canonical, nav = '', scripts = [], cls = '' }) {
  const t = title ? title + ' · ' + SITE_NAME : SITE_NAME;
  const d = desc || CFG.tagline;
  const links = (withIcons) => NAV.map(([id, href, label]) => '<a href="' + href + '"'
    + (id === nav ? ' aria-current="page" class="on"' : '') + '>'
    + (withIcons ? ICON[id] : '') + '<span>' + label + '</span></a>').join('');
  return '<!doctype html>\n<html lang="en">\n<head>\n'
    + '<meta charset="utf-8">\n'
    + '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
    + '<title>' + esc(t) + '</title>\n'
    + '<meta name="description" content="' + esc(d) + '">\n'
    + '<meta property="og:title" content="' + esc(t) + '">\n'
    + '<meta property="og:description" content="' + esc(d) + '">\n'
    + '<meta property="og:type" content="website">\n'
    + (canonical ? '<link rel="canonical" href="' + esc(CFG.url + canonical) + '">\n' : '')
    + '<link rel="alternate" type="application/rss+xml" title="' + esc(SITE_NAME) + '" href="/feed.xml">\n'
    + '<link rel="icon" href="/icon.svg" type="image/svg+xml">\n'
    + '<link rel="apple-touch-icon" href="/icon-180.png">\n'
    + '<link rel="manifest" href="/manifest.webmanifest">\n'
    + '<meta name="theme-color" content="#f6efe2" media="(prefers-color-scheme: light)">\n'
    + '<meta name="theme-color" content="#11121b" media="(prefers-color-scheme: dark)">\n'
    + '<link rel="preconnect" href="https://fonts.googleapis.com">\n'
    + '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
    + '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?'
    + 'family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;0,6..72,600;1,6..72,400'
    + '&family=Plus+Jakarta+Sans:wght@400;500;600;700'
    + '&family=Tiro+Devanagari+Sanskrit&display=swap">\n'
    + '<link rel="stylesheet" href="/style.css">\n'
    + '<script>(function(){try{var t=localStorage.getItem("theme");if(t)document.documentElement.dataset.theme=t}catch(e){}})();</script>\n'
    + '</head>\n<body class="' + esc(cls) + '">\n'
    + '<header class="top">\n'
    + '  <a class="brand" href="/" title="' + esc(CFG.tagline) + '"><span class="om" lang="sa">ॐ</span></a>\n'
    + '  <nav class="topnav" aria-label="Main">' + links(false) + '</nav>\n'
    + '  <div class="topicons">\n'
    + '    <a class="iconbtn" href="/search/" aria-label="Search">' + ICON.search + '</a>\n'
    + '    <button id="themetoggle" class="iconbtn" type="button" aria-label="Switch light or dark">' + ICON.theme + '</button>\n'
    + '  </div>\n'
    + '</header>\n'
    + '<main class="wrap">\n' + body + '\n</main>\n'
    + '<footer class="site">\n'
    + '  <p class="motto">' + esc(CFG.tagline) + '</p>\n'
    + '  <p class="flinks"><a href="/archive/">Archive · ' + journal.length + '</a>'
    + '<a href="/darshan/">Darshan</a><a href="/search/">Search</a><a href="/feed.xml">RSS</a></p>\n'
    + '</footer>\n'
    + '<nav class="tabbar" aria-label="Main">' + links(true) + '</nav>\n'
    + '<div id="toast" class="toast" role="status" aria-live="polite"></div>\n'
    + '<script src="/app.js" defer></script>\n'
    + scripts.map((s) => '<script src="' + s + '" defer></script>\n').join('')
    + '</body>\n</html>\n';
}

/* ---------- fragments ---------- */
const tagList = (tags) => tags.length
  ? '<div class="tags">' + tags.map((t) => '<a class="tag" href="/tags/' + esc(t) + '/">#' + esc(t) + '</a>').join('') + '</div>'
  : '';

const secChip = (id) => {
  const s = SECTION_BY_ID[id];
  return s ? '<a class="chip sec-' + s.id + '" href="/s/' + s.id + '/">' + esc(s.name) + '</a>' : '';
};

const readTime = (p) => (p.words > 400 ? '<span>' + Math.ceil(p.words / 220) + ' min read</span>' : '');

/* "about Tuesday" when a post was filed after the day it describes */
const aboutDay = (p) => (p.day && p.day !== keyOf(p.iso)
  ? '<span class="about">about ' + esc(fullDate(p.day)) + '</span>' : '');

/* ---------- the journal as a diary ----------
   One quiet row per entry -- a dot in its section's colour, the title, one
   line under it -- grouped under the day the entry is ABOUT. Cards with chips,
   excerpts, lessons and tags all at once read as a jumble; the post page is
   where the detail lives. */
const SEC_ORDER = Object.fromEntries(SECTIONS.map((s, i) => [s.id, i]));

function relDay(k) {
  if (k === TODAY) return 'Today';
  if (k === addDays(TODAY, -1)) return 'Yesterday';
  return '';
}

function entryRow(p, { showSection = true, showDate = false, excerpt = false } = {}) {
  const sec = SECTION_BY_ID[p.section];
  const name = p.title || (p.excerpt.length > 90 ? p.excerpt.slice(0, 88) + '…' : p.excerpt) || 'Untitled';
  const meta = [];
  if (showSection && sec) meta.push('<b>' + esc(sec.name) + '</b>');
  if (showDate) meta.push(esc(shortDate(p.day)));
  const line = p.lesson
    ? '<span class="eline">Instead: ' + esc(p.lesson) + '</span>'
    : (excerpt && p.title && p.excerpt ? '<span class="eline">' + esc(p.excerpt) + '</span>' : '');
  return '<a class="erow sec-' + esc(p.section) + '" href="' + p.url + '">'
    + '<span class="edot"></span>'
    + '<span class="ebody"><span class="ename' + (p.title ? '' : ' untitled') + '">' + esc(name) + '</span>'
    + (meta.length ? '<span class="emeta2">' + meta.join(' · ') + '</span>' : '')
    + line + '</span></a>';
}

/* within a day: the Daily story first, then goals, wins, mistakes... */
const byDiaryOrder = (a, b) => (SEC_ORDER[a.section] - SEC_ORDER[b.section]) || (a.ts - b.ts);

function dayGroups(list, opts = {}) {
  const groups = new Map();
  for (const p of list) (groups.get(p.day) || groups.set(p.day, []).get(p.day)).push(p);
  return [...groups.keys()].sort().reverse().map((k) => {
    const rel = relDay(k);
    return '<section class="dgroup"><h3 class="dghead">' + (rel ? '<b>' + rel + '</b>' : '')
      + '<span>' + esc(fullDate(k)) + '</span></h3>'
      + '<div class="rows">' + groups.get(k).sort(byDiaryOrder).map((p) => entryRow(p, opts)).join('') + '</div></section>';
  }).join('');
}

/* the newest N days that have any writing */
function recentDays(list, n) {
  const days = [...new Set(list.map((p) => p.day))].sort().reverse().slice(0, n);
  return list.filter((p) => days.includes(p.day));
}

const rowList = (list, opts) => '<div class="rows">' + list.map((p) => entryRow(p, opts)).join('') + '</div>';

/* a day (or week) of tasks, as a card whose boxes can be ticked in place */
function taskCard(p, heading, { link = true, cls = '' } = {}) {
  const t = p.tasks;
  const pct = t.total ? t.done / t.total : 0;
  return '<section class="card taskcard' + (cls ? ' ' + cls : '') + '" data-file="content/posts/' + esc(p.file) + '">\n'
    + '  <div class="cardhead"><h3>' + (link ? '<a href="' + p.url + '">' + esc(heading) + '</a>' : esc(heading)) + '</h3>'
    + '<span class="count" data-count>' + t.done + ' / ' + t.total + '</span></div>\n'
    + '  <div class="bar"><i data-bar style="width:' + Math.round(pct * 100) + '%"></i></div>\n'
    + '  ' + habitList(p.body) + '\n'
    + '</section>';
}

/* Yesterday, folded under today: the morning is when the evening's ticks get
   remembered, so they should be one tap away rather than a page away. */
function yesterdayCard(p) {
  const t = p.tasks;
  const pct = t.total ? t.done / t.total : 0;
  return '<details class="card taskcard yday" data-file="content/posts/' + esc(p.file) + '">\n'
    + '  <summary class="cardhead"><h3>Yesterday <span class="muted">· ' + esc(fullDate(p.iso)) + '</span></h3>'
    + '<span class="count" data-count>' + t.done + ' / ' + t.total + '</span></summary>\n'
    + '  <div class="bar"><i data-bar style="width:' + Math.round(pct * 100) + '%"></i></div>\n'
    + '  ' + habitList(p.body) + '\n'
    + '  <p class="muted small"><a href="' + p.url + '">Open the whole day →</a></p>\n'
    + '</details>';
}

/* The deity for a day: a real image in an arched frame when the config names
   one (deities[].image, under public/), otherwise the drawn medallion. */
function murti(d, { link = true, big = false } = {}) {
  if (!d) return '';
  let inner;
  if (d.image) {
    inner = '<img src="/' + esc(d.image) + '" alt="' + esc(d.name) + '" loading="' + (big ? 'lazy' : 'eager') + '"'
      + (d.imageFocus ? ' style="object-position:' + esc(d.imageFocus) + '"' : '') + '>';
  } else if (ART[d.id]) {
    inner = ART[d.id];
  } else {
    return '';
  }
  const cls = (d.image ? 'murti' : 'medal') + (big ? ' big' : '');
  return link
    ? '<a class="' + cls + '" href="/darshan/#' + d.id + '" aria-label="' + esc(d.name) + '">' + inner + '</a>'
    : '<div class="' + cls + '">' + inner + '</div>';
}
const medal = (k) => murti(deityFor(k));

function mantraBlock(k) {
  const d = deityFor(k);
  if (!d) return '';
  return '<p class="mantra" lang="sa">' + esc(d.mantra) + '</p>'
    + '<p class="roman">' + esc(d.roman) + ' <span class="dot">·</span> ' + esc(d.name) + '</p>';
}

function weekStrip(k) {
  const keys = weekKeys(k);
  return '<nav class="weekstrip" aria-label="This week">' + keys.map((key, i) => {
    const page = DAY_PAGES.get(key);
    const t = page ? page.tasks : null;
    const pct = t && t.total ? t.done / t.total : 0;
    const cls = ['wd', key === k ? 'today' : '', key > k ? 'future' : '',
      page && t.total && t.done === t.total ? 'full' : ''].filter(Boolean).join(' ');
    const inner = '<span class="wl">' + WEEK_LETTERS[i] + '</span>'
      + '<span class="wr">' + ring(pct, 44, 3.6) + '<span class="wn">' + +key.slice(8) + '</span></span>';
    return page
      ? '<a class="' + cls + '" href="' + page.url + '" data-ring="content/posts/' + esc(page.file) + '"'
        + ' title="' + esc(fullDate(key)) + ' — ' + t.done + ' of ' + t.total + '">' + inner + '</a>'
      : '<span class="' + cls + '">' + inner + '</span>';
  }).join('') + '</nav>';
}

/* The tracker grid: one row per routine item, one cell per day this week.
   Past cells can still be tapped -- the usual fix is ticking yesterday. */
function habitGrid(k) {
  const keys = weekKeys(k);
  const head = '<div class="hg-row hg-head"><span class="hg-name"></span>'
    + keys.map((key, i) => '<span class="hg-d' + (key === k ? ' today' : '') + '">' + WEEK_LETTERS[i]
      + '<small>' + +key.slice(8) + '</small></span>').join('')
    + '<span class="hg-sum">Week</span></div>';
  const rows = ROUTINE.map((item) => {
    const cells = keys.map((key) => {
      const page = DAY_PAGES.get(key);
      const it = page && taskItems(page.body).find((t) => norm(t.text) === norm(item.name));
      if (!it) return '<span class="cell ' + (key > k ? 'future' : 'none') + '"></span>';
      return '<button type="button" class="cell' + (key < k ? ' past' : '') + (key === k ? ' now' : '') + '"'
        + ' data-file="content/posts/' + esc(page.file) + '" data-task="' + esc(it.text) + '"'
        + ' aria-pressed="' + it.done + '" aria-label="' + esc(item.name + ', ' + fullDate(key)) + '" disabled></button>';
    }).join('');
    const count = keys.filter((key) => doneOn(key, item.name) === true).length;
    const target = item.target;
    const st = streak(item.name);
    const sum = target
      ? '<b class="' + (count >= target ? 'met' : '') + '">' + count + '/' + target + '</b>'
      : '<b>' + count + '</b>';
    const sub = target
      ? (count >= target ? 'done' : (target - count) + ' to go')
      : (st ? st + ' day' + (st === 1 ? '' : 's') + ' in a row' : '');
    return '<div class="hg-row"><span class="hg-name">' + esc(item.name) + '<small>' + esc(sub) + '</small></span>'
      + cells + '<span class="hg-sum" data-target="' + (target || '') + '">' + sum + '</span></div>';
  }).join('');
  const focusRow = '<div class="hg-row hg-focus"><span class="hg-name">Focus<small>hours, from the timer</small></span>'
    + keys.map((key) => {
      const f = FOCUS.get(key);
      return '<span class="fcell' + (key === k ? ' now' : '') + '">' + (f && f.sec ? fmtShort(f.sec) : '') + '</span>';
    }).join('')
    + '<span class="hg-sum"><b>' + fmtShort(keys.reduce((t, key) => t + ((FOCUS.get(key) || {}).sec || 0), 0)) + '</b></span></div>';
  return '<div class="hgrid">' + head + rows + focusRow + '</div>';
}

/* four weeks per habit, Monday-aligned, ending with this week */
function heatmaps(k) {
  const start = addDays(weekStartKey(k), -21);
  const keys = Array.from({ length: 28 }, (_, i) => addDays(start, i));
  return ROUTINE.map((item) => {
    let done = 0;
    let seen = 0;
    const cells = keys.map((key) => {
      const v = doneOn(key, item.name);
      if (key <= k && v !== null) seen++;
      if (v === true) done++;
      const cls = key > k ? 'fut' : v === true ? 'yes' : v === false ? (key === k ? 'open' : 'no') : 'off';
      return '<i class="' + cls + '" title="' + esc(fullDate(key)) + '"></i>';
    });
    /* grouped by week, so the eye can count Mondays */
    const weeks = [0, 7, 14, 21].map((i) => '<span class="wk">' + cells.slice(i, i + 7).join('') + '</span>').join('');
    return '<div class="heat"><div class="heathead"><span>' + esc(item.name) + '</span>'
      + '<span class="muted">' + done + ' of ' + seen + ' days</span></div>'
      + '<div class="heatcells">' + weeks + '</div></div>';
  }).join('');
}

function focusTimeline(key) {
  const f = FOCUS.get(key);
  if (!f || !f.sec) return '';
  const blocks = f.sessions.map((s) => {
    const p = clockParts(s.start);
    const a = p.h * 60 + p.mi;
    const w = Math.max(Number(s.sec) / 60, 4);
    return '<i style="left:' + (a / 14.4).toFixed(2) + '%;width:' + (w / 14.4).toFixed(2) + '%" title="'
      + esc(hhmm(s.start) + ' · ' + fmtDur(s.sec)) + '"></i>';
  }).join('');
  return '<div class="timeline"><div class="tl-track">' + blocks + '</div>'
    + '<div class="tl-hours"><span>0</span><span>6</span><span>12</span><span>18</span><span>24</span></div></div>';
}

/* ---------- write ---------- */
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const write = (rel, content) => {
  const f = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
};
/* JSON inside a <script> tag: nothing in it may close the tag */
const inlineJson = (o) => JSON.stringify(o).replace(/</g, '\\u003c');

const todayFocus = FOCUS.get(TODAY) || { sessions: [], sec: 0, n: 0 };
const focusCard = (k) => {
  const f = FOCUS.get(k) || { sessions: [], sec: 0, n: 0 };
  return '<section class="card focuscard" data-focus-card>\n'
    + '  <div class="fc-text"><p class="label">Focus today</p>'
    + '<p class="big" data-f-total>' + fmtDur(f.sec) + '</p>'
    + '<p class="sub"><span data-f-sub>of ' + fmtDur(FOCUS_TARGET) + ' · ' + f.n + ' block' + (f.n === 1 ? '' : 's') + '</span>'
    + '<span class="running" data-f-running hidden></span></p></div>\n'
    + '  <div class="fc-ring" data-f-ring>' + ring(f.sec / FOCUS_TARGET, 72, 7, 'focusring') + '</div>\n'
    + '  <a class="btn primary" href="/focus/">Start a block</a>\n'
    + '</section>';
};
/* what the focus script needs to show today live on any page */
const focusEmbed = () => '<script type="application/json" id="focusdata">' + inlineJson({
  today: TODAY,
  target: FOCUS_TARGET,
  presets: (CFG.focus && CFG.focus.presets) || [25, 30, 45, 60, 90],
  defaultMinutes: (CFG.focus && CFG.focus.defaultMinutes) || 30,
  repo: CFG.repo,
  branch: CFG.branch,
  weekStartsMonday: CFG.weekStartsMonday !== false,
  days: Object.fromEntries([...FOCUS].filter(([key]) => key >= addDays(TODAY, -40))
    .map(([key, v]) => [key, { sec: v.sec, n: v.n }])),
  sessions: todayFocus.sessions,
}) + '</script>';

/* ---------- home: today ---------- */
{
  const k = TODAY;
  const page = DAY_PAGES.get(k);
  const d = deityFor(k);
  const week = WEEK_PAGES.find((p) => weekStartKey(keyOf(p.iso)) === weekStartKey(k));
  const yday = DAY_PAGES.get(addDays(k, -1));
  const body = '<section class="hero">\n'
    + '  <div class="herotext">\n'
    + '    <p class="kicker">' + esc(VAAR[weekdayOf(k)]) + ' <span lang="hi">' + VAAR_DEVA[weekdayOf(k)] + '</span></p>\n'
    + '    <h1>' + esc(FULLDAYS[weekdayOf(k)]) + '<span>' + +k.slice(8) + ' ' + FULLMONTHS[+k.slice(5, 7) - 1] + '</span></h1>\n'
    + '    ' + mantraBlock(k) + '\n'
    + '  </div>\n'
    + '  ' + medal(k) + '\n'
    + '</section>\n'
    + weekStrip(k) + '\n'
    + (page
      ? taskCard(page, 'Today', { link: false, cls: 'today' })
      : '<section class="card"><p class="muted">Today\'s page appears at 5am. <a href="/admin/">Make it now</a> — pick Day Tasks and the routine fills itself in.</p></section>')
    + '\n' + (yday ? yesterdayCard(yday) + '\n' : '')
    + focusCard(k) + '\n'
    + (week ? taskCard(week, 'This week') + '\n' : '')
    + '<div class="rowhead"><h2>Journal</h2><a href="/journal/">Everything →</a></div>\n'
    + (journal.length ? dayGroups(recentDays(journal, 3)) : '<p class="muted">Nothing written yet.</p>') + '\n'
    + focusEmbed();
  write('index.html', shell({
    canonical: '/', nav: 'today', cls: 'home',
    desc: d ? CFG.tagline + ' ' + d.roman + '.' : CFG.tagline,
    body, scripts: ['/focus.js'],
  }));
}

/* ---------- habits ---------- */
write('habits/index.html', shell({
  title: 'Habits', canonical: '/habits/', nav: 'habits',
  body: '<div class="pagehead"><h1>Habits</h1><p class="muted">This week, ' + esc(shortDate(weekKeys(TODAY)[0]))
    + ' – ' + esc(shortDate(weekKeys(TODAY)[6])) + '. Tap a circle to tick a day, even a past one.</p></div>\n'
    + '<section class="card">' + habitGrid(TODAY) + '</section>\n'
    + '<div class="rowhead"><h2>Last four weeks</h2></div>\n'
    + '<section class="card heats">' + heatmaps(TODAY)
    + '<p class="legend"><i class="yes"></i> done <i class="no"></i> missed <i class="off"></i> not tracked</p></section>\n'
    + '<div class="rowhead"><h2>Every day</h2><span><a href="/s/weektasks/">Week lists</a> · <a href="/s/daytasks/">All days →</a></span></div>\n'
    + '<div class="stack">' + (bySection.daytasks || []).slice(0, 7).map((p) => taskCard(p, fullDate(p.iso))).join('\n') + '</div>',
}));

/* ---------- focus ---------- */
write('focus/index.html', shell({
  title: 'Focus', canonical: '/focus/', nav: 'focus', cls: 'focuspage',
  desc: 'A block timer with an alarm, and a running total of focused time.',
  scripts: ['/focus.js'],
  body: '<div id="focusapp" class="focusapp">\n'
    + '<section class="card timer">\n'
    + '  <div class="dial">\n'
    + '    <svg class="dialring" viewBox="0 0 240 240" aria-hidden="true"><circle class="track" cx="120" cy="120" r="108"/>'
    + '<circle class="prog" id="fprog" cx="120" cy="120" r="108" transform="rotate(-90 120 120)"/></svg>\n'
    + '    <div class="dialtext"><div class="clock" id="fclock">30:00</div><div class="fstate" id="fstate">Ready</div></div>\n'
    + '  </div>\n'
    + '  <div class="presets" id="fpresets" role="group" aria-label="Block length"></div>\n'
    + '  <div class="custom" id="fcustombox" hidden><input id="fcustom" type="number" inputmode="numeric" min="1" max="240" placeholder="minutes">'
    + '<button type="button" class="btn" id="fcustomset">Set</button></div>\n'
    + '  <div class="controls" id="fcontrols">\n'
    + '    <button type="button" class="btn primary big" id="fstart">Start</button>\n'
    + '    <button type="button" class="btn big" id="fpause" hidden>Pause</button>\n'
    + '    <button type="button" class="btn" id="fplus" hidden>+5 min</button>\n'
    + '    <button type="button" class="btn ghost" id="fstop" hidden>Stop &amp; log</button>\n'
    + '  </div>\n'
    + '  <div class="alarmbox" id="falarm" hidden>\n'
    + '    <p class="alarmtitle" id="falarmtitle">Time.</p>\n'
    + '    <div class="controls"><button type="button" class="btn primary big" id="fagain">Another block</button>'
    + '<button type="button" class="btn big" id="fdone">Done for now</button></div>\n'
    + '  </div>\n'
    + '  <p class="fnote" id="fnote"></p>\n'
    + '</section>\n'
    + '<section class="card ftoday">\n'
    + '  <div class="ftodayhead"><div><p class="label">Focused today</p><p class="big" id="ftotal">0m</p>'
    + '<p class="sub" id="fsub"></p></div><div id="fring"></div></div>\n'
    + '  <div class="timeline"><div class="tl-track" id="ftimeline"></div>'
    + '<div class="tl-hours"><span>0</span><span>6</span><span>12</span><span>18</span><span>24</span></div></div>\n'
    + '  <ul class="sessions" id="fsessions"></ul>\n'
    + '</section>\n'
    + '<section class="card">\n'
    + '  <div class="cardhead"><h3>This week</h3><span class="count" id="fweektotal"></span></div>\n'
    + '  <div class="bars" id="fweek"></div>\n'
    + '</section>\n'
    + '<section class="card fsettings">\n'
    + '  <div class="cardhead"><h3>Alarm</h3></div>\n'
    + '  <label class="switch"><input type="checkbox" id="fsound" checked><span>Bell when a block ends</span></label>\n'
    + '  <label class="switch"><input type="checkbox" id="fwake"><span>Keep the screen on while a block runs</span></label>\n'
    + '  <div class="notifyrow"><span id="fnotifystate">Notifications</span><button type="button" class="btn" id="fnotify">Allow notifications</button>'
    + '<button type="button" class="btn ghost" id="ftest">Test the alarm</button></div>\n'
    + '  <p class="muted small" id="fsync"></p>\n'
    + '</section>\n'
    + '</div>\n'
    + focusEmbed(),
}));

/* ---------- journal: a diary, newest day first ---------- */
{
  const chips = SECTIONS.filter((s) => !s.tasks).map((s) => '<a class="chip sec-' + s.id + '" href="/s/' + s.id + '/">'
    + esc(s.name) + ' <b>' + (bySection[s.id] || []).length + '</b></a>').join('');
  const shown = recentDays(journal, 14);
  write('journal/index.html', shell({
    title: 'Journal', canonical: '/journal/', nav: 'journal',
    body: '<div class="pagehead"><h1>Journal</h1><p class="muted">Everything written, under the day it is about.</p></div>\n'
      + '<nav class="secchips" aria-label="Sections">' + chips + '</nav>\n'
      + dayGroups(shown) + '\n'
      + (journal.length > shown.length ? '<p class="more"><a href="/archive/">Older days are in the archive →</a></p>' : ''),
  }));
}

/* ---------- darshan: all seven, one per weekday ---------- */
write('darshan/index.html', shell({
  title: 'Darshan', canonical: '/darshan/',
  body: '<div class="pagehead"><h1>Darshan</h1><p class="muted">One for each day of the week. Today\'s sits at the top of the Today page.</p></div>\n'
    + '<div class="darshan">' + [1, 2, 3, 4, 5, 6, 0].map((dow) => {
      const d = DEITIES.find((x) => x.day === dow);
      if (!d) return '';
      /* a borrowed image says whose it is, right under it */
      const credit = d.image && d.credit
        ? '<p class="credit">' + (d.source ? '<a href="' + esc(d.source) + '" rel="noopener">' + esc(d.credit) + '</a>' : esc(d.credit))
          + (d.license ? ' · ' + esc(d.license) : '') + '</p>'
        : '';
      return '<section class="card dcard' + (dow === weekdayOf(TODAY) ? ' today' : '') + '" id="' + d.id + '">'
        + murti(d, { link: false, big: true })
        + '<p class="kicker">' + VAAR[dow] + ' <span lang="hi">' + VAAR_DEVA[dow] + '</span></p>'
        + '<h2>' + esc(d.name) + '</h2>'
        + '<p class="mantra" lang="sa">' + esc(d.mantra) + '</p><p class="roman">' + esc(d.roman) + '</p>'
        + credit + '</section>';
    }).join('') + '</div>',
}));

/* ---------- section pages ---------- */
for (const s of SECTIONS) {
  const ps = bySection[s.id] || [];
  /* one section read end to end: the date and a line of each, newest first */
  const list = s.tasks
    ? '<div class="stack">' + ps.map((p) => taskCard(p, p.title || fullDate(p.iso))).join('\n') + '</div>'
    : rowList(ps, { showSection: false, showDate: true, excerpt: true });
  write('s/' + s.id + '/index.html', shell({
    title: s.name, desc: s.blurb, canonical: '/s/' + s.id + '/',
    nav: s.tasks ? 'habits' : 'journal',
    body: '<div class="pagehead"><p class="kicker"><a href="/journal/">Journal</a></p>'
      + '<h1><span class="dotsec sec-' + s.id + '"></span>' + esc(s.name) + '</h1>'
      + '<p class="muted">' + esc(s.blurb) + '</p></div>\n'
      + (s.id === 'daytasks' ? '<p class="muted"><a href="/habits/">The tracker view →</a></p>\n' : '')
      + (ps.length ? list : '<p class="muted">Nothing filed here yet. <a href="/admin/">Add the first one</a>.</p>'),
  }));
}

/* ---------- posts ---------- */
for (const p of posts) {
  const sec = SECTION_BY_ID[p.section];
  /* prev/next stay inside the same section -- reading one section end to end is
     the point of having sections at all */
  const sibs = bySection[p.section] || [];
  const at = sibs.indexOf(p);
  const prev = sibs[at + 1];
  const next = sibs[at - 1];
  const label = (q) => esc((q.title || fullDate(q.iso)).slice(0, 44));
  const pager = '<nav class="pager">'
    + (prev ? '<a href="' + prev.url + '">← ' + label(prev) + '</a>' : '<span></span>')
    + (next ? '<a href="' + next.url + '">' + label(next) + ' →</a>' : '<span></span>')
    + '</nav>';
  let body;

  if (p.section === 'daytasks') {
    /* a day page reads like a page of a diary: the day, its deity, the ticks,
       the focus, and everything written about that day */
    const k = keyOf(p.iso);
    const notes = stripTasks(p.body);
    const about = journal.filter((q) => q.day === k);
    const f = FOCUS.get(k);
    body = '<article class="daypage">\n'
      + '<section class="hero small">\n'
      + '  <div class="herotext"><p class="kicker">' + esc(VAAR[weekdayOf(k)]) + ' <span lang="hi">' + VAAR_DEVA[weekdayOf(k)] + '</span></p>\n'
      + '  <h1>' + esc(FULLDAYS[weekdayOf(k)]) + '<span>' + +k.slice(8) + ' ' + FULLMONTHS[+k.slice(5, 7) - 1] + ' ' + k.slice(0, 4) + '</span></h1>\n'
      + '  ' + mantraBlock(k) + '</div>\n'
      + '  ' + medal(k) + '\n'
      + '</section>\n'
      + taskCard(p, 'Habits', { link: false }) + '\n'
      + '<section class="card"><div class="cardhead"><h3>Focus</h3><span class="count">'
      + (f && f.sec ? fmtDur(f.sec) + ' · ' + f.n + ' block' + (f.n === 1 ? '' : 's') : 'none logged') + '</span></div>'
      + focusTimeline(k) + '</section>\n'
      + (notes ? '<section class="card prose">' + marked.parse(notes) + '</section>\n' : '')
      + (about.length ? '<div class="rowhead"><h2>Written about this day</h2></div>'
        + rowList(about.sort(byDiaryOrder)) + '\n' : '')
      + '</article>\n' + pager;
  } else if (sec && sec.tasks) {
    body = '<div class="pagehead"><p class="kicker">' + secChip(p.section) + '</p><h1>' + esc(p.title || fullDate(p.iso)) + '</h1>'
      + '<p class="muted">' + esc(fmtDate(p.iso, false)) + '</p></div>\n'
      + taskCard(p, 'The list', { link: false }) + '\n'
      + (stripTasks(p.body) ? '<section class="card prose">' + marked.parse(stripTasks(p.body)) + '</section>\n' : '')
      + pager;
  } else {
    const lessonBlock = p.lesson
      ? '  <aside class="lesson"><b>' + esc((sec && sec.lessonLabel) || 'Instead') + '</b>'
        + '<span>' + esc(p.lesson) + '</span></aside>\n'
      : '';
    /* data-file lets the browser find this post's source to tick a box off.
       Public visitors have no token, so for them the checkboxes stay inert. */
    body = '<article class="post" data-file="content/posts/' + esc(p.file) + '">\n'
      + '  <div class="emeta">' + secChip(p.section) + '<span class="when">' + esc(fmtDate(p.iso)) + '</span>'
      + aboutDay(p) + readTime(p) + '</div>\n'
      + (p.title ? '  <h1>' + esc(p.title) + '</h1>\n' : '<div class="spacer"></div>\n')
      + '  <div class="prose">' + p.html + '</div>\n'
      + lessonBlock
      + (p.tags.length ? '  ' + tagList(p.tags) + '\n' : '')
      + '</article>\n' + pager;
  }
  write('posts/' + p.slug + '/index.html', shell({
    title: p.title || fullDate(p.iso),
    desc: p.excerpt || (sec && sec.blurb),
    canonical: p.url,
    nav: sec && sec.tasks ? 'habits' : 'journal',
    body,
  }));
}

/* ---------- tags ---------- */
const byTag = {};
for (const p of journal) for (const t of p.tags) (byTag[t] ||= []).push(p);
for (const [t, ps] of Object.entries(byTag)) {
  write('tags/' + t + '/index.html', shell({
    title: '#' + t, canonical: '/tags/' + t + '/', nav: 'journal',
    body: '<div class="pagehead"><h1>#' + esc(t) + '</h1><p class="muted">' + ps.length + ' entr' + (ps.length === 1 ? 'y' : 'ies') + '</p></div>\n'
      + rowList(ps, { showDate: true }),
  }));
}

/* ---------- archive ---------- */
{
  const byMonth = {};
  for (const p of journal) (byMonth[monthKey(p.iso)] ||= []).push(p);
  const cloud = Object.keys(byTag).length
    ? '<div class="tags tagcloud">' + Object.entries(byTag).sort((a, b) => b[1].length - a[1].length)
      .map(([t, ps]) => '<a class="tag" href="/tags/' + esc(t) + '/">#' + esc(t) + ' <span class="n">' + ps.length + '</span></a>').join('')
      + '</div>'
    : '';
  write('archive/index.html', shell({
    title: 'Archive', canonical: '/archive/', nav: 'journal',
    body: '<div class="pagehead"><h1>Archive</h1><p class="muted">Everything written, newest first. Day pages live under <a href="/s/daytasks/">Day Tasks</a>.</p></div>\n'
      + cloud + '\n'
      + Object.keys(byMonth).sort().reverse().map((mk) => '<section class="card month">\n'
        + '  <h2>' + esc(monthLabel(mk)) + '</h2>\n'
        + '  <ul>' + byMonth[mk].map((p) => '<li><span class="d">' + pad2(clockParts(p.iso).d) + '</span>'
          + '<a href="' + p.url + '">' + esc(p.title || p.excerpt.slice(0, 70) || 'Untitled') + '</a>'
          + secChip(p.section) + '</li>').join('') + '</ul>\n'
        + '</section>').join('\n'),
  }));
}

/* ---------- search ---------- */
write('search/index.html', shell({
  title: 'Search', canonical: '/search/',
  body: '<div class="pagehead"><h1>Search</h1><p class="muted">Every word of every entry. Section names work too.</p></div>\n'
    + '<input id="q" type="search" placeholder="Type to search…" autocomplete="off" autofocus>\n'
    + '<div id="results"></div>',
}));
write('search.json', JSON.stringify(posts.map((p) => ({
  t: p.title || (isTaskSection(p.section) ? fullDate(p.iso) : ''), u: p.url, d: fmtDate(p.iso, false), g: p.tags,
  s: (SECTION_BY_ID[p.section] || {}).name || '', i: p.section,
  x: p.text.slice(0, 1500),
}))));

/* ---------- rss ---------- */
const rssItems = journal.slice(0, 50).map((p) => '  <item>\n'
  + '    <title>' + esc(p.title || fmtDate(p.iso, false)) + '</title>\n'
  + '    <link>' + esc(CFG.url + p.url) + '</link>\n'
  + '    <guid isPermaLink="true">' + esc(CFG.url + p.url) + '</guid>\n'
  + '    <category>' + esc((SECTION_BY_ID[p.section] || {}).name || '') + '</category>\n'
  + '    <pubDate>' + new Date(p.ts).toUTCString() + '</pubDate>\n'
  + '    <description>' + esc(p.excerpt) + '</description>\n'
  + '  </item>').join('\n');
write('feed.xml', '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<rss version="2.0"><channel>\n'
  + '  <title>' + esc(SITE_NAME) + '</title>\n'
  + '  <link>' + esc(CFG.url) + '</link>\n'
  + '  <description>' + esc(CFG.tagline) + '</description>\n'
  + rssItems + '\n</channel></rss>\n');

/* focus totals as data, for anything that wants them */
write('focus.json', JSON.stringify({
  target: FOCUS_TARGET,
  days: Object.fromEntries([...FOCUS].map(([key, v]) => [key, { sec: v.sec, n: v.n }])),
}));

/* ---------- static passthrough ---------- */
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

/* the editor reads the repo coordinates and the section list from here, so
   site.config.json stays the single place any of this is configured */
write('admin/config.json', JSON.stringify({
  repo: CFG.repo, branch: CFG.branch, quickTags: CFG.quickTags || [],
  url: CFG.url, sections: SECTIONS, speechLang: CFG.speechLang || 'en-IN',
  routine: CFG.routine || [], weeklyRoutine: CFG.weeklyRoutine || [],
}));

for (const f of ['style.css', 'app.js', 'focus.js', 'sw.js']) {
  fs.copyFileSync(path.join(ROOT, 'src', f), path.join(OUT, f));
}
write('.nojekyll', '');
write('404.html', shell({
  title: 'Not found',
  body: '<div class="pagehead"><h1>Not found</h1><p class="muted">That page does not exist. <a href="/">Back to today</a>.</p></div>',
}));

console.log('built ' + posts.length + ' posts (' + journal.length + ' journal, '
  + DAY_PAGES.size + ' day pages) across '
  + SECTIONS.filter((s) => (bySection[s.id] || []).length).length + '/' + SECTIONS.length
  + ' sections, ' + Object.keys(byTag).length + ' tags, ' + FOCUS.size + ' focus days; today = ' + TODAY);
