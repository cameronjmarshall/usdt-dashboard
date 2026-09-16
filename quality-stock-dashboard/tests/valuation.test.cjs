const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { valueCashFlows, impliedGrowth, valuationBasis } = require(path.join(process.env.QUALITY_TEST_BUILD, 'valuation.js'));
const base = { cashFlowPerShare: 10, growth: 0, discount: 10, terminalGrowth: 0, years: 10, marginOfSafety: 25 };
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} should equal ${b}`);

test('a level perpetuity is worth C/r regardless of explicit horizon; safety margin differs from upside', () => {
  for (const years of [1, 5, 10, 30]) {
    const result = valueCashFlows({ ...base, years }, 75);
    assert.equal(result.ok, true);
    near(result.value, 100);
    near(result.entryPrice, 75);
    near(result.marginOfSafety, 25);
    near(result.upside, 100 / 3);
  }
});

test('a constant-growth perpetuity agrees with Gordon value and discounts terminal value', () => {
  const result = valueCashFlows({ ...base, growth: 3, terminalGrowth: 3 }, 150);
  assert.equal(result.ok, true);
  near(result.value, 10 * 1.03 / (.1 - .03));
  near(result.terminalShare, (1.03 / 1.1) ** 10 * 100);
  assert.ok(result.marginOfSafety < 0);
});

test('reverse DCF recovers growth for rising and falling cash flows and flags unsolved prices', () => {
  for (const growth of [-30, 0, 8, 25]) {
    const input = { ...base, growth, terminalGrowth: 2 };
    const quote = valueCashFlows(input).value;
    near(impliedGrowth(input, quote).growth, growth);
  }
  assert.equal(impliedGrowth(base, 1e20).growth, null);
  assert.match(impliedGrowth(base, 1e20).reason, /outside/);
  assert.equal(impliedGrowth(base, null).growth, null);
});

test('missing, non-finite and economically invalid assumptions never become model values', () => {
  for (const override of [
    { cashFlowPerShare: null }, { cashFlowPerShare: -1 }, { cashFlowPerShare: 0 },
    { growth: -100 }, { growth: NaN }, { discount: 0 }, { discount: Infinity },
    { terminalGrowth: 10 }, { terminalGrowth: 11 }, { terminalGrowth: -100 },
    { years: 1.5 }, { years: 31 }, { years: 0 }, { marginOfSafety: 100 }, { marginOfSafety: -1 },
  ]) assert.equal(valueCashFlows({ ...base, ...override }, 75).ok, false);
  assert.equal(valueCashFlows(base, null).marginOfSafety, null);
  assert.equal(valueCashFlows(base, -1).upside, null);
  assert.equal(valueCashFlows(base, Infinity).marginOfSafety, null);
});

test('higher required return reduces value and higher growth increases value', () => {
  assert.ok(valueCashFlows({ ...base, discount: 12 }).value < valueCashFlows(base).value);
  assert.ok(valueCashFlows({ ...base, growth: 2 }).value > valueCashFlows(base).value);
});

test('UK pence, cross-currency FX and absent inputs are handled without a hundredfold valuation error', () => {
  const year = { currency: 'GBP', freeCashFlow: 80, basicAverageShares: 10 };
  const quote = { price: 2000, currency: 'GBp' };
  const basis = valuationBasis(year, quote);
  assert.equal(basis.price, 20);
  assert.equal(basis.cashFlowPerShare, 8);
  assert.equal(basis.currency, 'GBP');
  assert.equal(valuationBasis({ ...year, currency: 'USD' }, quote).cashFlowPerShare, null);
  near(valuationBasis({ ...year, currency: 'USD' }, quote, { from: 'USD', to: 'GBP', rate: .8 }).cashFlowPerShare, 6.4);
  assert.equal(valuationBasis({ ...year, currency: 'USD' }, quote, { from: 'GBP', to: 'USD', rate: .8 }).cashFlowPerShare, null);
  assert.equal(valuationBasis({ ...year, basicAverageShares: 0 }, quote).cashFlowPerShare, null);
  assert.equal(valuationBasis({ ...year, freeCashFlow: null }, quote).cashFlowPerShare, null);
});
