import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
from engine import BOTS, Book, Engine, buy_fill, entry_limit, fee, snapshot, upgrade_config
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

    def test_midpoint_buys_once_and_holds(self):
        self.obs(1149,.81)
        self.assertFalse(self.trades(4))
        self.obs(1150,.81)
        trade=self.trades(4)[0]
        self.assertEqual(trade['side'],'Up')
        self.assertAlmostEqual(trade['cost']+trade['entry_fee'],10,places=3)
        self.obs(1151,.99,.98);self.obs(1152,.99,.98)
        self.assertIsNone(self.trades(4)[0]['closed'])
        self.e.settle('m',1301,'Up')
        self.assertEqual(self.trades(4)[0]['reason'],'settlement')
        self.assertGreater(self.trades(4)[0]['pnl'],0)

    def test_midpoint_strict_threshold_and_no_later_retry(self):
        self.obs(1149,.80);self.obs(1150,.80);self.obs(1151,.85)
        self.assertFalse(self.trades(4))

    def test_midpoint_down_and_loss(self):
        self.obs(1149,.10);self.obs(1150,.10)
        self.assertEqual(self.trades(4)[0]['side'],'Down')
        self.e.settle('m',1301,'Up')
        self.assertAlmostEqual(self.trades(4)[0]['pnl'],-10,places=3)

    def test_midpoint_skips_feed_gap(self):
        self.obs(1140,.81);self.obs(1150,.81);self.obs(1151,.81)
        self.assertFalse(self.trades(4))

    def test_midpoint_skips_insufficient_depth(self):
        self.obs(1149,.81);self.obs(1150,.81,size=1);self.obs(1151,.81)
        self.assertFalse(self.trades(4))

    def test_midpoint_skip_persists_after_restart(self):
        with tempfile.TemporaryDirectory() as d:
            path=str(Path(d)/'test.sqlite')
            e=Engine(path);e.add_market('m',1000,{})
            e.observe('m',books(1149,.80),1149)
            e.observe('m',books(1150,.80),1150);e.db.close()
            e=Engine(path)
            e.observe('m',books(1151,.85),1151)
            self.assertEqual(e.db.execute('SELECT COUNT(*) FROM trades WHERE bot=4').fetchone()[0],0)
            e.db.close()

    def test_capped_midpoint_exact_price_boundaries(self):
        for ask,qualifies in ((.80,False),(.800001,True),(.85,True),(.90,True),(.900001,False),(.99,False)):
            with self.subTest(ask=ask):
                e=Engine(':memory:')
                try:
                    e.add_market('m',1000,{})
                    e.observe('m',books(1149,ask),1149)
                    self.assertEqual(e.db.execute('SELECT COUNT(*) FROM trades WHERE bot=5').fetchone()[0],0)
                    e.observe('m',books(1150,ask),1150)
                    rows=e.db.execute('SELECT * FROM trades WHERE bot=5').fetchall()
                    self.assertEqual(len(rows),int(qualifies))
                    if qualifies:
                        self.assertEqual(rows[0]['side'],'Up')
                        self.assertLessEqual(rows[0]['cost']+rows[0]['entry_fee'],10)
                        self.assertAlmostEqual(rows[0]['cost']+rows[0]['entry_fee'],10,places=3)
                        e.settle('m',1301,'Up')
                        self.assertGreater(e.cash(5),1000)
                finally:e.db.close()

    def test_capped_midpoint_rejects_any_fill_level_above_cap(self):
        self.obs(1149,.85)
        pair=books(1150,.85)
        pair['Up']=Book(1150,1150,((.84,1000),),((.85,10),(.91,1000)))
        self.e.observe('m',pair,1150)
        # The uncapped fill averages below 90 cents, but uses some 91-cent shares.
        self.assertLess(self.trades(4)[0]['entry'],.90)
        self.assertFalse(self.trades(5))
        self.obs(1151,.85)
        self.assertFalse(self.trades(5))

    def test_capped_midpoint_fills_depth_up_to_cap(self):
        self.obs(1149,.85)
        pair=books(1150,.85)
        pair['Up']=Book(1150,1150,((.84,1000),),((.85,10),(.90,1000)))
        self.e.observe('m',pair,1150)
        trade=self.trades(5)[0]
        self.assertGreater(trade['entry'],.85)
        self.assertLessEqual(trade['entry'],.90)
        self.assertAlmostEqual(trade['cost']+trade['entry_fee'],10,places=3)

    def test_capped_midpoint_down_holds_to_settlement(self):
        self.obs(1149,.16);self.obs(1150,.16)
        self.assertEqual(self.trades(5)[0]['side'],'Down')
        self.obs(1190,.02);self.obs(1191,.02)
        self.assertIsNone(self.trades(5)[0]['closed'])
        self.e.settle('m',1301,'Up')
        self.assertEqual(self.trades(5)[0]['reason'],'settlement')
        self.assertAlmostEqual(self.trades(5)[0]['pnl'],-10,places=3)

    def test_capped_midpoint_does_not_chase_lower_price(self):
        self.obs(1149,.91);self.obs(1150,.91);self.obs(1151,.85)
        self.assertEqual(len(self.trades(4)),1)
        self.assertFalse(self.trades(5))

    def test_capped_midpoint_execution_guards(self):
        for reason in ('gap','late_start','paused','cash','minimum_shares','minimum_notional','ambiguous','stale'):
            with self.subTest(reason=reason):
                e=Engine(':memory:',{'stake':5.,'bankroll':5.} if reason=='cash' else None)
                try:
                    e.add_market('m',1000,{'orderMinSize':11} if reason=='minimum_notional' else {})
                    if reason!='late_start':
                        previous=1140 if reason=='gap' else 1149
                        e.observe('m',books(previous,.85),previous)
                    if reason=='paused':e.db.execute('UPDATE controls SET paused=1');e.db.commit()
                    pair=books(1150,.85,source=1140 if reason=='stale' else 1150)
                    if reason=='minimum_shares':pair['Up']=Book(1150,1150,((.84,1000),),((.85,1000),),100)
                    if reason=='ambiguous':pair['Down']=Book(1150,1150,((.84,1000),),((.85,1000),))
                    e.observe('m',pair,1150)
                    self.assertEqual(e.db.execute('SELECT COUNT(*) FROM trades WHERE bot=5').fetchone()[0],0)
                finally:e.db.close()

    def test_capped_midpoint_attempt_persists_after_restart(self):
        for ask,count in ((.85,1),(.91,0)):
            with self.subTest(ask=ask),tempfile.TemporaryDirectory() as d:
                path=str(Path(d)/'test.sqlite')
                e=Engine(path);e.add_market('m',1000,{})
                e.observe('m',books(1149,ask),1149);e.observe('m',books(1150,ask),1150)
                e.db.close();e=Engine(path)
                try:
                    e.observe('m',books(1151,.85),1151)
                    self.assertEqual(e.db.execute('SELECT COUNT(*) FROM trades WHERE bot=5').fetchone()[0],count)
                finally:e.db.close()

    def test_adding_capped_bot_preserves_ledger_without_backfill(self):
        with tempfile.TemporaryDirectory() as d:
            path=str(Path(d)/'test.sqlite')
            with patch('engine.BOTS',BOTS[:4]):
                e=Engine(path);e.add_market('m',1000,{})
                e.observe('m',books(1149,.85),1149);e.observe('m',books(1150,.85),1150)
                before=[tuple(r) for r in e.db.execute('SELECT * FROM trades ORDER BY id')]
                settings=e.db.execute('SELECT config FROM settings').fetchone()[0]
                e.db.close()
            e=Engine(path)
            try:
                self.assertEqual([tuple(r) for r in e.db.execute('SELECT * FROM trades ORDER BY id')],before)
                self.assertEqual(e.db.execute('SELECT config FROM settings').fetchone()[0],settings)
                new_bot=next(b for b in snapshot(e.db,e.config,{'slug':'m'},1151)['bots'] if b['bot']['id']==5)
                self.assertEqual((new_bot['bot']['id'],new_bot['entries'],new_bot['cash']),(5,0,1000))
                e.observe('m',books(1151,.85),1151)
                self.assertEqual(e.db.execute('SELECT COUNT(*) FROM trades WHERE bot=5').fetchone()[0],0)
                e.add_market('next',1300,{})
                e.observe('next',books(1449,.85),1449);e.observe('next',books(1450,.85),1450)
                self.assertEqual(e.db.execute('SELECT slug FROM trades WHERE bot=5').fetchone()[0],'next')
            finally:e.db.close()

    def test_bot6_price_boundaries_preserve_bot5_cap(self):
        for ask,bot5_count,bot6_count in ((.80,0,0),(.800001,1,1),(.85,1,1),(.850001,1,0),(.90,1,0),(.900001,0,0)):
            with self.subTest(ask=ask):
                e=Engine(':memory:')
                try:
                    e.add_market('m',1000,{})
                    e.observe('m',books(1149,ask),1149)
                    self.assertEqual(e.db.execute('SELECT COUNT(*) FROM trades WHERE bot=6').fetchone()[0],0)
                    e.observe('m',books(1150,ask),1150)
                    for bot,count in ((5,bot5_count),(6,bot6_count)):
                        self.assertEqual(e.db.execute('SELECT COUNT(*) FROM trades WHERE bot=?',(bot,)).fetchone()[0],count)
                    e.observe('m',books(1151,.83),1151)
                    self.assertEqual(e.db.execute('SELECT COUNT(*) FROM trades WHERE bot=6').fetchone()[0],bot6_count)
                finally:e.db.close()

    def test_bot6_rejects_above_cap_depth_even_when_average_is_lower(self):
        self.obs(1149,.81)
        pair=books(1150,.81)
        pair['Up']=Book(1150,1150,((.80,1000),),((.81,10),(.86,1000)))
        self.e.observe('m',pair,1150)
        self.assertLess(self.trades(5)[0]['entry'],.85)
        self.assertFalse(self.trades(6))
        self.obs(1151,.83)
        self.assertFalse(self.trades(6))

    def test_bot6_consumes_depth_at_cap_with_fixed_fee_inclusive_budget(self):
        self.e.config['stake']=5.
        self.obs(1149,.81)
        pair=books(1150,.81)
        pair['Up']=Book(1150,1150,((.80,1000),),((.81,10),(.85,1000),(.86,1000)))
        self.e.observe('m',pair,1150)
        trade=self.trades(6)[0]
        self.assertGreater(trade['entry'],.81)
        self.assertLessEqual(trade['entry'],.85)
        self.assertLessEqual(trade['cost']+trade['entry_fee'],10)
        self.assertAlmostEqual(trade['cost']+trade['entry_fee'],10,places=3)
        self.assertAlmostEqual(self.e.cash(6),990,places=3)

    def test_bot6_holds_both_sides_and_accounts_for_settlement(self):
        for side in ('Up','Down'):
            for winner in ('Up','Down'):
                with self.subTest(side=side,winner=winner):
                    e=Engine(':memory:')
                    try:
                        e.add_market('m',1000,{})
                        for at in (1149,1150):e.observe('m',books(at,.83,side=side),at)
                        for at in (1190,1191):e.observe('m',books(at,.99,side=side),at)
                        trade=e.db.execute('SELECT * FROM trades WHERE bot=6').fetchone()
                        self.assertEqual(trade['side'],side)
                        self.assertIsNone(trade['closed'])
                        e.settle('m',1301,winner)
                        trade=e.db.execute('SELECT * FROM trades WHERE bot=6').fetchone()
                        self.assertEqual(trade['reason'],'settlement')
                        self.assertEqual(trade['exit'],float(side==winner))
                        self.assertAlmostEqual(e.cash(6),1000+trade['pnl'])
                        if side==winner:self.assertGreater(trade['pnl'],0)
                        else:self.assertAlmostEqual(trade['pnl'],-10,places=3)
                    finally:e.db.close()

    def test_bot6_execution_guards(self):
        for reason in ('gap','late_start','late_crossing','paused','cash','minimum_shares','minimum_notional','ambiguous','stale','depth'):
            with self.subTest(reason=reason):
                e=Engine(':memory:',{'stake':5.,'bankroll':5.} if reason=='cash' else None)
                try:
                    e.add_market('m',1000,{'orderMinSize':11} if reason=='minimum_notional' else {})
                    if reason!='late_start':
                        previous=1140 if reason=='gap' else 1149
                        e.observe('m',books(previous,.83),previous)
                    if reason=='paused':e.db.execute('UPDATE controls SET paused=1');e.db.commit()
                    at=1155 if reason=='late_crossing' else 1150
                    pair=books(at,.83,source=1140 if reason=='stale' else at,size=1 if reason=='depth' else 1000)
                    if reason=='minimum_shares':pair['Up']=Book(at,at,((.82,1000),),((.83,1000),),100)
                    if reason=='ambiguous':pair['Down']=Book(at,at,((.82,1000),),((.83,1000),))
                    e.observe('m',pair,at)
                    self.assertEqual(e.db.execute('SELECT COUNT(*) FROM trades WHERE bot=6').fetchone()[0],0)
                finally:e.db.close()

    def test_bot6_entry_and_skip_persist_after_restart(self):
        for ask,count in ((.85,1),(.86,0)):
            with self.subTest(ask=ask),tempfile.TemporaryDirectory() as d:
                path=str(Path(d)/'test.sqlite')
                e=Engine(path);e.add_market('m',1000,{})
                e.observe('m',books(1149,ask),1149);e.observe('m',books(1150,ask),1150)
                e.db.close();e=Engine(path)
                try:
                    e.observe('m',books(1151,.83),1151)
                    self.assertEqual(e.db.execute('SELECT COUNT(*) FROM trades WHERE bot=6').fetchone()[0],count)
                finally:e.db.close()

    def test_adding_bot6_preserves_five_bot_history_without_backfill(self):
        with tempfile.TemporaryDirectory() as d:
            path=str(Path(d)/'test.sqlite')
            with patch('engine.BOTS',BOTS[:5]):
                e=Engine(path);e.add_market('m',1000,{})
                e.observe('m',books(1149,.83),1149);e.observe('m',books(1150,.83),1150)
                before={table:[tuple(r) for r in e.db.execute('SELECT * FROM '+table)]
                        for table in ('trades','settings','observations','markets','checkpoints')}
                e.db.close()
            e=Engine(path)
            try:
                for table,records in before.items():
                    self.assertEqual([tuple(r) for r in e.db.execute('SELECT * FROM '+table)],records)
                new_bot=next(b for b in snapshot(e.db,e.config,{'slug':'m'},1151)['bots'] if b['bot']['id']==6)
                self.assertEqual((new_bot['entries'],new_bot['realised'],new_bot['cash']),(0,0,1000))
                e.observe('m',books(1151,.83),1151)
                self.assertEqual(e.db.execute('SELECT COUNT(*) FROM trades WHERE bot=6').fetchone()[0],0)
                e.add_market('next',1300,{})
                e.observe('next',books(1449,.83),1449);e.observe('next',books(1450,.83),1450)
                self.assertEqual(e.db.execute('SELECT slug FROM trades WHERE bot=6').fetchone()[0],'next')
            finally:e.db.close()

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

    def test_pending_round_allows_next_entry_with_reserved_cash(self):
        self.buys();self.e.add_market('next',1300,{})
        for at in (1301,1302):self.e.observe('next',books(at),at)
        self.assertEqual(len(self.trades()),6)
        for bot in (1,2,3):
            self.assertEqual(len(self.trades(bot)),2)
            self.assertAlmostEqual(self.e.cash(bot),980,places=3)
        # Another opportunity in the same market cannot open a second position.
        for at in (1303,1304):self.e.observe('next',books(at),at)
        self.assertEqual(len(self.trades()),6)
        s=snapshot(self.e.db,self.e.config,{'slug':'next'},1304)
        for b in s['bots'][:3]:
            self.assertEqual(len(b['positions']),2)
            self.assertEqual(b['position']['slug'],'next')
            self.assertEqual(b['pending_settlements'],1)
            self.assertAlmostEqual(b['reserved'],20,places=3)
            self.assertAlmostEqual(b['cash'],self.e.cash(b['bot']['id']))
            self.assertAlmostEqual(b['equity'],b['cash']+sum(p['mark'] for p in b['positions']))
        self.e.settle('m',1305,'Down')
        s=snapshot(self.e.db,self.e.config,{'slug':'next'},1305)
        for b in s['bots'][:3]:
            self.assertEqual(b['position']['slug'],'next')
            self.assertEqual(len(b['positions']),1)
            self.assertEqual(b['pending_settlements'],0)
            self.assertAlmostEqual(b['reserved'],10,places=3)
            self.assertAlmostEqual(b['cash'],980,places=3)
        self.assertFalse(self.e.settle('m',1306,'Down'))

    def test_prior_settlement_does_not_clear_new_market_signal(self):
        self.buys();self.e.add_market('next',1300,{})
        self.e.observe('next',books(1301),1301)
        self.e.settle('m',1301.5,'Down')
        self.e.observe('next',books(1302),1302)
        self.assertEqual(len(self.trades()),6)
        self.assertTrue(all(t['closed'] is None for t in self.trades() if t['slug']=='next'))

    def test_pending_stake_cannot_be_spent_again(self):
        self.e.config['bankroll']=10
        self.buys();self.e.add_market('next',1300,{})
        for at in (1301,1302):self.e.observe('next',books(at),at)
        self.assertEqual(len(self.trades()),3)
        self.e.settle('m',1303,'Up')
        for at in (1304,1305):self.e.observe('next',books(at),at)
        self.assertEqual(len(self.trades()),6)
        self.assertGreater(self.e.cash(1),0)

    def test_old_positions_do_not_receive_current_market_exits(self):
        self.buys();self.e.add_market('next',1300,{})
        for at in (1301,1302):self.e.observe('next',books(at),at)
        for at in (1303,1304):self.e.observe('next',books(at,.90,.89),at)
        self.assertTrue(all(t['closed'] is None for t in self.trades() if t['slug']=='m'))
        self.assertTrue(all(t['reason']=='target' for t in self.trades() if t['slug']=='next'))

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
        for b in s['bots'][:3]:
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

    def test_upgrade_preserves_pending_positions_and_records_policy_change(self):
        with tempfile.TemporaryDirectory() as d:
            path=str(Path(d)/'saved.sqlite');e=Engine(path);e.add_market('m',1000,{})
            for at in (1001,1002):e.observe('m',books(at),at)
            before=[dict(t) for t in e.db.execute('SELECT * FROM trades ORDER BY id')]
            legacy=dict(e.config,version=2);legacy.pop('position_scope')
            with e.db:
                e.db.execute('UPDATE settings SET config=?',(json.dumps(legacy),))
                e.db.execute('DROP INDEX one_position_per_market')
                e.db.execute('CREATE UNIQUE INDEX one_position ON trades(bot) WHERE closed IS NULL')
            e.db.close()
            # The normal launcher upgrades saved settings, including custom sizing.
            upgraded=upgrade_config(legacy)
            e=Engine(path,upgraded)
            self.assertEqual([dict(t) for t in e.db.execute('SELECT * FROM trades ORDER BY id')],before)
            self.assertEqual(e.db.execute("SELECT COUNT(*) FROM events WHERE kind='upgrade'").fetchone()[0],1)
            self.assertEqual(json.loads(e.db.execute('SELECT config FROM settings').fetchone()[0])['version'],3)
            e.add_market('next',1300,{})
            for at in (1301,1302):e.observe('next',books(at),at)
            e.db.close();e=Engine(path,upgraded)
            self.assertEqual(e.db.execute('SELECT COUNT(*) FROM trades WHERE closed IS NULL').fetchone()[0],6)
            self.assertAlmostEqual(e.cash(1),980,places=3)
            self.assertEqual(e.db.execute("SELECT COUNT(*) FROM events WHERE kind='upgrade'").fetchone()[0],1)
            for at in (1303,1304):e.observe('next',books(at),at)
            self.assertEqual(e.db.execute('SELECT COUNT(*) FROM trades').fetchone()[0],6)
            e.db.close()

    def test_upgrade_does_not_allow_sizing_changes(self):
        with tempfile.TemporaryDirectory() as d:
            path=str(Path(d)/'saved.sqlite');e=Engine(path,{'stake':25,'bankroll':2000,'side':'Down'})
            legacy=dict(e.config,version=2);legacy.pop('position_scope')
            with e.db:e.db.execute('UPDATE settings SET config=?',(json.dumps(legacy),))
            e.db.close()
            with self.assertRaises(ValueError):Engine(path,{'stake':50,'bankroll':2000,'side':'Down'})
            with sqlite3.connect(path) as db:
                self.assertEqual(json.loads(db.execute('SELECT config FROM settings').fetchone()[0]),legacy)
            e=Engine(path,upgrade_config(legacy))
            self.assertEqual(e.config['stake'],25)
            self.assertEqual(e.config['bankroll'],2000)
            self.assertEqual(e.config['side'],'Down')
            e.db.close()

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

