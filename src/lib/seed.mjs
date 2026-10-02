/* The markdown a day page / week page starts life as.
   One definition, used by the nightly job (newday.mjs), by the build (to draw
   tomorrow's page before it exists) and, as a string embedded in the page, by
   the browser (to create the file itself if the job has not run yet). If these
   three ever disagreed, a page made by the browser would look different from one
   made by the cron. */

export const dayFile = (k) => `${k}-0600-day.md`;
export const weekFile = (k) => `${k}-0600-week.md`;

/* the zone's UTC offset on date k, as +HH:MM (noon avoids DST edge hours) */
export function zoneOffset(zone, k) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
    .formatToParts(new Date(`${k}T12:00:00Z`));
  const tz = (parts.find((p) => p.type === 'timeZoneName') || {}).value || 'GMT';
  const m = tz.match(/GMT([+-])(\d{2}):(\d{2})/);
  return m ? `${m[1]}${m[2]}:${m[3]}` : '+00:00';
}

const names = (list) => (list || []).map((r) => (typeof r === 'string' ? r : r.name));

/* the whole file: header, a blank line, one unticked box per item */
export function seedText({ section, dateKey, offset, items, title }) {
  const front = ['---', `date: ${dateKey}T06:00:00${offset}`];
  if (title) front.push(`title: "${title}"`);
  front.push(`section: ${section}`, '---', '');
  return front.concat(names(items).map((t) => `- [ ] ${t}`), '').join('\n');
}

export const daySeedText = (cfg, k) => seedText({
  section: 'daytasks', dateKey: k, offset: zoneOffset(cfg.timezone || 'Asia/Kolkata', k), items: cfg.routine,
});

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
export const weekSeedText = (cfg, k) => seedText({
  section: 'weektasks', dateKey: k, offset: zoneOffset(cfg.timezone || 'Asia/Kolkata', k),
  items: cfg.weeklyRoutine, title: `Week of ${+k.slice(8)} ${MONTHS[+k.slice(5, 7) - 1]}`,
});

/* is k the first day of the week the config describes? */
export function isWeekStart(cfg, k) {
  const dow = new Date(`${k}T12:00:00Z`).getUTCDay();          // 0 = Sunday
  return cfg.weekStartsMonday === false ? dow === 0 : dow === 1;
}
