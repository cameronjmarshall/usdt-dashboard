/* Exact, dependency-free reconciliation functions shared by the UI and Node tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Reconcile = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function parts(value) {
    const text = String(value).trim();
    if (text.length > 220) throw new Error('Amount is too long.');
    const m = /^([+-]?)(\d+(?:\.\d*)?|\.\d+)(?:[eE]([+-]?\d+))?$/.exec(text);
    if (!m) throw new Error('Invalid amount: ' + text);
    const exponent = Number(m[3] || 0);
    if (Math.abs(exponent) > 60) throw new Error('Amount exponent is outside the supported range.');
    const bits = m[2].split('.');
    let scale = (bits[1] || '').length - exponent;
    let n = BigInt((m[1] === '-' ? '-' : '') + (bits[0] || '0') + (bits[1] || ''));
    if (scale < 0) { n *= 10n ** BigInt(-scale); scale = 0; }
    while (scale > 0 && n % 10n === 0n) { n /= 10n; scale--; }
    return { n, scale };
  }
  function decimal(n, scale) {
    const negative = n < 0n;
    let s = (negative ? -n : n).toString().padStart(scale + 1, '0');
    if (scale) s = s.slice(0, -scale) + '.' + s.slice(-scale);
    s = s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
    return (negative && n !== 0n ? '-' : '') + s;
  }
  function canonical(v) { const p = parts(v); return decimal(p.n, p.scale); }
  function add(a, b) {
    const x = parts(a), y = parts(b), s = Math.max(x.scale, y.scale);
    return decimal(x.n * 10n ** BigInt(s - x.scale) + y.n * 10n ** BigInt(s - y.scale), s);
  }
  function negate(a) { const p = parts(a); return decimal(-p.n, p.scale); }
  function sub(a, b) { return add(a, negate(b)); }
  function mul(a, b) { const x = parts(a), y = parts(b); return decimal(x.n * y.n, x.scale + y.scale); }
  function compare(a, b) { const n = parts(sub(a, b)).n; return n < 0n ? -1 : n > 0n ? 1 : 0; }
  function amount(value, separator) {
    let s = String(value).trim();
    if (separator === ',') {
      if (s.includes('.')) throw new Error('Use decimal commas without thousands separators.');
      s = s.replace(',', '.');
    } else if (/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
    return canonical(s);
  }
  function positive(value, separator) {
    const s = amount(value, separator);
    if (compare(s, '0') < 0) throw new Error('This layout requires positive quantities; use Signed movements for signed amounts.');
    return s;
  }
  function money(v) {
    const p = parts(v), sign = p.n < 0n ? '-' : '', n = p.n < 0n ? -p.n : p.n;
    let cents;
    if (p.scale <= 2) cents = n * 10n ** BigInt(2 - p.scale);
    else { const d = 10n ** BigInt(p.scale - 2); cents = (n + d / 2n) / d; }
    const s = cents.toString().padStart(3, '0');
    return (cents ? sign : '') + s.slice(0, -2) + '.' + s.slice(-2);
  }
  function parseCSV(text, delimiter) {
    if (typeof text !== 'string' || text.length > 20 * 1024 * 1024) throw new Error('Choose a CSV smaller than 20 MB.');
    text = text.replace(/^\uFEFF/, '');
    if (text.includes('\0')) throw new Error('This file is not a UTF-8 CSV. Export it as UTF-8.');
    if (!delimiter) {
      let quoted = false, first = '';
      for (let i = 0; i < text.length; i++) {
        if (text[i] === '"') { if (quoted && text[i + 1] === '"') { first += '""'; i++; continue; } quoted = !quoted; }
        if (!quoted && /[\r\n]/.test(text[i])) break;
        first += quoted ? ' ' : text[i];
      }
      delimiter = [',', ';', '\t'].sort((a, b) => first.split(b).length - first.split(a).length)[0];
    }
    const records = []; let cells = [], cell = '', quoted = false, closed = false, line = 1, startLine = 1;
    const endCell = () => { cells.push(cell); cell = ''; closed = false; };
    const endRow = () => {
      endCell();
      if (cells.some(v => v.trim() !== '')) records.push({ cells, line: startLine });
      cells = []; startLine = line + 1;
      if (records.length > 100001) throw new Error('Choose a CSV with at most 100,000 rows.');
    };
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } }
        else { cell += c; if (c === '\n') line++; }
      } else if (c === delimiter) endCell();
      else if (c === '\n' || c === '\r') { endRow(); if (c === '\r' && text[i + 1] === '\n') i++; line++; }
      else if (c === '"') { if (cell.trim() || closed) throw new Error('Unexpected quote on line ' + line); cell = ''; quoted = true; }
      else if (closed) { if (!/\s/.test(c)) throw new Error('Unexpected text after a quote on line ' + line); }
      else cell += c;
    }
    if (quoted) throw new Error('Unclosed quoted field at the end of the CSV.');
    if (cell || cells.length || closed) endRow();
    if (records.length < 2) throw new Error('The CSV needs a header and at least one transaction.');
    const headers = records.shift().cells.map(s => s.trim());
    if (headers.length > 200 || headers.some(s => !s) || new Set(headers.map(s => s.toLowerCase())).size !== headers.length)
      throw new Error('Headers must be unique and non-empty (maximum 200 columns). Remove report preambles before importing.');
    return { headers, rows: records, delimiter };
  }
  function timestamp(value, options = {}) {
    const s = String(value).trim();
    if (/^\d{10}(?:\.\d{1,3})?$/.test(s) || /^\d{13}$/.test(s)) {
      const date = new Date(Number(s) * (s.length === 13 && !s.includes('.') ? 1 : 1000));
      if (!Number.isFinite(date.getTime())) throw new Error('Invalid timestamp.');
      return date.toISOString();
    }
    const m = /^(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?\s*(Z|UTC|[+-]\d{2}:?\d{2})?$/i.exec(s);
    if (!m) throw new Error('Use ISO dates, slash dates, or Unix timestamps (at most millisecond precision).');
    let y, month, day;
    if (m[1].includes('-')) [y, month, day] = m[1].split('-').map(Number);
    else { const a = m[1].split('/').map(Number); y = a[2]; [day, month] = options.dateOrder === 'mdy' ? [a[1], a[0]] : [a[0], a[1]]; }
    const hour = Number(m[2] || 0), minute = Number(m[3] || 0), second = Number(m[4] || 0), ms = Number((m[5] || '').padEnd(3, '0'));
    if (y < 1970 || y > 2100 || month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(y, month, 0)).getUTCDate() || hour > 23 || minute > 59 || second > 59)
      throw new Error('Invalid calendar date or time.');
    let offset = Number(options.offsetMinutes || 0);
    if (m[6]) {
      if (/^(z|utc)$/i.test(m[6])) offset = 0;
      else { const z = m[6].replace(':', ''); const h = Number(z.slice(1, 3)), mins = Number(z.slice(3)); if (h > 14 || mins > 59 || (h === 14 && mins !== 0)) throw new Error('Invalid timezone offset.'); offset = (h * 60 + mins) * (z[0] === '-' ? -1 : 1); }
    }
    if (!Number.isFinite(offset) || Math.abs(offset) > 840) throw new Error('Invalid timezone offset.');
    return new Date(Date.UTC(y, month - 1, day, hour, minute, second, ms) - offset * 60000).toISOString();
  }
  const aliases = {
    date: ['date', 'datetime', 'timestamp', 'time', 'utc time', 'created at', 'time utc'],
    exchange: ['exchange', 'platform'], wallet: ['wallet', 'account', 'ledger'],
    sentAmount: ['sent amount', 'send amount', 'withdrawal amount'], sentAsset: ['sent currency', 'sent asset', 'send currency'],
    receivedAmount: ['received amount', 'receive amount', 'deposit amount'], receivedAsset: ['received currency', 'received asset', 'receive currency'],
    feeAmount: ['fee amount', 'fee', 'commission', 'fees'], feeAsset: ['fee currency', 'fee asset', 'commission asset', 'commission coin'],
    entryId: ['transaction id', 'trade id', 'fill id', 'entry id', 'txid', 'id'], orderId: ['order id', 'order', 'reference', 'refid', 'reference id'],
    hash: ['txhash', 'transaction hash', 'tx hash'], kind: ['label', 'type', 'transaction type', 'operation'],
    side: ['side', 'buy sell', 'type'], base: ['base currency', 'base asset', 'base'], quote: ['quote currency', 'quote asset', 'quote'],
    pair: ['pair', 'symbol', 'market', 'instrument'], quantity: ['quantity', 'qty', 'volume', 'vol', 'executed', 'size'],
    total: ['total', 'cost', 'quote amount', 'funds', 'quote quantity'], price: ['price', 'execution price'],
    asset: ['asset', 'currency', 'coin', 'token'], amount: ['amount', 'change', 'quantity'], notes: ['notes', 'description', 'comment', 'remark']
  };
  const clean = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  function suggestMapping(headers) {
    const mapping = {};
    for (const [key, names] of Object.entries(aliases)) {
      const match = names.map(n => headers.find(h => clean(h) === clean(n))).find(Boolean);
      mapping[key] = match || '';
    }
    return mapping;
  }
  function detectLayout(mapping) {
    if (mapping.sentAmount || mapping.receivedAmount) return 'dual';
    if (mapping.side && mapping.quantity && (mapping.pair || mapping.base)) return 'trade';
    if (mapping.asset && mapping.amount) return 'movement';
    return 'dual';
  }
  function asset(v) {
    const s = String(v || '').trim().toUpperCase();
    if (!s || s.length > 60 || /[\r\n\t]/.test(s)) throw new Error('A currency is missing or invalid.');
    return s;
  }
  function normalise(parsed, config) {
    const entries = [], errors = [];
    if (!['dual', 'trade', 'movement'].includes(config.layout)) throw new Error('Choose a supported CSV layout.');
    if (!config.mapping.date) throw new Error('Map the date column.');
    if (!['separate', 'included'].includes(config.feeMode)) throw new Error('Choose how fees affect the exported amounts.');
    for (const record of parsed.rows) {
      try {
        if (record.cells.length !== parsed.headers.length) throw new Error('Column count does not match the header.');
        const raw = Object.fromEntries(parsed.headers.map((h, i) => [h, record.cells[i]]));
        const get = name => String(raw[config.mapping[name]] ?? '').trim();
        const entry = {
          date: timestamp(get('date'), config), exchange: get('exchange') || String(config.exchange || '').trim(),
          wallet: get('wallet') || String(config.wallet || 'Main').trim(),
          entryId: get('entryId'), orderId: get('orderId'), hash: get('hash'),
          sent: null, received: null, fees: [], notes: get('notes'),
          sources: [{ line: record.line, raw }], warnings: []
        };
        if (!entry.exchange || !entry.wallet) throw new Error('Enter an exchange and wallet/account name.');
        for (const k of ['exchange', 'wallet', 'entryId', 'orderId']) if (entry[k].length > 300) throw new Error(k + ' is too long.');
        const leg = (v, a) => { const q = positive(v, config.decimalSeparator); return q === '0' ? null : { amount: q, asset: asset(a) }; };
        const label = get('kind').toLowerCase();
        if (config.layout === 'dual') {
          if (get('sentAmount')) entry.sent = leg(get('sentAmount'), get('sentAsset'));
          if (get('receivedAmount')) entry.received = leg(get('receivedAmount'), get('receivedAsset'));
          entry.kind = entry.sent && entry.received ? 'trade' : entry.sent ? 'withdrawal' : 'deposit';
          if (/^(trade|buy|sell)$/.test(label) && !(entry.sent && entry.received)) throw new Error('A trade needs both sent and received legs.');
        } else if (config.layout === 'trade') {
          const side = get('side').toLowerCase();
          if (!['buy', 'sell'].includes(side)) throw new Error('Trade side must be Buy or Sell.');
          let base = get('base') || config.base, quote = get('quote') || config.quote;
          if (!base || !quote) {
            const pair = get('pair').split(/[\/\-_]/);
            if (pair.length === 2) { base = base || pair[0]; quote = quote || pair[1]; }
            else throw new Error('Map base and quote currencies, enter defaults, or use a pair such as BTC/USDT.');
          }
          const quantity = positive(get('quantity'), config.decimalSeparator);
          const total = get('total') ? positive(get('total'), config.decimalSeparator) : mul(quantity, positive(get('price'), config.decimalSeparator));
          if (quantity === '0' || total === '0') throw new Error('Trade quantity and total must be greater than zero.');
          if (asset(base) === asset(quote)) throw new Error('Base and quote currency must differ.');
          const b = { asset: asset(base), amount: quantity }, q = { asset: asset(quote), amount: total };
          entry.sent = side === 'buy' ? q : b; entry.received = side === 'buy' ? b : q; entry.kind = 'trade';
          if (!get('total')) entry.warnings.push('Quote total calculated from quantity × price.');
        } else {
          const signed = amount(get('amount'), config.decimalSeparator), a = asset(get('asset'));
          if (compare(signed, '0') < 0) entry.sent = { asset: a, amount: negate(signed) };
          if (compare(signed, '0') > 0) entry.received = { asset: a, amount: signed };
          entry.kind = /^(trade|buy|sell)$/.test(label) ? 'trade_leg' : entry.sent ? 'withdrawal' : 'deposit';
          if (entry.kind === 'trade_leg' && !entry.orderId) entry.warnings.push('Map a shared order/reference ID to combine the trade legs.');
        }
        if (/^(reward|rewards|staking|income|interest|airdrop|mining)$/.test(label) && entry.received && !entry.sent) entry.kind = 'reward';
        if (/^(fee|fees)$/.test(label) && entry.sent && !entry.received) entry.kind = 'fee';
        const fee = get('feeAmount') ? positive(get('feeAmount'), config.decimalSeparator) : '0';
        if (fee !== '0') entry.fees.push({ asset: asset(get('feeAsset') || config.feeAsset), amount: fee, deduct: config.feeMode === 'separate' });
        if (!entry.sent && !entry.received) {
          if (!entry.fees.length) throw new Error('No non-zero transaction quantity.');
          if (config.feeMode !== 'separate') throw new Error('A fee-only row must deduct its fee.');
          entry.kind = 'fee';
        }
        if (entry.sent && entry.received && entry.sent.asset === entry.received.asset) { entry.kind = 'movement'; entry.warnings.push('Same currency on both sides; review this movement.'); }
        entry.label = get('kind');
        entries.push(entry);
      } catch (error) { errors.push({ line: record.line, message: error.message, cells: record.cells }); }
    }
    return { entries, errors };
  }
  function signature(e) {
    return JSON.stringify([e.date, e.exchange, e.wallet, e.kind, e.sent, e.received, e.fees, e.orderId, e.hash]);
  }
  function identity(e) { return e.entryId ? JSON.stringify([e.exchange, e.wallet, e.entryId]) : null; }
  function prepareImport(existing, incoming) {
    const knownIds = new Map(), knownShapes = new Set(existing.map(signature));
    existing.forEach(e => { if (identity(e)) knownIds.set(identity(e), signature(e)); });
    const accepted = [], duplicates = [], conflicts = [], possible = [];
    const incomingIds = new Map();
    for (const e of incoming) {
      const id = identity(e), shape = signature(e), prior = id && (knownIds.get(id) || incomingIds.get(id));
      if (prior) {
        if (prior === shape) duplicates.push(e);
        else conflicts.push(e);
      } else if (!id && knownShapes.has(shape)) possible.push(e);
      else { accepted.push(e); if (id) incomingIds.set(id, shape); }
    }
    // A reused ID with differing content quarantines every new row for that ID.
    const conflictIds = new Set(conflicts.map(identity));
    return { accepted: accepted.filter(e => !conflictIds.has(identity(e))), duplicates,
      conflicts: [...conflicts, ...accepted.filter(e => conflictIds.has(identity(e)))], possible };
  }
  function addAsset(map, leg) { if (leg) map.set(leg.asset, add(map.get(leg.asset) || '0', leg.amount)); }
  function groupTransactions(entries, mode = 'order') {
    const groups = new Map();
    entries.forEach((e, index) => {
      let period = ['entry', e.uid || String(index)];
      const tradeLeg = e.kind === 'trade_leg';
      let pair = [e.sent?.asset || '', e.received?.asset || ''];
      if (mode === 'order' && e.orderId && (e.kind === 'trade' || tradeLeg)) { period = ['order', e.orderId]; if (tradeLeg) pair = []; }
      if (mode === 'day' || mode === 'month') { period = [mode, e.date.slice(0, mode === 'day' ? 10 : 7)]; }
      const key = JSON.stringify([e.exchange, e.wallet, e.kind, pair, period]);
      if (!groups.has(key)) groups.set(key, { key, kind: e.kind, exchange: e.exchange, wallet: e.wallet, date: e.date, endDate: e.date, entries: [], sent: new Map(), received: new Map(), fees: new Map() });
      const g = groups.get(key); g.entries.push(e); addAsset(g.sent, e.sent); addAsset(g.received, e.received); e.fees.forEach(f => addAsset(g.fees, f));
      if (e.date < g.date) g.date = e.date;
      if (e.date > g.endDate) g.endDate = e.date;
    });
    for (const g of groups.values()) if (g.kind === 'trade_leg' && g.sent.size && g.received.size) g.kind = 'trade';
    return [...groups.values()].sort((a, b) => b.date.localeCompare(a.date));
  }
  function balances(entries) {
    const result = new Map();
    function post(e, a, quantity, category) {
      const key = JSON.stringify([e.exchange, e.wallet, a]);
      if (!result.has(key)) result.set(key, { key, exchange: e.exchange, wallet: e.wallet, asset: a, incoming: '0', outgoing: '0', fees: '0', movement: '0' });
      const row = result.get(key); row.movement = add(row.movement, quantity);
      row[category] = add(row[category], category === 'incoming' ? quantity : negate(quantity));
    }
    entries.forEach(e => {
      if (e.received) post(e, e.received.asset, e.received.amount, 'incoming');
      if (e.sent) post(e, e.sent.asset, negate(e.sent.amount), 'outgoing');
      e.fees.filter(f => f.deduct).forEach(f => post(e, f.asset, negate(f.amount), 'fees'));
    });
    return [...result.values()].sort((a, b) => a.exchange.localeCompare(b.exchange) || a.wallet.localeCompare(b.wallet) || a.asset.localeCompare(b.asset));
  }
  function reconcileBalance(row, input = {}) {
    const hasOpen = input.open !== undefined && input.open !== '', hasClose = input.close !== undefined && input.close !== '';
    const calculated = hasOpen ? add(input.open, row.movement) : null;
    const difference = hasOpen && hasClose ? sub(calculated, input.close) : null;
    return { calculated, difference, status: difference === null ? 'Enter balances' : difference === '0' ? 'Matched' : 'Difference' };
  }
  function exportCSV(headers, rows) {
    const cell = value => {
      let s = String(value ?? '');
      // Preserve valid negative numeric amounts; neutralise spreadsheet formulas in text fields.
      if (/^[\s]*[=+@-]/.test(s) && !/^-?\d+(?:\.\d+)?$/.test(s)) s = "'" + s;
      return '"' + s.replace(/"/g, '""') + '"';
    };
    return '\uFEFF' + [headers, ...rows].map(row => row.map(cell).join(',')).join('\r\n');
  }
  function validateProject(data) {
    if (!data || data.format !== 'crypto-reconcile' || data.version !== 1 || !Array.isArray(data.entries) || data.entries.length > 100000 || !Array.isArray(data.imports) || !data.balanceInputs || typeof data.balanceInputs !== 'object') throw new Error('This is not a supported Crypto Reconcile project.');
    const ids = new Set();
    data.entries.forEach(e => {
      if (!e || typeof e.uid !== 'string' || !e.uid || ids.has(e.uid)) throw new Error('Invalid or repeated transaction ID in project.');
      ids.add(e.uid);
      if (!['trade', 'trade_leg', 'deposit', 'withdrawal', 'reward', 'fee', 'movement'].includes(e.kind) || typeof e.exchange !== 'string' || !e.exchange || typeof e.wallet !== 'string' || !e.wallet) throw new Error('Invalid transaction in project.');
      if (timestamp(e.date) !== e.date) throw new Error('Invalid transaction date in project.');
      for (const k of ['entryId', 'orderId', 'hash', 'notes', 'label']) if (typeof e[k] !== 'string') throw new Error('Invalid transaction field: ' + k);
      if (!Array.isArray(e.fees) || !Array.isArray(e.sources) || !Array.isArray(e.warnings)) throw new Error('Missing audit data.');
      [...[e.sent, e.received].filter(Boolean), ...e.fees].forEach(l => { if (typeof l.amount !== 'string' || canonical(l.amount) !== l.amount || compare(l.amount, '0') <= 0 || asset(l.asset) !== l.asset) throw new Error('Invalid currency amount in project.'); });
      e.fees.forEach(f => { if (typeof f.deduct !== 'boolean') throw new Error('Invalid fee treatment.'); });
      if (!e.sent && !e.received && !e.fees.length) throw new Error('Empty transaction.');
      e.sources.forEach(s => { if (!s || !Number.isInteger(s.line) || !s.raw || typeof s.raw !== 'object') throw new Error('Invalid source row.'); });
    });
    Object.values(data.balanceInputs).forEach(v => {
      if (!v || typeof v !== 'object') throw new Error('Invalid balance record.');
      for (const k of ['open', 'close', 'openGBP', 'closeGBP']) if (v[k] !== undefined && v[k] !== '') canonical(v[k]);
    });
    data.imports.forEach(i => { if (!i || typeof i.name !== 'string' || !Number.isInteger(i.accepted) || !Array.isArray(i.errors)) throw new Error('Invalid import audit.'); });
    return data;
  }
  return { canonical, add, sub, mul, negate, compare, money, amount, parseCSV, timestamp, suggestMapping, detectLayout, normalise, prepareImport, groupTransactions, balances, reconcileBalance, exportCSV, validateProject };
});
