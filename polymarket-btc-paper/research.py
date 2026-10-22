"""Chronological replay of recorded books. Never writes to the live trade ledger."""
from contextlib import closing
import copy
import heapq
import itertools
import json
from pathlib import Path
import sqlite3
import tempfile
import time

from engine import BOTS, Book, DEFAULTS, Engine, finite, snapshot, validate_bots

MAX_SNAPSHOTS = 100_000


def connect_readonly(path):
    db = sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro', uri=True, timeout=10)
    db.row_factory = sqlite3.Row
    return db


def parameters(data):
    if not isinstance(data, dict):
        raise ValueError('Expected an object of backtest settings.')
    candidate = data.get('candidate', dict(id=4, name='Candidate', target=.65, windows=[[0,150,.35]]))
    validate_bots([candidate])
    candidate = dict(candidate, id=4, name='Candidate', color='#79b7ff')
    stake, bankroll = data.get('stake', 10.), data.get('bankroll', 1000.)
    if not all(finite(v) and v > 0 for v in (stake, bankroll)) or stake > bankroll:
        raise ValueError('Stake must be positive and no larger than the starting balance.')
    side = data.get('side', 'both')
    if side not in ('both', 'Up', 'Down') or type(data.get('reentry', True)) is not bool:
        raise ValueError('Invalid outcome or re-entry setting.')
    for key in ('start', 'end'):
        if data.get(key) is not None and not finite(data[key]):
            raise ValueError('Dates must be finite Unix timestamps.')
    return dict(candidate=candidate, stake=stake, bankroll=bankroll, side=side,
                reentry=data.get('reentry', True), start=data.get('start'), end=data.get('end'))


def dataset(path):
    with closing(connect_readonly(path)) as db:
        stats = dict(db.execute('SELECT COUNT(*) rows, MIN(at) first, MAX(at) last FROM observations').fetchone())
        stats.update(dict(db.execute('SELECT COUNT(*) markets, SUM(winner IS NOT NULL) resolved FROM markets').fetchone()))
        stats['legacy_rows'] = db.execute('SELECT COUNT(*) FROM observations WHERE min_size IS NULL OR received_at IS NULL').fetchone()[0]
        stats['bytes'] = Path(path).stat().st_size
        return stats


def replay_segment(db, markets, start, end, params, mode):
    config = dict(DEFAULTS, mode=mode, stake=params['stake'], bankroll=params['bankroll'],
                  side=params['side'], reentry=params['reentry'], bots=copy.deepcopy(BOTS[:3])+[params['candidate']])
    with tempfile.TemporaryDirectory(prefix='poly-replay-') as directory:
        engine = Engine(str(Path(directory)/'replay.sqlite'), config)
        try:
            selected = {m['slug'] for m in markets}
            for m in markets:
                engine.add_market(m['slug'], m['start'], json.loads(m['metadata']),
                                  m['fee_rate'], m['fee_exponent'], m['fee_source'])
            rows = db.execute('SELECT * FROM observations WHERE at>=? AND at<? ORDER BY at,id', (start,end))
            def observations():
                for (at, slug), group in itertools.groupby(rows, key=lambda r:(r['at'],r['slug'])):
                    pair = list(group)
                    if slug in selected:
                        yield at, 2, ('book', slug, pair)
            resets = ((r['at'], 0, ('reset',)) for r in db.execute(
                "SELECT at FROM events WHERE at>=? AND at<? AND kind IN ('feed_reset','startup') ORDER BY at", (start,end)))
            resolutions = sorted((m['resolved_at'], 1, ('settle',m['slug'],m['winner']))
                for m in markets if m['winner'] and m['resolved_at'] is not None and m['start']+300 <= m['resolved_at'] < end)
            paired = skipped = gaps = 0
            previous = {}
            started = time.monotonic()
            for at, _, event in heapq.merge(observations(), resets, resolutions):
                if time.monotonic()-started > 180:
                    raise ValueError('Replay exceeded three minutes. Select a shorter date range.')
                if event[0] == 'reset':
                    engine.pending.clear()
                elif event[0] == 'settle':
                    engine.settle(event[1], at, event[2], {'replayed':True})
                else:
                    _, slug, pair = event
                    if len(pair) != 2 or {r['side'] for r in pair} != {'Up','Down'}:
                        skipped += 1
                        engine.pending.clear()
                        continue
                    if any(r['min_size'] is None or r['received_at'] is None for r in pair):
                        raise ValueError('This date range includes older books without minimum-size/receipt metadata. Choose dates recorded after this upgrade.')
                    books = {r['side']: Book(r['received_at'], r['source_at'], tuple(json.loads(r['bids'])),
                                            tuple(json.loads(r['asks'])), r['min_size']) for r in pair}
                    if slug in previous and at-previous[slug] > config['max_gap_seconds']:
                        gaps += 1
                    previous[slug] = at
                    if engine.observe(slug, books, at):
                        paired += 1
                    else:
                        skipped += 1
            report = snapshot(engine.db, config, {}, end)
            summaries = []
            for b in report['bots']:
                summaries.append({k:b[k] for k in ('bot','entries','closed','realised','wins','fees','cash',
                    'reserved','pending_settlements','return_pct','max_drawdown','curve')})
            return dict(start=start, end=end, markets=len(markets), snapshots=paired, skipped=skipped,
                        gaps_over_5s=gaps, assumed_fee_markets=sum('assum' in m['fee_source'].lower() for m in markets),
                        unresolved=sum(m['winner'] is None or m['resolved_at'] is None or m['resolved_at']>=end for m in markets),
                        bots=summaries)
        finally:
            engine.db.close()


def run_replay(path, data):
    params = parameters(data)
    with closing(connect_readonly(path)) as db:
        db.execute('BEGIN')  # One consistent source snapshot for both periods.
        config = json.loads(db.execute('SELECT config FROM settings WHERE id=1').fetchone()[0])
        bounds = db.execute('SELECT MIN(at),MAX(at) FROM observations').fetchone()
        if bounds[0] is None:
            raise ValueError('No recorded books yet. Collect at least two completed markets first.')
        start = params['start'] if params['start'] is not None else bounds[0]-300
        end = params['end'] if params['end'] is not None else bounds[1]+1
        if start >= end:
            raise ValueError('The end date must follow the start date.')
        count = db.execute('SELECT COUNT(*) FROM observations WHERE at>=? AND at<?', (start,end)).fetchone()[0]
        if count > MAX_SNAPSHOTS*2:
            raise ValueError('Select a shorter date range (maximum 100,000 paired snapshots per run).')
        markets = db.execute('''SELECT * FROM markets m WHERE start>=? AND start+300<=?
            AND EXISTS(SELECT 1 FROM observations o WHERE o.slug=m.slug) ORDER BY start''', (start,end)).fetchall()
        if len(markets) < 2:
            raise ValueError('At least two completed, observed markets are needed for a chronological split.')
        split_index = max(1, min(len(markets)-1, int(len(markets)*.7)))
        split = markets[split_index]['start']
        training = replay_segment(db, markets[:split_index], start, split, params, config['mode'])
        holdout = replay_segment(db, markets[split_index:], split, end, params, config['mode'])
        return dict(parameters=params, mode=config['mode'], split=split, training=training, holdout=holdout,
                    method='Chronological 70/30 split by market count. Fresh independent balances in each period. '
                    'Recorded taker depth and fees, with original confirmation rules. No interpolation across missing data. '
                    'Only resolutions known before each period ends release stakes. Drawdown uses closed trades. '
                    'Repeatedly tuning against the holdout makes it development data; validate again on future markets.')
