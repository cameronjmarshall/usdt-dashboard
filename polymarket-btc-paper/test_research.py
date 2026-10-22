import base64
from contextlib import closing
import gzip
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from app import make_handler
from engine import Book, DEFAULTS, Engine
from research import parameters, run_replay
from services import backup, initialize
from test_engine import books


class ReplayTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = str(Path(self.temp.name)/'live.sqlite')
        self.engine = Engine(self.path)
        initialize(self.path)

    def tearDown(self):
        self.engine.db.close()
        self.temp.cleanup()

    def record(self, minimum=0, reset=False, settlement=1301):
        e = self.engine
        for slug, start in [('a',1000),('b',1300),('c',1600)]:
            e.add_market(slug,start,{})
            for offset in (1,2,30,31,299):
                at = start+offset
                if reset and offset == 2:
                    e.event(at-.1,'feed_reset','test')
                    e.pending.clear()
                sample = books(at,.35 if offset<=2 else .5)
                sample = {k:Book(v.at,v.source_at,v.bids,v.asks,minimum) for k,v in sample.items()}
                e.observe(slug,sample,at)
        e.settle('a',settlement,'Up')
        e.settle('b',1601,'Down')
        e.settle('c',1901,'Up')

    def test_replay_uses_same_fill_engine_and_does_not_change_live_ledger(self):
        self.record()
        before = [tuple(r) for r in self.engine.db.execute('SELECT * FROM trades')]
        result = run_replay(self.path,dict(end=1902))
        self.assertEqual(result['training']['markets'],2)
        self.assertEqual(result['holdout']['markets'],1)
        self.assertEqual(result['training']['bots'][0]['entries'],2)
        self.assertEqual(result['training']['bots'][0]['closed'],1)
        self.assertEqual(result['training']['unresolved'],1)
        actual = self.engine.db.execute("SELECT pnl FROM trades WHERE slug='a' AND bot=1").fetchone()[0]
        self.assertAlmostEqual(result['training']['bots'][0]['realised'],actual)
        self.assertEqual(result['holdout']['bots'][0]['closed'],1)
        after = [tuple(r) for r in self.engine.db.execute('SELECT * FROM trades')]
        self.assertEqual(before,after)

    def test_resolution_after_period_does_not_release_cash(self):
        self.record(settlement=1800)
        r = run_replay(self.path,dict(end=1902))
        self.assertEqual(r['training']['bots'][0]['closed'],0)
        self.assertGreater(r['training']['bots'][0]['reserved'],19)

    def test_minimum_share_size_is_replayed(self):
        self.record(minimum=100)
        r = run_replay(self.path,dict(end=1902))
        self.assertTrue(all(b['entries']==0 for b in r['training']['bots']))

    def test_feed_reset_breaks_confirmation(self):
        self.record(reset=True)
        r = run_replay(self.path,dict(end=1902))
        self.assertEqual(r['training']['bots'][0]['entries'],0)

    def test_unknown_legacy_sizes_rejected_instead_of_assumed(self):
        self.record()
        with self.engine.db:
            self.engine.db.execute('UPDATE observations SET min_size=NULL')
        with self.assertRaisesRegex(ValueError,'older books'):
            run_replay(self.path,dict(end=1902))

    def test_partial_markets_excluded(self):
        self.record()
        with self.assertRaisesRegex(ValueError,'two completed'):
            run_replay(self.path,dict(start=1001,end=1899))

    def test_missing_pair_resets_confirmation(self):
        self.record()
        with self.engine.db:
            self.engine.db.execute("DELETE FROM observations WHERE side='Down' AND at=1002")
        r=run_replay(self.path,dict(end=1902))
        self.assertEqual(r['training']['skipped'],1)
        self.assertEqual(r['training']['bots'][0]['entries'],1)

    def test_gaps_are_reported(self):
        self.record()
        r=run_replay(self.path,dict(end=1902))
        self.assertGreater(r['training']['gaps_over_5s'],0)

    def test_empty_and_oversized_datasets(self):
        with self.assertRaisesRegex(ValueError,'No recorded'):
            run_replay(self.path,{})
        self.record()
        with patch('research.MAX_SNAPSHOTS',1), self.assertRaisesRegex(ValueError,'shorter'):
            run_replay(self.path,{})

    def test_backups_include_wal_and_are_restorable(self):
        self.record()
        archive=backup(self.path)
        restored=Path(self.temp.name)/'restored.sqlite'
        with gzip.open(archive,'rb') as source:
            restored.write_bytes(source.read())
        with closing(sqlite3.connect(restored)) as db:
            self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0],'ok')
            self.assertEqual(db.execute('SELECT COUNT(*) FROM observations').fetchone()[0],30)
        self.assertFalse(list(archive.parent.glob('*.tmp')))

    def test_invalid_parameters(self):
        for data in ({'stake':float('nan')},{'start':float('inf')},{'reentry':'yes'},
                     {'candidate':{'id':4,'name':'x','target':.6,'windows':[[0,200,.3],[150,250,.4]]}}):
            with self.assertRaises(ValueError): parameters(data)


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.path=str(Path(self.temp.name)/'db.sqlite')
        Engine(self.path).db.close()
        initialize(self.path)
        self.password='test-password-with-at-least-24-characters'
        self.server=ThreadingHTTPServer(('127.0.0.1',0),make_handler(self.path,DEFAULTS,self.password,'https://lab.example'))
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.url=f'http://127.0.0.1:{self.server.server_port}'

    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.thread.join();self.temp.cleanup()

    def request(self,route,auth=True,body=None,origin='https://lab.example'):
        headers={}
        if auth:headers['Authorization']='Basic '+base64.b64encode(('cameron:'+self.password).encode()).decode()
        if body is not None:
            headers.update({'Host':'lab.example','Origin':origin,'X-Paper-Lab':'1','Content-Type':'application/json'})
        return urlopen(Request(self.url+route,data=json.dumps(body).encode() if body is not None else None,headers=headers),timeout=5)

    def test_all_data_routes_require_login(self):
        for route in ('/','/api/state','/api/research','/trades.csv','/observations.csv','/backup.sqlite.gz'):
            with self.assertRaises(HTTPError) as caught:self.request(route,auth=False)
            self.assertEqual(caught.exception.code,401)
        with self.request('/healthz',auth=False) as response:self.assertEqual(response.status,200)

    def test_authenticated_state_and_research(self):
        for route in ('/api/state','/api/research'):
            with self.request(route) as response:
                text=response.read().decode();self.assertNotIn(self.password,text);json.loads(text)

    def test_backtest_request_persists_result_and_restart_state(self):
        e=Engine(self.path)
        for start in (1000,1300,1600):
            slug=str(start);e.add_market(slug,start,{})
            e.observe(slug,books(start+1),start+1)
            e.observe(slug,books(start+2),start+2)
            e.settle(slug,start+300,'Up')
        e.db.close()
        with self.request('/api/backtest',body={'end':1901}) as response:
            self.assertEqual(response.status,202)
            job_id=json.load(response)['id']
        deadline=time.monotonic()+5
        while time.monotonic()<deadline:
            with self.request('/api/research') as response:
                run=json.load(response)['runs'][0]
            if run['status']!='running':break
            time.sleep(.02)
        self.assertEqual(run['id'],job_id)
        self.assertEqual(run['status'],'complete',run)
        initialize(self.path)
        with self.request('/api/research') as response:
            saved=json.load(response)['runs'][0]
        self.assertEqual(saved['result'],run['result'])

    def test_remote_pause_and_csrf_guard(self):
        with self.request('/api/pause',body={'paused':True}) as response:self.assertEqual(response.status,200)
        with self.assertRaises(HTTPError) as caught:
            self.request('/api/pause',body={'paused':False},origin='https://evil.example')
        self.assertEqual(caught.exception.code,403)
        with closing(sqlite3.connect(self.path)) as db:self.assertEqual(db.execute('SELECT paused FROM controls').fetchone()[0],1)


if __name__=='__main__':unittest.main()
