/* Unit tests for the pure parts of src/todo.js: what a spoken phrase becomes, how two
   devices' lists merge, the next day of a repeating task, which version of a task belongs
   on the phone, and what should ring when.

     node tools/test/test_todo.mjs

   The file is run inside a bare VM with just enough of a browser stubbed for it to load,
   and the site's own test hook (window.__todoTest) hands back the functions. Exits 1 on
   any failure. */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'todo.js'), 'utf8');

function boot() {
  const ls = new Map();
  let api = null;
  const noop = () => {};
  const sandbox = {
    console,
    Promise, JSON, Math, Date, Object, Array, String, Number, RegExp, Error, TextEncoder, TextDecoder, atob, btoa,
    Uint8Array, parseInt, parseFloat, isNaN,
    localStorage: {
      getItem: (k) => (ls.has(k) ? ls.get(k) : null),
      setItem: (k, v) => ls.set(k, String(v)),
      removeItem: (k) => ls.delete(k),
    },
    document: {
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
      addEventListener: noop, createElement: () => ({ addEventListener: noop, setAttribute: noop }),
      body: { appendChild: noop }, visibilityState: 'visible',
    },
    navigator: {},
    location: { search: '', hash: '', pathname: '/', origin: 'https://example.test' },
    history: { replaceState: noop },
    fetch: () => Promise.reject(new Error('offline')),
    setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0,
    URL: { createObjectURL: () => '' }, Blob: function () {},
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = noop;
  sandbox.__todoTest = (a) => { api = a; };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'todo.js' });
  return { api, ls, sandbox };
}

let fails = 0;
let passes = 0;
function eq(name, got, want) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { passes++; return; }
  fails++;
  console.log('  FAIL ' + name + '\n       got  ' + a + '\n       want ' + b);
}

const { api } = boot();
if (!api) { console.log('the test hook was not called'); process.exit(1); }

/* ---------- what a spoken phrase becomes ----------
   "now" is Thursday 8 October 2026, 15:00 (local time) */
