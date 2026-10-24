"""Tests for speakd.py with the stand-in for Whisper (no model needed).

    python tools/speakd/test_speakd.py

Starts the helper on a spare port with a temporary data folder, talks to it over HTTP the way
the Speak page does, and checks: the guards (only the site's origins, only loopback), audio and
take saving, transcription finishing, the take coming back with words and times, deleting,
editing, retrying, requeueing after a restart, a broken file being moved aside.
"""
import http.client
import http.server
import json
import os
import shutil
import subprocess
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
    def __init__(self, data, upstream='http://127.0.0.1:1'):
        self.store = speakd.Store(data)
        self.engine = speakd.FakeWhisper()
        self.worker = speakd.Worker(self.store, self.engine, lambda m: None)
        self.worker.start()
        for t in self.store.takes():
            if t.get('status') in ('queued', 'transcribing'):
                self.worker.add(t['id'])
        self.srv = speakd.ThreadingHTTPServer(('127.0.0.1', 0), speakd.make_handler(self.store, self.worker, self.engine, lambda m: None, upstream))
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


class Upstream:
    """A stand-in for the site: serves /speak/ and /speak.js, 404 for the rest."""
    FILES = {'/speak/': (b'<!doctype html><title>Speak</title>', 'text/html; charset=utf-8'),
             '/speak.js': (b'/* the page */', 'application/javascript')}

    def __init__(self):
        files = self.FILES

        class H(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                f = files.get(self.path.split('?')[0])
                if not f:
                    self.send_response(404)
                    self.send_header('Content-Length', '0')
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header('Content-Type', f[1])
                self.send_header('Content-Length', str(len(f[0])))
                self.end_headers()
                self.wfile.write(f[0])

        self.srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), H)
        self.url = 'http://127.0.0.1:%d' % self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def stop(self):
        self.srv.shutdown()
        self.srv.server_close()


class T(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='speakd-test-')
        self.up = Upstream()
        self.rig = Rig(self.dir, self.up.url)

    def tearDown(self):
        self.rig.stop()
        self.up.stop()
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
        self.rig = Rig(self.dir, self.up.url)
        self.assertEqual(self.rig.wait_done('resume0001')['status'], 'done')

    def test_broken_day_file_is_moved_aside_not_overwritten(self):
        self.rig.stop()
        (Path(self.dir) / 'takes').mkdir(exist_ok=True)
        (Path(self.dir) / 'takes' / '2026-10-21.json').write_text('{ this is not json', encoding='utf-8')
        self.rig = Rig(self.dir, self.up.url)
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


class TSite(unittest.TestCase):
    """The helper also serves the site's pages, so the Speak page can open at the helper's own address."""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='speakd-site-')
        self.up = Upstream()
        self.rig = Rig(self.dir, self.up.url)

    def tearDown(self):
        self.rig.stop()
        self.up.stop()
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_root_goes_to_speak(self):
        s, _, h = self.rig.req('GET', '/', origin=None)
        self.assertEqual(s, 302)
        self.assertEqual(h['location'], '/speak/')

    def test_page_comes_from_the_site(self):
        s, body, h = self.rig.req('GET', '/speak/', origin=None)
        self.assertEqual(s, 200)
        self.assertIn(b'<title>Speak</title>', body)
        self.assertTrue(h['content-type'].startswith('text/html'))
        s, body, h = self.rig.req('GET', '/speak.js?v=abc123', origin=None)
        self.assertEqual(s, 200)
        self.assertEqual(h['content-type'], 'application/javascript')

    def test_kept_copy_is_served_when_the_site_is_unreachable(self):
        self.assertEqual(self.rig.req('GET', '/speak/', origin=None)[0], 200)
        self.up.stop()
        s, body, _ = self.rig.req('GET', '/speak/', origin=None)
        self.assertEqual(s, 200)
        self.assertIn(b'<title>Speak</title>', body)

    def test_nothing_kept_and_no_site_is_a_502(self):
        self.up.stop()
        self.assertEqual(self.rig.req('GET', '/speak.js', origin=None)[0], 502)

    def test_site_404_is_404(self):
        self.assertEqual(self.rig.req('GET', '/nope/', origin=None)[0], 404)

    def test_paths_that_climb_are_refused(self):
        self.assertEqual(self.rig.req('GET', '/a/../b', origin=None)[0], 404)

    def test_api_is_not_shadowed_by_the_site(self):
        s, b, _ = self.rig.req('GET', '/health', origin=None)
        self.assertTrue(b['ok'])

    def test_site_is_get_only(self):
        self.assertEqual(self.rig.req('POST', '/speak/', {'x': 1})[0], 404)

    def test_same_origin_page_may_use_the_api(self):
        for o in ('http://localhost:4777', 'http://127.0.0.1:4777'):
            s, _, h = self.rig.req('GET', '/health', origin=o)
            self.assertEqual(s, 200)
            self.assertEqual(h['access-control-allow-origin'], o)

    def test_foreign_host_cannot_read_the_site_either(self):
        self.assertEqual(self.rig.req('GET', '/speak/', host='attacker.example:4777', origin=None)[0], 403)


