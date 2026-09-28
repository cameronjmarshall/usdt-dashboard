"""Deterministic three-bot paper engine. No credentials or order submission."""
from dataclasses import dataclass
import json
import math
import sqlite3
import time

BOTS = [
    dict(id=1, name='Bot 1', target=.70, windows=[(0, 150, .35)], color='#58d5b0'),
    dict(id=2, name='Bot 2', target=.85, windows=[(0, 150, .35)], color='#a793f5'),
    dict(id=3, name='Bot 3', target=.60, windows=[(0, 120, .40), (120, 180, .45)], color='#f5bb6c'),
]
DEFAULTS = dict(version=3, position_scope='market', stake=10., bankroll=1000., side='both', reentry=True,
                confirmation_seconds=1., max_gap_seconds=5., max_age_seconds=5., mode='live')


def upgrade_config(config):
    """Retain experiment sizing when upgrading the former global position cap."""
    if config.get('version') == 2:
        return dict(config, version=3, position_scope='market')
    return dict(config)


def entry_limit(bot, elapsed):
    return next((price for lo, hi, price in bot['windows'] if lo <= elapsed < hi), None)


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def fee(shares, price, rate, exponent=1.):
    return round(shares * rate * (price * (1-price)) ** exponent, 5)


@dataclass(frozen=True)
class Book:
    at: float
    source_at: float
    bids: tuple
    asks: tuple
    min_size: float = 0.

    @property
    def bid(self):
        return max((p for p, _ in self.bids), default=None)

    @property
    def ask(self):
        return min((p for p, _ in self.asks), default=None)

    def valid(self, now, max_age=5.):
        if not all(finite(v) for v in (now, self.at, self.source_at, self.min_size)):
            return False
        if not 0 <= now-self.at <= max_age or not -1 <= now-self.source_at <= max_age:
            return False
        if self.min_size < 0 or not (self.bids or self.asks):
            return False
        for p, size in (*self.bids, *self.asks):
            if not finite(p) or not finite(size) or not 0 < p < 1 or size <= 0:
                return False
        return self.bid is None or self.ask is None or self.bid <= self.ask


def buy_fill(book, limit, budget, rate, exponent):
    """Spend up to the all-in budget; require depth for the entire stake."""
    left = max(0., budget - .0001)  # reserve for per-level fee rounding
    shares = gross = fees = 0.
    for price, size in sorted(book.asks):
        if price > limit:
            break
        unit_cost = price + rate * (price*(1-price)) ** exponent
        quantity = min(size, left / unit_cost)
        quantity = math.floor(quantity * 1e6) / 1e6
        if quantity <= 0:
            continue
        charge = fee(quantity, price, rate, exponent)
        shares += quantity
        gross += quantity * price
        fees += charge
        left -= quantity * price + charge
        if left <= .0001:
            break
    if left > .0002 or shares <= 0 or shares < book.min_size:
        return None
    return shares, gross, fees


def sell_fill(book, target, shares, rate, exponent, require_full=True):
    left = shares
    gross = fees = 0.
    for price, size in sorted(book.bids, reverse=True):
        if price < target:
            break
        quantity = min(size, left)
        gross += quantity * price
        fees += fee(quantity, price, rate, exponent)
        left -= quantity
        if left <= 1e-7:
            break
    if require_full and left > 1e-7:
        return None
    return gross, fees


