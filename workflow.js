(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./core.js'));
  else root.ReconcileWorkflow = factory(root.Reconcile);
})(typeof globalThis !== 'undefined' ? globalThis : this, function(R) {
  'use strict';
  const kindName = k => ({trade:'Trade',trade_leg:'Trade',deposit:'Deposit',withdrawal:'Withdrawal',reward:'Reward',fee:'Fee',movement:'Movement'}[k] || k);
  const compatible = e => JSON.stringify([e.exchange,e.wallet,e.date.slice(0,10),e.kind,e.sent?.asset || '',e.received?.asset || '']);
  function combine(entries, ids, groupId) {
    const chosen = new Set(ids), rows = entries.filter(e => chosen.has(e.uid));
    if (rows.length !== chosen.size || rows.length < 2) throw new Error('Select at least two existing entries.');
    if (!groupId || entries.some(e => e.manualGroup === groupId)) throw new Error('Choose a new combination ID.');
    if (rows.some(e => e.manualGroup)) throw new Error('Split the existing combination first, then select the entries to combine.');
    if (rows.some(e => compatible(e) !== compatible(rows[0]))) throw new Error('Combine entries from the same exchange, account, UTC day, transaction type and currency direction. Buys and sells stay separate.');
    return entries.map(e => chosen.has(e.uid) ? {...e,manualGroup:groupId} : e);
  }
  function split(entries, ids) {
    const chosen = new Set(ids), groups = new Set(entries.filter(e => chosen.has(e.uid) && e.manualGroup).map(e => e.manualGroup));
    return entries.map(e => { if (!groups.has(e.manualGroup)) return e; const copy={...e}; delete copy.manualGroup; return copy; });
  }
  function displayGroups(entries, mode) {
    if (mode !== 'order' && mode !== 'combined') return R.groupTransactions(entries, mode);
    const manual = new Map(), remainder = [];
    entries.forEach(e => { if (!e.manualGroup) remainder.push(e); else { if (!manual.has(e.manualGroup)) manual.set(e.manualGroup,[]); manual.get(e.manualGroup).push(e); } });
    const result = R.groupTransactions(remainder, mode === 'combined' ? 'none' : 'order');
    for (const [id, rows] of manual) {
      const group = R.groupTransactions(rows, 'day')[0];
      group.key = 'manual:' + id; group.manualGroup = id; result.push(group);
    }
    return result.sort((a,b) => b.date.localeCompare(a.date));
  }
  function dailyRows(entries) {
    const rows = new Map();
    function get(e, asset) {
      const kind = e.kind === 'trade_leg' ? 'trade' : e.kind, day=e.date.slice(0,10);
      const key=JSON.stringify([e.exchange,e.wallet,day,kind,asset]);
      if (!rows.has(key)) rows.set(key,{key,exchange:e.exchange,wallet:e.wallet,day,kind,asset,incoming:'0',outgoing:'0',fees:'0',recordedFees:'0',net:'0',entries:new Map()});
      const row=rows.get(key); row.entries.set(e.uid,e); return row;
    }
    for(const e of entries) {
      if(e.received) {const r=get(e,e.received.asset);r.incoming=R.add(r.incoming,e.received.amount);}
      if(e.sent) {const r=get(e,e.sent.asset);r.outgoing=R.add(r.outgoing,e.sent.amount);}
      for(const f of e.fees) {const r=get(e,f.asset);r.recordedFees=R.add(r.recordedFees,f.amount);if(f.deduct)r.fees=R.add(r.fees,f.amount);}
    }
    return [...rows.values()].map(r=>({...r,net:R.sub(R.sub(r.incoming,r.outgoing),r.fees),entries:[...r.entries.values()]})).sort((a,b)=>a.day.localeCompare(b.day)||a.exchange.localeCompare(b.exchange)||a.wallet.localeCompare(b.wallet)||a.kind.localeCompare(b.kind)||a.asset.localeCompare(b.asset));
  }
  function fingerprint(row, review) {
    return JSON.stringify([row.key,row.entries.map(e=>[e.uid,e.date,e.sent,e.received,e.fees]).sort((a,b)=>a[0].localeCompare(b[0])),String(review.rate ?? ''),String(review.reviewer || ''),String(review.comment || '')]);
  }
  function reviewState(row, review={}) {
    const rate=row.asset==='GBP' ? '1' : review.rate;
    let netGBP=null;
    if(rate!==undefined && rate!=='') {if(R.compare(rate,'0')<0)throw new Error('GBP rates cannot be negative.');netGBP=R.mul(row.net,rate);}
    const current = !!review.signedAt && review.signature===fingerprint(row,{...review,rate});
    return {rate:rate ?? '',netGBP,status:current?'Signed off':review.signedAt?'Recheck':netGBP===null?'Rate needed':'To check',signedAt:current?review.signedAt:'',reviewer:review.reviewer || ''};
  }
  function sign(row, review, now=new Date().toISOString()) {
    const rate=row.asset==='GBP'?'1':String(review.rate ?? '');
    if(rate==='')throw new Error('Enter the GBP value of one unit before signing off.');
    if(R.compare(rate,'0')<0)throw new Error('GBP rates cannot be negative.');
    const reviewer=String(review.reviewer || '').trim();if(!reviewer)throw new Error('Enter your name or initials before signing off.');
    const result={...review,rate:R.canonical(rate),reviewer,signedAt:now};result.signature=fingerprint(row,result);return result;
  }
  function validateProject(data) {
    if(!data || ![1,2].includes(data.version))throw new Error('Unsupported project version.');
    R.validateProject({...data,version:1});
    const next={...data,version:2,dailyReviews:data.dailyReviews || {},workflowAudit:data.workflowAudit || []};
    if(typeof next.dailyReviews!=='object'||Array.isArray(next.dailyReviews)||!Array.isArray(next.workflowAudit))throw new Error('Invalid review data.');
    const manual=new Map();
    next.entries.forEach(e=>{if(e.manualGroup!==undefined){if(typeof e.manualGroup!=='string'||!e.manualGroup)throw new Error('Invalid combination.');if(!manual.has(e.manualGroup))manual.set(e.manualGroup,[]);manual.get(e.manualGroup).push(e);}});
    for(const rows of manual.values())if(rows.length<2||rows.some(e=>compatible(e)!==compatible(rows[0])))throw new Error('An invalid combination was found in this project.');
    for(const r of Object.values(next.dailyReviews)) {
      if(!r||typeof r!=='object')throw new Error('Invalid review row.');
      for(const k of ['rate','reviewer','comment','signedAt','signature'])if(r[k]!==undefined&&typeof r[k]!=='string')throw new Error('Invalid review field.');
      if(r.rate!==undefined&&r.rate!==''&&R.compare(r.rate,'0')<0)throw new Error('Invalid GBP rate.');
    }
    return next;
  }
  const esc = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const numeric = v => v===null||v===undefined||v==='' ? '—' : esc(v);
  function reportHTML({title='Crypto reconciliation',period,exchange,account,balances,daily,reviews,entries,audit=[],generatedAt=new Date().toISOString()}) {
    const signed=daily.filter(r=>reviewState(r,reviews[r.key]).status==='Signed off').length;
    const table=(heads,rows)=>'<div class="table-wrap"><table><thead><tr>'+heads.map(h=>'<th>'+esc(h)+'</th>').join('')+'</tr></thead><tbody>'+rows.join('')+'</tbody></table></div>';
    const tr=cells=>'<tr>'+cells.map(c=>'<td>'+c+'</td>').join('')+'</tr>';
    const balanceTable=table(['Exchange / account','Token','Open CCY','Net movement','Calculated close','Statement close','Difference','Open GBP','Close GBP','Status / comments'],balances.map(b=>tr([esc(b.exchange)+'<small>'+esc(b.wallet)+'</small>',esc(b.asset),numeric(b.input.open),numeric(b.movement),numeric(b.result.calculated),numeric(b.input.close),numeric(b.result.difference),b.input.openGBP===''||b.input.openGBP===undefined?'—':esc(R.money(b.input.openGBP)),b.input.closeGBP===''||b.input.closeGBP===undefined?'—':esc(R.money(b.input.closeGBP)),esc(b.result.status)+'<small>'+esc(b.input.comment)+'</small>'])));
    const dailyTable=table(['Day / account','Type','Token','Received','Sent','Additional fees','GBP / unit','Net GBP','Check / reviewer','Comment'],daily.map(r=>{const saved=reviews[r.key] || {},v=reviewState(r,saved);return tr([esc(r.day)+'<small>'+esc(r.exchange+' / '+r.wallet)+'</small>',esc(kindName(r.kind)),esc(r.asset),numeric(r.incoming),numeric(r.outgoing),numeric(r.fees),numeric(v.rate),v.netGBP===null?'—':esc(R.money(v.netGBP)),esc(v.status)+'<small>'+esc(v.reviewer)+(v.signedAt?' · '+esc(v.signedAt):'')+'</small>',esc(saved.comment)]);}));
    const sourceTable=table(['Date (UTC)','Exchange / account','Type','Sent','Received','Fee / treatment','Source file / line','Entry / order / combination'],entries.map(e=>tr([esc(e.date),esc(e.exchange+' / '+e.wallet),esc(kindName(e.kind)),e.sent?esc(e.sent.amount+' '+e.sent.asset):'—',e.received?esc(e.received.amount+' '+e.received.asset):'—',e.fees.map(f=>esc(f.amount+' '+f.asset+(f.deduct?' additional':' included'))).join('<br>')||'—',esc(e.fileName)+'<small>'+esc(e.sources.map(s=>s.line).join(', '))+'</small>',esc(e.entryId||e.uid)+'<small>'+esc([e.orderId,e.manualGroup].filter(Boolean).join(' / '))+'</small>'])));
    return '<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'"><title>'+esc(title)+'</title><style>body{margin:0;background:#edf1f6;color:#162339;font:15px/1.5 system-ui,sans-serif}.sheet{max-width:1500px;margin:32px auto;padding:40px;background:white;border-top:6px solid #146e58}h1{font-size:30px;margin:0 0 8px;letter-spacing:-.03em}h2{font-size:20px;margin:32px 0 12px}p,small{color:#536579}small{display:block;font-size:11px}.meta{display:flex;gap:32px;flex-wrap:wrap;border-bottom:1px solid #ccd6df;padding-bottom:20px}.stats{display:flex;gap:40px;padding:20px 0}.stats strong{font-size:24px;display:block;color:#146e58}.table-wrap{overflow:auto}table{border-collapse:collapse;width:100%;font-size:12px}th{background:#14283d;color:white;text-align:left;padding:10px;white-space:normal}td{border-bottom:1px solid #dce3eb;padding:10px;vertical-align:top;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}tbody tr:nth-child(even){background:#f4f7fa}.note{font-size:12px;border-left:3px solid #146e58;padding-left:12px}.audit{font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere}footer{margin-top:32px;font-size:12px;color:#536579}@page{size:A4 landscape;margin:12mm}@media print{body{background:white;font-size:10pt}.sheet{margin:0;padding:0;max-width:none;border:0}.table-wrap{overflow:visible}table{font-size:8pt}th,td{padding:5px}thead{display:table-header-group}tr{break-inside:avoid}h2{break-after:avoid}.appendix{break-before:page}.no-print{display:none}th{background:#e4ebf0!important;color:#162339!important}small{font-size:7pt}}</style></head><body><article class="sheet"><h1>'+esc(title)+'</h1><div class="meta"><span>Period: <b>'+esc(period||'All imported dates')+'</b></span><span>Exchange: <b>'+esc(exchange||'All exchanges')+'</b></span><span>Account: <b>'+esc(account||'All accounts')+'</b></span><span>Prepared: '+esc(generatedAt)+'</span></div><div class="stats"><div><strong>'+balances.length+'</strong>Account / token balances</div><div><strong>'+signed+' / '+daily.length+'</strong>Daily rows signed off</div><div><strong>'+entries.length+'</strong>Underlying entries</div></div><p class="no-print">Use your browser’s Print command and choose Save as PDF for a landscape report.</p><h2>Opening and closing balances</h2>'+balanceTable+'<p class="note">Calculated close = opening + received − sent − additional fees. GBP opening/closing values are manual. Quantity matches do not verify GBP valuations.</p><h2>Daily activity and GBP checks</h2>'+dailyTable+'<p class="note">GBP / unit means pounds sterling for one unit of the row’s currency. Net GBP = (received − sent − additional fees) × rate. This is a movement valuation, not profit or a pooled-cost calculation. Blank rates are unvalued. A sign-off is a local review record, not an authenticated signature.</p><section class="appendix"><h2>Underlying transactions</h2>'+sourceTable+'</section><details><summary>Review and combination history ('+audit.length+' events)</summary><pre class="audit">'+esc(JSON.stringify(audit,null,2))+'</pre></details><footer>Crypto Reconcile · Original CSV rows, rates and review history are retained in the saved project.</footer></article></body></html>';
  }
  return {kindName,combine,split,displayGroups,dailyRows,reviewState,sign,fingerprint,validateProject,reportHTML};
});