const NOW = new Date(2026, 9, 8, 15, 0, 0).getTime();
const at = (d, h, m) => new Date(2026, 9, d, h, m || 0).getTime();
const cases = [
  // phrase,                                   title,                  day,          time
  ['call the bank at 5 pm tomorrow',           'Call the bank',        '2026-10-09', '17:00'],
  ['Call the bank',                            'Call the bank',        null,         null],
  ['remind me to pay rent on friday',          'Pay rent',             '2026-10-09', null],
  ['meet rahul at 7',                          'Meet rahul',           '2026-10-08', '19:00'],
  ['gym at 6 am',                              'Gym',                  '2026-10-09', '06:00'],
  ['submit report by 5:30 pm',                 'Submit report',        '2026-10-08', '17:30'],
  ['in 20 minutes check the oven',             'Check the oven',       '2026-10-08', '15:20'],
  ['in an hour call mom',                      'Call mom',             '2026-10-08', '16:00'],
  ['in half an hour stretch',                  'Stretch',              '2026-10-08', '15:30'],
  ['buy milk tomorrow morning',                'Buy milk',             '2026-10-09', '09:00'],
  ['doctor on 15 october at 11 am',            'Doctor',               '2026-10-15', '11:00'],
  ['tonight pack the bags',                    'Pack the bags',        '2026-10-08', '20:00'],
  ['call at 17:30',                            'Call',                 '2026-10-08', '17:30'],
  ['read chapter 5',                           'Read chapter 5',       null,         null],
  ['sat on the chair',                         'Sat on the chair',     null,         null],
  ['call bank at 5 tomorrow',                  'Call bank',            '2026-10-09', '17:00'],
  ['pay 3 bills',                              'Pay 3 bills',          null,         null],
  ['meeting at noon',                          'Meeting',              '2026-10-09', '12:00'],
  ['email sam next monday',                    'Email sam',            '2026-10-12', null],
  ['call in 2 days',                           'Call',                 '2026-10-10', null],
  ['day after tomorrow dentist',               'Dentist',              '2026-10-10', null],
  ['10 am standup',                            'Standup',              '2026-10-09', '10:00'],
  ['dentist at 4:30 pm on 12 oct',             'Dentist',              '2026-10-12', '16:30'],
  ['remember to call',                         'Call',                 null,         null],
  ['5 pm',                                     '',                     '2026-10-08', '17:00'],
  ['buy 2 kg rice by tomorrow',                'Buy 2 kg rice',        '2026-10-09', null],
  ['walk the dog this evening',                'Walk the dog',         '2026-10-08', '18:00'],
  ['call mom today',                           'Call mom',             '2026-10-08', null],
  ['review trades tomorrow at 9',              'Review trades',        '2026-10-09', '09:00'],
  ['lunch with dad at 1 pm',                   'Lunch with dad',       '2026-10-09', '13:00'],   // 13:00 has gone today
  ['submit form on 2026-11-03',                'Submit form',          '2026-11-03', null],
  ['attend class on thursday',                 'Attend class',         '2026-10-15', null],      // today is Thursday: the next one
  ['gym at 12 am',                             'Gym',                  '2026-10-09', '00:00'],
  ['wake up at 5:30 tomorrow',                 'Wake up',              '2026-10-09', '17:30'],   // bare 5:30 on another day: before 7 is the afternoon
  ['call at 05:30 tomorrow',                   'Call',                 '2026-10-09', '05:30'],   // a leading zero is 24-hour
  ['pay the fee at 9',                         'Pay the fee',          '2026-10-08', '21:00'],   // 9:00 has gone, so tonight's 9
  ['gym at 6:30 in the morning',               'Gym',                  '2026-10-09', '06:30'],
  ['call at 9 in the morning',                 'Call',                 '2026-10-09', '09:00'],
  ['call at 8 in the evening',                 'Call',                 '2026-10-08', '20:00'],
  ['study at night',                           'Study',                '2026-10-08', '20:00'],
  ['pay electricity bill on the 15th',         'Pay electricity bill', '2026-10-15', null],
  ['pay rent on the 3rd',                      'Pay rent',             '2026-11-03', null],
  ['pay the loan on the 8th',                  'Pay the loan',         '2026-10-08', null],
  ['ons review 2 hours from now',              'Ons review',           '2026-10-08', '17:00'],
  ['call back 10 minutes from now',            'Call back',            '2026-10-08', '15:10'],
  ['meet at 5th avenue',                       'Meet at 5th avenue',   null,         null],
  ['meet at 5 pm sharp',                       'Meet sharp',           '2026-10-08', '17:00'],
];
for (const [phrase, title, day, time] of cases) {
  const p = api.parseWhen(phrase, NOW);
  eq('parse "' + phrase + '"', { text: p.text, day: p.day, at: p.at }, { text: title, day, at: time });
}
{
  /* a month with no 31st goes to the next month that has one */
  const feb = new Date(2026, 1, 10, 12).getTime();
  eq('the 31st in February is March the 31st', api.parseWhen('file returns on the 31st', feb).day, '2026-03-31');
}

/* repeating: what it says, and when the first one falls */
const reps = [
  ['gym every weekday at 7',              'Gym',               '2026-10-09', '07:00', 'wd'],
  ['water the plants every day at 8 pm',  'Water the plants',  '2026-10-08', '20:00', 'd'],
  ['pay rent every month on the 1st',     'Pay rent',          '2026-11-01', null,    'm'],
  ['review trades every friday',          'Review trades',     '2026-10-09', null,    'w'],
  ['every thursday standup',              'Standup',           '2026-10-08', null,    'w'],
  ['stretch every morning',               'Stretch',           '2026-10-09', '09:00', 'd'],
  ['call mom weekly',                     'Call mom',          null,         null,    'w'],
  ['daily standup at 10 am',              'Standup',           '2026-10-09', '10:00', 'd'],
  ['meditate every evening',              'Meditate',          '2026-10-08', '18:00', 'd'],
  ['backup the laptop monthly',           'Backup the laptop', null,         null,    'm'],
  ['call the bank at 5 pm tomorrow',      'Call the bank',     '2026-10-09', '17:00', ''],
];
for (const [phrase, title, day, time, rep] of reps) {
  const p = api.parseWhen(phrase, NOW);
  eq('repeat "' + phrase + '"', { text: p.text, day: p.day, at: p.at, rep: p.rep }, { text: title, day, at: time, rep });
}
eq('weekdays from a Saturday start Monday', api.parseWhen('check email every weekday', new Date(2026, 9, 10, 9, 0).getTime()).day, '2026-10-12');

