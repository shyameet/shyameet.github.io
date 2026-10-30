/* Unit tests for the pure parts of src/speak.js: what the words of a talk show (pace,
   fillers, restarts, pauses between timed words, topic words), the transcript segments,
   the coaching note's markup, streaks, and the choice of a topic.

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
ok('hook gave the functions', A && A.analyze && A.analyzeWords && A.pausesOf && A.streakOf);

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
eq('average', A.average([{ v: 100 }, { v: 150 }, {}], (t) => t.v), 125);
eq('average of nothing', A.average([], (t) => t.v), null);


/* ---- timed words: pauses, first word, flags line up with the words ---- */
const TW = (spec) => {
  /* spec: [[word, startSec, endSec], ...] */
  return spec.map(([w, s, e]) => ({ w, s, e }));
};
const timed = TW([['Um,', 1.5, 1.9], ['so', 2.0, 2.2], ['I', 2.3, 2.4], ['think', 2.5, 2.9], ['money', 4.6, 5.0], ['is', 5.1, 5.2], ['like', 5.3, 5.5], ['you', 5.6, 5.7], ['know', 5.8, 6.0], ['useful', 6.1, 6.6]]);
const pa = A.pausesOf(timed);
eq('pauses: one gap of 1.7 s', [pa.count, pa.longest, pa.long], [1, 1.7, 1]);
eq('pauses: where it is', pa.gaps, [{ i: 4, len: 1.7 }]);
eq('pauses: first word', pa.first, 1.5);
eq('pauses: none in steady speech', A.pausesOf(TW([['a', 0, 0.3], ['b', 0.4, 0.7], ['c', 0.8, 1.1]])).count, 0);
eq('pauses: a gap of exactly 0.7 counts', A.pausesOf(TW([['a', 0, 0.3], ['b', 1.0, 1.3]])).count, 1);
eq('pauses: a gap of 0.6 does not', A.pausesOf(TW([['a', 0, 0.3], ['b', 0.9, 1.2]])).count, 0);
eq('pauses: total', A.pausesOf(TW([['a', 0, 0.3], ['b', 1.3, 1.6], ['c', 3.6, 3.9]])).total, 3);
eq('pauses: empty', A.pausesOf([]), { count: 0, long: 0, total: 0, longest: 0, first: null, gaps: [] });
eq('pauses: a custom minimum', A.pausesOf(TW([['a', 0, 0.3], ['b', 0.9, 1.2]]), 0.5).count, 1);

const aw = A.analyzeWords(timed, { sec: 30 });
eq('words: um is flagged at position 0', aw.flags.indexOf(0) >= 0, true);
eq('words: "so" after um is flagged', aw.flags.indexOf(1) >= 0, true);
eq('words: "like you know" flags like, you, know', [6, 7, 8].every((i) => aw.flags.indexOf(i) >= 0), true);
eq('words: ordinary words are not flagged', [2, 3, 4, 5, 9].some((i) => aw.flags.indexOf(i) >= 0), false);
eq('words: filler tally', aw.fillers, { um: 1, so: 1, like: 1, 'you know': 1 });
eq('words: punctuation on a word does not hide it', A.analyzeWords(TW([['Uh,', 0, 0.2]]), {}).fillerTotal, 1);
eq('words: a word that is two tokens is one position', A.analyzeWords(TW([['non-profit', 0, 0.5], ['um', 0.6, 0.8]]), {}).flags, [1]);
eq('words: an empty word does not break positions', A.analyzeWords(TW([['...', 0, 0.1], ['um', 0.2, 0.3]]), {}).flags, [1]);
eq('words: matlab (a Hindi filler) is counted', A.analyzeWords(TW([['matlab', 0, 0.4]]), {}).fillerTotal, 1);

const facts = A.factsOf({ words: timed, sec: 30, mode: 'topic', topic: 'Explain money to a child.' });
eq('facts: first word and pauses ride along', [facts.pauses.first, facts.pauses.count, facts.delay], [1.5, 1, 1.5]);
eq('facts: wpm from the seconds spoken', facts.wpm, 20);
ok('facts: topic words used', facts.touched.indexOf('money') >= 0 && facts.missed.indexOf('child') >= 0);
eq('facts: free talk has no topic words', A.factsOf({ words: timed, sec: 30, mode: 'free', topic: 'x' }).missed, []);
eq('facts: none without words', A.factsOf({ words: [], sec: 30 }), null);
eq('facts: none for a take still being written out', A.factsOf({ sec: 30, status: 'queued' }), null);

