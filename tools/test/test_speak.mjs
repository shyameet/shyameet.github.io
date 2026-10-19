/* Unit tests for the pure parts of src/speak.js: what the words of a talk show (pace,
   fillers, restarts, topic words, the tips), how two devices' takes merge, streaks, and
   the choice of a topic.

     node tools/test/test_speak.mjs

   Same method as test_todo.mjs: the real file runs in a bare VM and the site's own test
   hook (window.__speakTest) hands back the functions. Exits 1 on any failure. */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'speak.js'), 'utf8');
const { TOPICS } = await import(path.join(ROOT, 'src', 'lib', 'topics.mjs').replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));

function boot() {
  let api = null;
  const noop = () => {};
  const sandbox = {
    console, Promise, JSON, Math, Date, Object, Array, String, Number, RegExp, Error, TextEncoder, TextDecoder, atob, btoa,
    Uint8Array, parseInt, parseFloat, isNaN, isFinite,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener: noop },
    navigator: {}, location: { search: '' }, fetch: () => Promise.reject(new Error('offline')),
    setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = noop;
  sandbox.__speakTest = (a) => { api = a; };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'speak.js' });
  return api;
}

let fails = 0;
let passes = 0;
function eq(name, got, want) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { passes++; return; }
  fails++;
  console.log('  FAIL ' + name + '\n       got  ' + a + '\n       want ' + b);
}
const ok = (name, cond) => eq(name, !!cond, true);

const A = boot();
ok('hook gave the functions', A && A.analyze && A.mergeTakes && A.streakOf);

/* ---- tokenize ---- */
eq('tokenize lowercases and strips punctuation', A.tokenize("Hello, World! It's 5."), ['hello', 'world', "it's", '5']);
eq('tokenize splits hyphens', A.tokenize('non-profit'), ['non', 'profit']);
eq('tokenize empty', A.tokenize(''), []);
eq('tokenize curly apostrophe', A.tokenize('don’t'), ["don't"]);

/* ---- fillers ---- */
const f = (t, sec = 60, topic = '') => A.analyze(t, { sec, topic });
eq('hard fillers', f('um I went to the uh market and er bought rice').fillers, { um: 1, uh: 1, er: 1 });
eq('you know / i mean', f('you know it was big and i mean really big').fillers, { 'you know': 1, 'i mean': 1 });
eq('do you know is not a filler', f('do you know the way').fillerTotal, 0);
eq('what i mean is not a filler', f('that is what i mean by it').fillerTotal, 0);
eq('what kind of is not a filler', f('what kind of food do you like').fillerTotal, 0);
eq('kind of as a hedge is', f('it was kind of nice').fillers, { 'kind of': 1 });
eq('like as a verb is not', f('I like tea and they would like some').fillerTotal, 0);
eq('like as a filler is', f('it was like really big and like heavy').fillers, { like: 2 });
eq('looks like is not', f('it looks like rain').fillerTotal, 0);
eq('so at the start is a filler', f('so I went home').fillers, { so: 1 });
eq('so in the middle is not', f('it was so cold that I left').fillerTotal, 0);
eq('and so is a filler', f('I left and so we went').fillers, { so: 1 });
eq('so is counted in soTotal', f('so it was so cold').soTotal, 2);
eq('basically and actually', f('basically it works and actually it is fast').fillers, { basically: 1, actually: 1 });
eq('well at the start', f('well I think so').fillers, { well: 1 });
eq('well in the middle is not', f('it works well').fillerTotal, 0);
eq('no words no fillers', f('').fillerTotal, 0);
eq('fillers per minute', f('um um um um um um', 60).fillerPerMin, 6);
eq('fillers per minute needs time', f('um um', 0).fillerPerMin, null);
eq('per 100 words', f('um ' + 'word '.repeat(19)).fillerPer100, 5);

/* ---- pace ---- */
eq('wpm', A.analyze('word '.repeat(140), { sec: 60 }).wpm, 140);
eq('wpm half minute', A.analyze('word '.repeat(70), { sec: 30 }).wpm, 140);
eq('wpm needs time', A.analyze('word word', { sec: 2 }).wpm, null);

/* ---- restarts ---- */
eq('repeated word', f('I want I want to go').restarts, 1);
eq('repeated word pair', f('helping any helping any person').restarts, 1);
eq('repeated three words', f('on the way on the way home').restarts, 1);
eq('very very is not a restart', f('it was very very good').restarts, 0);
eq('triple word counts once', f('go go go home').restarts, 1);
eq('no repeats', f('this is a normal sentence').restarts, 0);
eq('two separate restarts', f('the the cat and and dog').restarts, 2);