/* the next day of a repeating task */
{
  const R = (o) => api.clean(Object.assign({ id: 'r', text: 'r', made: 1, mod: 1 }, o));
  eq('daily: the next day', api.nextDay(R({ day: '2026-10-08', rep: 'd' }), '2026-10-08'), '2026-10-09');
  eq('weekdays: Friday to Monday', api.nextDay(R({ day: '2026-10-09', rep: 'wd' }), '2026-10-09'), '2026-10-12');
  eq('weekly: Thursday to Thursday', api.nextDay(R({ day: '2026-10-08', rep: 'w' }), '2026-10-08'), '2026-10-15');
  eq('weekly, done late: the next Thursday after today', api.nextDay(R({ day: '2026-10-01', rep: 'w' }), '2026-10-08'), '2026-10-15');
  eq('monthly on the 31st: February has 28', api.nextDay(R({ day: '2026-01-31', rep: 'm', dom: 31 }), '2026-01-31'), '2026-02-28');
  eq('monthly on the 31st: back to the 31st in March', api.nextDay(R({ day: '2026-02-28', rep: 'm', dom: 31 }), '2026-02-28'), '2026-03-31');
  eq('monthly on the 15th', api.nextDay(R({ day: '2026-10-15', rep: 'm', dom: 15 }), '2026-10-20'), '2026-11-15');
}

/* ---------- the list ---------- */
const T = (o) => api.clean(Object.assign({ id: 'x', text: 't', day: '2026-10-08', made: 1, mod: 1 }, o));
{
  const a = { x: T({ mod: 5, text: 'mine' }) }, b = { x: T({ mod: 9, text: 'theirs' }) };
  eq('later change wins (a,b)', api.merge(a, b).x.text, 'theirs');
  eq('later change wins (b,a)', api.merge(b, a).x.text, 'theirs');
  const open = { x: T({ mod: 7 }) }, done = { x: T({ mod: 7, done: 7 }) };
  eq('tie: finished beats open', api.merge(open, done).x.done, 7);
  eq('tie: finished beats open (flipped)', api.merge(done, open).x.done, 7);
  const gone = { x: T({ mod: 7, del: 7 }) };
  eq('tie: removed beats finished', !!api.merge(done, gone).x.del, true);
  eq('merge adds what the other lacks', Object.keys(api.merge({ a: T({ id: 'a' }) }, { b: T({ id: 'b' }) })).sort(), ['a', 'b']);
}
{
  const now = Date.now();
  const day = 864e5;
  const items = {
    old: T({ id: 'old', done: now - 61 * day, mod: now - 61 * day }),
    fresh: T({ id: 'fresh', done: now - 5 * day, mod: now - 5 * day }),
    tomb: T({ id: 'tomb', del: now - 31 * day, mod: now - 31 * day }),
    tomb2: T({ id: 'tomb2', del: now - 2 * day, mod: now - 2 * day }),
    open: T({ id: 'open', mod: now - 90 * day }),
  };
  eq('prune drops old done and old tombstones, keeps the rest', Object.keys(api.prune(items, now)).sort(), ['fresh', 'open', 'tomb2']);
}
{
  const one = { a: T({ id: 'a', made: 1, mod: 2 }), b: T({ id: 'b', made: 3, mod: 4, at: '09:30' }) };
  const two = { b: one.b, a: one.a };
  eq('the file is the same bytes whatever order it was built in', api.toFile(one), api.toFile(two));
  const text = api.toFile(one);
  eq('the file is valid JSON with every task', JSON.parse(text).tasks.map((t) => t.id), ['a', 'b']);
  eq('an empty list is a valid file', JSON.parse(api.toFile({})).tasks, []);
  eq('one task a line', text.split('\n').filter((l) => l.startsWith('  {')).length, 2);
  eq('clean keeps a field a newer version added', api.clean({ id: 'z', text: 'hi', day: '2026-10-08', mod: 1, note: 'later' }).note, 'later');
  eq('clean drops a repeat it does not know', api.clean({ id: 'z', text: 'hi', day: '2026-10-08', mod: 1, rep: 'daily' }).rep, undefined);
  eq('clean gives a monthly task its day of the month', api.clean({ id: 'z', text: 'hi', day: '2026-10-15', mod: 1, rep: 'm' }).dom, 15);
  eq('clean drops a bad time', api.clean({ id: 'z', text: 'hi', day: '2026-10-08', at: '25:99', mod: 1 }).at, undefined);
  eq('clean drops a task with no words', api.clean({ id: 'z', text: '  ', day: '2026-10-08', mod: 1 }), null);
  eq('clean keeps a removed task even with no words', !!api.clean({ id: 'z', text: '', day: '2026-10-08', mod: 1, del: 5 }), true);
}
{
  const push = { on: true, topic: 'rdx-abcdefghijkl', ck: '20:00', mod: 7 };
  eq('the push settings are written', JSON.parse(api.toFile({}, push)).push, push);
  eq('no push settings: none written', JSON.parse(api.toFile({}, null)).push, undefined);
  eq('the later push settings win', api.newerPush(push, Object.assign({}, push, { on: false, mod: 9 })).on, false);
}