class TReview(unittest.TestCase):
    """review_pack lays the takes out for a reader: pauses marked in line, no scoring."""

    def setUp(self):
        import review_pack
        self.rp = review_pack
        self.dir = tempfile.mkdtemp(prefix='speakd-review-')

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def words(self, spec):
        return [{'w': w, 's': s, 'e': e} for w, s, e in spec]

    def test_pauses_are_marked_inline(self):
        text, gaps = self.rp.marked(self.words([('so', 1.0, 1.3), ('the', 1.4, 1.6), ('thing', 3.3, 3.7)]))
        self.assertEqual(text, 'so the [1.7s] thing')
        self.assertEqual(gaps, [1.7])

    def test_short_gaps_are_not_marked(self):
        text, gaps = self.rp.marked(self.words([('a', 0, 0.3), ('b', 0.8, 1.1)]))
        self.assertEqual(text, 'a b')
        self.assertEqual(gaps, [])

    def test_one_take_has_facts_and_transcript_but_no_verdict(self):
        t = {'at': 1792568643840, 'mode': 'topic', 'topic': 'Explain money.', 'status': 'done', 'sec': 30,
             'words': self.words([('Um,', 1.0, 1.3), ('money', 3.0, 3.4), ('is', 3.5, 3.6), ('a', 3.7, 3.8), ('tool', 3.9, 4.2)])}
        out = self.rp.one(t)
        self.assertIn('Explain money.', out)
        self.assertIn('5 words', out)
        self.assertIn('10 words/min', out)
        self.assertIn('first word at 1.0 s', out)
        self.assertIn('1 um/uh/er', out)
        self.assertIn('1 pauses', out)
        self.assertIn('Um, [1.7s] money is a tool', out)
        for bad in ('score', 'good job', 'great', 'poor'):
            self.assertNotIn(bad, out.lower())

    def test_take_not_ready_says_so(self):
        out = self.rp.one({'at': 1792568643840, 'mode': 'free', 'status': 'error', 'error': 'no audio arrived', 'words': []})
        self.assertIn('free talk', out)
        self.assertIn('error', out)
        self.assertIn('no audio arrived', out)

    def test_load_reads_days_and_skips_broken_files(self):
        (Path(self.dir) / 'takes').mkdir()
        (Path(self.dir) / 'takes' / '2026-10-20.json').write_text(json.dumps({'v': 1, 'takes': [{'id': 'a', 'at': 2, 'day': '2026-10-20'}]}), encoding='utf-8')
        (Path(self.dir) / 'takes' / '2026-10-21.json').write_text('{ broken', encoding='utf-8')
        (Path(self.dir) / 'takes' / '2026-10-22.json').write_text(json.dumps({'v': 1, 'takes': [{'id': 'b', 'at': 3, 'day': '2026-10-22'}]}), encoding='utf-8')
        self.assertEqual([t['id'] for t in self.rp.load(self.dir)], ['a', 'b'])
        self.assertEqual([t['id'] for t in self.rp.load(self.dir, since='2026-10-22')], ['b'])
        self.assertEqual([t['id'] for t in self.rp.load(self.dir, day='2026-10-20')], ['a'])



