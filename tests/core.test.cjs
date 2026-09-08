const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const R = require('../core.js');
const read = name => fs.readFileSync(path.join(__dirname, '..', 'examples', name), 'utf8');
function parse(text, extra = {}) {
  const csv = R.parseCSV(text);
  const config = { layout: 'dual', mapping: R.suggestMapping(csv.headers), exchange: 'Exchange A', wallet: 'Main', feeMode: 'separate', ...extra };
  return { ...R.normalise(csv, config), config, csv };
}
const universal = () => parse(read('universal.csv')).entries.map((e, i) => ({ ...e, uid: 'entry-' + i }));

test('decimal calculations preserve fractional tokens and large balances exactly', () => {
  assert.equal(R.add('0.1', '0.2'), '0.3');
  assert.equal(R.add('9007199254740993', '0.000000000000000001'), '9007199254740993.000000000000000001');
  assert.equal(R.mul('0.000000000000000001', '0.000000000000000001'), '0.000000000000000000000000000000000001');
  assert.equal(R.sub('0.3', '0.300000000000000001'), '-0.000000000000000001');
  assert.equal(R.canonical('1e-18'), '0.000000000000000001');
  assert.equal(R.money('-1.005'), '-1.01');
  assert.throws(() => R.canonical('NaN'));
  assert.throws(() => R.canonical('1e9999'));
});
test('CSV supports BOM, escaped quotes, semicolons, CRLF, and multiline fields', () => {
  const p = R.parseCSV('\uFEFFDate;Amount;Notes\r\n2026-08-01;"1,25";"a; b\nsaid ""hello"""\r\n');
  assert.equal(p.delimiter, ';'); assert.equal(p.rows.length, 1);
  assert.equal(p.rows[0].cells[2], 'a; b\nsaid "hello"');
  assert.equal(R.amount(p.rows[0].cells[1], ','), '1.25');
  assert.equal(R.amount('1,234.56', '.'), '1234.56');
  assert.throws(() => R.parseCSV('A,A\n1,2'));
  assert.throws(() => R.parseCSV('A,B\n"unclosed,2'));
  assert.throws(() => R.amount('1.234,56', ','));
});
test('dates validate the calendar, explicit offsets and UK/US ordering', () => {
  assert.equal(R.timestamp('03/08/2026 12:00:00', { dateOrder: 'dmy', offsetMinutes: 60 }), '2026-08-03T11:00:00.000Z');
  assert.equal(R.timestamp('03/08/2026', { dateOrder: 'mdy' }), '2026-03-08T00:00:00.000Z');
  assert.equal(R.timestamp('2026-08-03T12:00:00-04:00', { offsetMinutes: 60 }), '2026-08-03T16:00:00.000Z');
  assert.equal(R.timestamp('2026-08-03 12:00:00 UTC', { offsetMinutes: 60 }), '2026-08-03T12:00:00.000Z');
  assert.throws(() => R.timestamp('2026-02-30'));
  assert.throws(() => R.timestamp('2026-08-01 24:00:00'));
  assert.throws(() => R.timestamp('2026-08-01T12:00:00.123456Z'));
});
test('one order combines two fills without mixing fees into the trade quantities', () => {
  const entries = universal();
  const g = R.groupTransactions(entries, 'order').find(g => g.entries.some(e => e.orderId === 'BTC-BUY-101'));
  assert.equal(g.entries.length, 2); assert.equal(g.sent.get('USDT'), '15000'); assert.equal(g.received.get('BTC'), '0.25'); assert.equal(g.fees.get('USDT'), '15');
  assert.equal(g.entries[0].sources[0].raw['Sent Amount'], '6000');
  assert.equal(R.groupTransactions(entries, 'none').length, 6);
});
test('orders never group across accounts, directions or asset pairs', () => {
  const buy = universal()[1];
  const otherAccount = { ...buy, wallet: 'Account 2', uid: 'other-wallet' };
  const sell = { ...buy, sent: { asset: 'BTC', amount: '0.1' }, received: { asset: 'USDT', amount: '6100' }, uid: 'sell' };
  const eth = { ...buy, received: { asset: 'ETH', amount: '2' }, uid: 'eth' };
  assert.equal(R.groupTransactions([buy, otherAccount, sell, eth], 'order').length, 4);
  assert.equal(R.groupTransactions([buy, otherAccount, sell, eth], 'month').length, 4);
});
test('missing order IDs stay separate and cannot collide with a real order reference', () => {
  const buy = universal()[1], a = { ...buy, orderId: '', uid: 'collision' }, b = { ...buy, orderId: 'collision', uid: 'other' };
  assert.equal(R.groupTransactions([a, b], 'order').length, 2);
  assert.equal(R.groupTransactions([a, { ...a, uid: 'third' }], 'order').length, 2);
  assert.equal(R.groupTransactions([a, { ...a, uid: 'third' }], 'day').length, 1);
});
test('daily and monthly totals preserve different UTC periods', () => {
  const e = universal()[1], f = { ...e, uid: 'later', date: '2026-08-04T00:00:00.000Z' }, next = { ...e, uid: 'next', date: '2026-09-01T00:00:00.000Z' };
  assert.equal(R.groupTransactions([e, f, next], 'day').length, 3);
  assert.equal(R.groupTransactions([e, f, next], 'month').length, 2);
});
test('trade fills map buy and sell legs and derive quote totals exactly when absent', () => {
  const result = parse(read('trade-fills.csv'), { layout: 'trade' });
  assert.equal(result.errors.length, 0); assert.equal(result.entries[0].sent.amount, '6000');
  assert.equal(result.entries[2].sent.asset, 'BTC'); assert.equal(result.entries[2].received.amount, '4960');
  const derived = parse('Time,Side,Pair,Quantity,Price\n2026-08-01,buy,BTC/USDT,0.1,61234.56789', { layout: 'trade' });
  assert.equal(derived.entries[0].sent.amount, '6123.456789');
  const bad = parse('Time,Side,Pair,Quantity,Total\n2026-08-01,buy,BTCUSDT,0.1,6000', { layout: 'trade' });
  assert.equal(bad.errors.length, 1);
});
test('signed trade legs share a reference and fees are posted once', () => {
  const result = parse(read('signed-movements.csv'), { layout: 'movement' });
  assert.equal(result.errors.length, 0);
  const groups = R.groupTransactions(result.entries, 'order'); assert.equal(groups.length, 1); assert.equal(groups[0].kind, 'trade');
  assert.equal(groups[0].sent.get('USDT'), '6000'); assert.equal(groups[0].received.get('BTC'), '0.1');
  assert.equal(R.balances(result.entries).find(r => r.asset === 'USDT').movement, '-6006');
});
test('deduplication uses unique fill IDs, not a shared order or transaction hash', () => {
  const entries = universal(), fills = entries.slice(1, 3), otherFill = { ...fills[0], entryId: 'new-fill-id' };
  const result = R.prepareImport([fills[0]], [fills[0], fills[1], otherFill]);
  assert.equal(result.duplicates.length, 1); assert.equal(result.accepted.length, 2);
  const sameIdDifferentAccount = { ...fills[0], wallet: 'Other' };
  assert.equal(R.prepareImport([fills[0]], [sameIdDifferentAccount]).accepted.length, 1);
});
test('conflicting unique IDs quarantine all new versions without changing existing entries', () => {
  const e = universal()[1], conflict = { ...e, sent: { asset: 'USDT', amount: '6001' } };
  const result = R.prepareImport([], [e, conflict]);
  assert.equal(result.accepted.length, 0); assert.equal(result.conflicts.length, 2);
  const existing = R.prepareImport([e], [conflict]); assert.equal(existing.accepted.length, 0); assert.equal(existing.conflicts.length, 1);
});
test('no-ID overlap requires a user choice; identical fills in the same new file survive', () => {
  const e = { ...universal()[1], entryId: '' };
  assert.equal(R.prepareImport([], [e, e]).accepted.length, 2);
  const result = R.prepareImport([e], [e]); assert.equal(result.possible.length, 1); assert.equal(result.accepted.length, 0);
});
test('balances deduct additional fees in their actual currency, including a third currency', () => {
  const rows = R.balances(universal());
  assert.equal(rows.find(r => r.exchange === 'Example Exchange' && r.asset === 'BTC').movement, '0.1199');
  assert.equal(rows.find(r => r.exchange === 'Ledger' && r.asset === 'BTC').movement, '0.05');
  assert.equal(rows.find(r => r.asset === 'USDT').movement, '39940.04');
  const e = { ...universal()[1], fees: [{ asset: 'BNB', amount: '0.001', deduct: true }] };
  const third = R.balances([e]); assert.equal(third.find(r => r.asset === 'BNB').movement, '-0.001'); assert.equal(third.find(r => r.asset === 'USDT').movement, '-6000');
});
test('fees already included in amounts do not get deducted twice', () => {
  const result = parse(read('universal.csv'), { feeMode: 'included' });
  assert.equal(R.balances(result.entries).find(r => r.asset === 'USDT').movement, '39960');
  assert.throws(() => parse(read('universal.csv'), { feeMode: '' }));
});
test('a missing opening or statement balance is never called matched', () => {
  const row = { movement: '0.1' };
  assert.deepEqual(R.reconcileBalance(row, {}), { calculated: null, difference: null, status: 'Enter balances' });
  assert.equal(R.reconcileBalance(row, { open: '0' }).status, 'Enter balances');
  assert.equal(R.reconcileBalance(row, { open: '0.2', close: '0.3' }).status, 'Matched');
  assert.equal(R.reconcileBalance(row, { open: '0.2', close: '0.300000000000000001' }).difference, '-0.000000000000000001');
});
test('invalid rows are reported individually with their original source line', () => {
  const result = parse('Date,Sent Amount,Sent Currency,Received Amount,Received Currency,Label\n2026-02-30,1,BTC,,,withdrawal\n2026-08-01,-1,BTC,,,withdrawal\n2026-08-01,1,,,,withdrawal\n2026-08-01,1,BTC,,,trade\n2026-08-01,1,BTC,,,withdrawal\n2026-08-01,1,BTC');
  assert.equal(result.entries.length, 1); assert.equal(result.errors.length, 5);
  assert.deepEqual(result.errors.map(e => e.line), [2, 3, 4, 5, 7]);
});
test('CSV export quotes fields and neutralises spreadsheet formula injection', () => {
  const csv = R.exportCSV(['Account', 'Amount'], [['=HYPERLINK("x")', '-0.1'], ['\t+cmd', '2'], ['safe, name', '3']]);
  const rows = R.parseCSV(csv).rows;
  assert.equal(rows[0].cells[0], '\'=HYPERLINK("x")'); assert.equal(rows[0].cells[1], '-0.1');
  assert.equal(rows[1].cells[0], "'\t+cmd"); assert.equal(rows[2].cells[0], 'safe, name');
});
test('project roundtrip retains exact amounts and source rows, invalid amounts are refused', () => {
  const project = { format: 'crypto-reconcile', version: 1, entries: universal(), imports: [], balanceInputs: {} };
  const restored = R.validateProject(JSON.parse(JSON.stringify(project)));
  assert.deepEqual(R.balances(restored.entries), R.balances(project.entries));
  assert.equal(restored.entries[1].sources[0].raw['Fee Amount'], '6');
  const bad = JSON.parse(JSON.stringify(project)); bad.entries[0].received.amount = 'NaN';
  assert.throws(() => R.validateProject(bad));
  assert.throws(() => R.validateProject({ ...project, version: 2 }));
});
test('the embedded demo is valid and has the promised two-fill trade', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const csv = source.match(/const DEMO_CSV = `([\s\S]*?)`;/)[1];
  const result = parse(csv); assert.equal(result.errors.length, 0); assert.equal(result.entries.length, 12);
  const group = R.groupTransactions(result.entries).find(g => g.entries.length === 2); assert.equal(group.received.get('BTC'), '0.25');
  assert.equal(R.balances(result.entries).find(r => r.asset === 'ETH').movement, '2.6');
});