/* what is on the phone (ps, with its own time pt) travels with the task: the later record
   of it wins, whichever copy of the task won */
{
  const base = { id: 'p', text: 'Call', day: '2026-10-09', at: '17:00', made: 1, mod: 5 };
  const plain = api.clean(base);
  const sig = api.sigOf(plain);
  const sent = api.clean(Object.assign({}, base, { ps: sig, pt: 10 }));
  eq('ps comes across from the copy that has it (a,b)', api.merge({ p: plain }, { p: sent }).p.ps, sig);
  eq('ps comes across from the copy that has it (b,a)', api.merge({ p: sent }, { p: plain }).p.ps, sig);
  const edited = api.clean(Object.assign({}, base, { at: '18:00', mod: 9 }));
  eq('an edit keeps the record of what was sent (so it is replaced)', api.merge({ p: edited }, { p: sent }).p.ps, sig);
  eq('the edit itself wins', api.merge({ p: edited }, { p: sent }).p.at, '18:00');
  const ticked = api.clean(Object.assign({}, base, { done: 9, mod: 9 }));
  eq('a tick keeps the record of what was sent (so it is taken back)', api.merge({ p: ticked }, { p: sent }).p.ps, sig);
  const back = api.clean(Object.assign({}, base, { ps: '-', pt: 20 }));
  eq('taken back later beats sent earlier (a,b)', api.merge({ p: sent }, { p: back }).p.ps, '-');
  eq('taken back later beats sent earlier (b,a)', api.merge({ p: back }, { p: sent }).p.ps, '-');
  const resent = api.clean(Object.assign({}, base, { ps: sig, pt: 30 }));
  eq('sent again later beats taken back', api.merge({ p: back }, { p: resent }).p.ps, sig);
  eq('the record carries its time', api.merge({ p: back }, { p: resent }).p.pt, 30);
}
/* which version of a task should be on the phone */
{
  const now = new Date(2026, 9, 8, 15, 0).getTime();
  const W = (o) => api.clean(Object.assign({ id: 'w', text: 'W', made: 1, mod: 1 }, o));
  eq('due later today: send it', api.wantPush(W({ day: '2026-10-08', at: '17:00' }), now), api.sigOf(W({ day: '2026-10-08', at: '17:00' })));
  eq('no time: nothing', api.wantPush(W({ day: '2026-10-08' }), now), '');
  eq('done: nothing (take it back)', api.wantPush(W({ day: '2026-10-08', at: '17:00', done: 5 }), now), '');
  eq('four days ahead: not yet (ntfy holds three)', api.wantPush(W({ day: '2026-10-12', at: '17:00' }), now), '');
  eq('its time has come: leave what was sent', api.wantPush(W({ day: '2026-10-08', at: '14:00', ps: 'abc' }), now), 'abc');
  eq('its time has come, nothing sent: nothing', api.wantPush(W({ day: '2026-10-08', at: '14:00' }), now), '');
}

