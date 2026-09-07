(function () {
  'use strict';
  const R = window.Reconcile, $ = id => document.getElementById(id);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fresh = () => ({ format: 'crypto-reconcile', version: 1, entries: [], imports: [], balanceInputs: {}, demo: false });
  let state = fresh(), dirty = false, view = 'transactions', page = 0, groups = [], draft = null, fileQueue = [], sequence = 0;
  const expanded = new Set(), PAGE_SIZE = 50;
  const uid = prefix => prefix + '-' + Date.now().toString(36) + '-' + (++sequence);
  const names = { trade: 'Trade', trade_leg: 'Trade leg', deposit: 'Deposit', withdrawal: 'Withdrawal', reward: 'Reward', fee: 'Fee', movement: 'Movement' };
  const groupNames = { order: 'Grouped by order', day: 'Daily totals', month: 'Monthly totals', none: 'Individual entries' };
  function notify(message, error = false) { $('notice').textContent = message; $('notice').className = 'notice' + (error ? ' error' : ''); $('notice').hidden = false; }
  function changed() { dirty = true; $('save-project').textContent = 'Save project *'; }
  function number(value) { const [whole, fraction] = String(value).split('.'); return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction ? '.' + fraction : ''); }
  function legHTML(leg) { return leg ? escape(number(leg.amount)) + '<span class="asset-symbol">' + escape(leg.asset) + '</span>' : '—'; }
  function mapHTML(map) { return map.size ? [...map].map(([asset, amount]) => '<span class="asset-amount">' + legHTML({ asset, amount }) + '</span>').join('') : '<span class="subtext">—</span>'; }
  function mapText(map) { return [...map].map(([asset, amount]) => amount + ' ' + asset).join(' | '); }
  function dateText(date) { return date.slice(0, 10).split('-').reverse().join('/'); }
  function filterEntries(includeSearch = true) {
    const period = $('period').value, exchange = $('exchange-filter').value, wallet = $('wallet-filter').value, q = includeSearch ? $('search').value.trim().toLowerCase() : '';
    return state.entries.filter(e => (!period || e.date.startsWith(period)) && (!exchange || e.exchange === exchange) && (!wallet || e.wallet === wallet) && (!q || [e.sent?.asset, e.received?.asset, ...e.fees.map(f => f.asset), e.entryId, e.orderId, e.notes, e.label, e.hash].join(' ').toLowerCase().includes(q)));
  }
  function options(id, values, label) {
    const old = $(id).value;
    $(id).innerHTML = '<option value="">' + label + '</option>' + [...new Set(values)].sort().map(v => '<option value="' + escape(v) + '">' + escape(v) + '</option>').join('');
    if ([...$(id).options].some(o => o.value === old)) $(id).value = old;
  }
  function render() {
    options('exchange-filter', state.entries.map(e => e.exchange), 'All exchanges');
    options('wallet-filter', state.entries.filter(e => !$('exchange-filter').value || e.exchange === $('exchange-filter').value).map(e => e.wallet), 'All accounts');
    const entries = filterEntries(view === 'transactions');
    groups = R.groupTransactions(entries, $('group-mode').value);
    $('nav-count').textContent = state.entries.length.toLocaleString('en-GB');
    $('stat-entries').textContent = state.entries.length.toLocaleString('en-GB');
    $('stat-imports').textContent = state.imports.length ? state.imports.length + ' CSV import' + (state.imports.length === 1 ? '' : 's') : 'No CSVs imported';
    $('stat-groups').textContent = (view === 'balances' ? R.balances(entries).length : groups.length).toLocaleString('en-GB');
    $('stat-group-label').textContent = view === 'balances' ? 'Account / token balances' : groupNames[$('group-mode').value];
    $('stat-review').textContent = entries.filter(e => !e.reviewed).length.toLocaleString('en-GB');
    $('demo-banner').hidden = !state.demo;
    $('page-title').textContent = view === 'transactions' ? 'Transactions' : view === 'balances' ? 'Balances' : 'Import history';
    for (const key of ['transactions', 'balances', 'imports']) $(key + '-view').hidden = view !== key;
    document.querySelectorAll('[data-view]').forEach(b => { b.classList.toggle('active', b.dataset.view === view); if (b.dataset.view === view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    $('filters').hidden = view === 'imports';
    $('group-label').hidden = $('search-label').hidden = view !== 'transactions';
    if (view === 'transactions') renderTransactions();
    if (view === 'balances') renderBalances();
    if (view === 'imports') renderImports();
  }
  function renderTransactions() {
    $('empty-state').hidden = state.entries.length > 0;
    $('transaction-table-wrap').hidden = state.entries.length === 0;
    $('export-transactions').disabled = groups.length === 0;
    $('activity-caption').textContent = state.entries.length ? 'Buy and sell directions stay separate. Expand a row to inspect entries, fees and source data.' : 'Import a CSV to start reconciling.';
    page = Math.max(0, Math.min(page, Math.ceil(groups.length / PAGE_SIZE) - 1));
    $('transaction-body').innerHTML = groups.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((g, offset) => {
      const index = page * PAGE_SIZE + offset, reviewed = g.entries.every(e => e.reviewed), count = g.entries.length;
      const orders = [...new Set(g.entries.map(e => e.orderId).filter(Boolean))];
      const reference = $('group-mode').value === 'order' && orders.length === 1 ? 'Order ' + orders[0] : count + (count === 1 ? ' entry' : ' entries');
      return '<tr class="transaction-row"><td>' + escape(dateText(g.date)) + '<span class="subtext">' + escape(reference) + (g.date.slice(0, 10) !== g.endDate.slice(0, 10) ? ' · to ' + escape(dateText(g.endDate)) : '') + '</span></td><td><span class="pill ' + escape(g.kind) + '">' + escape(names[g.kind]) + '</span></td><td>' + escape(g.exchange) + '<span class="subtext">' + escape(g.wallet) + '</span></td><td class="numeric">' + mapHTML(g.sent) + '</td><td class="numeric positive">' + mapHTML(g.received) + '</td><td><button class="review-button ' + (reviewed ? 'reviewed' : '') + '" data-review="' + index + '" aria-pressed="' + reviewed + '">' + (reviewed ? 'Reviewed' : 'To review') + '</button></td><td><button class="expand-button" data-expand="' + index + '" aria-expanded="' + expanded.has(g.key) + '" aria-label="Details for ' + escape(names[g.kind] + ' ' + dateText(g.date)) + '">' + (expanded.has(g.key) ? '−' : '+') + '</button></td></tr>' + (expanded.has(g.key) ? detailsHTML(g) : '');
    }).join('') || '<tr><td colspan="7" class="no-results">No transactions match these filters.</td></tr>';
    $('pagination').hidden = groups.length === 0;
    $('page-summary').textContent = (page * PAGE_SIZE + 1) + '–' + Math.min((page + 1) * PAGE_SIZE, groups.length) + ' of ' + groups.length + ' rows';
    $('previous-page').disabled = page === 0; $('next-page').disabled = (page + 1) * PAGE_SIZE >= groups.length;
  }
  function detailsHTML(g) {
    return '<tr><td colspan="7" class="details-cell"><div class="detail-content"><h3>' + g.entries.length + ' underlying ' + (g.entries.length === 1 ? 'entry' : 'entries') + '</h3><div class="table-wrap"><table><thead><tr><th>Time (UTC)</th><th>Sent</th><th>Received</th><th>Fee / treatment</th><th>Entry ID</th></tr></thead><tbody>' + g.entries.map(e => '<tr><td>' + escape(e.date.replace('T', ' ').replace('.000Z', '')) + '</td><td>' + legHTML(e.sent) + '</td><td>' + legHTML(e.received) + '</td><td>' + (e.fees.map(f => legHTML(f) + '<span class="subtext">' + (f.deduct ? 'Additional deduction' : 'Already in amounts') + '</span>').join('') || '—') + '</td><td>' + escape(e.entryId || 'Not supplied') + '</td></tr>').join('') + '</tbody></table></div>' + g.entries.map(e => '<div class="raw-row">' + (e.warnings.length ? '<p class="help">' + e.warnings.map(escape).join(' · ') + '</p>' : '') + (e.notes ? '<p class="help">' + escape(e.notes) + '</p>' : '') + e.sources.map(s => '<details><summary>' + escape(e.fileName || 'Source CSV') + ' · line ' + escape(s.line) + '</summary><pre>' + escape(JSON.stringify(s.raw, null, 2)) + '</pre></details>').join('') + '</div>').join('') + '</div></td></tr>';
  }
  function balanceKey(row) { return JSON.stringify([$('period').value || 'all', row.exchange, row.wallet, row.asset]); }
  function balanceRows() {
    const rows = R.balances(filterEntries(false)), existing = new Set(rows.map(r => r.key));
    // Keep manually entered accounts visible even when a period has no transactions.
    for (const key of Object.keys(state.balanceInputs)) {
      let a; try { a = JSON.parse(key); } catch { continue; }
      if (!Array.isArray(a) || a.length !== 4 || a[0] !== ($('period').value || 'all')) continue;
      const [period, exchange, wallet, asset] = a, rowKey = JSON.stringify([exchange, wallet, asset]);
      if (existing.has(rowKey) || ($('exchange-filter').value && exchange !== $('exchange-filter').value) || ($('wallet-filter').value && wallet !== $('wallet-filter').value)) continue;
      rows.push({ key: rowKey, exchange, wallet, asset, incoming: '0', outgoing: '0', fees: '0', movement: '0' });
    }
    return rows;
  }
  function renderBalances() {
    const rows = balanceRows();
    $('stat-groups').textContent = rows.length.toLocaleString('en-GB');
    $('export-balances').disabled = rows.length === 0;
    $('balance-body').innerHTML = rows.map(row => {
      const key = balanceKey(row), input = state.balanceInputs[key] || {}, result = R.reconcileBalance(row, input);
      const field = (name, label) => '<input data-balance-key="' + escape(key) + '" data-field="' + name + '" aria-label="' + escape(label + ' for ' + row.exchange + ' ' + row.wallet + ' ' + row.asset) + '" value="' + escape(input[name] ?? '') + '" placeholder="' + (name.includes('GBP') ? 'Optional' : 'Required') + '" inputmode="decimal" autocomplete="off">';
      return '<tr><td>' + escape(row.exchange) + '<span class="subtext">' + escape(row.wallet) + '</span></td><td>' + escape(row.asset) + '</td><td>' + field('open', 'Opening quantity') + '</td><td class="numeric">' + escape(number(row.movement)) + '</td><td class="numeric">' + (result.calculated === null ? '—' : escape(number(result.calculated))) + '</td><td>' + field('close', 'Statement closing quantity') + '</td><td class="numeric ' + (result.difference === '0' ? 'positive' : result.difference === null ? '' : 'negative') + '">' + (result.difference === null ? '—' : escape(number(result.difference))) + '</td><td>' + field('openGBP', 'Opening GBP value') + '</td><td>' + field('closeGBP', 'Closing GBP value') + '</td><td><span class="pill ' + (result.status === 'Matched' ? 'matched' : result.status === 'Difference' ? 'difference' : '') + '">' + result.status + '</span></td><td><input class="comment-input" data-balance-key="' + escape(key) + '" data-field="comment" aria-label="' + escape('Comment for ' + row.exchange + ' ' + row.wallet + ' ' + row.asset) + '" value="' + escape(input.comment || '') + '" placeholder="Add comment"></td></tr>';
    }).join('') || '<tr><td colspan="11" class="no-results">Import transactions to reconcile account balances.</td></tr>';
  }
  function renderImports() {
    $('imports-list').innerHTML = [...state.imports].reverse().map(i => '<article class="import-card"><h3>' + escape(i.name) + '</h3><p>' + escape(i.accepted) + ' imported · ' + escape(i.duplicates || 0) + ' duplicates excluded · ' + escape(i.errors.length) + ' invalid / conflicting rows</p><p>' + escape(i.exchange || 'Exchanges from CSV') + ' · ' + escape(i.date ? i.date.slice(0, 16).replace('T', ' ') + ' UTC' : '') + '</p>' + (i.errors.length ? '<details><summary>View excluded rows</summary><pre>' + escape(JSON.stringify(i.errors, null, 2)) + '</pre></details>' : '') + '<details><summary>Import settings</summary><pre>' + escape(JSON.stringify(i.config || {}, null, 2)) + '</pre></details></article>').join('') || '<p class="no-results">Your imported CSVs will appear here.</p>';
  }
  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type })), link = document.createElement('a');
    link.href = url; link.download = name; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  function exportTransactions() {
    const headers = ['Date UTC', 'End date UTC', 'Type', 'Exchange', 'Account', 'Sent', 'Received', 'Fees by currency', 'Entry count', 'Order IDs', 'Reviewed', 'Source lines'];
    const rows = groups.map(g => [g.date, g.endDate, names[g.kind], g.exchange, g.wallet, mapText(g.sent), mapText(g.received), mapText(g.fees), g.entries.length, [...new Set(g.entries.map(e => e.orderId).filter(Boolean))].join(' | '), g.entries.every(e => e.reviewed) ? 'Yes' : 'No', g.entries.map(e => (e.fileName || 'CSV') + ':' + e.sources.map(s => s.line).join(',')).join(' | ')]);
    download('crypto-transactions-' + ($('period').value || 'all-dates') + '.csv', R.exportCSV(headers, rows), 'text/csv;charset=utf-8');
  }
  function exportBalances() {
    if (!validBalanceInputs()) return;
    const headers = ['Period UTC', 'Exchange', 'Account', 'Token', 'Open CCY', 'Received', 'Sent', 'Additional fees', 'Net movement', 'Calculated close CCY', 'Statement close CCY', 'Difference CCY', 'Open GBP', 'Close GBP', 'Status', 'Comments'];
    const rows = balanceRows().map(row => { const v = state.balanceInputs[balanceKey(row)] || {}, r = R.reconcileBalance(row, v); return [$('period').value || 'All imported dates', row.exchange, row.wallet, row.asset, v.open, row.incoming, row.outgoing, row.fees, row.movement, r.calculated, v.close, r.difference, v.openGBP, v.closeGBP, r.status, v.comment]; });
    download('crypto-balances-' + ($('period').value || 'all-dates') + '.csv', R.exportCSV(headers, rows), 'text/csv;charset=utf-8');
  }
  const fieldLabels = { date: 'Date / time *', exchange: 'Exchange', wallet: 'Ledger / account', entryId: 'Unique fill / entry ID', orderId: 'Shared order / reference ID', hash: 'Transaction hash', kind: 'Type / label', notes: 'Description / notes', sentAmount: 'Sent amount', sentAsset: 'Sent currency', receivedAmount: 'Received amount', receivedAsset: 'Received currency', feeAmount: 'Fee amount', feeAsset: 'Fee currency', side: 'Buy / sell *', base: 'Base currency', quote: 'Quote currency', pair: 'Pair (BTC/USDT)', quantity: 'Base quantity *', total: 'Quote total', price: 'Price (if total absent)', asset: 'Currency *', amount: 'Signed amount *' };
  const layoutFields = { dual: ['date', 'sentAmount', 'sentAsset', 'receivedAmount', 'receivedAsset'], trade: ['date', 'side', 'quantity', 'total', 'price', 'base', 'quote', 'pair'], movement: ['date', 'asset', 'amount'] };
  const commonFields = ['feeAmount', 'feeAsset', 'entryId', 'orderId', 'exchange', 'wallet', 'kind', 'hash', 'notes'];
  function readMapping() { const mapping = { ...draft.mapping }; document.querySelectorAll('[data-map]').forEach(s => { mapping[s.dataset.map] = s.value; }); return mapping; }
  function renderMapping() {
    $('mapping-grid').innerHTML = [...layoutFields[$('layout').value], ...commonFields].map(field => '<label>' + fieldLabels[field] + '<select data-map="' + field + '"><option value="">Not mapped</option>' + draft.parsed.headers.map(h => '<option value="' + escape(h) + '"' + (draft.mapping[field] === h ? ' selected' : '') + '>' + escape(h) + '</option>').join('') + '</select></label>').join('');
    $('trade-defaults').hidden = $('layout').value !== 'trade';
  }
  function config() {
    return { layout: $('layout').value, mapping: readMapping(), exchange: $('import-exchange').value.trim(), wallet: $('import-wallet').value.trim() || 'Main', dateOrder: $('date-order').value, offsetMinutes: Number($('timezone').value), decimalSeparator: $('decimal-separator').value, feeMode: $('fee-mode').value, base: $('default-base').value.trim(), quote: $('default-quote').value.trim(), feeAsset: $('default-fee').value.trim() };
  }
  function invalidatePreview() { if (draft) draft.preview = null; $('confirm-import').disabled = true; $('import-preview').innerHTML = '<p>Preview the import after changing these settings.</p>'; }
  async function nextFile() {
    const file = fileQueue.shift(); if (!file) return;
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error('Choose a CSV smaller than 20 MB.');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()), parsed = R.parseCSV(text), mapping = R.suggestMapping(parsed.headers);
      draft = { file, text, parsed, mapping, preview: null };
      $('import-filename').textContent = file.name + ' · ' + parsed.rows.length + ' source rows' + (fileQueue.length ? ' · ' + fileQueue.length + ' files next' : '');
      $('layout').value = R.detectLayout(mapping);
      $('import-exchange').value = /kraken|coinbase|binance|bullish|falconx|ledger|okx|bybit|kucoin/i.exec(file.name)?.[0] || '';
      $('import-wallet').value = 'Main'; $('fee-mode').value = ''; $('default-base').value = $('default-quote').value = $('default-fee').value = '';
      renderMapping(); invalidatePreview();
      $('source-preview').innerHTML = '<table><thead><tr>' + parsed.headers.map(h => '<th>' + escape(h) + '</th>').join('') + '</tr></thead><tbody>' + parsed.rows.slice(0, 4).map(row => '<tr>' + row.cells.map(v => '<td>' + escape(v) + '</td>').join('') + '</tr>').join('') + '</tbody></table>';
      $('import-dialog').showModal();
    } catch (error) { notify(file.name + ': ' + error.message, true); fileQueue = []; }
  }
  function previewImport() {
    try {
      const cfg = config(), parsed = R.normalise(draft.parsed, cfg);
      let report = R.prepareImport(state.entries, parsed.entries);
      const identicalFile = state.imports.some(i => i.text === draft.text && JSON.stringify(i.config) === JSON.stringify(cfg));
      if (identicalFile) report = { accepted: [], duplicates: parsed.entries, conflicts: [], possible: [] };
      draft.preview = { cfg, parsed, report };
      const errors = [...parsed.errors, ...report.conflicts.map(e => ({ line: e.sources[0].line, message: 'This entry ID has different transaction details. Resolve it in the CSV before importing.' }))];
      const previewEntries = [...report.accepted, ...report.possible].slice(0, 4);
      $('import-preview').innerHTML = '<div class="preview-numbers"><span><strong>' + report.accepted.length + '</strong> new entries</span><span>' + report.duplicates.length + ' duplicates</span><span>' + report.possible.length + ' possible duplicates</span><span>' + errors.length + ' invalid / conflicting rows</span></div>' +
        (identicalFile ? '<p>This file has already been imported with these settings.</p>' : '') +
        (errors.length ? '<ul>' + errors.slice(0, 30).map(e => '<li>Line ' + escape(e.line) + ': ' + escape(e.message) + '</li>').join('') + (errors.length > 30 ? '<li>Further errors will be saved in import history.</li>' : '') + '</ul><label class="checkbox-label"><input type="checkbox" id="ack-errors">I have checked these errors. Import the valid rows and retain excluded rows in import history.</label>' : '') +
        (report.possible.length ? '<label>Matching entries without a unique ID already exist. How should these rows be treated?<select id="possible-action"><option value="">Choose after checking the source</option><option value="skip">Exclude these possible duplicates</option><option value="keep">Keep them as additional transactions</option></select></label>' : '') +
        (previewEntries.length ? '<div class="table-wrap"><table><thead><tr><th>Date (UTC)</th><th>Type</th><th>Sent</th><th>Received</th><th>Additional fees</th></tr></thead><tbody>' + previewEntries.map(e => '<tr><td>' + escape(e.date.replace('T', ' ').replace('.000Z', '')) + '</td><td>' + escape(names[e.kind]) + '</td><td>' + legHTML(e.sent) + '</td><td>' + legHTML(e.received) + '</td><td>' + (e.fees.filter(f => f.deduct).map(legHTML).join(' | ') || '—') + '</td></tr>').join('') + '</tbody></table></div>' : '') +
        (parsed.entries.some(e => e.warnings.length) ? '<p class="help">Some entries have review notes. Expand their rows after import to inspect them.</p>' : '');
      updateConfirm();
    } catch (error) { draft.preview = null; $('confirm-import').disabled = true; $('import-preview').innerHTML = '<p class="negative">' + escape(error.message) + '</p>'; }
  }
  function updateConfirm() {
    const p = draft?.preview;
    $('confirm-import').disabled = !p || (!!$('ack-errors') && !$('ack-errors').checked) || (!!$('possible-action') && !$('possible-action').value) || (p.parsed.entries.length === 0);
  }
  function confirmImport() {
    if ($('confirm-import').disabled || !draft?.preview) return;
    const { cfg, parsed, report } = draft.preview, keep = $('possible-action')?.value === 'keep';
    const entries = [...report.accepted, ...(keep ? report.possible : [])];
    if (state.entries.length + entries.length > 100000) { $('import-preview').innerHTML = '<p>A project supports 100,000 entries. Save this project and start another period.</p>'; $('confirm-import').disabled = true; return; }
    const importId = uid('import');
    entries.forEach(e => { e.uid = uid('entry'); e.importId = importId; e.fileName = draft.file.name; e.reviewed = false; });
    const errors = [...parsed.errors, ...report.conflicts.map(e => ({ line: e.sources[0].line, message: 'Conflicting unique entry ID', raw: e.sources[0].raw }))];
    const importRecord = { id: importId, name: draft.file.name, date: new Date().toISOString(), exchange: cfg.exchange, accepted: entries.length, duplicates: report.duplicates.length + (keep ? 0 : report.possible.length), errors, config: cfg, text: draft.text };
    const nextState = { ...state, entries: [...state.entries, ...entries], imports: [...state.imports, importRecord] };
    if (new Blob([JSON.stringify(nextState)]).size > 99 * 1024 * 1024) { $('import-preview').innerHTML = '<p>This would exceed the project file limit. Save the current project and start another period.</p>'; $('confirm-import').disabled = true; return; }
    state = nextState;
    changed(); view = 'transactions'; page = 0; $('search').value = ''; $('exchange-filter').value = ''; $('wallet-filter').value = ''; $('period').value = '';
    $('import-dialog').close(); notify(entries.length + ' entries imported. ' + errors.length + ' invalid / conflicting rows excluded. Review the grouped rows before reconciling balances.'); draft = null; render(); nextFile();
  }
  function reset() {
    if (dirty && !window.confirm('Start a new project? Save your current project first if you want to keep these changes.')) return false;
    state = fresh(); dirty = false; expanded.clear(); page = 0; $('save-project').textContent = 'Save project'; $('period').value = ''; $('search').value = ''; $('notice').hidden = true; render(); return true;
  }
  function beginImport() { if (state.demo && !reset()) return; $('csv-file').value = ''; $('csv-file').click(); }
  document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => { view = b.dataset.view; page = 0; render(); }));
  for (const id of ['period', 'exchange-filter', 'wallet-filter', 'group-mode']) $(id).addEventListener('change', () => { page = 0; expanded.clear(); render(); });
  $('search').addEventListener('input', () => { page = 0; render(); });
  $('clear-period').addEventListener('click', () => { $('period').value = ''; page = 0; render(); });
  $('previous-page').addEventListener('click', () => { page--; renderTransactions(); }); $('next-page').addEventListener('click', () => { page++; renderTransactions(); });
  $('transaction-body').addEventListener('click', event => {
    const expand = event.target.closest('[data-expand]'), review = event.target.closest('[data-review]');
    if (expand) { const g = groups[Number(expand.dataset.expand)]; expanded.has(g.key) ? expanded.delete(g.key) : expanded.add(g.key); renderTransactions(); }
    if (review) { const g = groups[Number(review.dataset.review)], next = !g.entries.every(e => e.reviewed); g.entries.forEach(e => { e.reviewed = next; }); changed(); render(); }
  });
  $('balance-body').addEventListener('change', event => {
    const input = event.target.closest('[data-balance-key]'); if (!input) return;
    try {
      const key = input.dataset.balanceKey, field = input.dataset.field, value = input.value.trim();
      const normalized = field === 'comment' || value === '' ? value : R.amount(value, '.');
      state.balanceInputs[key] = { ...(state.balanceInputs[key] || {}), [field]: normalized };
      input.setCustomValidity(''); input.value = normalized; changed();
      const row = balanceRows().find(r => balanceKey(r) === key), result = R.reconcileBalance(row, state.balanceInputs[key]), cells = input.closest('tr').cells;
      cells[4].textContent = result.calculated === null ? '—' : number(result.calculated);
      cells[6].textContent = result.difference === null ? '—' : number(result.difference);
      cells[6].className = 'numeric ' + (result.difference === '0' ? 'positive' : result.difference === null ? '' : 'negative');
      cells[9].innerHTML = '<span class="pill ' + (result.status === 'Matched' ? 'matched' : result.status === 'Difference' ? 'difference' : '') + '">' + result.status + '</span>';
    } catch (error) { input.setCustomValidity(error.message); input.reportValidity(); }
  });
  $('balance-body').addEventListener('input', event => event.target.setCustomValidity?.(''));
  function validBalanceInputs() { const invalid = $('balance-body').querySelector('input:invalid'); if (invalid) { invalid.reportValidity(); return false; } return true; }
  $('export-transactions').addEventListener('click', exportTransactions); $('export-balances').addEventListener('click', exportBalances);
  $('import-button').addEventListener('click', beginImport); $('empty-import').addEventListener('click', beginImport);
  $('csv-file').addEventListener('change', () => { fileQueue = [...$('csv-file').files]; nextFile(); });
  $('layout').addEventListener('change', () => { draft.mapping = readMapping(); renderMapping(); invalidatePreview(); });
  $('import-dialog').addEventListener('change', event => { if (event.target.id === 'ack-errors' || event.target.id === 'possible-action') updateConfirm(); else if (event.target.id !== 'layout') invalidatePreview(); });
  $('import-dialog').addEventListener('input', event => { if (event.target.tagName === 'INPUT' && event.target.id !== 'ack-errors') invalidatePreview(); });
  $('close-import').addEventListener('click', () => { fileQueue = []; draft = null; $('import-dialog').close(); });
  $('import-dialog').addEventListener('cancel', () => { fileQueue = []; draft = null; });
  $('preview-import').addEventListener('click', previewImport); $('confirm-import').addEventListener('click', confirmImport);
  $('new-project').addEventListener('click', reset); $('exit-demo').addEventListener('click', reset);
  $('save-project').addEventListener('click', () => {
    if (!validBalanceInputs()) return;
    download('crypto-reconcile-' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify({ ...state, savedAt: new Date().toISOString() }), 'application/json');
    dirty = false; $('save-project').textContent = 'Save project'; notify('Project download prepared. Keep the JSON file to reopen your entries, source rows and balance checks.');
  });
  $('open-project').addEventListener('click', () => { $('project-file').value = ''; $('project-file').click(); });
  $('project-file').addEventListener('change', async () => {
    const file = $('project-file').files[0]; if (!file) return;
    try {
      if (file.size > 100 * 1024 * 1024) throw new Error('Choose a project file smaller than 100 MB.');
      const restored = R.validateProject(JSON.parse(await file.text()));
      if (dirty && !window.confirm('Replace this workspace with the saved project? Unsaved changes will be lost.')) return;
      state = restored; dirty = false; page = 0; expanded.clear(); $('period').value = ''; $('search').value = ''; $('save-project').textContent = 'Save project'; render(); notify('Opened ' + file.name + '.');
    } catch (error) { notify('Could not open the project: ' + error.message, true); }
  });
  window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
  const DEMO_CSV = `Date,Exchange,Wallet,Sent Amount,Sent Currency,Received Amount,Received Currency,Fee Amount,Fee Currency,Order ID,Transaction ID,Label,Description
2026-08-01 09:00:00,Kraken,Trading,,,50000,USDT,,,,sample-deposit,deposit,Opening funding
2026-08-03 10:00:01,Kraken,Trading,6000,USDT,0.1,BTC,6,USDT,BTC-BUY-101,sample-fill-1,trade,First order fill
2026-08-03 10:00:02,Kraken,Trading,9000,USDT,0.15,BTC,9,USDT,BTC-BUY-101,sample-fill-2,trade,Second order fill
2026-08-08 15:00:00,Kraken,Trading,0.08,BTC,4960,USDT,4.96,USDT,BTC-SELL-102,sample-sell,trade,Partial sale
2026-08-09 11:00:00,Kraken,Trading,0.05,BTC,,,0.0001,BTC,,sample-send,withdrawal,Sent to Ledger
2026-08-09 11:12:00,Ledger,Ledger 21 wallet 3,,,0.05,BTC,,,,sample-receive,deposit,Received from exchange
2026-08-10 09:00:00,Ledger,Ledger 21 wallet 3,,,500,TRX,,,,sample-trx-deposit,deposit,TRX funding
2026-08-11 10:00:00,Ledger,Ledger 21 wallet 3,100,TRX,,,1.2,TRX,,sample-trx-send,withdrawal,TRX transfer
2026-08-12 10:00:00,Kraken,Trading,,,0.00001234,BTC,,,,sample-reward,reward,Reward credit
2026-08-15 10:00:00,Kraken,Trading,2500,USDT,0.7,ETH,2.5,USDT,ETH-BUY-103,sample-eth-buy,trade,ETH purchase
2026-08-16 11:00:00,Kraken,Trading,0.1,ETH,400,USDT,0.4,USDT,ETH-SELL-104,sample-eth-sell,trade,ETH sale
2026-08-20 09:00:00,Kraken,Trading,,,2,ETH,,,,sample-eth-deposit,deposit,ETH deposit`;
  $('load-demo').addEventListener('click', () => {
    if (!reset()) return;
    const parsed = R.parseCSV(DEMO_CSV), cfg = { layout: 'dual', mapping: R.suggestMapping(parsed.headers), feeMode: 'separate', dateOrder: 'dmy', offsetMinutes: 0, decimalSeparator: '.', exchange: '', wallet: 'Main' };
    const normalized = R.normalise(parsed, cfg), id = uid('import');
    if (normalized.errors.length) { notify('Sample data failed validation.', true); return; }
    state.entries = normalized.entries.map(e => ({ ...e, uid: uid('entry'), importId: id, fileName: 'fictional-sample.csv', reviewed: false }));
    state.imports = [{ id, name: 'fictional-sample.csv', date: new Date().toISOString(), accepted: state.entries.length, duplicates: 0, errors: [], config: cfg, text: DEMO_CSV }]; state.demo = true;
    R.balances(state.entries).forEach(r => { state.balanceInputs[JSON.stringify(['all', r.exchange, r.wallet, r.asset])] = { open: '0', close: r.asset === 'ETH' ? R.sub(r.movement, '0.01') : r.movement, comment: r.asset === 'ETH' ? 'Sample discrepancy to investigate' : '' }; });
    changed(); view = 'transactions'; render(); notify('Sample loaded. The two BTC purchase fills appear as one trade. Balances includes a fictional 0.01 ETH difference.');
  });
  render();
})();