/* ---- repeated content words ---- */
eq('said often', f('help is good help is kind help is big, animals').repeated, [['help', 3]]);
eq('stop words never repeated', f('the the the the and and and').repeated, []);
eq('said often needs three', f('market market').repeated, []);

/* ---- topic words ---- */
const topic = 'Explain what a non-profit is to a child who wants to help animals.';
const t1 = f('A group that helps animals is good, and it helps people want to help.', 60, topic);
ok('helping/helps match help', t1.touched.indexOf('help') >= 0);
ok('animals matches animals', t1.touched.indexOf('animals') >= 0);
ok('profit is missed', t1.missed.indexOf('profit') >= 0);
ok('child is missed', t1.missed.indexOf('child') >= 0);
eq('no topic, no topic words', [f('hello there').touched, f('hello there').missed], [[], []]);
ok('instruction verbs are not topic words', t1.touched.concat(t1.missed).indexOf('explain') < 0);

/* ---- the sample talk from the day this was asked for ---- */
const sample = 'So there are a lot of things in this world that doesn\'t give you rewards such as money, or fortune, or something like that. But what it gives you is happiness sense of purpose and a new way or something you could so for me helping any helping any person who is in need or helping an animals who have no one to look for gives me a sense of purpose and something that no amount of money could ever give me. It actually makes me smile at night and when I think about it it actually gives me meaning in my life as well that I am doing something other than just breathe live in the moment or just earn money so my one minute is over';
const ss = A.analyze(sample, { sec: 60, delay: 3, topic });
ok('sample: about 140 words', ss.words > 125 && ss.words < 160);
ok('sample: wpm in a normal range', ss.wpm > 120 && ss.wpm < 165);
ok('sample: restart "helping any" found', ss.restarts >= 1);
ok('sample: actually x2 found', ss.fillers.actually === 2);
ok('sample: leading so found', ss.fillers.so >= 1);
ok('sample: never touched profit', ss.missed.indexOf('profit') >= 0);
ok('sample: gives is not said often (stop word)', !ss.repeated.some((r) => r[0] === 'gives'));
ok('sample: money is said often', ss.repeated.some((r) => r[0] === 'money'));

/* ---- tips ---- */
/* n different made-up words, so the text has no repeats of its own */
const W = (n) => Array.from({ length: n }, (_, i) => 'w' + String.fromCharCode(97 + (i % 26)) + String.fromCharCode(97 + Math.floor(i / 26) % 26) + 'x').join(' ') + ' ';
ok('short take gets the short tip', /short/.test(A.tips(A.analyze('hello there', { sec: 60 }), 'free')[0]));
ok('long wait tip', A.tips(A.analyze(W(100), { sec: 60, delay: 9 }), 'free').some((t) => /9 seconds/.test(t)));
ok('filler tip names the filler', A.tips(A.analyze('um '.repeat(10) + W(90), { sec: 60 }), 'free').some((t) => /"um"/.test(t)));
ok('restart tip', A.tips(A.analyze('go go to to be be ' + W(90), { sec: 60 }), 'free').some((t) => /over 3 times/.test(t)));
ok('fast tip', A.tips(A.analyze(W(200), { sec: 60 }), 'free').some((t) => /fast/.test(t)));
ok('slow tip', A.tips(A.analyze(W(60), { sec: 60 }), 'free').some((t) => /Slow/.test(t)));
ok('clean take tip', /clean take/i.test(A.tips(A.analyze(W(130), { sec: 60, delay: 1 }), 'free')[0]));
ok('at most two tips', A.tips(A.analyze('um '.repeat(10) + 'go go to to be be ' + W(190), { sec: 60, delay: 9 }), 'free').length <= 2);
ok('off-topic tip', A.tips(A.analyze(W(130), { sec: 60, delay: 1, topic: 'Explain volcano magma crater lava' }), 'topic').some((t) => /never touched/.test(t)));