const seg = A.segmentsOf(timed, facts);
eq('segments: one per word', seg.length, 10);
eq('segments: the pause sits before "money"', [seg[3].gap, seg[4].gap], [0, 1.7]);
eq('segments: fillers marked', seg.filter((s) => s.filler).map((s) => s.w), ['Um,', 'so', 'like', 'you', 'know']);
eq('segments: no words', A.segmentsOf([], null), []);

/* ---- the coaching note ---- */
eq('note: heading, paragraph, bullets', A.noteHtml('## Today\nYou did well.\n- one\n- two\n\nBye'), '<h4>Today</h4><p>You did well.</p><ul><li>one</li><li>two</li></ul><p>Bye</p>');
eq('note: bold', A.noteHtml('a **big** word'), '<p>a <b>big</b> word</p>');
eq('note: html is escaped', A.noteHtml('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
eq('note: hindi survives', A.noteHtml('- \u092e\u0948\u0902'), '<ul><li>\u092e\u0948\u0902</li></ul>');
eq('note: empty', A.noteHtml(''), '');
eq('note: windows line endings', A.noteHtml('a\r\n- b\r\n'), '<p>a</p><ul><li>b</li></ul>');


/* ---- how sentences begin ---- */
const W2 = (s) => s.split(' ').map((w, i) => ({ w, s: i, e: i + 0.5 }));
eq('openers: counts so/and at sentence starts', A.openersOf(W2('It was fine. So we went. And then we ate. Good food.')), { sentences: 4, count: 2, so: 1, and: 1 });
eq('openers: the first word counts', A.openersOf(W2('So I think so.')), { sentences: 1, count: 1, so: 1, and: 0 });
eq('openers: a so after a comma is not a starter', A.openersOf(W2('It was late, so we left, and it rained.')), { sentences: 1, count: 0, so: 0, and: 0 });
eq('openers: question and exclamation end a sentence', A.openersOf(W2('Why? So what! And now.')), { sentences: 3, count: 2, so: 1, and: 1 });
eq('openers: a closing quote after the full stop still ends it', A.openersOf(W2('He said "go." So we went.')), { sentences: 2, count: 1, so: 1, and: 0 });
eq('openers: capitals and commas do not matter', A.openersOf(W2('Fine. SO, we went. And, then.')), { sentences: 3, count: 2, so: 1, and: 1 });
eq('openers: none', A.openersOf([]), { sentences: 0, count: 0, so: 0, and: 0 });
eq('openers: riding along in the facts', A.factsOf({ words: W2('Fine. So we went. And ate.'), sec: 10, mode: 'free' }).openers.count, 2);


/* ---- notes about the recording itself ---- */
const rec = (o) => Object.assign({ sec: 60, peak: 0.5, rms: 0.05, clipped_pct: 0, floor: 0.003, speech_s: 40 }, o);
eq('audio notes: nothing measured', A.audioNotes(null), []);
eq('audio notes: empty list', A.audioNotes([]), []);
eq('audio notes: a healthy recording', A.audioNotes([rec({})]), []);
ok('audio notes: too loud and clipping', /too loud/.test(A.audioNotes([rec({ peak: 0.99, clipped_pct: 0.5, rms: 0.09 })])[0]));
eq('audio notes: one touch of the ceiling is not clipping', A.audioNotes([rec({ peak: 0.99, clipped_pct: 0.01 })]), []);
ok('audio notes: very quiet', /very quiet/.test(A.audioNotes([rec({ rms: 0.004 })])[0]));
ok('audio notes: noisy pauses', /background noise/.test(A.audioNotes([rec({ floor: 0.03 })])[0]));
eq('audio notes: several problems, several notes', A.audioNotes([rec({ peak: 1, clipped_pct: 2, floor: 0.05 })]).length, 2);
ok('audio notes: the worst part counts', A.audioNotes([rec({}), rec({ rms: 0.002 })]).length === 1);
ok('audio notes: a note is plain words about the recording, not a score', A.audioNotes([rec({ peak: 0.99, clipped_pct: 0.5 })]).every((n) => !/\d/.test(n)));


/* ---- words written on the device itself: the pure parts ---- */
const tone = (sec, amp, hz = 220, rate = 16000) => Float32Array.from({ length: sec * rate }, (_, i) => amp * Math.sin(2 * Math.PI * hz * i / rate));
const hiss = (sec, amp, rate = 16000) => { let x = 12345; return Float32Array.from({ length: sec * rate }, () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return amp * ((x / 0x7fffffff) * 2 - 1); }); };
const cat = (...a) => { const o = new Float32Array(a.reduce((n, x) => n + x.length, 0)); let k = 0; for (const x of a) { o.set(x, k); k += x.length; } return o; };
const near = (name, got, want, tol) => ok(name + ' (' + got + ' vs ' + want + ')', Math.abs(got - want) <= tol);

const sil = A.pcmStats(new Float32Array(16000 * 3));
eq('pcm: silence has no peak, level or voice', [sil.peak, sil.rms, sil.speech_s, sil.sec], [0, 0, 0, 3]);
const pcmTone = A.pcmStats(tone(2, 0.3));
near('pcm: a steady tone has its rms', pcmTone.rms, 0.3 / Math.SQRT2, 0.005);
near('pcm: and its peak', pcmTone.peak, 0.3, 0.001);
eq('pcm: and no clipping', pcmTone.clipped_pct, 0);
const sq = A.pcmStats(Float32Array.from({ length: 16000 }, (_, i) => (i % 100 < 50 ? 1 : -1)));
eq('pcm: a full-scale square wave clips everywhere', sq.clipped_pct, 100);
const burst = A.pcmStats(cat(hiss(3, 0.004), tone(1, 0.2), hiss(3, 0.004)));
near('pcm: a one-second burst in quiet is about one second of voice', burst.speech_s, 1, 0.15);
const noisy = A.pcmStats(hiss(5, 0.05));
eq('pcm: steady noise everywhere is not a voice', noisy.speech_s, 0);
ok('pcm: the noise floor reflects steady noise', noisy.floor > 0.02);
eq('pcm: an empty recording', A.pcmStats(new Float32Array(0)).sec, 0);

const ch = (text, s, e) => ({ text, timestamp: [s, e] });
eq('chunks: words with this part\'s start added', A.wordsFromChunks([ch(' Hello', 0.5, 0.9), ch(' world.', 1, 1.4)], 10, 5).map((w) => [w.w, w.s, w.e]), [['Hello', 10.5, 10.9], ['world.', 11, 11.4]]);
eq('chunks: no end time is allowed', A.wordsFromChunks([ch('hi', 2, null)], 0, 5)[0].e, 2.3);
eq('chunks: blank words are dropped', A.wordsFromChunks([ch('  ', 0, 1), ch('ok', 1, 2)], 0, 5).length, 1);
eq('chunks: nothing', A.wordsFromChunks([], 0, 5), []);
eq('chunks: a looping word is cut to two', A.wordsFromChunks(Array.from({ length: 100 }, (_, i) => ch(' hello', i * 0.3, i * 0.3 + 0.2)), 0, 30).length, 2);
eq('chunks: four of the same in a row is still a person', A.wordsFromChunks(Array.from({ length: 4 }, (_, i) => ch(' no', i, i + 0.5)), 0, 5).length, 4);
eq('chunks: a stock phrase over little voice is dropped', A.wordsFromChunks([ch(' Thanks', 0, 1), ch(' for', 1, 1.2), ch(' watching!', 1.2, 2)], 0, 1.5), []);
eq('chunks: the same words in a real talk are kept', A.wordsFromChunks([ch(' Thanks', 0, 1), ch(' for', 1, 1.2), ch(' watching!', 1.2, 2)], 0, 20).length, 3);

console.log(passes + ' checks passed' + (fails ? ', ' + fails + ' FAILED' : ''));
process.exit(fails ? 1 : 0);
