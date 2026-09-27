"""Local, paper-only Polymarket dashboard. Python 3.10+; no pip packages needed."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import csv
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import logging
from pathlib import Path
import sqlite3
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from engine import Book, DEFAULTS, Engine, snapshot

ROOT = Path(__file__).resolve().parent
STOP = threading.Event()
STATUS = {'message': 'Connecting to Polymarket', 'updated': None, 'slug': None,
          'connected': False, 'settlement_message': None, 'demo_now': None}
STATUS_LOCK = threading.Lock()


def status_update(**values):
    with STATUS_LOCK:
        STATUS.update(values)


def get(url):
    try:
        with urlopen(Request(url, headers={'User-Agent': 'Poly-Paper-Lab/2.0', 'Cache-Control': 'no-cache'}), timeout=8) as response:
            return json.load(response)
    except HTTPError as exc:
        raise RuntimeError(f'{urlsplit(url).hostname}: HTTP {exc.code}. Retrying; no paper fills while disconnected.') from exc
    except URLError as exc:
        raise RuntimeError(f'{urlsplit(url).hostname}: {exc.reason}. Check your network and Python certificates.') from exc


def array(value):
    result = json.loads(value) if isinstance(value, str) else value
    if not isinstance(result, list):
        raise ValueError('Expected an outcome array')
    return result


def validate_market(m, start):
    slug = f'btc-updown-5m-{start}'
    end = datetime.fromisoformat(m['endDate'].replace('Z', '+00:00')).timestamp()
    sides, tokens = array(m['outcomes']), array(m['clobTokenIds'])
    if (m['slug'] != slug or abs(end-start-300) > 1 or len(sides) != 2
            or set(sides) != {'Up', 'Down'} or len(tokens) != 2
            or len(set(tokens)) != 2 or not all(str(t).isdigit() for t in tokens)):
        raise ValueError('Market identity, duration or outcomes changed; collection paused for this market.')
    return dict(zip(sides, map(str, tokens)))


def fee_schedule(m):
    if m.get('feesEnabled') is False:
        return 0., 1., 'Gamma: fees disabled'
    schedule = m.get('feeSchedule')
    if isinstance(schedule, dict) and 'rate' in schedule and 'exponent' in schedule:
        return float(schedule['rate']), float(schedule['exponent']), 'Gamma market fee schedule'
    if m.get('conditionId'):
        try:
            info = get('https://clob.polymarket.com/clob-markets/' + m['conditionId'])
            detail = info.get('fd')
            if isinstance(detail, dict) and 'r' in detail and 'e' in detail:
                return float(detail['r']), float(detail['e']), 'CLOB market fee schedule'
        except (RuntimeError, ValueError, TypeError):
            pass
    return .07, 1., 'ASSUMED crypto schedule (market fee metadata unavailable)'


def parse_book(data, token, sent, received):
    if received-sent > 3:
        raise ValueError('Order-book response exceeded 3 seconds; snapshot skipped.')
    if str(data.get('asset_id')) != str(token):
        raise ValueError('Order book token does not match this market.')
    source = float(data['timestamp'])
    if source > 1e11:
        source /= 1000
    def levels(name):
        return tuple((float(v['price']), float(v['size'])) for v in data[name] if float(v['size']) > 0)
    result = Book(received, source, levels('bids'), levels('asks'), float(data.get('min_order_size') or 0))
    if not result.valid(received):
        raise ValueError('Stale, crossed or invalid order book; snapshot skipped.')
    return result


def book(token):
    sent = time.time()
    data = get('https://clob.polymarket.com/book?token_id=' + token)
    return parse_book(data, token, sent, time.time())


def official_winner(m, slug):
    # A high final quote or closed=true on its own is not resolution evidence.
    if m.get('slug') != slug or m.get('closed') is not True or m.get('umaResolutionStatus') != 'resolved':
        return None
    sides = array(m.get('outcomes', []))
    prices = [float(v) for v in array(m.get('outcomePrices', []))]
    if len(sides) == 2 and set(sides) == {'Up', 'Down'} and sorted(prices) == [0., 1.]:
        return sides[prices.index(1.)]
    return None


def collector(path, config):
    engine = Engine(path, config)
    start_seen = None
    market = None
    last_refresh = last_error = 0
    with ThreadPoolExecutor(max_workers=2) as pool:
        while not STOP.is_set():
            try:
                start = int(time.time())//300*300
                if start != start_seen or time.time()-last_refresh >= 30:
                    market = get('https://gamma-api.polymarket.com/markets/slug/' + f'btc-updown-5m-{start}')
                    tokens = validate_market(market, start)
                    if start != start_seen:
                        rate, exponent, source = fee_schedule(market)
                        engine.add_market(market['slug'], start, market, rate, exponent, source)
                        engine.pending.clear()
                        start_seen = start
                    last_refresh = time.time()
                    status_update(slug=market['slug'])
                if market.get('active') is not True or market.get('acceptingOrders') is not True or market.get('closed'):
                    raise ValueError('Current market is not accepting orders. Waiting for the next update.')
                futures = {side: pool.submit(book, token) for side, token in tokens.items()}
                books = {side: future.result() for side, future in futures.items()}
                now = time.time()
                if engine.observe(market['slug'], books, now):
                    status_update(message='Public order books connected', updated=now, connected=True, slug=market['slug'])
                else:
                    engine.pending.clear()
                    status_update(message='Snapshot expired or market rolled over; waiting for fresh books.', connected=False)
            except Exception as exc:
                engine.pending.clear()
                status_update(message=str(exc), connected=False)
                if time.time()-last_error > 30:
                    engine.event(time.time(), 'feed', str(exc))
                    logging.warning('%s', exc)
                    last_error = time.time()
                STOP.wait(2)
            STOP.wait(1)
    engine.db.close()


def settler(path, config):
    engine = Engine(path, config)
    while not STOP.is_set():
        rows = engine.db.execute('''SELECT DISTINCT m.slug FROM markets m JOIN trades t USING(slug)
            WHERE t.closed IS NULL AND m.start+300<=?''', (time.time(),)).fetchall()
        for row in rows:
            if STOP.is_set():
                break
            try:
                m = get('https://gamma-api.polymarket.com/markets/slug/' + row['slug'])
                winner = official_winner(m, row['slug'])
                if winner:
                    engine.settle(row['slug'], time.time(), winner, m)
                    status_update(settlement_message=None)
                else:
                    status_update(settlement_message='Expired positions are awaiting official resolution.')
            except Exception as exc:
                status_update(settlement_message='Resolution check pending: ' + str(exc))
        STOP.wait(15)
    engine.db.close()


def demo_collector(path, config, speed):
    """Deterministic synthetic price scenarios. Never combined with live results."""
    engine = Engine(path, config)
    last = engine.db.execute('SELECT MAX(start) FROM markets').fetchone()[0]
    start = max(int(time.time())//300*300, int(last)+300 if last else 0)
    # Finish any interrupted synthetic round using its predetermined demo outcome.
    for m in engine.db.execute('SELECT * FROM markets WHERE winner IS NULL').fetchall():
        winner = json.loads(m['metadata']).get('demo_winner')
        if winner:
            engine.settle(m['slug'], start, winner, {'synthetic': True})
    # Target exits, reversals, expiry losses and second-window entries are all exercised.
    scenarios = [
        ([(0,.52),(20,.34),(65,.74),(100,.32),(130,.88),(200,.55),(299,.97)], 'Up'),
        ([(0,.50),(25,.34),(100,.22),(200,.08),(299,.02)], 'Down'),
        ([(0,.50),(119,.49),(135,.43),(165,.64),(225,.81),(299,.97)], 'Up'),
        ([(0,.50),(20,.39),(70,.63),(110,.34),(175,.58),(240,.30),(299,.02)], 'Down'),
    ]
    cycle = 0
    while not STOP.is_set():
        points, winner = scenarios[cycle % len(scenarios)]
        slug = f'demo-btc-5m-{start}'
        engine.add_market(slug, start, {'question': 'Synthetic BTC five-minute market', 'demo_winner': winner}, source='Synthetic demo: 0.07 × p × (1−p)')
        status_update(slug=slug, connected=True, message=f'SYNTHETIC DEMO · {speed:g}× playback')
        for elapsed in range(300):
            if STOP.is_set():
                break
            lo, hi = next(((a,b) for a,b in zip(points, points[1:]) if a[0] <= elapsed <= b[0]), (points[-2],points[-1]))
            up = lo[1]+(hi[1]-lo[1])*(elapsed-lo[0])/(hi[0]-lo[0])
            at = start+elapsed
            def sample(mid):
                return Book(at, at, ((round(max(.001,mid-.005),4), 500.),), ((round(min(.999,mid+.005),4), 500.),))
            engine.observe(slug, {'Up': sample(up), 'Down': sample(1-up)}, at)
            status_update(updated=at, demo_now=at)
            STOP.wait(1/speed)
        if STOP.is_set():
            break
        engine.settle(slug, start+300, winner, {'synthetic': True, 'winner': winner})
        start += 300
        cycle += 1
    engine.db.close()


def make_handler(path, config):
    class Handler(BaseHTTPRequestHandler):
        def reply(self, body, kind='application/json', status=200, attachment=None):
            self.send_response(status)
            self.send_header('Content-Type', kind)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'")
            if attachment:
                self.send_header('Content-Disposition', f'attachment; filename="{attachment}"')
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def do_GET(self):
            route = urlsplit(self.path).path
            assets = {'/': ('index.html', 'text/html; charset=utf-8'), '/dashboard.js': ('dashboard.js', 'text/javascript; charset=utf-8'),
                      '/style.css': ('style.css', 'text/css; charset=utf-8')}
            if route in assets:
                name, kind = assets[route]
                self.reply((ROOT/name).read_bytes(), kind)
                return
            if route not in ('/api/state', '/trades.csv', '/observations.csv'):
                self.send_error(404)
                return
            db = sqlite3.connect(path, timeout=10)
            db.row_factory = sqlite3.Row
            try:
                if route == '/api/state':
                    with STATUS_LOCK:
                        status = STATUS.copy()
                    now = status['demo_now'] if status['demo_now'] is not None else time.time()
                    db.execute('BEGIN')
                    payload = snapshot(db, config, status, now)
                    db.rollback()
                    self.reply(json.dumps(payload, allow_nan=False).encode())
                else:
                    table = 'trades' if route == '/trades.csv' else 'observations'
                    # Stream a read snapshot to avoid loading an entire long experiment into RAM.
                    self.send_response(200)
                    self.send_header('Content-Type', 'text/csv; charset=utf-8')
                    self.send_header('Content-Disposition', f'attachment; filename="poly-{config["mode"]}-{table}.csv"')
                    self.send_header('Cache-Control', 'no-store')
                    self.end_headers()
                    cursor = db.execute(f'SELECT * FROM {table} ORDER BY id')
                    out = io.StringIO()
                    writer = csv.writer(out)
                    writer.writerow([c[0] for c in cursor.description])
                    for row in cursor:
                        writer.writerow(row)
                        if out.tell() >= 65536:
                            self.wfile.write(out.getvalue().encode())
                            out.seek(0); out.truncate(0)
                    self.wfile.write(out.getvalue().encode())
            finally:
                db.close()

        def do_POST(self):
            # Read-only public APIs; only this loopback control changes paper entry eligibility.
            if self.path != '/api/pause':
                self.send_error(404)
                return
            origin = self.headers.get('Origin')
            host = self.headers.get('Host')
            if origin and origin not in (f'http://127.0.0.1:{self.server.server_port}', f'http://localhost:{self.server.server_port}'):
                self.send_error(403)
                return
            if host not in (f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}') or self.headers.get('X-Paper-Lab') != '1':
                self.send_error(403)
                return
            if config.get('offline'):
                self.send_error(403)
                return
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= 256:
                    raise ValueError('Invalid request length')
                data = json.loads(self.rfile.read(size))
                if type(data.get('paused')) is not bool:
                    raise ValueError('paused must be a boolean')
                with sqlite3.connect(path, timeout=10) as db:
                    db.execute('UPDATE controls SET paused=? WHERE id=1', (int(data['paused']),))
                self.reply(json.dumps(data).encode())
            except (ValueError, TypeError):
                self.send_error(400)

        def log_message(self, *_):
            pass
    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--db', help='SQLite experiment file (default: bots-live.sqlite or bots-demo.sqlite)')
    parser.add_argument('--port', type=int, default=8765)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--demo', action='store_true', help='Synthetic scenarios in a separate database')
    mode.add_argument('--offline', action='store_true', help='View saved results without collecting or filling')
    parser.add_argument('--demo-speed', type=float, default=10.)
    parser.add_argument('--stake', type=float, help='Maximum dollars per entry, including simulated fees (default 10)')
    parser.add_argument('--bankroll', type=float, help='Starting paper dollars for EACH bot (default 1000)')
    parser.add_argument('--side', choices=('both', 'Up', 'Down'))
    parser.add_argument('--single-entry', action='store_true', help='Disable repeat entries per bot per market')
    args = parser.parse_args()
    if not 0 < args.demo_speed <= 100:
        parser.error('--demo-speed must be between 0 and 100')
    path = str(Path(args.db).expanduser().resolve()) if args.db else str(ROOT/('bots-demo.sqlite' if args.demo else 'bots-live.sqlite'))
    config = DEFAULTS.copy()
    if Path(path).exists():
        with sqlite3.connect(path) as db:
            exists = db.execute("SELECT name FROM sqlite_master WHERE name='settings'").fetchone()
            saved = db.execute('SELECT config FROM settings WHERE id=1').fetchone() if exists else None
        if saved:
            config = json.loads(saved[0])
            if config.get('version') != 2:
                parser.error('Older experiment format. Choose a new --db filename; your original results are preserved.')
    if not args.offline:
        config['mode'] = 'demo' if args.demo else 'live'
    for key in ('stake', 'bankroll', 'side'):
        if getattr(args, key) is not None:
            config[key] = getattr(args, key)
    if args.single_entry:
        config['reentry'] = False
    try:
        e = Engine(path, config)
        e.db.close()
    except (ValueError, sqlite3.Error) as exc:
        parser.error(str(exc))
    view_config = dict(config, offline=args.offline)
    server = ThreadingHTTPServer(('127.0.0.1', args.port), make_handler(path, view_config))
    workers = []
    if args.offline:
        status_update(message='Offline · saved results only', connected=False)
    else:
        jobs = [(demo_collector, (path, config, args.demo_speed))] if args.demo else [(collector, (path, config)), (settler, (path, config))]
        for target, values in jobs:
            worker = threading.Thread(target=target, args=values, daemon=True)
            worker.start()
            workers.append(worker)
    print(f'\nPoly Paper Lab: http://127.0.0.1:{args.port}\nMode: {"OFFLINE" if args.offline else config["mode"].upper()} | Database: {path}\nLeave this terminal running. Ctrl+C to stop.\n', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        STOP.set()
        server.server_close()
        for worker in workers:
            worker.join(timeout=10)


if __name__ == '__main__':
    main()