class Engine:
    def __init__(self, path, config=None):
        self.config = upgrade_config(dict(DEFAULTS, **(config or {})))
        c = self.config
        if c['version'] != 3 or c['position_scope'] != 'market':
            raise ValueError('Unsupported experiment format or position scope.')
        if not all(finite(c[k]) and c[k] > 0 for k in ('stake', 'bankroll', 'confirmation_seconds', 'max_gap_seconds', 'max_age_seconds')):
            raise ValueError('Stake, bankroll and timing settings must be positive finite numbers.')
        if c['stake'] > c['bankroll'] or c['side'] not in ('both', 'Up', 'Down') or c['mode'] not in ('live', 'demo'):
            raise ValueError('Invalid experiment settings.')
        self.db = sqlite3.connect(path, timeout=10)
        self.db.row_factory = sqlite3.Row
        # Refuse the old schema before making any changes to it.
        old_settings = self.db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'").fetchone()
        migrated = False
        if old_settings:
            old = self.db.execute('SELECT config FROM settings WHERE id=1').fetchone()
            saved = json.loads(old[0]) if old else None
            if saved and upgrade_config(saved) != c:
                self.db.close()
                raise ValueError('This database uses different settings. Use a new --db filename for this experiment.')
            migrated = bool(saved and saved.get('version') == 2)
        self.db.executescript('''
        PRAGMA journal_mode=WAL;
        PRAGMA busy_timeout=10000;
        CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1), config TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS controls(id INTEGER PRIMARY KEY CHECK(id=1), paused INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS markets(slug TEXT PRIMARY KEY, start REAL NOT NULL, metadata TEXT NOT NULL,
            fee_rate REAL NOT NULL, fee_exponent REAL NOT NULL, fee_source TEXT NOT NULL,
            winner TEXT, resolved_at REAL, resolution TEXT);
        CREATE TABLE IF NOT EXISTS observations(id INTEGER PRIMARY KEY, slug TEXT NOT NULL, side TEXT NOT NULL,
            at REAL NOT NULL, source_at REAL NOT NULL, bid REAL, ask REAL, bids TEXT NOT NULL, asks TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS obs_market ON observations(slug,at);
        CREATE INDEX IF NOT EXISTS obs_side ON observations(slug,side,at DESC);
        CREATE TABLE IF NOT EXISTS trades(id INTEGER PRIMARY KEY, bot INTEGER NOT NULL, slug TEXT NOT NULL,
            side TEXT NOT NULL, entered REAL NOT NULL, entry REAL NOT NULL, shares REAL NOT NULL,
            cost REAL NOT NULL, entry_fee REAL NOT NULL, target REAL NOT NULL, closed REAL, exit REAL,
            proceeds REAL, exit_fee REAL, reason TEXT, pnl REAL);
        CREATE UNIQUE INDEX IF NOT EXISTS one_position_per_market ON trades(bot,slug) WHERE closed IS NULL;
        CREATE INDEX IF NOT EXISTS trades_market ON trades(slug);
        CREATE INDEX IF NOT EXISTS trades_closed ON trades(bot,closed);
        CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, at REAL NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL);
        ''')
        with self.db:
            self.db.execute('BEGIN IMMEDIATE')
            self.db.execute('DROP INDEX IF EXISTS one_position')
            self.db.execute('INSERT OR IGNORE INTO settings VALUES(1,?)', (json.dumps(c, sort_keys=True),))
            if migrated:
                self.db.execute('UPDATE settings SET config=? WHERE id=1', (json.dumps(c, sort_keys=True),))
                self.db.execute('INSERT INTO events(at,kind,message) VALUES(?,?,?)',
                                (time.time(), 'upgrade', 'Position limit changed to one per bot per market. '
                                 'Existing trades retained; pending stakes remain reserved until settlement.'))
            self.db.execute('INSERT OR IGNORE INTO controls VALUES(1,0)')
        self.pending = {}

    def add_market(self, slug, start, metadata, rate=.07, exponent=1., source='assumed crypto schedule'):
        if not finite(start) or not finite(rate) or not finite(exponent) or not 0 <= rate <= 1 or not 0 < exponent <= 5:
            raise ValueError('Invalid market or fee parameters')
        with self.db:
            self.db.execute('INSERT OR IGNORE INTO markets(slug,start,metadata,fee_rate,fee_exponent,fee_source) VALUES(?,?,?,?,?,?)',
                            (slug, start, json.dumps(metadata), rate, exponent, source))

    def event(self, at, kind, message):
        with self.db:
            self.db.execute('INSERT INTO events(at,kind,message) VALUES(?,?,?)', (at, kind, message))

    def cash(self, bot):
        pnl = self.db.execute('SELECT COALESCE(SUM(pnl),0) FROM trades WHERE bot=? AND closed IS NOT NULL', (bot,)).fetchone()[0]
        cost = self.db.execute('SELECT COALESCE(SUM(cost+entry_fee),0) FROM trades WHERE bot=? AND closed IS NULL', (bot,)).fetchone()[0]
        return self.config['bankroll'] + pnl - cost

    def observe(self, slug, books, at):
        """Both sides are evaluated as one snapshot; each bot is an independent experiment."""
        if set(books) != {'Up', 'Down'} or not all(b.valid(at, self.config['max_age_seconds']) for b in books.values()):
            self.pending.clear()
            return False
        market = self.db.execute('SELECT * FROM markets WHERE slug=?', (slug,)).fetchone()
        if market is None:
            return False
        previous = self.db.execute('SELECT MAX(at) FROM observations WHERE slug=?', (slug,)).fetchone()[0]
        if previous is not None and at <= previous:
            return False
        elapsed = at - market['start']
        if not 0 <= elapsed < 300 or market['winner']:
            self.pending.clear()
            return False
        paused = self.db.execute('SELECT paused FROM controls WHERE id=1').fetchone()[0]
        rate, exponent = market['fee_rate'], market['fee_exponent']
        with self.db:
            for side, book in books.items():
                self.db.execute('INSERT INTO observations(slug,side,at,source_at,bid,ask,bids,asks) VALUES(?,?,?,?,?,?,?,?)',
                                (slug, side, at, book.source_at, book.bid, book.ask, json.dumps(book.bids), json.dumps(book.asks)))
            for bot in BOTS:
                bot_id = bot['id']
                trade = self.db.execute('SELECT * FROM trades WHERE bot=? AND slug=? AND closed IS NULL', (bot_id, slug)).fetchone()
                action = side = result = None
                limit = entry_limit(bot, elapsed)
                if trade:
                    if trade['slug'] == slug:
                        side = trade['side']
                        result = sell_fill(books[side], trade['target'], trade['shares'], rate, exponent)
                        if result:
                            action = 'sell'
                elif not paused and limit is not None and self.cash(bot_id) >= self.config['stake']:
                    already = self.db.execute('SELECT 1 FROM trades WHERE bot=? AND slug=? LIMIT 1', (bot_id, slug)).fetchone()
                    if self.config['reentry'] or not already:
                        candidates = []
                        for candidate in ('Up', 'Down'):
                            if self.config['side'] not in ('both', candidate):
                                continue
                            fill = buy_fill(books[candidate], limit, self.config['stake'], rate, exponent)
                            # Gamma minimum is documented in dollars; also apply book's share-size screen.
                            minimum = float(json.loads(market['metadata']).get('orderMinSize') or 0.)
                            if fill and fill[1] >= minimum:
                                candidates.append((fill[1]/fill[0], candidate, fill))
                        if candidates:
                            # Cheapest eligible ask; alphabetical side breaks exact ties deterministically.
                            _, side, result = min(candidates)
                            action = 'buy'
                signature = (slug, side, action, limit if action == 'buy' else bot['target'])
                pending_key = (bot_id, slug)
                pending = self.pending.get(pending_key)
                if action is None:
                    self.pending.pop(pending_key, None)
                    continue
                if (pending and pending[0] == signature and previous is not None
                        and at-previous <= self.config['max_gap_seconds']):
                    if at-pending[1] >= self.config['confirmation_seconds']:
                        if action == 'buy':
                            shares, cost, charge = result
                            self.db.execute('''INSERT INTO trades(bot,slug,side,entered,entry,shares,cost,entry_fee,target)
                                VALUES(?,?,?,?,?,?,?,?,?)''', (bot_id, slug, side, at, cost/shares, shares, cost, charge, bot['target']))
                        else:
                            gross, charge = result
                            self._close(trade, at, gross, charge, 'target')
                        self.pending.pop(pending_key, None)
                else:
                    self.pending[pending_key] = (signature, at)
        return True

    def _close(self, trade, at, gross, charge, reason):
        self.db.execute('''UPDATE trades SET closed=?,exit=?,proceeds=?,exit_fee=?,reason=?,pnl=?
            WHERE id=? AND closed IS NULL''',
            (at, gross/trade['shares'], gross, charge, reason,
             gross-charge-trade['cost']-trade['entry_fee'], trade['id']))

    def settle(self, slug, at, winner, evidence=None):
        market = self.db.execute('SELECT * FROM markets WHERE slug=?', (slug,)).fetchone()
        if not market or not finite(at) or at < market['start']+300 or winner not in ('Up', 'Down') or market['winner']:
            return False
        with self.db:
            for t in self.db.execute('SELECT * FROM trades WHERE slug=? AND closed IS NULL', (slug,)).fetchall():
                self._close(t, at, t['shares'] if t['side'] == winner else 0., 0., 'settlement')
                self.pending.pop((t['bot'], slug), None)
            self.db.execute('UPDATE markets SET winner=?,resolved_at=?,resolution=? WHERE slug=?',
                            (winner, at, json.dumps(evidence or {}), slug))
        return True