/* ---------- what should ring ---------- */
const PF = { nag: 30, checkin: true, checkinAt: '20:00', quiet: true, quietFrom: '23:00', quietTo: '06:30' };
const task = (id, day, hhmm, extra) => api.clean(Object.assign({ id, text: id, day, at: hhmm, made: 1, mod: 1 }, extra));
const ids = (l) => (l || []).map((t) => t.id);
{
  const items = { a: task('a', '2026-10-08', '17:00') };
  let p = api.plan(at(8, 16, 59), items, {}, PF);
  eq('not yet due: nothing', [ids(p.due), ids(p.nag), p.checkin], [[], [], null]);
  p = api.plan(at(8, 17, 0), items, {}, PF);
  eq('due on the minute: rings', ids(p.due), ['a']);
  p = api.plan(at(8, 17, 1), items, { a: at(8, 17, 0) }, PF);
  eq('already rang: quiet for now', [ids(p.due), ids(p.nag)], [[], []]);
  p = api.plan(at(8, 17, 29), items, { a: at(8, 17, 0) }, PF);
  eq('29 minutes on: still quiet', ids(p.nag), []);
  p = api.plan(at(8, 17, 30), items, { a: at(8, 17, 0) }, PF);
  eq('30 minutes on: nudges again', ids(p.nag), ['a']);
  p = api.plan(at(8, 17, 30), items, { a: at(8, 17, 0) }, Object.assign({}, PF, { nag: 0 }));
  eq('nudges off: never', ids(p.nag), []);
  p = api.plan(at(8, 21, 5), items, { a: at(8, 20, 40) }, PF);
  eq('past four hours: no more nudges', ids(p.nag), []);
  p = api.plan(at(8, 17, 5), items, { a: 1 }, PF);
  eq('a ring from days ago does not count: it rings (catch-up)', ids(p.due), ['a']);
  p = api.plan(at(9, 7, 0), items, {}, PF);
  eq('due 14 hours ago and never rang: too old to ring for', ids(p.due), []);
  p = api.plan(at(8, 16, 0), { d: task('d', '2026-10-08', '17:00', { done: 5 }) }, {}, PF);
  eq('done: nothing', ids(p.due), []);
  p = api.plan(at(8, 17, 5), { d: task('d', '2026-10-08', '17:00', { del: 5 }) }, {}, PF);
  eq('removed: nothing', ids(p.due), []);
}
{
  /* quiet hours hold back nudges and the check-in, never a time he set */
  const items = { n: task('n', '2026-10-08', '22:30') };
  let p = api.plan(at(9, 0, 1), items, { n: at(8, 23, 30) }, PF);
  eq('quiet hours: no nudge after midnight', ids(p.nag), []);
  p = api.plan(at(8, 22, 30), items, {}, PF);
  eq('a time he set rings even at 22:30', ids(p.due), ['n']);
  p = api.plan(at(9, 5, 30), { e: task('e', '2026-10-09', '05:30') }, {}, PF);
  eq('a 05:30 alarm rings inside quiet hours', ids(p.due), ['e']);
  p = api.plan(at(9, 6, 29), { e: task('e', '2026-10-09', '05:30') }, { e: at(9, 5, 30) }, PF);
  eq('but its nudges wait for 06:30', ids(p.nag), []);
}
{
  const open = { a: task('a', '2026-10-08', undefined), b: task('b', '2026-10-07', undefined) };
  let p = api.plan(at(8, 19, 59), open, {}, PF);
  eq('check-in: not before its time', p.checkin, null);
  p = api.plan(at(8, 20, 0), open, {}, PF);
  eq('check-in at 20:00 names what is open, oldest first', ids(p.checkin), ['b', 'a']);
  p = api.plan(at(8, 20, 30), open, { 'ck:2026-10-08': at(8, 20, 0) }, PF);
  eq('check-in once a day', p.checkin, null);
  p = api.plan(at(8, 20, 0), { a: task('a', '2026-10-08', undefined, { done: 5 }) }, {}, PF);
  eq('check-in: nothing open, nothing said', p.checkin, null);
  p = api.plan(at(8, 20, 0), open, {}, Object.assign({}, PF, { checkin: false }));
  eq('check-in switched off', p.checkin, null);
  p = api.plan(at(8, 20, 0), { f: task('f', '2026-10-09', undefined) }, {}, PF);
  eq("check-in ignores tomorrow's tasks", p.checkin, null);
  p = api.plan(at(8, 23, 40), open, {}, PF);
  eq('check-in is not held past four hours of its time', p.checkin, null);
}

console.log(passes + ' passed, ' + fails + ' failed');
process.exit(fails ? 1 : 0);
