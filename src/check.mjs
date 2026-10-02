/* Checks the built site (dist/) and the content for the problems that never show
   up as an error: a link to a page that is not there, an image that 404s, a tick
   box pointing at a file that is not in the repo, writing filed under a task
   section, a verse missing a field.

     npm run build && npm run check

   Exits 1 if anything is wrong. It reads, it never changes anything. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const problems = [];
const bad = (where, what) => problems.push(where + ' — ' + what);

if (!fs.existsSync(DIST)) {
  console.error('dist/ is missing. Run `npm run build` first.');
  process.exit(1);
}

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const rel = (f) => path.relative(DIST, f).replace(/\\/g, '/');

/* ---------- the built pages ---------- */
const pages = walk(DIST).filter((f) => f.endsWith('.html') && !/(^|[\\/])_/.test(path.basename(f)));
const idsOf = new Map();
const html = new Map();
for (const f of pages) {
  const h = fs.readFileSync(f, 'utf8');
  html.set(f, h);
  idsOf.set(rel(f), new Set([...h.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1])));
}

/* a URL as it appears in a page -> the file it should resolve to, or null if it
   is not ours to check */
function resolve(pageFile, url) {
  if (!url || /^(https?:|\/\/|mailto:|tel:|data:|javascript:|#)/i.test(url)) return null;
  let [p, frag] = url.split('#');
  p = p.split('?')[0];
  const base = p.startsWith('/') ? path.join(DIST, p) : path.join(path.dirname(pageFile), p);
  const cands = [base, path.join(base, 'index.html')];
  const hit = cands.find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
  return { hit, frag, shown: url };
}

let links = 0;
for (const [f, full] of html) {
  const here = rel(f);
  /* inline scripts build markup out of strings ('<a href="' + url + '">'); those
     are code, not links. Scripts loaded with src= are kept, so they are checked. */
  const h = full.replace(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/g, '');
  for (const m of h.matchAll(/\b(?:href|src)="([^"]*)"/g)) {
    const r = resolve(f, m[1]);
    if (!r) continue;
    links++;
    if (!r.hit) { bad(here, 'links to ' + r.shown + ', which does not exist'); continue; }
    if (r.frag && r.hit.endsWith('.html')) {
      const ids = idsOf.get(rel(r.hit));
      if (ids && !ids.has(r.frag)) bad(here, 'links to #' + r.frag + ' on ' + rel(r.hit) + ', which has no such id');
    }
  }
  /* every tick box names the source file it rewrites */
  for (const m of h.matchAll(/\bdata-file="([^"]+)"/g)) {
    if (!fs.existsSync(path.join(ROOT, m[1]))) bad(here, 'a tick box points at ' + m[1] + ', which is not in the repo');
  }
  for (const m of h.matchAll(/<img\b[^>]*>/g)) {
    if (!/\balt=/.test(m[0])) bad(here, 'an <img> has no alt text: ' + m[0].slice(0, 60));
  }
  /* an id used twice in one page makes anchors and labels unreliable */
  const seen = new Map();
  for (const m of h.matchAll(/\bid="([^"]+)"/g)) seen.set(m[1], (seen.get(m[1]) || 0) + 1);
  for (const [id, n] of seen) if (n > 1) bad(here, 'id="' + id + '" appears ' + n + ' times');
}

