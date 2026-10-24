/* Checks on src/sw.js without a browser: it must register a fetch handler (some browsers only offer
   to install a site as an app when its service worker has one), that handler must pass page loads
   straight to the network and leave every other request alone, and the notification buttons must
   still bring the right page back.

     node tools/test/test_sw.mjs
*/
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'sw.js'), 'utf8');

let fails = 0, passes = 0;
const ok = (name, cond) => { if (cond) passes++; else { fails++; console.log('  FAIL ' + name); } };

function boot() {
  const handlers = {};
  const calls = { fetched: [], opened: [], skipWaiting: 0, claimed: 0 };
  const self = {
    addEventListener: (type, fn) => { handlers[type] = fn; },
    skipWaiting: () => { calls.skipWaiting++; },
    clients: {
      claim: () => { calls.claimed++; return Promise.resolve(); },
      matchAll: () => Promise.resolve([]),
      openWindow: (u) => { calls.opened.push(u); return Promise.resolve(); },
    },
  };
  const sandbox = { self, URL, Promise, fetch: (req) => { calls.fetched.push(req); return Promise.resolve({ ok: true, from: 'network' }); } };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'sw.js' });
  return { handlers, calls };
}

const { handlers, calls } = boot();
ok('has a fetch handler', typeof handlers.fetch === 'function');
ok('has install, activate, notificationclick', ['install', 'activate', 'notificationclick'].every((k) => typeof handlers[k] === 'function'));

const run = (request) => {
  let responded = null;
  handlers.fetch({ request, respondWith: (p) => { responded = p; } });
  return responded;
};
const nav = { method: 'GET', mode: 'navigate', url: 'https://x.test/' };
const r1 = run(nav);
ok('a page load is answered by the network', r1 !== null);
await r1;
ok('the request went to the network unchanged', calls.fetched.length === 1 && calls.fetched[0] === nav);
ok('an image request is left alone', run({ method: 'GET', mode: 'no-cors', url: 'https://x.test/a.png' }) === null);
ok('a script request is left alone', run({ method: 'GET', mode: 'same-origin', url: 'https://x.test/app.js' }) === null);
ok('a POST is left alone', run({ method: 'POST', mode: 'navigate', url: 'https://x.test/' }) === null);
ok('a cross-origin API call is left alone', run({ method: 'PUT', mode: 'cors', url: 'https://api.github.com/x' }) === null);
ok('nothing else was fetched', calls.fetched.length === 1);

handlers.install({});
ok('install takes over at once', calls.skipWaiting === 1);
let waited = null;
handlers.activate({ waitUntil: (p) => { waited = p; } });
await waited;
ok('activate claims the open pages', calls.claimed === 1);

/* a notification button with nothing open opens the right page */
const tap = async (tag, action, ids) => {
  let p = null;
  handlers.notificationclick({ notification: { tag, data: { ids }, close() {} }, action, waitUntil: (x) => { p = x; } });
  await p;
};
await tap('todo', 'done', ['t1']);
ok('a task button opens the tasks page with the action', calls.opened[calls.opened.length - 1] === '/tasks/?do=done&id=t1');
await tap('focus', 'again', []);
ok('the focus button opens the focus page again', calls.opened[calls.opened.length - 1] === '/focus/?again=1');

console.log(passes + ' checks passed' + (fails ? ', ' + fails + ' FAILED' : ''));
process.exit(fails ? 1 : 0);
