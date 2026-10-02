/* The collection of verses (content/shlokas.json) and the pick for a given day.

   Seven pools, one per weekday, each headed by that day's deity (Sunday Surya,
   Monday Shiva ... Saturday Bhairav). A given Thursday always shows a Thursday
   verse, and the verse moves on by one each week, so a pool of fourteen takes
   fourteen weeks to come round. The pick is a pure function of the date, so every
   device, and every rebuild, agrees on today's verse without storing anything. */
import fs from 'node:fs';
import path from 'node:path';
import { toIAST } from './translit.mjs';

const BAD = (id, why) => { throw new Error('content/shlokas.json · ' + id + ': ' + why); };

export function loadShlokas(root) {
  const file = path.join(root, 'content', 'shlokas.json');
  const empty = { families: {}, items: [], pools: [[], [], [], [], [], [], []], byId: new Map() };
  if (!fs.existsSync(file)) return empty;

  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const families = data.families || {};
  const seen = new Set();
  const items = (data.items || []).map((raw) => {
    const id = raw.id || BAD('?', 'an entry has no id');
    for (const k of ['src', 'sa', 'en', 'carry']) if (!raw[k]) BAD(id, 'missing "' + k + '"');
    if (!(raw.day >= 0 && raw.day <= 6)) BAD(id, '"day" must be 0 (Sunday) to 6 (Saturday)');
    if (!families[raw.family]) BAD(id, 'unknown family "' + raw.family + '"');
    if (seen.has(id)) BAD(id, 'id used twice');
    seen.add(id);
    return {
      id, day: raw.day, family: raw.family, src: raw.src, by: raw.by || '',
      sa: raw.sa.replace(/\r\n/g, '\n').trim(),
      /* Sanskrit is transliterated by rule; a verse in Hindi/Awadhi brings its own */
      tr: (raw.tr || toIAST(raw.sa)).replace(/\r\n/g, '\n').trim(),
      en: raw.en, carry: raw.carry,
    };
  });
  const pools = [0, 1, 2, 3, 4, 5, 6].map((d) => items.filter((i) => i.day === d));
  return { families, items, pools, byId: new Map(items.map((i) => [i.id, i])) };
}

/* whole days since 1970-01-01 for a YYYY-MM-DD key */
const dayNumber = (k) => Math.floor(Date.UTC(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10)) / 86400000);

/* weekday of a key, 0 = Sunday */
const weekday = (k) => new Date(Date.UTC(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10))).getUTCDay();

export function shlokaFor(S, k) {
  const pool = S.pools[weekday(k)];
  if (!pool || !pool.length) return null;
  /* 1970-01-04 was a Sunday (day 3), so this counts Sundays: the verse changes
     once a week, whichever weekday it is */
  const week = Math.floor((dayNumber(k) - 3) / 7);
  return pool[((week % pool.length) + pool.length) % pool.length];
}