/* ---------- the content ---------- */
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'site.config.json'), 'utf8'));
const secs = Object.fromEntries((cfg.sections || []).map((s) => [s.id, s]));
const postsDir = path.join(ROOT, 'content', 'posts');
const dayPages = new Map();
for (const file of fs.readdirSync(postsDir).filter((f) => f.endsWith('.md'))) {
  const raw = fs.readFileSync(path.join(postsDir, file), 'utf8').replace(/\r\n/g, '\n');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) { bad('content/posts/' + file, 'has no header'); continue; }
  const fm = Object.fromEntries([...m[1].matchAll(/^([A-Za-z_][\w-]*):\s*(.*)$/gm)].map((x) => [x[1], x[2].trim()]));
  const where = 'content/posts/' + file;
  const sec = (fm.section || '').replace(/^["']|["']$/g, '');
  const tasks = (m[2].match(/^\s*[-*+]\s+\[[ xX]\]\s/gm) || []).length;
  if (!secs[sec]) bad(where, 'section "' + sec + '" does not exist');
  if (secs[sec] && secs[sec].tasks && !tasks && m[2].trim()) bad(where, 'is under ' + secs[sec].name + ' but has no checkboxes (the build re-files it as Daily)');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(fm.date || '')) bad(where, 'date "' + fm.date + '" is not YYYY-MM-DDTHH:MM');
  else if ((fm.date || '').slice(0, 10) !== file.slice(0, 10)) bad(where, 'file name date differs from the header date ' + fm.date.slice(0, 10));
  if (fm.day && !/^\d{4}-\d{2}-\d{2}$/.test(fm.day)) bad(where, 'day "' + fm.day + '" is not YYYY-MM-DD');
  if (sec === 'daytasks' && tasks) {
    const k = (fm.date || '').slice(0, 10);
    if (dayPages.has(k)) bad(where, 'a second Day Tasks page for ' + k + ' (' + dayPages.get(k) + ')');
    dayPages.set(k, file);
  }
}

/* focus blocks: one file per day, ids unique, each block starting on its own day */
const focusDir = path.join(ROOT, 'content', 'focus');
if (fs.existsSync(focusDir)) {
  for (const f of fs.readdirSync(focusDir).filter((x) => x.endsWith('.json'))) {
    const where = 'content/focus/' + f;
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(focusDir, f), 'utf8')); } catch (e) { bad(where, 'is not valid JSON'); continue; }
    const ids = new Set();
    for (const s of d.sessions || []) {
      if (ids.has(s.id)) bad(where, 'block id ' + s.id + ' appears twice');
      ids.add(s.id);
      if (!String(s.start || '').startsWith(f.slice(0, 10))) bad(where, 'block ' + s.id + ' starts on another day (' + s.start + ')');
    }
  }
}

/* verses: every field present, ids unique, and enough in each weekday's pool */
const shl = path.join(ROOT, 'content', 'shlokas.json');
if (fs.existsSync(shl)) {
  const d = JSON.parse(fs.readFileSync(shl, 'utf8'));
  const ids = new Set();
  const perDay = [0, 0, 0, 0, 0, 0, 0];
  for (const it of d.items || []) {
    const w = 'content/shlokas.json · ' + (it.id || '?');
    for (const k of ['id', 'src', 'sa', 'en', 'carry']) if (!it[k]) bad(w, 'is missing "' + k + '"');
    if (ids.has(it.id)) bad(w, 'id used twice');
    ids.add(it.id);
    if (!(it.day >= 0 && it.day <= 6)) bad(w, '"day" must be 0-6');
    else perDay[it.day]++;
    if (!d.families || !d.families[it.family]) bad(w, 'unknown family "' + it.family + '"');
    if (it.sa && !/[ऀ-ॿ]/.test(it.sa)) bad(w, 'the Sanskrit line has no Devanagari in it');
  }
  perDay.forEach((n, i) => { if (n < 7) bad('content/shlokas.json', 'weekday ' + i + ' has only ' + n + ' verses (aim for at least 7)'); });
}

/* ---------- report ---------- */
console.log('checked ' + pages.length + ' pages, ' + links + ' internal links');
if (problems.length) {
  console.log('\n' + problems.length + ' problem' + (problems.length === 1 ? '' : 's') + ':');
  for (const p of problems.slice(0, 60)) console.log('  - ' + p);
  if (problems.length > 60) console.log('  … and ' + (problems.length - 60) + ' more');
  process.exit(1);
}
console.log('no problems found');
