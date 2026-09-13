/* Creates today's Day Tasks page if it does not exist yet.
   Run from the daily workflow (and safe to run by hand). Doing nothing when the
   page is already there means it can run as often as it likes. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'site.config.json'), 'utf8'));
const POSTS = path.join(ROOT, 'content', 'posts');

/* The day is whatever it is where he lives, not on the runner. Offsets come
   from the configured zone rather than a hardcoded +5:30 so moving zones is a
   config change, not a code change. */
const ZONE = CFG.timezone || 'Asia/Kolkata';
const now = new Date();
const parts = Object.fromEntries(
  new Intl.DateTimeFormat('en-GB', {
    timeZone: ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]),
);
/* NEWDAY_DATE=2026-09-14 forces the date -- used to test the week-start branch
   and to backfill a day that was missed. */
const override = process.env.NEWDAY_DATE;
if (override && !/^\d{4}-\d{2}-\d{2}$/.test(override)) {
  console.error(`NEWDAY_DATE must be YYYY-MM-DD, got "${override}"`);
  process.exit(1);
}
const today = override || `${parts.year}-${parts.month}-${parts.day}`;

/* the zone's current UTC offset, as +HH:MM */
const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
const offsetMin = Math.round((asUTC - now.setSeconds(0, 0)) / 60000);
const sign = offsetMin >= 0 ? '+' : '-';
const pad = (n) => String(n).padStart(2, '0');
const offset = `${sign}${pad(Math.floor(Math.abs(offsetMin) / 60))}:${pad(Math.abs(offsetMin) % 60)}`;

const names = (list) => (list || []).map((r) => (typeof r === 'string' ? r : r.name));

function hasPageFor(section, datePrefix) {
  return fs.readdirSync(POSTS)
    .filter((f) => f.startsWith(datePrefix) && f.endsWith('.md'))
    .some((f) => new RegExp('^section:\\s*' + section + '\\s*$', 'm')
      .test(fs.readFileSync(path.join(POSTS, f), 'utf8')));
}

function create(section, datePrefix, hhmm, slug, items, title) {
  const file = path.join(POSTS, `${datePrefix}-${hhmm}-${slug}.md`);
  const front = ['---', `date: ${datePrefix}T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00${offset}`];
  if (title) front.push(`title: "${title}"`);
  front.push(`section: ${section}`, '---', '');
  fs.writeFileSync(file, front.concat(items.map((t) => `- [ ] ${t}`), '').join('\n'));
  console.log(`created ${path.relative(ROOT, file)} with ${items.length} items`);
}

let made = 0;

/* ---- today's day page ---- */
if (hasPageFor('daytasks', today)) {
  console.log(`day page for ${today} already exists — nothing to do`);
} else if (!names(CFG.routine).length) {
  console.log('no daily routine configured');
} else {
  create('daytasks', today, '0600', 'day', names(CFG.routine));
  made++;
}

/* ---- the week's page, on the day the week starts ---- */
const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();       // 0 = Sunday
const isWeekStart = CFG.weekStartsMonday === false ? weekday === 0 : weekday === 1;
const weekly = names(CFG.weeklyRoutine);

if (!isWeekStart) {
  console.log('not the start of the week — no week page');
} else if (hasPageFor('weektasks', today)) {
  console.log(`week page for ${today} already exists — nothing to do`);
} else if (!weekly.length) {
  console.log('no weekly routine configured');
} else {
  const [y, m, d] = today.split('-').map(Number);
  const MON = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  create('weektasks', today, '0600', 'week', weekly, `Week of ${d} ${MON[m - 1]}`);
  made++;
}

process.exitCode = 0;
console.log(made ? `${made} page(s) created` : 'nothing created');
