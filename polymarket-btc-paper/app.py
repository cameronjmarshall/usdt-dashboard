"""Public REST collector and loopback dashboard; Python standard library only."""
import argparse
import csv
import io
import json
import logging
from pathlib import Path
import sqlite3
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, urlopen
from concurrent.futures import ThreadPoolExecutor
from engine import Engine, CONFIG

ROOT = Path(__file__).resolve().parent
STATUS = {'message':'Starting collector', 'updated':None, 'slug':None}
STOP = threading.Event()

def get(url):
    with urlopen(Request(url,headers={'User-Agent':'BTC-Rebound-Paper/1.0','Cache-Control':'no-cache'}),timeout=8) as response:
        return json.load(response)

def array(value):
    return json.loads(value) if isinstance(value,str) else value

def discover(start):
    slug = f'btc-updown-5m-{start}'
    m = get('https://gamma-api.polymarket.com/markets/slug/'+slug)
    end = datetime.fromisoformat(m['endDate'].replace('Z','+00:00')).timestamp()
    sides, tokens = array(m['outcomes']), array(m['clobTokenIds'])
    if m['slug'] != slug or abs(end-start-300)>1 or set(sides)!={'Up','Down'} or len(tokens)!=2:
        raise ValueError('Market identity, duration or outcome schema changed; entries disabled')
    return m,dict(zip(sides,tokens))

def book(token):
    sent = time.time()
    b = get('https://clob.polymarket.com/book?token_id='+token)
    received = time.time()
    if received-sent > 3: raise ValueError('Slow order-book response skipped')
    bids = [(float(x['price']),float(x['size'])) for x in b['bids'] if float(x['size'])>0]
    asks = [(float(x['price']),float(x['size'])) for x in b['asks'] if float(x['size'])>0]
    if not bids or not asks: raise ValueError('Empty book')
    stamp=float(b['timestamp'])/1000
    if not -1 <= received-stamp <= 5: raise ValueError('Stale order-book snapshot skipped')
    bid=max(p for p,s in bids); ask=min(p for p,s in asks)
    return received,bid,ask,sum(s for p,s in bids if p==bid),sum(s for p,s in asks if p==ask)

def collector(path):
    engine = Engine(path)
    start_seen=None; market=None; tokens={}; last_settle=0
    with ThreadPoolExecutor(max_workers=2) as pool:
        while not STOP.is_set():
            try:
                start=int(time.time())//300*300
                if start != start_seen:
                    market,tokens=discover(start)
                    engine.add_market(market['slug'],start,market)
                    start_seen=start
                if market.get('acceptingOrders') is True and not market.get('closed'):
                    futures={side:pool.submit(book,token) for side,token in tokens.items()}
                    for side,future in futures.items():
                        try:
                            snapshot=future.result()
                            engine.observe(market['slug'],side,*snapshot)
                        except Exception as exc:
                            raise RuntimeError(f'{side} book: {exc}') from exc
                else: raise ValueError('Market is not accepting orders')
                STATUS.update(message='Collecting public order books',updated=time.time(),slug=market['slug'])
            except Exception as exc:
                engine.pending.clear()
                STATUS.update(message=str(exc))
                logging.warning('%s',exc)
                STOP.wait(3)
            if time.time()-last_settle > 30:
                last_settle=time.time()
                pending=engine.db.execute('SELECT t.slug,m.metadata FROM trades t JOIN markets m USING(slug) WHERE t.closed IS NULL AND m.start+300<=?',(time.time(),)).fetchall()
                for row in pending:
                    try:
                        m=get('https://gamma-api.polymarket.com/markets/slug/'+row['slug'])
                        prices=array(m.get('outcomePrices',[])); sides=array(m.get('outcomes',[]))
                        # Never infer settlement from a high quote or expiry alone.
                        if m.get('closed') is True and m.get('umaResolutionStatus')=='resolved' and len(prices)==2 and sorted(float(p) for p in prices)==[0.,1.]:
                            engine.settle(row['slug'],time.time(),sides[[float(p) for p in prices].index(1.)])
                    except Exception as exc: logging.warning('Settlement pending: %s',exc)
            STOP.wait(1)
    engine.db.close()

def make_handler(path):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            with sqlite3.connect(path) as db:
                db.row_factory=sqlite3.Row
                if self.path=='/api/state':
                    trades=[dict(r) for r in db.execute('SELECT * FROM trades ORDER BY entered DESC')]
                    slug=STATUS.get('slug')
                    observations=[dict(r) for r in db.execute('SELECT * FROM observations WHERE slug=? ORDER BY at',(slug,))]
                    finished=[t for t in trades if t['closed'] is not None]
                    payload=dict(status=STATUS.copy(),now=time.time(),config=CONFIG,trades=trades,observations=observations,
                      metrics=dict(entries=len(trades),closed=len(finished),pending=len(trades)-len(finished),
                      hits=sum(t['reason']=='target' for t in finished),pnl=sum(t['pnl'] for t in finished)))
                    body=json.dumps(payload,allow_nan=False).encode(); kind='application/json'
                elif self.path=='/trades.csv':
                    rows=db.execute('SELECT * FROM trades ORDER BY entered').fetchall()
                    out=io.StringIO(); writer=csv.writer(out)
                    writer.writerow([x[1] for x in db.execute('PRAGMA table_info(trades)')]);writer.writerows(rows)
                    body=out.getvalue().encode();kind='text/csv'
                elif self.path in ('/','/index.html'):
                    body=(ROOT/'index.html').read_bytes();kind='text/html; charset=utf-8'
                else:
                    self.send_error(404);return
            self.send_response(200);self.send_header('Content-Type',kind)
            self.send_header('Cache-Control','no-store');self.send_header('X-Content-Type-Options','nosniff')
            self.end_headers();self.wfile.write(body)
        def log_message(self,*args): pass
    return Handler

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db',default=str(ROOT/'paper.sqlite'))
    parser.add_argument('--port',type=int,default=8765)
    parser.add_argument('--offline',action='store_true',help='View saved data without calling APIs')
    args=parser.parse_args()
    e=Engine(args.db);e.db.close()
    if not args.offline:
        threading.Thread(target=collector,args=(args.db,),daemon=True).start()
    else: STATUS['message']='Offline: viewing saved results'
    server=ThreadingHTTPServer(('127.0.0.1',args.port),make_handler(args.db))
    print(f'Paper dashboard: http://127.0.0.1:{args.port} — Ctrl+C to stop',flush=True)
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally: STOP.set();server.server_close()
