"""Tests for speakd.py with the stand-in for Whisper (no model needed).

    python tools/speakd/test_speakd.py

Starts the helper on a spare port with a temporary data folder, talks to it over HTTP the way
the Speak page does, and checks: the guards (only the site's origins, only loopback), audio and
take saving, transcription finishing, the take coming back with words and times, deleting,
editing, retrying, requeueing after a restart, a broken file being moved aside.
"""
import http.client
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import speakd  # noqa: E402

ORIGIN = 'https://shyameet.github.io'


class Rig:
    def __init__(self, data):
        self.store = speakd.Store(data)
        self.engine = speakd.FakeWhisper()
        self.worker = speakd.Worker(self.store, self.engine, lambda m: None)
        self.worker.start()
        for t in self.store.takes():
            if t.get('status') in ('queued', 'transcribing'):
                self.worker.add(t['id'])
        self.srv = speakd.ThreadingHTTPServer(('127.0.0.1', 0), speakd.make_handler(self.store, self.worker, self.engine, lambda m: None))
        self.port = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def stop(self):
        self.srv.shutdown()
        self.srv.server_close()

    def req(self, method, path, body=None, headers=None, raw=None, origin=ORIGIN, host=None):
        c = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        h = dict(headers or {})
        if origin:
            h['Origin'] = origin
        if host:
            h['Host'] = host
        data = raw
        if body is not None:
            data = json.dumps(body).encode()
            h['Content-Type'] = 'application/json'
        c.request(method, path, body=data, headers=h)
        r = c.getresponse()
        payload = r.read()
        hdrs = {k.lower(): v for k, v in r.getheaders()}
        c.close()
        try:
            return r.status, json.loads(payload.decode() or 'null'), hdrs
        except Exception:
            return r.status, payload, hdrs

    def wait_done(self, tid, secs=5):
        end = time.time() + secs
        while time.time() < end:
            s, t, _ = self.req('GET', '/take/' + tid)
            if s == 200 and t.get('status') in ('done', 'error'):
                return t
            time.sleep(0.05)
        raise AssertionError('take %s did not finish' % tid)


