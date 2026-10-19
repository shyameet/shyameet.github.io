/* A small fake of the GitHub REST API (the parts the site uses), plus fakes of
   raw.githubusercontent.com and ntfy.sh, so several "devices" (different origins in one
   browser) can share one repository without touching the real one.

     node tools/test/fake_gh.mjs            listens on :4400

   Real behaviour copied: file writes need the current sha (409 when stale, 422 when a
   sha is sent for a new file or missing for an existing one), a branch must exist, GET
   answers 304 to a matching If-None-Match, CORS for the browser.

   Test controls:
     GET  /__state            the whole repo as JSON (branches -> paths)
     GET  /__log              every API request so far
     GET  /__ntfy             the scheduled ntfy messages and a log of ntfy calls
     POST /__reset            back to the seed (main only, no sync branch)
     POST /__fail?n=2         the next n write requests answer 500
     POST /__offline?on=1     every API request answers 503 (on=0 to end it)
     POST /__delay?ms=300     every API request waits that long first

   Pages talk to it through a stub that tools/test/mk_dev.py puts into a copy of a page. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO = 'shyameet/shyameet.github.io';
const PORT = 4400;

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
let branches;
let log;
let failN = 0;
let offline = false;
let delayMs = 0;
let counter = 0;
const ntfyMsgs = new Map();
const ntfyLog = [];
let ntfyCounter = 0;

function seed() {
  const files = new Map();
  for (const dir of ['content/posts', 'content/focus']) {
    for (const f of fs.readdirSync(path.join(SITE, dir))) {
      const buf = fs.readFileSync(path.join(SITE, dir, f));
      files.set(dir + '/' + f, { buf, sha: sha1(buf) });
    }
  }
  branches = { main: files };
  log = [];
  counter = 0;
  failN = 0; offline = false; delayMs = 0;
  ntfyMsgs.clear();
  ntfyLog.length = 0;
}
seed();

const send = (res, status, body, extra = {}) => {
  const data = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-None-Match, X-GitHub-Api-Version, Accept',
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
    'Access-Control-Expose-Headers': 'ETag',
    ...extra,
  });
  res.end(data);
};

const readBody = (req) => new Promise((resolve) => {
  let s = '';
  req.on('data', (c) => (s += c));
  req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { resolve({}); } });
});

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);
  if (req.method === 'OPTIONS') return send(res, 204);

  /* controls */
  if (p === '/__state') {
    const out = {};
    for (const [b, files] of Object.entries(branches)) {
      out[b] = {};
      for (const [k, v] of files) out[b][k] = v.buf.length > 4000 ? '(' + v.buf.length + ' bytes)' : v.buf.toString('utf8');
    }
    return send(res, 200, out);
  }
  if (p === '/__log') return send(res, 200, log);
  if (p === '/__reset') { seed(); return send(res, 200, { ok: true }); }
  if (p === '/__fail') { failN = +url.searchParams.get('n') || 0; return send(res, 200, { failN }); }
  if (p === '/__offline') { offline = url.searchParams.get('on') === '1'; return send(res, 200, { offline }); }
  if (p === '/__delay') { delayMs = +url.searchParams.get('ms') || 0; return send(res, 200, { delayMs }); }

  /* a fake of raw.githubusercontent.com: /raw/<owner>/<repo>/<branch>/<path> */
  const rawm = p.match(/^\/raw\/[^/]+\/[^/]+\/([^/]+)\/(.+)$/);
  if (rawm) {
    const f = (branches[rawm[1]] || new Map()).get(rawm[2]);
    if (!f) { res.writeHead(404, { 'Access-Control-Allow-Origin': '*' }); return res.end('404: Not Found'); }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    return res.end(f.buf);
  }

  /* a fake of ntfy.sh: POST / with JSON publishes (a sequence_id replaces the scheduled
     message with that id), DELETE /<topic>/<seq> cancels it */
  if (p === '/__ntfy') return send(res, 200, { scheduled: [...ntfyMsgs.values()], log: ntfyLog });
  if (p.startsWith('/ntfy')) {
    const rest = p.slice('/ntfy'.length) || '/';
    if (req.method === 'POST' && rest === '/') {
      const body = await readBody(req);
      if (!body.topic) return send(res, 400, { error: 'topic missing' });
      const id = 'm' + (++ntfyCounter);
      const msg = { id, topic: body.topic, seq: body.sequence_id || id, title: body.title, message: body.message, delay: body.delay || null, tags: body.tags };
      ntfyMsgs.set(body.topic + '/' + msg.seq, msg);
      ntfyLog.push('POST ' + msg.seq + (msg.delay ? ' @' + msg.delay : ' now') + ' ' + (msg.title || ''));
      return send(res, 200, { id, time: Math.floor(Date.now() / 1000), topic: body.topic });
    }
    const m2 = rest.match(/^\/([^/]+)\/([^/]+)$/);
    if (req.method === 'DELETE' && m2) {
      const had = ntfyMsgs.delete(m2[1] + '/' + m2[2]);
      ntfyLog.push('DELETE ' + m2[2] + (had ? '' : ' (none)'));
      return send(res, 200, { deleted: had });
    }
    return send(res, 404, { error: 'not found' });
  }

  if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  const entry = { n: ++counter, m: req.method, p: p + url.search, auth: !!req.headers.authorization };
  log.push(entry);
  if (offline) { entry.s = 503; return send(res, 503, { message: 'offline' }); }
  if (!req.headers.authorization) { entry.s = 401; return send(res, 401, { message: 'Requires authentication' }); }

  const base = '/repos/' + REPO;
  if (p === base) { entry.s = 200; return send(res, 200, { full_name: REPO, permissions: { push: true } }); }

  /* git refs */
  let m = p.match(new RegExp('^' + base + '/git/ref/heads/(.+)$'));
  if (m && req.method === 'GET') {
    const b = branches[m[1]];
    if (!b) { entry.s = 404; return send(res, 404, { message: 'Not Found' }); }
    entry.s = 200;
    return send(res, 200, { ref: 'refs/heads/' + m[1], object: { sha: sha1(m[1] + counter) } });
  }
  if (p === base + '/git/refs' && req.method === 'POST') {
    const body = await readBody(req);
    const name = String(body.ref || '').replace('refs/heads/', '');
    if (!name || branches[name]) { entry.s = 422; return send(res, 422, { message: 'Reference already exists' }); }
    branches[name] = new Map([...branches.main].map(([k, v]) => [k, { ...v }]));
    entry.s = 201;
    return send(res, 201, { ref: 'refs/heads/' + name });
  }

  /* contents */
  m = p.match(new RegExp('^' + base + '/contents/(.*)$'));
  if (m) {
    const file = m[1];
    const branch = url.searchParams.get('ref') || 'main';
    if (req.method === 'GET') {
      const files = branches[branch];
      if (!files) { entry.s = 404; return send(res, 404, { message: 'No commit found for the ref ' + branch }); }
      const f = files.get(file);
      if (!f) {
        /* a directory listing */
        const kids = [...files.keys()].filter((k) => k.startsWith(file + '/') && !k.slice(file.length + 1).includes('/'));
        if (kids.length) { entry.s = 200; return send(res, 200, kids.map((k) => ({ name: k.split('/').pop(), path: k, sha: files.get(k).sha, type: 'file' }))); }
        entry.s = 404;
        return send(res, 404, { message: 'Not Found' });
      }
      const etag = '"' + f.sha + '"';
      if (req.headers['if-none-match'] === etag) { entry.s = 304; return send(res, 304, undefined, { ETag: etag }); }
      entry.s = 200;
      return send(res, 200, { name: file.split('/').pop(), path: file, sha: f.sha, content: f.buf.toString('base64'), encoding: 'base64' }, { ETag: etag });
    }
    if (req.method === 'PUT') {
      const body = await readBody(req);
      if (failN > 0) { failN--; entry.s = 500; return send(res, 500, { message: 'Server on fire' }); }
      const branch2 = body.branch || 'main';
      const files = branches[branch2];
      if (!files) { entry.s = 404; return send(res, 404, { message: 'Branch ' + branch2 + ' not found' }); }
      const cur = files.get(file);
      if (cur && !body.sha) { entry.s = 422; return send(res, 422, { message: 'Invalid request. "sha" wasn\'t supplied.' }); }
      if (cur && body.sha !== cur.sha) { entry.s = 409; return send(res, 409, { message: file + ' does not match ' + body.sha }); }
      if (!cur && body.sha) { entry.s = 422; return send(res, 422, { message: 'Invalid request. "sha" wasn\'t supplied or doesn\'t match.' }); }
      const buf = Buffer.from(String(body.content || ''), 'base64');
      const nf = { buf, sha: sha1(buf + String(counter)) };
      files.set(file, nf);
      entry.s = cur ? 200 : 201;
      entry.msg = body.message;
      return send(res, cur ? 200 : 201, { content: { sha: nf.sha, path: file }, commit: { message: body.message } });
    }
    if (req.method === 'DELETE') {
      const body = await readBody(req);
      const files = branches[body.branch || 'main'];
      const cur = files && files.get(file);
      if (!cur) { entry.s = 404; return send(res, 404, { message: 'Not Found' }); }
      if (body.sha !== cur.sha) { entry.s = 409; return send(res, 409, { message: file + ' does not match ' + body.sha }); }
      files.delete(file);
      entry.s = 200;
      entry.msg = body.message;
      return send(res, 200, { content: null, commit: { message: body.message } });
    }
  }
  entry.s = 404;
  send(res, 404, { message: 'Not Found: ' + p });
}).listen(PORT, () => console.log('fake GitHub (+ raw, ntfy) on :' + PORT));