class TWhisperGuard(unittest.TestCase):
    """What the real Whisper is allowed to hand back: nothing made up over silence or noise."""

    def seg(self, text, nsp=0.0, words=None):
        from types import SimpleNamespace as NS
        return NS(text=text, no_speech_prob=nsp, words=words or [], start=0.0)

    def test_the_hint_repeated_over_non_speech_is_dropped(self):
        echo = 'Okay, so, uh, let me explain.'
        self.assertFalse(speakd.keep_segment(self.seg(echo, 0.65)))
        self.assertFalse(speakd.keep_segment(self.seg('Umm, so, uh, basically I was like, you know, thinking about it.', 0.5)))

    def test_the_same_words_said_for_real_are_kept(self):
        self.assertTrue(speakd.keep_segment(self.seg('Okay, so, uh, let me explain.', 0.0)))
        self.assertTrue(speakd.keep_segment(self.seg('Okay, so, uh, let me explain.', 0.1)))

    def test_stock_phrases_over_noise_are_dropped(self):
        self.assertFalse(speakd.keep_segment(self.seg('Thanks for watching!', 0.5)))
        self.assertFalse(speakd.keep_segment(self.seg('Thank you very much.', 0.9)))
        self.assertTrue(speakd.keep_segment(self.seg('Thank you very much.', 0.0)))   # said by a person

    def test_whisper_own_call_of_no_speech_wins(self):
        self.assertFalse(speakd.keep_segment(self.seg('I went to the market and bought rice', 0.9)))
        self.assertTrue(speakd.keep_segment(self.seg('I went to the market and bought rice', 0.1)))

    def test_empty_text_is_dropped(self):
        self.assertFalse(speakd.keep_segment(self.seg('  ', 0.0)))
        self.assertFalse(speakd.keep_segment(self.seg('...', 0.0)))

    def test_transcribe_asks_for_voice_detection_and_joins_parts(self):
        from types import SimpleNamespace as NS
        calls = []

        class Model:
            def transcribe(self, path, **kw):
                calls.append(kw)
                n = len(calls)
                w = NS(word='hello', start=1.0, end=1.4)
                segs = [NS(text=' hello', no_speech_prob=0.0, words=[w], start=1.0),
                        NS(text=' Thanks for watching!', no_speech_prob=0.9, words=[NS(word='Thanks', start=5.0, end=5.5)], start=5.0)]
                return iter(segs), NS(language='en', duration=10.0)

        w = speakd.Whisper(self.id())
        w.model = Model()
        res = w.transcribe(['a.webm', 'b.webm'])
        self.assertEqual([x['w'] for x in res['words']], ['hello', 'hello'])
        self.assertEqual([x['s'] for x in res['words']], [1.0, 11.0])   # the second part is shifted by the first
        self.assertEqual(res['text'], 'hello hello')
        for kw in calls:
            self.assertTrue(kw['vad_filter'])
            self.assertEqual(kw['vad_parameters']['threshold'], 0.35)
            self.assertEqual(kw['language'], 'en')
            self.assertTrue(kw['word_timestamps'])
            self.assertFalse(kw['condition_on_previous_text'])
            self.assertEqual(kw['initial_prompt'], speakd.PROMPT)


class TLog(unittest.TestCase):
    """The log keeps every write and every failure, so a take that did not arrive can be traced."""

    def test_writes_and_failures_are_logged(self):
        d = tempfile.mkdtemp(prefix='speakd-log-')
        lines = []
        try:
            store = speakd.Store(d)
            worker = speakd.Worker(store, speakd.FakeWhisper(), lambda m: None)
            worker.start()
            srv = speakd.ThreadingHTTPServer(('127.0.0.1', 0), speakd.make_handler(store, worker, speakd.FakeWhisper(), lines.append, 'http://127.0.0.1:1'))
            port = srv.server_address[1]
            threading.Thread(target=srv.serve_forever, daemon=True).start()

            def req(method, path, body=None, origin=ORIGIN):
                c = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
                h = {'Origin': origin}
                c.request(method, path, body=body, headers=h)
                r = c.getresponse(); r.read(); c.close(); return r.status
            req('GET', '/health')
            req('POST', '/audio?id=logtest1&day=2026-10-21&n=0', b'WEBM')
            req('GET', '/takes', origin='https://evil.example')
            srv.shutdown(); srv.server_close()
        finally:
            shutil.rmtree(d, ignore_errors=True)
        joined = ' | '.join(lines)
        self.assertIn('POST /audio -> 200', joined)
        self.assertIn('GET /takes -> 403', joined)
        self.assertIn('https://evil.example', joined)
        self.assertNotIn('/health', joined)



