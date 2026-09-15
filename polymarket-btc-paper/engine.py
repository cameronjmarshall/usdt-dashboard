"""Deterministic paper engine. No wallet, signing, or order submission code."""
import json
import math
import sqlite3

CONFIG = dict(entry=0.30, target=0.55, shares=10, entry_seconds=150,
              fee_rate=0.07, confirmation_seconds=1.0, max_gap_seconds=5.0)

class Engine:
    def __init__(self, path):
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
        self.db.executescript('''
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS markets(slug TEXT PRIMARY KEY, start REAL, metadata TEXT);
        CREATE TABLE IF NOT EXISTS observations(id INTEGER PRIMARY KEY, slug TEXT, side TEXT,
          at REAL, bid REAL, ask REAL, bid_size REAL, ask_size REAL);
        CREATE INDEX IF NOT EXISTS obs_market ON observations(slug,at);
        CREATE TABLE IF NOT EXISTS trades(slug TEXT PRIMARY KEY, side TEXT, entered REAL,
          entry REAL, shares REAL, entry_fee REAL, closed REAL, exit REAL, exit_fee REAL,
          reason TEXT, pnl REAL);
        CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1), config TEXT);
        ''')
        old = self.db.execute('SELECT config FROM settings WHERE id=1').fetchone()
        if old and json.loads(old[0]) != CONFIG:
            raise ValueError('Settings changed: use a new --db file for a separate experiment.')
        self.db.execute('INSERT OR IGNORE INTO settings VALUES(1,?)',(json.dumps(CONFIG),))
        self.db.commit()
        self.pending = {}

    def add_market(self, slug, start, metadata):
        self.db.execute('INSERT OR IGNORE INTO markets VALUES(?,?,?)',
                        (slug,start,json.dumps(metadata)))
        self.db.commit()

    def fee(self, price):
        return round(CONFIG['shares'] * CONFIG['fee_rate'] * price * (1-price),5)

    def observe(self, slug, side, at, bid, ask, bid_size, ask_size):
        values = (at,bid,ask,bid_size,ask_size)
        if not all(isinstance(v,(int,float)) and math.isfinite(v) for v in values):
            return
        if not 0 <= bid <= ask <= 1 or min(bid_size,ask_size) < 0:
            return
        m = self.db.execute('SELECT start FROM markets WHERE slug=?',(slug,)).fetchone()
        if not m: return
        previous = self.db.execute('SELECT MAX(at) FROM observations WHERE slug=? AND side=?',
                                   (slug,side)).fetchone()[0]
        if previous is not None and at <= previous: return
        self.db.execute('INSERT INTO observations(slug,side,at,bid,ask,bid_size,ask_size) VALUES(?,?,?,?,?,?,?)',
                        (slug,side,at,bid,ask,bid_size,ask_size))
        trade = self.db.execute('SELECT * FROM trades WHERE slug=?',(slug,)).fetchone()
        elapsed = at-m['start']
        action = None
        if not trade and 0 <= elapsed < CONFIG['entry_seconds'] and 0 < ask <= CONFIG['entry'] and ask_size >= CONFIG['shares']:
            action = 'buy'
        elif trade and trade['closed'] is None and side == trade['side'] and 0 <= elapsed < 300 and bid >= CONFIG['target'] and bid_size >= CONFIG['shares']:
            action = 'sell'
        key = (slug,side)
        pending = self.pending.get(key)
        if action:
            if pending and pending[0] == action and previous is not None and at-previous <= CONFIG['max_gap_seconds']:
                if at-pending[1] >= CONFIG['confirmation_seconds']:
                    if action == 'buy':
                        self.db.execute('INSERT INTO trades(slug,side,entered,entry,shares,entry_fee) VALUES(?,?,?,?,?,?)',
                          (slug,side,at,ask,CONFIG['shares'],self.fee(ask)))
                    else:
                        self.close(slug,at,bid,self.fee(bid),'target')
                    self.pending.pop(key,None)
            else: self.pending[key] = (action,at)
        else: self.pending.pop(key,None)
        self.db.commit()

    def close(self, slug, at, price, fee, reason):
        t = self.db.execute('SELECT * FROM trades WHERE slug=?',(slug,)).fetchone()
        if t and t['closed'] is None:
            pnl = t['shares']*(price-t['entry'])-t['entry_fee']-fee
            self.db.execute('UPDATE trades SET closed=?,exit=?,exit_fee=?,reason=?,pnl=? WHERE slug=?',
                            (at,price,fee,reason,pnl,slug))
            self.db.commit()

    def settle(self, slug, at, winner):
        m = self.db.execute('SELECT start FROM markets WHERE slug=?',(slug,)).fetchone()
        t = self.db.execute('SELECT * FROM trades WHERE slug=?',(slug,)).fetchone()
        if m and t and at >= m['start']+300 and winner in ('Up','Down'):
            self.close(slug,at,float(t['side']==winner),0,'settlement')