/* ---- takes: clean + merge ---- */
const T = (id, mod, extra = {}) => ({ id, at: 1000 + mod, mod, day: '2026-10-19', mode: 'topic', topic: 'x', sec: 60, text: 'hello world', ...extra });
eq('clean drops junk', A.cleanTake({ nope: 1 }), null);
eq('clean keeps tombstone small', A.cleanTake({ id: 'a', del: 1, mod: 5, at: 4, day: '2026-10-19', text: 'secret' }), { id: 'a', mod: 5, at: 4, day: '2026-10-19', del: 1 });
ok('clean computes stats when missing', A.cleanTake(T('a', 1)).st.words === 2);
eq('merge: later change wins', A.mergeTakes([T('a', 1, { text: 'one' })], [T('a', 2, { text: 'two' })]).map((t) => t.text), ['two']);
eq('merge: stale device does not win', A.mergeTakes([T('a', 5, { text: 'new' })], [T('a', 2, { text: 'old' })]).map((t) => t.text), ['new']);
eq('merge: union by id, ordered by time', A.mergeTakes([T('b', 9)], [T('a', 1)]).map((t) => t.id), ['a', 'b']);
eq('merge: a deletion stays deleted against an older copy', A.mergeTakes([{ id: 'a', del: 1, mod: 9, at: 1, day: '2026-10-19' }], [T('a', 3)]).map((t) => !!t.del), [true]);
eq('merge: an edit made after a deletion wins', A.mergeTakes([{ id: 'a', del: 1, mod: 3, at: 1, day: '2026-10-19' }], [T('a', 9)]).map((t) => !!t.del), [false]);
eq('merge: same mod, deletion wins', A.mergeTakes([T('a', 4)], [{ id: 'a', del: 1, mod: 4, at: 1, day: '2026-10-19' }]).map((t) => !!t.del), [true]);
eq('merge twice is stable', A.mergeTakes(A.mergeTakes([T('a', 1)], [T('b', 2)]), [T('a', 1)]).map((t) => t.id), ['a', 'b']);
ok('file text is JSON', JSON.parse(A.fileText([A.cleanTake(T('a', 1))])).takes.length === 1);

/* ---- streaks ---- */
eq('streak: three days incl. today', A.streakOf(['2026-10-17', '2026-10-18', '2026-10-19'], '2026-10-19'), { days: 3, today: true });
eq('streak: today not yet spoken keeps yesterday', A.streakOf(['2026-10-17', '2026-10-18'], '2026-10-19'), { days: 2, today: false });
eq('streak: a gap breaks it', A.streakOf(['2026-10-15', '2026-10-18', '2026-10-19'], '2026-10-19'), { days: 2, today: true });
eq('streak: two days gone is zero', A.streakOf(['2026-10-16'], '2026-10-19'), { days: 0, today: false });
eq('streak: empty', A.streakOf([], '2026-10-19'), { days: 0, today: false });
eq('streak across a month end', A.streakOf(['2026-09-30', '2026-10-01'], '2026-10-01'), { days: 2, today: true });
eq('addDays across year end', A.addDays('2026-12-31', 1), '2027-01-01');
eq('addDays back', A.addDays('2026-03-01', -1), '2026-02-28');

/* ---- topics ---- */
ok('topics: a decent bank', TOPICS.length >= 90);
ok('topics: all unique', new Set(TOPICS.map((t) => t[1])).size === TOPICS.length);
ok('topics: each a [kind, sentence]', TOPICS.every((t) => t.length === 2 && t[0] && /[.?:]$/.test(t[1])));
ok('topics: six kinds', new Set(TOPICS.map((t) => t[0])).size === 6);
eq('pick: first by rnd 0', A.pickTopic(TOPICS, [], 0), TOPICS[0]);
eq('pick: last by rnd .999', A.pickTopic(TOPICS, [], 0.9999), TOPICS[TOPICS.length - 1]);
ok('pick: skips a recently seen one', A.pickTopic(TOPICS, [TOPICS[0][1]], 0)[1] !== TOPICS[0][1]);
ok('pick: with everything seen still returns one', !!A.pickTopic(TOPICS, TOPICS.map((t) => t[1]), 0.5));
{
  /* over many draws, never an immediate repeat and every topic reachable */
  const seen = [];
  const got = new Set();
  let prev = '';
  let repeat = false;
  for (let i = 0; i < 3000; i++) {
    const t = A.pickTopic(TOPICS, seen, Math.random());
    if (t[1] === prev) repeat = true;
    prev = t[1];
    got.add(t[1]);
    seen.push(t[1]);
  }
  ok('pick: no immediate repeat in 3000 draws', !repeat);
  ok('pick: most topics get used', got.size > TOPICS.length * 0.9);
}

/* ---- average ---- */
eq('average', A.average([{ st: { wpm: 100 } }, { st: { wpm: 150 } }, { st: {} }], 'wpm'), 125);
eq('average of nothing', A.average([], 'wpm'), null);

console.log(passes + ' checks passed' + (fails ? ', ' + fails + ' FAILED' : ''));
process.exit(fails ? 1 : 0);
