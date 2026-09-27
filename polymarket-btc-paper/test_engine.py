import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
from engine import BOTS, Book, Engine, buy_fill, entry_limit, fee, snapshot
from app import fee_schedule, official_winner, parse_book, validate_market


def books(at, ask=.35, bid=None, size=1000, side='Up', source=None):
    bid=ask-.01 if bid is None else bid
    source=at if source is None else source
    return {side:Book(at,source,((bid,size),),((ask,size),)),
            'Down' if side=='Up' else 'Up':Book(at,source,((1-ask,size),),((1-bid,size),))}


class StrategyTests(unittest.TestCase):
    def setUp(self):
        self.e=Engine(':memory:');self.e.add_market('m',1000,{})
    def tearDown(self):self.e.db.close()
    def obs(self,at,ask=.35,bid=None,**kw):return self.e.observe('m',books(at,ask,bid,**kw),at)
    def buys(self,ask=.35,at=1001,**kw):self.obs(at,ask,**kw);self.obs(at+1,ask,**kw)
    def trades(self,bot=None):
        return self.e.db.execute('SELECT * FROM trades'+(' WHERE bot=?' if bot else '')+' ORDER BY id',(bot,) if bot else ()).fetchall()

    def test_exact_windows(self):
        for bot in BOTS[:2]:
            self.assertEqual(entry_limit(bot,149.999),.35);self.assertIsNone(entry_limit(bot,150))
        for t,result in [(-1,None),(0,.4),(119.999,.4),(120,.45),(179.999,.45),(180,None),(300,None)]:
            self.assertEqual(entry_limit(BOTS[2],t),result)

    def test_independent_balances_and_confirmation(self):
        self.obs(1001);self.assertFalse(self.trades());self.obs(1002)
        self.assertEqual(len(self.trades()),3)
        for t in self.trades():
            self.assertAlmostEqual(t['cost']+t['entry_fee'],10,places=3)
            self.assertAlmostEqual(self.e.cash(t['bot']),990,places=3)

    def test_distinct_late_targets(self):
        self.buys();self.obs(1200,.71,.70);self.obs(1201,.71,.70)
        self.assertEqual(self.trades(1)[0]['reason'],'target')
        self.assertIsNone(self.trades(2)[0]['closed'])
        self.assertEqual(self.trades(3)[0]['reason'],'target')
        self.obs(1202,.86,.85);self.obs(1203,.86,.85)
        self.assertEqual(self.trades(2)[0]['reason'],'target')

    def test_midpoint_buy_cutoff(self):
        self.obs(1149);self.obs(1150)
        self.assertFalse(self.trades(1));self.assertFalse(self.trades(2));self.assertEqual(len(self.trades(3)),1)

    def test_bot3_second_window(self):
        self.buys(.44,1118);self.assertFalse(self.trades())
        self.buys(.44,1120);self.assertEqual([t['bot'] for t in self.trades()],[3])

    def test_bot3_limit_change_reconfirms(self):
        self.obs(1119,.39);self.obs(1120,.39);self.assertFalse(self.trades())
        self.obs(1121,.39);self.assertEqual(len(self.trades()),1)

    def test_bot3_buy_cutoff(self):
        self.obs(1179,.44);self.obs(1180,.44);self.assertFalse(self.trades())

    def test_exit_at_299_not_300(self):
        self.buys();self.obs(1298,.72,.71);self.obs(1299,.72,.71)
        self.assertEqual(self.trades(1)[0]['closed'],1299)
        self.obs(1300,.9,.89);self.assertIsNone(self.trades(2)[0]['closed'])

    def test_no_forced_sale_and_settlement_loss(self):
        self.buys();self.obs(1150,.25);self.obs(1300,.01,.001)
        self.assertTrue(all(t['closed'] is None for t in self.trades()))
        self.assertFalse(self.e.settle('m',1299,'Down'))
        self.assertTrue(self.e.settle('m',1301,'Down',{'official':True}))
        for t in self.trades():self.assertAlmostEqual(t['pnl'],-t['cost']-t['entry_fee'])
        self.assertFalse(self.e.settle('m',1302,'Up'))

    def test_settlement_win(self):
        self.buys();self.e.settle('m',1300,'Up');t=self.trades(1)[0]
        self.assertAlmostEqual(t['pnl'],t['shares']-t['cost']-t['entry_fee']);self.assertEqual(t['exit_fee'],0)

    def test_reentry(self):
        self.buys();self.obs(1050,.75,.74);self.obs(1051,.75,.74);self.buys(at=1060)
        self.assertEqual([len(self.trades(i)) for i in (1,2,3)],[2,1,2])

    def test_single_entry_setting(self):
        self.e.config['reentry']=False
        self.buys();self.obs(1050,.9,.89);self.obs(1051,.9,.89);self.buys(at=1060)
        self.assertEqual(len(self.trades()),3)

    def test_pending_round_blocks_next_entry(self):
        self.buys();self.e.add_market('next',1300,{})
        for at in (1301,1302):self.e.observe('next',books(at),at)
        self.assertEqual(len(self.trades()),3)

    def test_ask_not_midpoint(self):
        self.buys(.37,bid=.30)
        self.assertFalse(self.trades(1));self.assertEqual(len(self.trades(3)),1)

    def test_entry_depth_and_minimum(self):
        self.buys(size=1);self.assertFalse(self.trades())
        b=Book(1000,1000,((.34,100),),((.35,100),),100)
        self.assertIsNone(buy_fill(b,.35,10,.07,1))

    def test_depth_vwap_with_price_limit(self):
        b=Book(0,0,((.2,100),),((.34,100),(.3,10),(.5,1000)))
        shares,gross,charge=buy_fill(b,.35,10,.07,1)
        self.assertGreater(gross/shares,.3);self.assertLess(gross/shares,.34)
        self.assertLessEqual(gross+charge,10);self.assertIsNone(buy_fill(b,.3,10,.07,1))

    def test_exit_requires_full_depth(self):
        self.buys();self.obs(1200,.9,.89,size=1);self.obs(1201,.9,.89,size=1)
        self.assertTrue(all(t['closed'] is None for t in self.trades()))

    def test_exit_with_no_asks(self):
        self.buys()
        for at in (1200,1201):
            self.e.observe('m',{'Up':Book(at,at,((.9,1000),),()),'Down':Book(at,at,(),((.1,1000),))},at)
        self.assertTrue(all(t['reason']=='target' for t in self.trades()))

    def test_stale_and_invalid_reset_confirmation(self):
        self.obs(1001);self.assertFalse(self.obs(1002,source=990))
        self.obs(1003);self.assertFalse(self.trades())
        self.assertFalse(self.obs(1004,.3,.4));self.assertFalse(self.obs(float('nan')))

    def test_gap_and_interruption(self):
        self.obs(1001);self.obs(1010);self.assertFalse(self.trades())
        self.obs(1011,.5);self.obs(1012);self.assertFalse(self.trades())
        self.obs(1013);self.assertEqual(len(self.trades()),3)

    def test_duplicate_and_backwards_samples(self):
        self.obs(1001);self.obs(1001);self.obs(1000);self.assertFalse(self.trades())
        self.obs(1002);self.assertEqual(len(self.trades()),3)

    def test_side_filter_and_down(self):
        self.e.config['side']='Up';self.buys(side='Down');self.assertFalse(self.trades())
        self.e.config['side']='both';self.buys(at=1010,side='Down')
        self.assertEqual(len(self.trades()),3);self.assertTrue(all(t['side']=='Down' for t in self.trades()))

    def test_pause_only_blocks_entries(self):
        self.e.db.execute('UPDATE controls SET paused=1');self.e.db.commit()
        self.buys();self.assertFalse(self.trades())
        self.e.db.execute('UPDATE controls SET paused=0');self.e.db.commit();self.buys(at=1010)
        self.e.db.execute('UPDATE controls SET paused=1');self.e.db.commit()
        self.obs(1020,.9,.89);self.obs(1021,.9,.89)
        self.assertTrue(all(t['closed'] for t in self.trades()))

    def test_fee_and_cash_accounting(self):
        self.assertEqual(fee(100,.35,.07),1.5925);self.assertEqual(fee(100,.85,.07),.8925)
        self.buys();self.obs(1200,.9,.89);self.obs(1201,.9,.89)
        for t in self.trades():
            self.assertAlmostEqual(t['pnl'],t['shares']*(t['exit']-t['entry'])-t['entry_fee']-t['exit_fee'])
            self.assertAlmostEqual(self.e.cash(t['bot']),1000+t['pnl'])

    def test_cash_constraint(self):
        self.e.config['bankroll']=10;self.buys();self.e.settle('m',1300,'Down');self.e.add_market('next',1300,{})
        for at in (1301,1302):self.e.observe('next',books(at),at)
        self.assertEqual(len(self.trades()),3)

    def test_pending_equity_and_closed_drawdown(self):
        self.buys();s=snapshot(self.e.db,self.e.config,{'slug':'m'},1301)
        for b in s['bots']:
            self.assertEqual(b['closed'],0);self.assertTrue(b['position']['awaiting_settlement'])
            self.assertTrue(b['position']['stale']);self.assertLess(b['unrealised'],0)
            self.assertAlmostEqual(b['cash']+b['position']['mark'],b['equity'])
        self.e.settle('m',1302,'Down');s=snapshot(self.e.db,self.e.config,{'slug':'m'},1302)
        self.assertAlmostEqual(s['bots'][0]['max_drawdown'],10,places=3)

    def test_restart_and_experiment_isolation(self):
        with tempfile.TemporaryDirectory() as d:
            path=str(Path(d)/'saved.sqlite');e=Engine(path);e.add_market('m',1000,{})
            for at in (1001,1002):e.observe('m',books(at),at)
            e.db.close();e=Engine(path)
            self.assertEqual(e.db.execute('SELECT COUNT(*) FROM trades').fetchone()[0],3)
            self.assertAlmostEqual(e.cash(1),990,places=3);e.settle('m',1300,'Down');e.db.close()
            with self.assertRaises(ValueError):Engine(path,{'stake':20})
            with self.assertRaises(ValueError):Engine(path,{'mode':'demo'})

    def test_legacy_db_is_untouched(self):
        with tempfile.TemporaryDirectory() as d:
            path=str(Path(d)/'old.sqlite')
            with sqlite3.connect(path) as db:
                db.execute('CREATE TABLE settings(id INTEGER,config TEXT)');db.execute('INSERT INTO settings VALUES(1,?)',(json.dumps({'entry':.3}),))
            with self.assertRaises(ValueError):Engine(path)
            with sqlite3.connect(path) as db:
                self.assertEqual(db.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='table'").fetchone()[0],1)


class AdapterTests(unittest.TestCase):
    def market(self):return {'slug':'btc-updown-5m-1800','endDate':'1970-01-01T00:35:00Z','outcomes':'["Down","Up"]','clobTokenIds':'["2","1"]'}
    def test_market_identity(self):
        self.assertEqual(validate_market(self.market(),1800),{'Down':'2','Up':'1'})
        m=self.market();m['endDate']='1970-01-01T00:40:00Z'
        with self.assertRaises(ValueError):validate_market(m,1800)
    def test_official_resolution(self):
        m=self.market();slug=m['slug'];m.update(closed=True,outcomePrices='["1","0"]')
        self.assertIsNone(official_winner(m,slug));m['umaResolutionStatus']='resolved'
        self.assertEqual(official_winner(m,slug),'Down');self.assertIsNone(official_winner(m,'wrong'))
        m['outcomePrices']='["0.999","0.001"]';self.assertIsNone(official_winner(m,slug))
    def test_fee_sources(self):
        self.assertEqual(fee_schedule({'feesEnabled':False})[:2],(0,1))
        self.assertEqual(fee_schedule({'feeSchedule':{'rate':.04,'exponent':1}})[:2],(.04,1))
        with patch('app.get',return_value={'fd':{'r':.07,'e':1}}):self.assertEqual(fee_schedule({'conditionId':'abc'})[2],'CLOB market fee schedule')
        with patch('app.get',side_effect=RuntimeError('network')):self.assertIn('ASSUMED',fee_schedule({'conditionId':'abc'})[2])
    def test_book_validation(self):
        data={'asset_id':'123','timestamp':'1800000000000','bids':[{'price':'.25','size':'5'},{'price':'.3','size':'50'}],'asks':[{'price':'.4','size':'8'},{'price':'.35','size':'50'}]}
        b=parse_book(data,'123',1800000000,1800000001)
        self.assertEqual(b.bid,.3);self.assertEqual(b.ask,.35)
        with self.assertRaises(ValueError):parse_book(data,'456',1800000000,1800000001)
        with self.assertRaises(ValueError):parse_book(data,'123',1800000000,1800000010)
        data['asks']=[];self.assertIsNone(parse_book(data,'123',1800000000,1800000001).ask)


if __name__=='__main__':unittest.main()
