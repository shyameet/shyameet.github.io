/* The Write page's dictation: what one listening session has said, from its list of results, however the
   browser reports them (desktop Chrome: each result its own phrase; the Android tablet: each result the
   whole sentence so far, sometimes corrected).

     node tools/test/test_dictation.mjs

   The function lives in public/admin/index.html (a page with no module system), between the markers
   "dictationText:start" and "dictationText:end"; this test pulls it out and runs it. */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'admin', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
const a = html.indexOf('dictationText:start');
const b = html.indexOf('dictationText:end');
if (a < 0 || b < 0) { console.log('FAIL: the markers are missing from admin/index.html'); process.exit(1); }
const src = html.slice(html.indexOf('function dictationText', a), b).replace(/\/\*\s*$/, '');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(src + '\nthis.dictationText = dictationText;', ctx);
const D = ctx.dictationText;

let fails = 0, passes = 0;
const eq = (name, got, want) => { if (got === want) passes++; else { fails++; console.log('  FAIL ' + name + '\n       got  ' + JSON.stringify(got) + '\n       want ' + JSON.stringify(want)); } };

/* desktop: separate phrases */
eq('separate phrases are joined', D(['hello', 'how are you', 'fine thanks']), 'hello how are you fine thanks');
eq('one phrase', D(['hello']), 'hello');
eq('nothing', D([]), '');
eq('blanks are skipped', D(['', '  ', 'hello', ' ']), 'hello');

/* the tablet: every result is the whole sentence so far */
eq('growing sentence', D(['any', 'any understand', 'any understand what', 'any understand what I am saying']), 'any understand what I am saying');
eq('the 24 Oct tablet, as it was typed before', D(['any', 'any understand', 'any understand what', 'any understand what I', 'any understand what I am', 'any understand what I am saying']), 'any understand what I am saying');
eq('the engine corrects its first guess half way', D(['any', 'any understand', 'any understand what', 'can you understand what I', 'can you understand what I am', 'can you understand what I am saying']), 'can you understand what I am saying');
eq('a growing sentence, then a new one', D(['hello', 'hello how', 'hello how are you', 'fine thanks', 'fine thanks very much']), 'hello how are you fine thanks very much');
eq('case and punctuation do not matter', D(['Hello.', 'hello how are you']), 'hello how are you');
eq('only the sentence so far is kept, once', D(['one', 'one two', 'one two three', 'one two three four', 'one two three four five']).split(' ').length, 5);

/* a hundred hellos (the other tablet bug) */
const hundred = Array.from({ length: 100 }, (_, i) => Array(i + 1).fill('hello').join(' '));
eq('a hundred growing hellos are 100 words at most, not 5050', D(hundred).split(' ').length, 100);
eq('the same word said twice as separate phrases is one (a repeated word is not worth a duplicate)', D(['no', 'no']), 'no');

/* other scripts */
eq('hindi growing', D(['मैं', 'मैं यह', 'मैं यह बोल']), 'मैं यह बोल');
eq('hindi separate', D(['मैं ठीक', 'bahut accha']), 'मैं ठीक bahut accha');

/* phrases that merely start alike are not the same sentence grown */
eq('"I think" then "I mean"', D(['I think so', 'I mean it is fine']), 'I think so I mean it is fine');
eq('two similar sentences that really are two', D(['the cat is here', 'the dog is here']), 'the cat is here the dog is here');
eq('a corrected first word with nothing after it yet is kept apart until the sentence grows', D(['any', 'can you']), 'any can you');
eq('a short phrase after a long one', D(['we went to the market yesterday', 'and bought rice']), 'we went to the market yesterday and bought rice');

console.log(passes + ' checks passed' + (fails ? ', ' + fails + ' FAILED' : ''));
process.exit(fails ? 1 : 0);