class T(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='speakd-test-')
        self.rig = Rig(self.dir)

    def tearDown(self):
        self.rig.stop()
        shutil.rmtree(self.dir, ignore_errors=True)

    def send_take(self, tid='take0001', day='2026-10-21', parts=1, **extra):
        for n in range(parts):
            s, b, _ = self.rig.req('POST', '/audio?id=%s&day=%s&n=%d' % (tid, day, n), raw=b'WEBM' * 100)
            self.assertEqual(s, 200, b)
        body = dict(id=tid, day=day, at=1792400000000, mode='topic', topic='Explain money.', cat='explain',
                    target=60, think=30, sec=58, delay=1.2, parts=parts, text='')
        body.update(extra)
        return self.rig.req('POST', '/take', body)

    # -- guards
    def test_health(self):
        s, b, h = self.rig.req('GET', '/health')
        self.assertEqual(s, 200)
        self.assertTrue(b['ok'])
        self.assertEqual(h['access-control-allow-origin'], ORIGIN)

    def test_foreign_origin_refused(self):
        s, b, _ = self.rig.req('GET', '/takes', origin='https://evil.example')
        self.assertEqual(s, 403)
        s, b, _ = self.rig.req('POST', '/take', {'id': 'abcd1234', 'day': '2026-10-21'}, origin='https://evil.example')
        self.assertEqual(s, 403)
        self.assertEqual(self.rig.store.takes(), [])

    def test_foreign_host_refused(self):
        s, _, _ = self.rig.req('GET', '/takes', host='attacker.example:4777', origin=None)
        self.assertEqual(s, 403)

    def test_no_origin_ok_from_this_machine(self):
        s, _, _ = self.rig.req('GET', '/health', origin=None)
        self.assertEqual(s, 200)

    def test_preflight_allows_private_network(self):
        s, _, h = self.rig.req('OPTIONS', '/take', headers={'Access-Control-Request-Method': 'POST',
                                                            'Access-Control-Request-Private-Network': 'true'})
        self.assertEqual(s, 204)
        self.assertEqual(h['access-control-allow-private-network'], 'true')
        self.assertEqual(h['access-control-allow-origin'], ORIGIN)

    def test_preflight_foreign_refused(self):
        s, _, _ = self.rig.req('OPTIONS', '/take', origin='https://evil.example')
        self.assertEqual(s, 403)

    def test_local_test_server_origin_ok(self):
        s, _, h = self.rig.req('GET', '/health', origin='http://localhost:4321')
        self.assertEqual(s, 200)
        self.assertEqual(h['access-control-allow-origin'], 'http://localhost:4321')

    # -- a take, start to finish
    def test_take_is_transcribed(self):
        s, b, _ = self.send_take(fake='um so I think money is a tool for trade')
        self.assertEqual(s, 200)
        self.assertEqual(b['status'], 'queued')
        t = self.rig.wait_done('take0001')
        self.assertEqual(t['status'], 'done')
        self.assertEqual(t['text'], 'um so I think money is a tool for trade')
        self.assertEqual(t['words'][0]['w'], 'um')
        self.assertGreater(t['words'][3]['s'] - t['words'][2]['e'], 1.0)   # the pause is kept
        self.assertTrue((Path(self.dir) / 'audio' / '2026-10-21' / 'take0001_0.webm').exists())
        self.assertTrue((Path(self.dir) / 'takes' / '2026-10-21.json').exists())

    def test_two_parts_are_joined(self):
        self.send_take(parts=2, fake='one two three four')
        t = self.rig.wait_done('take0001')
        self.assertEqual(t['status'], 'done')
        self.assertEqual(t['parts'], 2)

    def test_take_without_audio_keeps_dictated_text(self):
        s, b, _ = self.rig.req('POST', '/take', dict(id='typed001', day='2026-10-21', parts=0, text='typed words here', sec=10))
        self.assertEqual(b['status'], 'done')
        self.assertEqual(self.rig.req('GET', '/take/typed001')[1]['text'], 'typed words here')

    def test_audio_that_never_arrived_is_an_error(self):
        s, b, _ = self.rig.req('POST', '/take', dict(id='noaudio01', day='2026-10-21', parts=1, text=''))
        t = self.rig.wait_done('noaudio01')
        self.assertEqual(t['status'], 'error')

    def test_repeat_of_a_done_take_keeps_its_words(self):
        self.send_take(fake='alpha beta gamma delta')
        self.rig.wait_done('take0001')
        s, b, _ = self.rig.req('POST', '/take', dict(id='take0001', day='2026-10-21', parts=1, text=''))
        self.assertEqual(b['status'], 'done')
        self.assertEqual(len(b['words']), 4)
        self.assertEqual(len(self.rig.req('GET', '/takes')[1]['takes']), 1)

    def test_takes_listing_and_since(self):
        self.send_take('take0001', '2026-10-20', fake='a b c')
        self.send_take('take0002', '2026-10-21', fake='d e f')
        self.rig.wait_done('take0001'); self.rig.wait_done('take0002')
        s, b, _ = self.rig.req('GET', '/takes')
        self.assertEqual([t['id'] for t in b['takes']], ['take0001', 'take0002'])
        self.assertEqual(b['days'], ['2026-10-20', '2026-10-21'])
        s, b, _ = self.rig.req('GET', '/takes?since=2026-10-21')
        self.assertEqual([t['id'] for t in b['takes']], ['take0002'])

    def test_edit_text(self):
        self.send_take(fake='helo world')
        self.rig.wait_done('take0001')
        s, t, _ = self.rig.req('POST', '/take/take0001/text', {'text': 'hello world'})
        self.assertEqual(t['text'], 'hello world')
        self.assertTrue(t['edited'])
        self.assertEqual(len(t['words']), 2)   # the timed words are still there

    def test_delete_removes_take_audio_and_empty_day(self):
        self.send_take(fake='a b c')
        self.rig.wait_done('take0001')
        s, b, _ = self.rig.req('DELETE', '/take/take0001')
        self.assertTrue(b['deleted'])
        self.assertEqual(self.rig.req('GET', '/take/take0001')[0], 404)
        self.assertFalse((Path(self.dir) / 'takes' / '2026-10-21.json').exists())
        self.assertEqual(list((Path(self.dir) / 'audio' / '2026-10-21').glob('*')), [])
        self.assertFalse(self.rig.req('DELETE', '/take/take0001')[1]['deleted'])

    def test_retry(self):
        self.rig.req('POST', '/take', dict(id='retry0001', day='2026-10-21', parts=1, text=''))
        self.assertEqual(self.rig.wait_done('retry0001')['status'], 'error')
        self.rig.req('POST', '/audio?id=retry0001&day=2026-10-21&n=0', raw=b'WEBM' * 10)
        self.rig.req('POST', '/take/retry0001/retry')
        self.assertEqual(self.rig.wait_done('retry0001')['status'], 'done')

    # -- bad input
    def test_bad_input(self):
        self.assertEqual(self.rig.req('POST', '/take', {'id': '../x', 'day': '2026-10-21'})[0], 400)
        self.assertEqual(self.rig.req('POST', '/take', {'id': 'abcd1234', 'day': 'yesterday'})[0], 400)
        self.assertEqual(self.rig.req('POST', '/audio?id=../../etc&day=2026-10-21&n=0', raw=b'x')[0], 400)
        self.assertEqual(self.rig.req('POST', '/audio?id=abcd1234&day=2026-10-21&n=99', raw=b'x')[0], 400)
        self.assertEqual(self.rig.req('POST', '/audio?id=abcd1234&day=2026-10-21&n=0', raw=b'')[0], 400)
        self.assertEqual(self.rig.req('GET', '/take/..%2f..%2fsecret')[0], 404)
        self.assertEqual(self.rig.req('GET', '/nope')[0], 404)
        c = http.client.HTTPConnection('127.0.0.1', self.rig.port, timeout=5)
        c.request('POST', '/take', body=b'{not json', headers={'Origin': ORIGIN, 'Content-Type': 'application/json'})
        self.assertEqual(c.getresponse().status, 400)

    # -- coaching
    def test_coaching(self):
        self.assertEqual(self.rig.req('GET', '/coaching')[1]['text'], '')
        (Path(self.dir) / 'coaching' / '2026-10-20.md').write_text('old note', encoding='utf-8')
        (Path(self.dir) / 'coaching' / '2026-10-21.md').write_text('new note हिंदी', encoding='utf-8')
        (Path(self.dir) / 'coaching' / 'notes.md').write_text('ignored', encoding='utf-8')
        s, b, _ = self.rig.req('GET', '/coaching')
        self.assertEqual(b['name'], '2026-10-21.md')
        self.assertIn('हिंदी', b['text'])
        self.assertEqual(b['all'], ['2026-10-20.md', '2026-10-21.md'])

    # -- restart and damage
    def test_unfinished_takes_resume_after_restart(self):
        self.rig.stop()
        # a take left 'transcribing' by a helper that was stopped mid-way
        st = speakd.Store(self.dir)
        st.save_audio('2026-10-21', 'resume0001', 0, b'WEBM')
        st.put({'id': 'resume0001', 'day': '2026-10-21', 'at': 1, 'mod': 1, 'parts': 1, 'text': '', 'status': 'transcribing', 'fake': 'x y z'})
        self.rig = Rig(self.dir)
        self.assertEqual(self.rig.wait_done('resume0001')['status'], 'done')

    def test_broken_day_file_is_moved_aside_not_overwritten(self):
        self.rig.stop()
        (Path(self.dir) / 'takes').mkdir(exist_ok=True)
        (Path(self.dir) / 'takes' / '2026-10-21.json').write_text('{ this is not json', encoding='utf-8')
        self.rig = Rig(self.dir)
        self.assertEqual(self.rig.req('GET', '/takes')[1]['takes'], [])
        self.send_take(fake='a b c')
        self.rig.wait_done('take0001')
        left = sorted(p.name for p in (Path(self.dir) / 'takes').glob('*'))
        self.assertTrue(any('broken' in n for n in left), left)
        self.assertIn('2026-10-21.json', left)

    def test_utf8_roundtrip(self):
        self.send_take(fake='main yeh bol raha hoon matlab')
        self.rig.wait_done('take0001')
        self.rig.req('POST', '/take/take0001/text', {'text': 'मैं यह बोल रहा हूँ'})
        self.assertEqual(self.rig.req('GET', '/take/take0001')[1]['text'], 'मैं यह बोल रहा हूँ')

    def test_concurrent_takes_all_land(self):
        def go(i):
            self.send_take('conc%04d' % i, '2026-10-21', fake='w%d x y' % i)
        ts = [threading.Thread(target=go, args=(i,)) for i in range(8)]
        [t.start() for t in ts]
        [t.join() for t in ts]
        for i in range(8):
            self.assertEqual(self.rig.wait_done('conc%04d' % i)['status'], 'done')
        self.assertEqual(len(self.rig.req('GET', '/takes')[1]['takes']), 8)


if __name__ == '__main__':
    unittest.main(verbosity=1)
