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
const today = `${parts.year}-${parts.month}-${parts.day}`;

/* the zone's current UTC offset, as +HH:MM */
const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
const offsetMin = Math.round((asUTC - now.setSeconds(0, 0)) / 60000);
const sign = offsetMin >= 0 ? '+' : '-';
const pad = (n) => String(n).padStart(2, '0');
const offset = `${sign}${pad(Math.floor(Math.abs(offsetMin) / 60))}:${pad(Math.abs(offsetMin) % 60)}`;

/* already have a day page for today? then there is nothing to do */
const existing = fs.readdirSync(POSTS).filter((f) => f.startsWith(today) && f.endsWith('.md'))
  .filter((f) => /^section:\s*daytasks\s*$/m.test(fs.readFileSync(path.join(POSTS, f), 'utf8')));

if (existing.length) {
  console.log(`day page for ${today} already exists (${existing[0]}) — nothing to do`);
  process.exit(0);
}

const routine = CFG.routine || [];
if (!routine.length) {
  console.log('no routine configured — nothing to create');
  process.exit(0);
}

const file = path.join(POSTS, `${today}-0600-day.md`);
const body = [
  '---',
  `date: ${today}T06:00:00${offset}`,
  'section: daytasks',
  '---',
  '',
  ...routine.map((t) => `- [ ] ${t}`),
  '',
].join('\n');

fs.writeFileSync(file, body);
console.log(`created ${path.relative(ROOT, file)} with ${routine.length} routine tasks`);