def snapshot(db, config, status, now):
    """Read aggregates and bounded chart/table data, without changing the engine."""
    slug = status.get('slug')
    market = db.execute('SELECT * FROM markets WHERE slug=?', (slug,)).fetchone()
    if market is None:
        market = db.execute('SELECT * FROM markets ORDER BY start DESC LIMIT 1').fetchone()
    market = dict(market) if market else None
    bots = []
    for bot in BOTS:
        bid = bot['id']
        summary = dict(db.execute('''SELECT COUNT(*) entries, COUNT(closed) closed,
            COALESCE(SUM(pnl),0) realised, COALESCE(SUM(pnl>0),0) wins,
            COALESCE(SUM(reason='target'),0) targets,
            COALESCE(SUM(entry_fee+COALESCE(exit_fee,0)),0) fees FROM trades WHERE bot=?''', (bid,)).fetchone())
        positions = [dict(row) for row in db.execute('''SELECT t.*,m.start,m.fee_rate,m.fee_exponent
            FROM trades t JOIN markets m USING(slug) WHERE bot=? AND t.closed IS NULL
            ORDER BY t.entered DESC,t.id DESC''', (bid,))]
        unrealised = reserved = 0.
        for position in positions:
            mark = 0.
            last = db.execute('SELECT * FROM observations WHERE slug=? AND side=? ORDER BY at DESC LIMIT 1', (position['slug'], position['side'])).fetchone()
            mark_at = min(last['at'], last['source_at']) if last else None
            if last:
                b = Book(last['at'], last['source_at'], tuple(json.loads(last['bids'])), ())
                gross, charge = sell_fill(b, 0, position['shares'], position['fee_rate'], position['fee_exponent'], False)
                mark = gross-charge
            cost = position['cost']+position['entry_fee']
            reserved += cost
            unrealised += mark-cost
            position.update(mark=mark, unrealised=mark-cost, mark_at=mark_at, stale=mark_at is None or now-mark_at > config['max_age_seconds'],
                            awaiting_settlement=now >= position['start']+300)
        position = next((p for p in positions if market and p['slug'] == market['slug']), None)
        # Window functions preserve lifetime cumulative P&L while bounding chart data.
        curve = [dict(r) for r in db.execute('''SELECT * FROM (SELECT id,closed AS at,
            SUM(pnl) OVER(ORDER BY closed,id) AS pnl FROM trades WHERE bot=? AND closed IS NOT NULL)
            ORDER BY at DESC,id DESC LIMIT 800''', (bid,))][::-1]
        drawdown = db.execute('''WITH curve AS (SELECT closed,id,SUM(pnl) OVER(ORDER BY closed,id) AS pnl
            FROM trades WHERE bot=? AND closed IS NOT NULL), peaks AS
            (SELECT pnl,MAX(pnl) OVER(ORDER BY closed,id) AS peak FROM curve)
            SELECT COALESCE(MAX(MAX(0,peak)-pnl),0) FROM peaks''', (bid,)).fetchone()[0]
        summary.update(bot=bot, position=position, positions=positions, reserved=reserved,
                       pending_settlements=sum(p['awaiting_settlement'] for p in positions), unrealised=unrealised,
                       cash=config['bankroll']+summary['realised']-reserved,
                       equity=config['bankroll']+summary['realised']+unrealised,
                       return_pct=100*summary['realised']/config['bankroll'], max_drawdown=drawdown, curve=curve)
        bots.append(summary)
    observations = []
    if market:
        market['metadata'] = json.loads(market['metadata'])
        observations = [dict(r) for r in db.execute('SELECT side,at,bid,ask FROM observations WHERE slug=? ORDER BY at', (market['slug'],))]
    history = [dict(r) for r in db.execute('''SELECT m.slug,m.start,m.winner,COUNT(t.id) entries,
        COALESCE(SUM(t.pnl),0) pnl FROM markets m LEFT JOIN trades t USING(slug)
        GROUP BY m.slug ORDER BY m.start DESC LIMIT 20''')]
    totals = dict(db.execute('SELECT COUNT(*) markets,MIN(start) first_market FROM markets').fetchone())
    totals['observations'] = db.execute('SELECT COUNT(*) FROM observations').fetchone()[0]
    return dict(config=config, status=status, now=now, market=market, bots=bots, observations=observations,
                paused=bool(db.execute('SELECT paused FROM controls WHERE id=1').fetchone()[0]),
                trades=[dict(r) for r in db.execute('SELECT * FROM trades ORDER BY entered DESC,id DESC LIMIT 500')],
                history=history, totals=totals,
                events=[dict(r) for r in db.execute('SELECT * FROM events ORDER BY id DESC LIMIT 15')])
