/* Creates the Day Tasks page for today AND tomorrow (and the week page on the day
   a week starts) if they do not exist yet. Safe to run as often as you like:
   a page that is already there is left alone.

   Tomorrow's page is made a day ahead on purpose. GitHub runs scheduled
   workflows hours late (this one has been landing between 07:00 and 08:10 IST
   instead of 05:00), so a page made "just in time" leaves the early morning with
   no page for the new day. With tomorrow's page already in the repo, the new day
   starts with its page waiting whatever the scheduler does. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dayFile, weekFile, daySeedText, weekSeedText, isWeekStart } from './lib/seed.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'site.config.json'), 'utf8'));
const POSTS = path.join(ROOT, 'content', 'posts');

/* The day is whatever it is where he lives, not on the runner. */
const ZONE = CFG.timezone || 'Asia/Kolkata';
const parts = Object.fromEntries(
  new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date()).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]),
);
/* NEWDAY_DATE=2026-09-14 forces the date -- used to test the week-start branch
   and to backfill a day that was missed. */
const override = process.env.NEWDAY_DATE;
if (override && !/^\d{4}-\d{2}-\d{2}$/.test(override)) {
  console.error(`NEWDAY_DATE must be YYYY-MM-DD, got "${override}"`);
  process.exit(1);
}
const today = override || `${parts.year}-${parts.month}-${parts.day}`;
const addDays = (k, n) => {
  const d = new Date(`${k}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

fs.mkdirSync(POSTS, { recursive: true });
const FULLDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];
const nice = (k) => `${FULLDAYS[new Date(`${k}T12:00:00Z`).getUTCDay()]} ${+k.slice(8)} ${MON[+k.slice(5, 7) - 1]}`;

function hasPageFor(section, datePrefix) {
  return fs.readdirSync(POSTS)
    .filter((f) => f.startsWith(datePrefix) && f.endsWith('.md'))
    .some((f) => new RegExp('^section:\\s*' + section + '\\s*$', 'm')
      .test(fs.readFileSync(path.join(POSTS, f), 'utf8')));
}

const made = [];
function create(file, text) {
  fs.writeFileSync(path.join(POSTS, file), text);
  console.log(`created content/posts/${file}`);
}

for (const k of [today, addDays(today, 1)]) {
  if (hasPageFor('daytasks', k)) {
    console.log(`day page for ${k} already exists`);
  } else if (!(CFG.routine || []).length) {
    console.log('no daily routine configured');
  } else {
    create(dayFile(k), daySeedText(CFG, k));
    made.push(nice(k));
  }

  if (!isWeekStart(CFG, k)) continue;
  if (hasPageFor('weektasks', k)) {
    console.log(`week page for ${k} already exists`);
  } else if (!(CFG.weeklyRoutine || []).length) {
    console.log('no weekly routine configured');
  } else {
    create(weekFile(k), weekSeedText(CFG, k));
    made.push(`week of ${nice(k)}`);
  }
}

/* the workflow reads this for its commit message, then deletes it */
if (made.length) fs.writeFileSync(path.join(ROOT, '.newday-message'), 'daytasks: ' + made.join(' + ') + '\n');
console.log(made.length ? `${made.length} page(s) created` : 'nothing created');
