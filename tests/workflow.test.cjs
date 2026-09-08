const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const R=require('../core.js'),W=require('../workflow.js');
function fixture(){const csv=R.parseCSV(fs.readFileSync(path.join(__dirname,'../examples/universal.csv'),'utf8'));return R.normalise(csv,{layout:'dual',mapping:R.suggestMapping(csv.headers),feeMode:'separate'}).entries.map((e,i)=>({...e,uid:'e'+i,fileName:'example.csv'}));}
test('manual combinations retain exact balances, daily rows and raw source records',()=>{
  const before=fixture(),after=W.combine(before,['e1','e2'],'group-1');
  assert.equal(before[1].manualGroup,undefined);
  assert.deepEqual(R.balances(after),R.balances(before));
  assert.deepEqual(after[1].sources,before[1].sources);
  const group=W.displayGroups(after,'combined').find(g=>g.manualGroup==='group-1');
  assert.equal(group.entries.length,2);assert.equal(group.sent.get('USDT'),'15000');assert.equal(group.received.get('BTC'),'0.25');
  assert.equal(W.displayGroups(after,'none').length,before.length);
  assert.deepEqual(W.split(after,['e1']),before);
});
test('manual combination refuses cross-day, account, type and currency-direction selections',()=>{
  const entries=fixture();
  for(const patch of [{exchange:'Other'},{wallet:'Other'},{date:'2026-08-04T00:00:00.000Z'},{kind:'reward'},{sent:{asset:'BTC',amount:'0.1'},received:{asset:'USDT',amount:'6000'}}]){
    const copy=entries.map(e=>e.uid==='e2'?{...e,...patch}:e);assert.throws(()=>W.combine(copy,['e1','e2'],'g'));
  }
  assert.throws(()=>W.combine(entries,['e1','missing'],'g'));
  assert.throws(()=>W.combine(W.combine(entries,['e1','e2'],'g'),['e1','e2'],'again'));
});
test('daily currency movements reconcile to the raw balances including fees',()=>{
  const entries=fixture(),daily=W.dailyRows(entries),balances=R.balances(entries);
  for(const balance of balances){const rows=daily.filter(r=>r.exchange===balance.exchange&&r.wallet===balance.wallet&&r.asset===balance.asset);assert.equal(rows.reduce((n,r)=>R.add(n,r.net),'0'),balance.movement);}
  const buy=daily.find(r=>r.day==='2026-08-03'&&r.asset==='USDT');assert.equal(buy.entries.length,2);assert.equal(buy.outgoing,'15000');assert.equal(buy.fees,'15');assert.equal(buy.net,'-15015');
  assert.equal(W.reviewState(buy,{rate:'0.78'}).netGBP,'-11711.7');
});
test('sign-off requires an explicit rate and reviewer and is invalidated by changed economic data',()=>{
  const entries=fixture(),row=W.dailyRows(entries).find(r=>r.asset==='BTC'&&r.kind==='trade');
  assert.throws(()=>W.sign(row,{reviewer:'CM'}));assert.throws(()=>W.sign(row,{rate:'45000'}));assert.throws(()=>W.sign(row,{rate:'-1',reviewer:'CM'}));
  const signed=W.sign(row,{rate:'45000',reviewer:'CM',comment:'Checked'},'2026-09-08T12:00:00.000Z');
  assert.equal(W.reviewState(row,signed).status,'Signed off');
  assert.equal(W.reviewState(row,{...signed,rate:'45001'}).status,'Recheck');
  assert.equal(W.reviewState(row,{...signed,comment:'Changed'}).status,'Recheck');
  const extra={...entries[1],uid:'late-fill'};
  const changed=W.dailyRows([...entries,extra]).find(r=>r.key===row.key);
  assert.equal(W.reviewState(changed,signed).status,'Recheck');assert.equal(W.reviewState(changed,signed).signedAt,'');
  const reordered=W.dailyRows([...entries].reverse()).find(r=>r.key===row.key);assert.equal(W.reviewState(reordered,signed).status,'Signed off');
});
test('GBP uses a unit rate and an explicit zero valuation is permitted',()=>{
  const row=W.dailyRows([{...fixture()[0],received:{asset:'GBP',amount:'500'}}])[0];
  assert.equal(W.reviewState(row,{}).netGBP,'500');assert.equal(W.sign(row,{reviewer:'CM'}).rate,'1');
  const token=W.dailyRows(fixture()).find(r=>r.asset==='BTC');assert.equal(W.reviewState(token,{rate:'0'}).netGBP,'0');assert.equal(W.sign(token,{rate:'0',reviewer:'CM'}).rate,'0');
});
test('combinations do not invalidate a sign-off because economic entries are unchanged',()=>{
  const entries=fixture(),row=W.dailyRows(entries).find(r=>r.day==='2026-08-03'&&r.asset==='BTC');
  const signed=W.sign(row,{rate:'45000',reviewer:'CM'}),combined=W.combine(entries,['e1','e2'],'g');
  assert.equal(W.reviewState(W.dailyRows(combined).find(r=>r.key===row.key),signed).status,'Signed off');
});
test('v1 projects migrate and v2 roundtrip preserves reviews and combinations',()=>{
  const v1={format:'crypto-reconcile',version:1,entries:fixture(),imports:[],balanceInputs:{}};
  const next=W.validateProject(v1);assert.equal(next.version,2);assert.deepEqual(next.dailyReviews,{});
  next.entries=W.combine(next.entries,['e1','e2'],'g');const row=W.dailyRows(next.entries)[0];next.dailyReviews[row.key]=W.sign(row,{rate:'0.78',reviewer:'CM'});
  const restored=W.validateProject(JSON.parse(JSON.stringify(next)));assert.deepEqual(restored,next);
  restored.entries[1].date='2026-08-04T00:00:00.000Z';assert.throws(()=>W.validateProject(restored));
});
test('report contains open/close, GBP sign-offs, sources and escapes imported text',()=>{
  const entries=fixture(),daily=W.dailyRows(entries),row=daily[0];
  entries[0]={...entries[0],fileName:'<script>alert(1)</script>'};
  const input={open:'0',close:'39940.04',openGBP:'1000',closeGBP:'2000'};
  const balances=R.balances(entries).map(b=>({...b,input,result:R.reconcileBalance(b,input)}));
  const reviews={[row.key]:W.sign(row,{rate:'0.78',reviewer:'CM',comment:'<img src=x>'},'2026-09-08T12:00:00.000Z')};
  const html=W.reportHTML({period:'2026-08',balances,daily,reviews,entries});
  for(const text of ['Open CCY','Statement close','Open GBP','Close GBP','GBP / unit','Signed off','CM','2026-09-08T12:00:00.000Z','Underlying transactions','A4 landscape'])assert.ok(html.includes(text),text);
  assert.ok(!html.includes('<script>'));assert.ok(html.includes('&lt;script&gt;'));assert.ok(html.includes('&lt;img src=x&gt;'));
});
