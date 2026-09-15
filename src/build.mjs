/* Static generator for the journal.
   Design notes:
   - Every post belongs to exactly one SECTION (daily, goals, feynman, wins,
     mistakes, speaking, vocabulary, blabber). Tags stay, but they are secondary.
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

const SECTIONS = CFG.sections || [];
const SECTION_BY_ID = Object.fromEntries(SECTIONS.map((s) => [s.id, s]));
const FALLBACK = SECTIONS.length ? SECTIONS[SECTIONS.length - 1].id : 'blabber';

/* No personal name on this site by design (2026-09-13) -- the tagline carries
   the identity instead. Text that technically cannot be blank (browser tab,
   RSS reader title, og:title) falls back to it. Setting CFG.title back to a
   real value brings the old name-led header/masthead straight back. */
const SITE_NAME = CFG.title || CFG.tagline;

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

const shortDate = (iso) => {
  const p = clockParts(iso);
  return p ? p.d + ' ' + MONTHS[p.mo - 1] : '';
};

/* "Saturday 12 September" -- the heading a day of tasks gets, so the list reads
   like a page in a diary rather than a blog post with a date on it */
const FULLDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const FULLMONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
function fullDate(iso) {
  const p = clockParts(iso);
  if (!p) return String(iso);
  const dow = FULLDAYS[new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay()];
  return dow + ' ' + p.d + ' ' + FULLMONTHS[p.mo - 1];
}

const monthKey = (iso) => {
  const p = clockParts(iso);
  return p ? p.y + '-' + String(p.mo).padStart(2, '0') : '0000-00';
};
const monthLabel = (k) => {
  const parts = k.split('-');
  return MONTHS[+parts[1] - 1] + ' ' + parts[0];
};

/* "- [ ] thing" / "- [x] thing" -- counted so a task post can show its own
   progress without anyone maintaining a tally by hand */
function countTasks(md) {
  const open = (md.match(/^\s*[-*]\s+\[ \]\s+/gm) || []).length;
  const done = (md.match(/^\s*[-*]\s+\[[xX]\]\s+/gm) || []).length;
  return { open, done, total: open + done };
}

function progressBar(t) {
  if (!t.total) return '';
  const pct = Math.round((t.done / t.total) * 100);
  return '<div class="progress">' + t.done + ' of ' + t.total + ' done'
    + '<span class="bar"><i style="width:' + pct + '%"></i></span>' + pct + '%</div>';
}

/* The tasks themselves, rendered into the listing. A list you have to click
   into to read is a list you stop checking. Built from the markdown rather
   than scraped out of the rendered post so the index order is guaranteed to
   match the source order the toggler rewrites. */
function taskListHtml(md) {
  const items = [];
  for (const line of md.split('\n')) {
    const m = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/);
    if (m) items.push({ done: m[1] !== ' ', text: m[2] });
  }
  if (!items.length) return '';
  return '<ul class="tasks">' + items.map((i) => '<li><input type="checkbox" disabled'
    + (i.done ? ' checked' : '') + '>' + marked.parseInline(i.text) + '</li>').join('')
    + '</ul>';
}

/* Routine items are either "Gym" or { name: "Gym", target: 5 }. */
const ROUTINE = (CFG.routine || []).map((r) => (typeof r === 'string' ? { name: r } : r));

/* Monday-based week key, so a week reads Mon..Sun the way a week actually does. */
function weekStart(iso) {
  const p = clockParts(iso);
  if (!p) return null;
  const d = new Date(Date.UTC(p.y, p.mo - 1, p.d));
  const dow = d.getUTCDay();                       // 0 = Sunday
  const back = CFG.weekStartsMonday === false ? dow : (dow + 6) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d;
}
const ymd = (d) => d.toISOString().slice(0, 10);

/* Which routine items got ticked on a given day page. Matched on the task text
   so a day page can carry extra one-off tasks without confusing the tally. */
function doneNames(md) {
  const done = new Set();
  for (const line of md.split('\n')) {
    const m = line.match(/^\s*[-*+]\s+\[[xX]\]\s+(.*)$/);
    if (m) done.add(m[1].trim().toLowerCase());
  }
  return done;
}

