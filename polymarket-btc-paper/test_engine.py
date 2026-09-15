import unittest
from engine import Engine

class StrategyTests(unittest.TestCase):
    def setUp(self):
        self.e=Engine(':memory:');self.e.add_market('m',1000,{})
    def tearDown(self): self.e.db.close()
    def obs(self,t,side='Up',bid=.29,ask=.30,size=100):
        self.e.observe('m',side,t,bid,ask,size,size)
    def trade(self): return self.e.db.execute('SELECT * FROM trades').fetchone()
    def buy(self): self.obs(1001);self.obs(1002)
    def test_confirmation_and_fees(self):
        self.obs(1001);self.assertIsNone(self.trade());self.obs(1002)
        self.assertAlmostEqual(self.trade()['entry_fee'],.147)
    def test_boundary_blocks_buy(self):
        self.obs(1149);self.obs(1150);self.assertIsNone(self.trade())
    def test_late_target_and_no_reentry(self):
        self.buy();self.obs(1298,bid=.55,ask=.56);self.obs(1299,bid=.55,ask=.56)
        self.assertEqual(self.trade()['reason'],'target')
        self.assertAlmostEqual(self.trade()['pnl'],2.17975)
        self.obs(1100,side='Down');self.obs(1101,side='Down')
        self.assertEqual(self.e.db.execute('SELECT COUNT(*) FROM trades').fetchone()[0],1)
    def test_no_sale_at_expiry(self):
        self.buy();self.obs(1299,bid=.55,ask=.56);self.obs(1300,bid=.55,ask=.56)
        self.assertIsNone(self.trade()['closed'])
    def test_gap_resets_confirmation(self):
        self.obs(1001);self.obs(1010);self.assertIsNone(self.trade())
    def test_depth_and_ask_required(self):
        self.obs(1001,size=1);self.obs(1002,size=1);self.assertIsNone(self.trade())
        self.obs(1003,ask=.31);self.obs(1004,ask=.31);self.assertIsNone(self.trade())
    def test_settlement_loss(self):
        self.buy();self.e.settle('m',1299,'Down');self.assertIsNone(self.trade()['closed'])
        self.e.settle('m',1301,'Down');self.assertAlmostEqual(self.trade()['pnl'],-3.147)
        self.e.settle('m',1302,'Up');self.assertAlmostEqual(self.trade()['pnl'],-3.147)
    def test_settlement_win(self):
        self.buy();self.e.settle('m',1301,'Up');self.assertAlmostEqual(self.trade()['pnl'],6.853)
    def test_crossed_and_nan_books(self):
        self.obs(1001,bid=.4,ask=.3);self.obs(float('nan'));self.assertIsNone(self.trade())
    def test_restart_preserves_position(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as tmp:
            p=str(Path(tmp)/'db');e=Engine(p);e.add_market('m',1000,{})
            e.observe('m','Up',1001,.29,.3,100,100);e.observe('m','Up',1002,.29,.3,100,100);e.db.close()
            e=Engine(p);e.observe('m','Down',1010,.29,.3,100,100);e.observe('m','Down',1011,.29,.3,100,100)
            self.assertEqual(e.db.execute('SELECT side FROM trades').fetchone()[0],'Up');e.db.close()

if __name__=='__main__': unittest.main()
