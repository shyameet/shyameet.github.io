/* The festival calendar (content/festivals.json): which utsav comes next.

   The list is a hand-checked table, not a calculation -- tithis do not fit a
   formula a static site should carry -- so it runs out. forDay() is a pure
   function of the date, like the verse pick, and the build warns while there are
   still weeks left to renew the file. */
import fs from 'node:fs';
import path from 'node:path';

export function loadFestivals(root) {
  const file = path.join(root, 'content', 'festivals.json');
  if (!fs.existsSync(file)) return { about: '', items: [] };
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const items = (data.items || []).map((raw, i) => {
    const where = 'content/festivals.json · item ' + (i + 1) + (raw.name ? ' (' + raw.name + ')' : '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.date || '')) throw new Error(where + ': "date" must be YYYY-MM-DD');
    if (!raw.name) throw new Error(where + ': missing "name"');
    return { date: raw.date, name: raw.name, hi: raw.hi || '', note: raw.note || '' };
  });
  /* stable: two festivals on one date keep the order they were written in */
  items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { about: data.about || '', items };
}

/* the next n festivals on or after a day */
export function upcoming(F, k, n) {
  return F.items.filter((f) => f.date >= k).slice(0, n);
}