function plainText(md) {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^>\s?/gm, '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s*/gm, '')  /* task markers */
    .replace(/^\s*[-*+]\s+/gm, '')              /* list bullets */
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
    /* Normalized to LF once, here, for every function downstream. Git's
       core.autocrlf on this machine writes CRLF into the working tree, and a
       line ending in \r silently breaks any regex capturing "rest of line"
       with (.*)$  -- \r is a line terminator in JS regex, so . can't consume
       it and $ won't match past it. doneNames() and taskListHtml() both hit
       this: doneNames returned an empty set for a correctly-ticked box, and
       taskListHtml rendered zero items for a six-item list. Fixing it once
       here beats re-deriving \r?-tolerance in every regex that touches body. */
    const raw = fs.readFileSync(path.join(POSTS_DIR, file), 'utf8').replace(/\r\n/g, '\n');
    const { data, body } = parseFront(raw);
    const fileDate = (file.match(/^(\d{4}-\d{2}-\d{2})/) || [])[1];
    const iso = data.date || (fileDate ? fileDate + 'T00:00' : '1970-01-01T00:00');
    const title = (data.title || '').trim();
    const text = plainText(body);
    const tags = (Array.isArray(data.tags) ? data.tags : (data.tags ? [data.tags] : []))
      .map((t) => String(t).toLowerCase().trim()).filter(Boolean);
    const section = SECTION_BY_ID[String(data.section || '').toLowerCase()] ? String(data.section).toLowerCase() : FALLBACK;
    /* An untitled day page is identified by its day, not by its filename --
       /posts/daytasks-2026-09-12/ rather than the timestamped source name. */
    const dateSlug = (clockParts(iso)
      ? section + '-' + String(clockParts(iso).y) + '-'
        + String(clockParts(iso).mo).padStart(2, '0') + '-'
        + String(clockParts(iso).d).padStart(2, '0')
      : '');
    const slug = data.slug || slugify(title) || dateSlug || file.replace(/\.md$/, '');
    return {
      file, title, iso, tags, body, text, slug, section,
      lesson: (data.lesson || '').trim(),
      draft: data.draft === true,
      url: '/posts/' + slug + '/',
      ts: new Date(iso).getTime() || 0,
      words: text ? text.split(/\s+/).length : 0,
      excerpt: text.slice(0, 240) + (text.length > 240 ? '…' : ''),
      html: marked.parse(body),
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

/* ---------- page shell ---------- */
function sectionStrip(activeId) {
  return '<nav class="strip" aria-label="Sections">'
    + SECTIONS.map((s) => '<a href="/s/' + s.id + '/"' + (s.id === activeId ? ' class="on" aria-current="page"' : '') + '>'
      + esc(s.name) + '</a>').join('')
    + '</nav>';
}

function shell({ title, desc, body, canonical, activeId = '' }) {
  const t = title ? title + ' · ' + SITE_NAME : SITE_NAME;
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
    + '<link rel="alternate" type="application/rss+xml" title="' + esc(SITE_NAME) + '" href="/feed.xml">\n'
    + '<link rel="icon" href="/icon.svg" type="image/svg+xml">\n'
    + '<link rel="apple-touch-icon" href="/icon-180.png">\n'
    + '<link rel="manifest" href="/manifest.webmanifest">\n'
    + '<meta name="theme-color" content="#faf7f0">\n'
    + '<link rel="preconnect" href="https://fonts.googleapis.com">\n'
    + '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
    + '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?'
    + 'family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;0,6..72,600;1,6..72,400'
    + '&family=IBM+Plex+Mono:wght@400;500&display=swap">\n'
    + '<link rel="stylesheet" href="/style.css">\n'
    + '<script>(function(){try{var t=localStorage.getItem("theme");if(t)document.documentElement.dataset.theme=t}catch(e){}})();</script>\n'
    + '</head>\n<body>\n'
    + '<header class="site">\n'
    /* "Home" is navigation, not an identity -- keeps the flex layout (brand
       left, nav right) intact without needing a name to show there. */
    + '  <a class="brand" href="/">' + (CFG.title ? esc(CFG.title) : 'Home') + '</a>\n'
    + '  <nav>\n'
    + '    <a href="/archive/">Archive</a>\n'
    + '    <a href="/search/">Search</a>\n'
    + '    <a href="/admin/">Write</a>\n'
    + '    <button id="themetoggle" type="button" aria-label="Toggle theme">◐</button>\n'
    + '  </nav>\n'
    + '</header>\n'
    + sectionStrip(activeId) + '\n'
    + '<main>\n' + body + '\n</main>\n'
    + '<footer class="site">\n'
    + (CFG.author ? '  <span>' + esc(CFG.author) + '</span>\n  <span class="sep">·</span>\n' : '')
    + '  <a href="/archive/">' + posts.length + ' post' + (posts.length === 1 ? '' : 's') + '</a>\n'
    + '  <span class="sep">·</span>\n'
    + '  <a href="/feed.xml">RSS</a>\n'
    + '</footer>\n'
    + '<script src="/app.js"></script>\n'
    + '</body>\n</html>\n';
}

/* ---------- fragments ---------- */
const tagList = (tags) => tags.length
  ? '<div class="tags">' + tags.map((t) => '<a class="tag" href="/tags/' + esc(t) + '/">' + esc(t) + '</a>').join('') + '</div>'
  : '';

const readTime = (p) => (p.words > 400 ? ' <span class="sep">·</span> ' + Math.ceil(p.words / 220) + ' min' : '');

function feedItem(p, showSection = true) {
  const sec = SECTION_BY_ID[p.section];
  const isTaskCard = !!(sec && sec.tasks && p.tasks.total);

  /* A day of tasks is headed by its day, not by a made-up title. */
  const headText = p.title || (isTaskCard ? fullDate(p.iso) : '');
  const heading = headText
    ? '<h2 class="pt"><a href="' + p.url + '">' + esc(headText) + '</a></h2>'
    : '<h2 class="pt untitled"><a href="' + p.url + '">' + esc(p.excerpt.slice(0, 90) || 'Untitled') + '</a></h2>';

  const metaBits = [];
  if (showSection && sec) metaBits.push('<a class="secref" href="/s/' + sec.id + '/">' + esc(sec.name) + '</a>');
  metaBits.push('<a href="' + p.url + '">'
    + esc(isTaskCard ? fmtDate(p.iso, false) : fmtDate(p.iso)) + '</a>' + readTime(p));

  return '<article class="card' + (isTaskCard ? ' taskcard' : '') + '"'
    + (isTaskCard ? ' data-file="content/posts/' + esc(p.file) + '"' : '') + '>\n'
    + '  <div class="meta">' + metaBits.join(' <span class="sep">·</span> ') + '</div>\n'
    + '  ' + heading + '\n'
    + (isTaskCard
      ? '  ' + progressBar(p.tasks) + '\n  ' + taskListHtml(p.body) + '\n'
      : (p.tasks.total ? '  ' + progressBar(p.tasks) + '\n'
        : (p.title ? '  <p class="ex">' + esc(p.excerpt) + '</p>\n' : '')))
    + (p.lesson ? '  <p class="lessonline"><b>Instead →</b> ' + esc(p.lesson) + '</p>\n' : '')
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

/* home: a table of contents, the way a notebook has one -- then what is newest */
const board = '<nav class="contents">'
  + SECTIONS.map((s) => {
    const ps = bySection[s.id] || [];
    const count = ps.length
      ? ps.length + ' · ' + esc(shortDate(ps[0].iso))
      : '<span class="empty-dot">empty</span>';
    return '<a href="/s/' + s.id + '/">'
      + '<span class="n">' + esc(s.name) + '</span>'
      + '<span class="c">' + count + '</span>'
      + '<span class="b">' + esc(s.blurb) + '</span>'
      + '</a>';
  }).join('')
  + '</nav>';

/* With no name to lead on, the tagline itself becomes the h1 -- one line,
   not the name followed by a restatement of it underneath. */
const masthead = CFG.title
  ? '<div class="masthead"><h1>' + esc(CFG.title) + '</h1>'
    + '<p class="sub">' + esc(CFG.tagline) + '</p></div>\n'
  : '<div class="masthead"><h1 class="taglineh1">' + esc(CFG.tagline) + '</h1></div>\n';

const latest = posts.slice(0, CFG.latestOnHome || 15);
write('index.html', shell({
  canonical: '/',
  body: masthead
    + board + '\n'
    + '<h2 class="rule">Latest</h2>\n'
    + '<div class="feed">'
    + (latest.map((p) => feedItem(p)).join('\n') || '<p class="empty">Nothing here yet. Go say something.</p>')
    + '</div>\n'
    + (posts.length > latest.length ? '<nav class="pager"><span></span><a href="/archive/">everything in the archive →</a></nav>' : ''),
}));

/* ---------- this week's scoreboard ----------
   Built from the day pages themselves, so it cannot disagree with them. Shows
   the week Mon..Sun: what was done, what was missed, and how far off target.
   The site cannot nag, so the miss has to be visible the moment the page opens. */
function scoreboard() {
  const days = (bySection.daytasks || []);
  if (!days.length || !ROUTINE.length) return '';

  const start = weekStart(days[0].iso);            // week of the most recent day page
  if (!start) return '';
  const startKey = ymd(start);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);

  /* one slot per weekday, holding that day's page if it exists */
  const slots = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    const key = ymd(d);
    const page = days.find((p) => {
      const c = clockParts(p.iso);
      return c && key === c.y + '-' + String(c.mo).padStart(2, '0') + '-' + String(c.d).padStart(2, '0');
    });
    slots.push({ key, page, done: page ? doneNames(page.body) : null });
  }

  const rows = ROUTINE.map((item) => {
    const want = item.name.trim().toLowerCase();
    const marks = slots.map((s) => {
      if (!s.page) return '<i class="no"></i>';               // no page for that day yet
      return s.done.has(want) ? '<i class="yes"></i>' : '<i class="miss"></i>';
    }).join('');
    const count = slots.filter((s) => s.done && s.done.has(want)).length;
    const target = item.target;
    const met = target ? count >= target : null;
    const tally = target ? count + ' / ' + target : String(count);
    const note = target
      ? (met ? 'done' : (target - count) + ' to go')
      : count + (count === 1 ? ' day' : ' days');
    return '<li class="' + (met === false ? 'short' : (met ? 'met' : '')) + '">'
      + '<span class="n">' + esc(item.name) + '</span>'
      + '<span class="dots">' + marks + '</span>'
      + '<span class="tally">' + esc(tally) + '</span>'
      + '<span class="note">' + esc(note) + '</span>'
      + '</li>';
  }).join('');

  const label = shortDate(startKey + 'T00:00') + ' – ' + shortDate(ymd(end) + 'T00:00');
  return '<section class="scoreboard">\n'
    + '  <h2 class="rule">This week · ' + esc(label) + '</h2>\n'
    /* same grid and same dot widths as the rows, so the letters sit over them */
    + '  <div class="wkhead"><span></span><span class="dots">'
    + ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d) => '<i>' + d + '</i>').join('')
    + '</span><span></span></div>\n'
    + '  <ul class="score">' + rows + '</ul>\n'
    + '</section>';
}