def run_git(cwd, *args):
    env = dict(os.environ, GIT_TERMINAL_PROMPT='0', LC_ALL='C')
    return subprocess.run(['git', *args], cwd=str(cwd), check=True, capture_output=True, text=True, encoding='utf-8', env=env)


class TInbox(unittest.TestCase):
    """The drop box: recordings from another device arrive through a private git repo, the words go back.
    A local bare repository stands in for the GitHub one; `tablet` is another device's clone of it."""

    DAY = '2026-10-24'

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='speakd-inbox-'))
        self.remote = self.root / 'remote.git'
        run_git(self.root, 'init', '-q', '--bare', '-b', 'main', str(self.remote))
        self.tablet = self.root / 'tablet'
        run_git(self.root, 'clone', '-q', str(self.remote), str(self.tablet))
        run_git(self.tablet, 'config', 'user.name', 'Tablet')
        run_git(self.tablet, 'config', 'user.email', 'tablet@example.test')
        run_git(self.tablet, 'checkout', '-q', '-B', 'main')
        self.store = speakd.Store(self.root / 'data')
        self.worker = speakd.Worker(self.store, speakd.FakeWhisper(), lambda m: None)
        self.worker.start()
        self.logs = []
        self.inbox = speakd.Inbox(self.store, self.worker, self.logs.append, str(self.remote), self.root / 'pc', interval=1)

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def remote_has_commits(self):
        p = subprocess.run(['git', 'rev-parse', '--verify', '-q', 'main'], cwd=str(self.remote), capture_output=True)
        return p.returncode == 0

    # what the Speak page does on the tablet
    def tablet_push(self, msg='tablet'):
        run_git(self.tablet, 'add', '-A')
        run_git(self.tablet, 'commit', '-q', '-m', msg)
        if self.remote_has_commits():
            run_git(self.tablet, 'pull', '-q', '--rebase', 'origin', 'main')
        run_git(self.tablet, 'push', '-q', 'origin', 'HEAD:main')

    def upload_audio(self, tid, day=None, parts=1):
        d = self.tablet / 'inbox' / (day or self.DAY)
        d.mkdir(parents=True, exist_ok=True)
        for n in range(parts):
            (d / ('%s_%d.webm' % (tid, n))).write_bytes(b'WEBM' * 50)

    def upload_meta(self, tid, day=None, parts=1, **extra):
        day = day or self.DAY
        meta = dict(id=tid, day=day, at=1792800000000, mode='topic', topic='Explain money.', cat='explain', target=60, think=30, sec=58, parts=parts)
        meta.update(extra)
        d = self.tablet / 'inbox' / day
        d.mkdir(parents=True, exist_ok=True)
        (d / (tid + '.json')).write_text(json.dumps(meta), encoding='utf-8')

    def upload(self, tid, **kw):
        self.upload_audio(tid, kw.get('day'), kw.get('parts', 1))
        self.upload_meta(tid, **kw)
        self.tablet_push('upload ' + tid)

    def wait_done(self, tid, secs=8):
        end = time.time() + secs
        while time.time() < end:
            t = self.store.get(tid)
            if t and t.get('status') in ('done', 'error'):
                return t
            time.sleep(0.05)
        raise AssertionError('take %s did not finish' % tid)

    def fresh_clone(self):
        d = self.root / ('check-%d' % time.time_ns())
        run_git(self.root, 'clone', '-q', str(self.remote), str(d))
        return d

    def done_file(self, clone, tid):
        return clone / 'done' / ('%s_%s.json' % (self.DAY, tid))

    def test_recording_is_imported_transcribed_and_returned(self):
        self.upload('tab00001')
        self.inbox.cycle()
        t = self.store.get('tab00001')
        self.assertIsNotNone(t)
        self.assertEqual(t['origin'], 'drop box')
        self.assertEqual(t['topic'], 'Explain money.')
        self.assertTrue(self.store.audio_path(self.DAY, 'tab00001', 0).exists())
        self.assertEqual(self.wait_done('tab00001')['status'], 'done')
        self.inbox.cycle()   # the words go back, the audio leaves the repo's tip
        c = self.fresh_clone()
        doc = json.loads(self.done_file(c, 'tab00001').read_text(encoding='utf-8'))
        self.assertEqual(doc['status'], 'done')
        self.assertEqual(doc['words'][0]['w'], 'um')
        box = c / 'inbox' / self.DAY
        self.assertEqual(list(box.glob('tab00001*')) if box.exists() else [], [])

    def test_a_take_with_two_parts(self):
        self.upload('tab00002', parts=2)
        self.inbox.cycle()
        self.assertEqual(self.store.get('tab00002')['parts'], 2)
        self.assertTrue(self.store.audio_path(self.DAY, 'tab00002', 1).exists())

    def test_nothing_is_taken_until_the_details_arrive(self):
        self.upload_audio('tab00003')
        self.tablet_push('audio only')
        self.inbox.cycle()
        self.assertIsNone(self.store.get('tab00003'))
        self.upload_meta('tab00003')
        self.tablet_push('details')
        self.inbox.cycle()
        self.assertIsNotNone(self.store.get('tab00003'))

    def test_a_take_with_a_missing_part_waits(self):
        self.upload_audio('tab00004', parts=1)
        self.upload_meta('tab00004', parts=2)
        self.tablet_push('half')
        self.inbox.cycle()
        self.assertIsNone(self.store.get('tab00004'))
        self.upload_audio('tab00004', parts=2)
        self.tablet_push('rest')
        self.inbox.cycle()
        self.assertIsNotNone(self.store.get('tab00004'))

    def test_the_same_take_is_not_taken_in_twice(self):
        self.upload('tab00005')
        self.inbox.cycle()
        self.wait_done('tab00005')
        self.inbox.cycle()
        self.inbox.cycle()
        self.assertEqual(len(self.store.takes()), 1)
        self.assertEqual(self.store.get('tab00005')['words'][0]['w'], 'um')

    def test_takes_recorded_on_the_pc_go_to_the_repo_too(self):
        self.store.put({'id': 'pc000001', 'day': self.DAY, 'at': 5, 'mod': 5, 'parts': 0, 'text': 'typed', 'status': 'done', 'words': [{'w': 'hi', 's': 0.1, 'e': 0.3}]})
        self.inbox.cycle()
        self.assertTrue(self.done_file(self.fresh_clone(), 'pc000001').exists())

    def test_a_take_that_failed_is_returned_with_its_error(self):
        self.upload_meta('tab00006', parts=0)
        self.tablet_push('no audio')
        self.inbox.cycle()
        self.inbox.cycle()
        doc = json.loads(self.done_file(self.fresh_clone(), 'tab00006').read_text(encoding='utf-8'))
        self.assertEqual(doc['status'], 'error')

    def test_coaching_goes_to_the_repo_and_updates(self):
        (self.store.root / 'coaching' / '2026-10-24.md').write_text('## Today\nGood. मैं', encoding='utf-8')
        self.inbox.cycle()
        self.assertIn('मैं', (self.fresh_clone() / 'coaching' / '2026-10-24.md').read_text(encoding='utf-8'))
        (self.store.root / 'coaching' / '2026-10-24.md').write_text('## Today\nBetter.', encoding='utf-8')
        self.inbox.cycle()
        self.assertEqual((self.fresh_clone() / 'coaching' / '2026-10-24.md').read_text(encoding='utf-8'), '## Today\nBetter.')

    def test_a_device_can_ask_for_a_take_to_be_deleted(self):
        self.upload('tab00007')
        self.inbox.cycle()
        self.wait_done('tab00007')
        self.inbox.cycle()
        d = self.tablet / 'inbox' / 'delete'
        d.mkdir(parents=True, exist_ok=True)
        (d / 'tab00007.json').write_text('{}', encoding='utf-8')
        self.tablet_push('delete')
        self.inbox.cycle()
        self.assertIsNone(self.store.get('tab00007'))
        self.assertFalse(self.store.audio_path(self.DAY, 'tab00007', 0).exists())
        c = self.fresh_clone()
        self.assertFalse(self.done_file(c, 'tab00007').exists())
        self.assertFalse((c / 'inbox' / 'delete' / 'tab00007.json').exists())
        # uploading the same id again does not bring it back
        self.upload('tab00007')
        self.inbox.cycle()
        self.assertIsNone(self.store.get('tab00007'))

    def test_a_take_deleted_on_the_pc_leaves_the_repo(self):
        self.store.put({'id': 'pc000002', 'day': self.DAY, 'at': 5, 'mod': 5, 'parts': 0, 'text': 'x', 'status': 'done'})
        self.inbox.cycle()
        self.assertTrue(self.done_file(self.fresh_clone(), 'pc000002').exists())
        self.store.delete('pc000002')
        self.inbox.cycle()
        self.assertFalse(self.done_file(self.fresh_clone(), 'pc000002').exists())

    def test_losing_the_local_folder_never_deletes_anything_in_the_repo(self):
        self.store.put({'id': 'pc000003', 'day': self.DAY, 'at': 5, 'mod': 5, 'parts': 0, 'text': 'x', 'status': 'done'})
        self.inbox.cycle()
        # the data folder is wiped (disk trouble): no take, and no record of any deletion
        shutil.rmtree(self.store.root / 'takes')
        (self.store.root / 'takes').mkdir()
        self.store.index.clear()
        self.inbox.cycle()
        self.assertTrue(self.done_file(self.fresh_clone(), 'pc000003').exists())

    def test_garbage_in_the_inbox_is_ignored(self):
        d = self.tablet / 'inbox' / self.DAY
        d.mkdir(parents=True, exist_ok=True)
        (d / 'broken1.json').write_text('{ nope', encoding='utf-8')
        (d / 'zzzz.json').write_text(json.dumps({'id': '../evil', 'day': self.DAY, 'parts': 0}), encoding='utf-8')
        (d / 'wrongday.json').write_text(json.dumps({'id': 'wrongday', 'day': '2026-01-01', 'parts': 0}), encoding='utf-8')
        (d / 'huge001.json').write_text(json.dumps({'id': 'huge001', 'day': self.DAY, 'parts': 9999}), encoding='utf-8')
        self.tablet_push('junk')
        self.inbox.cycle()
        self.assertEqual(self.store.takes(), [])
        self.assertTrue(any('could not read broken1.json' in l for l in self.logs))

    def test_a_push_that_loses_a_race_is_retried(self):
        self.upload('tab00008')
        outer = self

        class Racy(speakd.Inbox):
            raced = False

            def export(self):
                if not Racy.raced:   # a device pushes just before this helper does
                    Racy.raced = True
                    (outer.tablet / 'note.txt').write_text('from the tablet', encoding='utf-8')
                    outer.tablet_push('race')
                return super().export()

        self.inbox = Racy(self.store, self.worker, self.logs.append, str(self.remote), self.root / 'pc', interval=1)
        self.inbox.cycle()
        self.wait_done('tab00008')
        self.inbox.cycle()
        c = self.fresh_clone()
        self.assertTrue((c / 'note.txt').exists())
        self.assertTrue(self.done_file(c, 'tab00008').exists())

    def test_an_unreachable_repo_is_an_error_not_a_crash_and_it_recovers(self):
        missing = self.root / 'later.git'
        box = speakd.Inbox(self.store, self.worker, self.logs.append, str(missing), self.root / 'pc2', interval=1)
        with self.assertRaises(RuntimeError):
            box.cycle()
        run_git(self.root, 'init', '-q', '--bare', '-b', 'main', str(missing))
        box.cycle()   # now it exists
        self.assertEqual(box.status['last_error'], '')

    def test_the_loop_survives_errors_and_records_them(self):
        box = speakd.Inbox(self.store, self.worker, self.logs.append, str(self.root / 'nowhere.git'), self.root / 'pc3', interval=1)
        box.start()
        end = time.time() + 8
        while time.time() < end and not box.status['last_error']:
            time.sleep(0.1)
        box.stop.set()
        self.assertIn('git clone failed', box.status['last_error'])
        self.assertTrue(any('drop box:' in l for l in self.logs))

    def test_health_reports_the_drop_box(self):
        srv = speakd.ThreadingHTTPServer(('127.0.0.1', 0), speakd.make_handler(self.store, self.worker, speakd.FakeWhisper(), lambda m: None, 'http://127.0.0.1:1', self.inbox))
        port = srv.server_address[1]
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            c = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
            c.request('GET', '/health')
            d = json.loads(c.getresponse().read().decode())
            self.assertTrue(d['dropbox']['configured'])
            self.assertIn('last_error', d['dropbox'])
        finally:
            srv.shutdown()
            srv.server_close()


if __name__ == '__main__':
    unittest.main(verbosity=1)