/* section pages */
for (const s of SECTIONS) {
  const ps = bySection[s.id] || [];
  write('s/' + s.id + '/index.html', shell({
    title: s.name,
    desc: s.blurb,
    canonical: '/s/' + s.id + '/',
    activeId: s.id,
    body: '<h1 class="pagetitle">' + esc(s.name) + '</h1>\n'
      + '<p class="tagline">' + esc(s.blurb) + '</p>\n'
      + (s.id === 'daytasks' ? scoreboard() + '\n' : '')
      + '<div class="feed">'
      + (ps.map((p) => feedItem(p, false)).join('\n')
        || '<p class="empty">Nothing filed here yet. <a href="/admin/">Add the first one</a>.</p>')
      + '</div>',
  }));
}

/* posts */
for (let i = 0; i < posts.length; i++) {
  const p = posts[i];
  const sec = SECTION_BY_ID[p.section];
  /* prev/next stay inside the same section -- reading one section end to end is
     the point of having sections at all */
  const sibs = bySection[p.section] || [];
  const at = sibs.indexOf(p);
  const prev = sibs[at + 1];
  const next = sibs[at - 1];
  const label = (q) => esc((q.title || fmtDate(q.iso, false)).slice(0, 40));
  const lessonBlock = p.lesson
    ? '  <aside class="lesson"><b>' + esc((sec && sec.lessonLabel) || 'Instead') + '</b>'
      + '<span>' + esc(p.lesson) + '</span></aside>\n'
    : '';
  /* data-file lets the browser find this post's source to tick a box off. Public
     visitors have no token, so for them the checkboxes stay inert. */
  const body = '<article class="post" data-file="content/posts/' + esc(p.file) + '">\n'
    + '  <div class="meta">'
    + (sec ? '<a class="secref" href="/s/' + sec.id + '/">' + esc(sec.name) + '</a> <span class="sep">·</span> ' : '')
    + esc(fmtDate(p.iso))
    + (p.words > 400 ? ' <span class="sep">·</span> ' + Math.ceil(p.words / 220) + ' min read' : '')
    + '</div>\n'
    + (p.title
      ? '  <h1>' + esc(p.title) + '</h1>\n'
      : (sec && sec.tasks ? '  <h1>' + esc(fullDate(p.iso)) + '</h1>\n' : ''))
    + (p.tasks.total ? '  ' + progressBar(p.tasks) + '\n' : '')
    + '  <div class="prose">' + p.html + '</div>\n'
    + lessonBlock
    + '  ' + tagList(p.tags) + '\n'
    + '</article>\n'
    + '<nav class="pager">'
    + (prev ? '<a href="' + prev.url + '">← ' + label(prev) + '</a>' : '<span></span>')
    + (next ? '<a href="' + next.url + '">' + label(next) + ' →</a>' : '<span></span>')
    + '</nav>';
  write('posts/' + p.slug + '/index.html', shell({
    title: p.title || fmtDate(p.iso, false),
    desc: p.excerpt,
    canonical: p.url,
    activeId: p.section,
    body,
  }));
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
      + '<div class="feed">' + ps.map((p) => feedItem(p)).join('\n') + '</div>',
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
const archiveBody = '<h1 class="pagetitle">Archive</h1>\n'
  + '<p class="tagline">Everything, newest first.</p>\n' + cloud + '\n'
  + Object.keys(byMonth).sort().reverse().map((k) => '<section class="month">\n'
    + '  <h2>' + esc(monthLabel(k)) + '</h2>\n'
    + '  <ul>' + byMonth[k].map((p) => {
      const sec = SECTION_BY_ID[p.section];
      return '<li><span class="d">' + String(clockParts(p.iso).d).padStart(2, '0') + '</span>'
        + '<a href="' + p.url + '">' + esc(p.title || p.excerpt.slice(0, 70) || 'Untitled') + '</a>'
        + (sec ? '<span class="sectag">' + esc(sec.name) + '</span>' : '') + '</li>';
    }).join('') + '</ul>\n'
    + '</section>').join('\n');
write('archive/index.html', shell({ title: 'Archive', body: archiveBody, canonical: '/archive/' }));

/* search */
write('search/index.html', shell({
  title: 'Search',
  canonical: '/search/',
  body: '<h1 class="pagetitle">Search</h1>\n'
    + '<p class="tagline">Every word of every post. Section names work too.</p>\n'
    + '<input id="q" type="search" placeholder="Type to search…" autocomplete="off" autofocus>\n'
    + '<div id="results" class="feed"></div>',
}));
write('search.json', JSON.stringify(posts.map((p) => ({
  t: p.title, u: p.url, d: fmtDate(p.iso, false), g: p.tags,
  s: (SECTION_BY_ID[p.section] || {}).name || '',
  x: p.text.slice(0, 1200),
}))));

/* rss */
const rssItems = posts.slice(0, 50).map((p) => '  <item>\n'
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

/* the editor reads the repo coordinates and the section list from here, so
   site.config.json stays the single place any of this is configured */
write('admin/config.json', JSON.stringify({
  repo: CFG.repo, branch: CFG.branch, quickTags: CFG.quickTags || [],
  url: CFG.url, sections: SECTIONS, speechLang: CFG.speechLang || 'en-IN',
  routine: CFG.routine || [],
}));

fs.copyFileSync(path.join(ROOT, 'src', 'style.css'), path.join(OUT, 'style.css'));
fs.copyFileSync(path.join(ROOT, 'src', 'app.js'), path.join(OUT, 'app.js'));
write('.nojekyll', '');
write('404.html', shell({
  title: 'Not found',
  body: '<h1 class="pagetitle">Not found</h1><p class="tagline">That page does not exist. <a href="/">Back home</a>.</p>',
}));

console.log('built ' + posts.length + ' posts across '
  + SECTIONS.filter((s) => (bySection[s.id] || []).length).length + '/' + SECTIONS.length
  + ' sections, ' + Object.keys(byTag).length + ' tags');
