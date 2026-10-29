'use strict';
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
const money = n => Number(n || 0).toLocaleString('en-US', {style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:2});
const signed = n => (n > 0 ? '+' : '') + money(n);
const signClass = n => n > .00001 ? 'positive' : n < -.00001 ? 'negative' : '';
const cents = n => n == null ? '—' : (n*100).toFixed(1) + '¢';
const time = n => new Date(n*1000).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
const shortTime = n => new Date(n*1000).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
const date = n => new Date(n*1000).toLocaleDateString([], {day:'2-digit',month:'short'});
let state = null;
let receivedAt = 0;
let requesting = false;

function currentNow(){
  if(!state) return Date.now()/1000;
  return state.now + (state.config.mode === 'demo' || state.config.offline ? 0 : (Date.now()-receivedAt)/1000);
}
function elapsed(){ return state?.market ? currentNow()-state.market.start : 0; }
function limitFor(bot,t){ const phase = bot.windows.find(w => t>=w[0] && t<w[1]); return phase ? phase[2] : null; }
function fresh(){return !!state && !state.config.offline && state.status.connected && state.status.updated != null && currentNow()-state.status.updated <= 5;}

function renderClock(){
  if(!state) return;
  const left = state.market ? Math.max(0, Math.ceil(state.market.start+300-currentNow())) : 300;
  $('countdown').textContent = `${String(Math.floor(left/60)).padStart(2,'0')}:${String(left%60).padStart(2,'0')}`;
  $('phase').textContent = !state.market ? 'Awaiting quotes' : elapsed()>=300 ? 'Round ended · rolling over' : elapsed()>=180 ? 'Bots 1–3: exits · Bots 4–6: hold' : elapsed()>=155 ? 'Midpoint checks complete · Bot 3 can buy' : elapsed()>=150 ? 'Bots 4–6 midpoint check · Bot 3 can buy' : elapsed()>=120 ? 'Bot 3 buy limit: 45¢' : 'Bots 1–3 buying · Bots 4–6 waiting';
  $('feed-light').classList.toggle('ok',fresh());
  const age=state.status.updated==null?null:Math.max(0,currentNow()-state.status.updated);
  $('feed-age').textContent = age==null ? 'No snapshots yet' : `Last quote ${Math.floor(age)}s ago`;
  if(!fresh() && state.status.connected && !state.config.offline) $('feed-message').textContent='Quote feed stale · waiting for a fresh snapshot';
}

function svgLine(points,x,y){
  let previous=null;
  return points.map(p=>{
    const breakLine = previous==null || p.at-previous>5;
    previous=p.at;
    return `${breakLine?'M':'L'}${x(p.at).toFixed(2)},${y(p.value).toFixed(2)}`;
  }).join(' ');
}
function renderPrices(){
  if(!state) return;
  const svg=$('price-chart'), W=760,H=246,L=42,R=17,T=14,B=29;
  const start=state.market?.start || state.now;
  const x=at=>L+(at-start)/300*(W-L-R), y=v=>T+(1-v)*(H-T-B);
  let out='';
  [0,.25,.5,.75,1].forEach(v=>out+=`<line class="grid" x1="${L}" y1="${y(v)}" x2="${W-R}" y2="${y(v)}"/><text class="axis-label" x="${L-9}" y="${y(v)+3}" text-anchor="end">${v*100}¢</text>`);
  [0,60,120,180,240,300].forEach(t=>out+=`<text class="axis-label" x="${x(start+t)}" y="${H-8}" text-anchor="middle">${Math.floor(t/60)}:00</text>`);
  [120,150,180].forEach(t=>out+=`<line class="guide" x1="${x(start+t)}" y1="${T}" x2="${x(start+t)}" y2="${H-B}"/>`);
  const show=$('outcome-filter').value;
  ['Up','Down'].forEach(side=>{
    if(show!=='both' && show!==side)return;
    const color=side==='Up'?'#58d5b0':'#8da9f7';
    const rows=state.observations.filter(r=>r.side===side);
    ['ask','bid'].forEach(field=>{
      const pts=rows.map(r=>({at:r.at,value:r[field]})).filter(r=>r.value!=null);
      if(pts.length)out+=`<path class="price-line" d="${svgLine(pts,x,y)}" stroke="${color}" ${field==='bid'?'stroke-dasharray="4 4" opacity=".45"':''}/>`;
    });
    const last=rows.at(-1);
    if(last?.ask!=null)out+=`<circle cx="${x(last.at)}" cy="${y(last.ask)}" r="3.5" fill="${color}"/>`;
  });
  svg.innerHTML=out;
  $('price-empty').classList.toggle('hidden',state.observations.length>0);
}
function renderPnl(){
  const svg=$('pnl-chart'),W=400,H=230,L=47,R=16,T=18,B=30;
  const points=state.bots.flatMap(b=>b.curve);
  const start=Math.min(state.totals.first_market || state.now,...points.map(p=>p.at)),end=Math.max(start+1,state.now,...points.map(p=>p.at));
  const min=Math.min(0,...points.map(p=>p.pnl)),max=Math.max(0,...points.map(p=>p.pnl));
  const pad=Math.max(1,(max-min)*.15),lo=min-pad,hi=max+pad;
  const x=t=>L+(t-start)/(end-start)*(W-L-R),y=v=>T+(hi-v)/(hi-lo)*(H-T-B);
  let out='';
  for(let i=0;i<4;i++){
    const v=lo+(hi-lo)*i/3;
    out+=`<line class="grid" x1="${L}" x2="${W-R}" y1="${y(v)}" y2="${y(v)}"/><text class="axis-label" x="${L-8}" y="${y(v)+3}" text-anchor="end">$${v.toFixed(Math.abs(v)<10?1:0)}</text>`;
  }
  out+=`<line class="guide" x1="${L}" x2="${W-R}" y1="${y(0)}" y2="${y(0)}"/>`;
  state.bots.forEach(b=>{
    if(!b.curve.length)return;
    // Step path: P&L only changes when a position closes. Truncated curves retain their true cumulative baseline.
    const first=b.curve.length>=800?b.curve[0]:{at:start,pnl:0};
    let d=`M${x(first.at)},${y(first.pnl)}`;
    b.curve.forEach(p=>d+=` H${x(p.at)} V${y(p.pnl)}`);
    const last=b.curve.at(-1);
    d+=` H${x(end)}`;
    out+=`<path class="price-line" stroke="${b.bot.color}" d="${d}"/><circle r="3" cx="${x(end)}" cy="${y(last.pnl)}" fill="${b.bot.color}"/>`;
  });
  out+=`<text class="axis-label" x="${L}" y="${H-7}">${shortTime(start)}</text><text class="axis-label" x="${W-R}" y="${H-7}" text-anchor="end">${shortTime(end)}</text>`;
  svg.innerHTML=out;
  $('pnl-empty').classList.toggle('hidden',points.length>0);
  const closed=state.bots.some(b=>b.closed>0);
  const best=[...state.bots].sort((a,b)=>b.realised-a.realised)[0];
  $('leader-value').textContent=signed(best.realised);
  $('leader-value').className=signClass(best.realised);
  $('leader-name').textContent=closed?`${best.bot.name} · ${best.closed} closed trades · ${best.entries-best.closed} pending`:'No closed trades yet';
}
function renderBots(){
  $('bot-cards').innerHTML=state.bots.map(b=>{
    const p=b.position, bot=b.bot, limit=limitFor(bot,elapsed());
    let status=p?(p.awaiting_settlement?'AWAITING RESULT':'POSITION OPEN'):state.paused?'ENTRIES PAUSED':b.cash<state.config.stake?'LOW CASH':elapsed()>=300?'NEXT MARKET':limit==null?'EXITS ONLY':'WATCHING';
    if(bot.checkpoint!=null && !p && !state.paused)status=elapsed()<150?'WAITING FOR 2:30':'CHECKPOINT PASSED';
    if(state.config.offline)status='SAVED RESULTS';
    else if(!fresh()&&!p)status='WAITING FOR FEED';
    const capped=bot.checkpoint!=null && bot.windows[0][2]<.99;
    const capCents=Math.round(bot.windows[0][2]*100);
    const checkpointPrice=capped?`<strong>80¢ &lt; ask ≤ ${capCents}¢</strong>`:'ask <strong>above 80¢</strong>';
    const rules=bot.checkpoint!=null?`At <strong>2:30</strong>, buy ${checkpointPrice} · $10 incl. fees<br>One attempt · hold to settlement${capped?`<br>${capCents}¢ cap on every fill · forward trial`:''}`:bot.id===3?'<strong>40¢</strong> before 2:00 · <strong>45¢</strong> from 2:00–3:00<br>Sell at <strong>60¢</strong> until expiry':`Buy <strong>35¢</strong> before 2:30<br>Sell at <strong>${Math.round(bot.target*100)}¢</strong> until expiry`;
    const position=p?`${esc(p.side)} · ${p.shares.toFixed(2)} shares @ ${cents(p.entry)} · ${p.awaiting_settlement?'Awaiting settlement · ':''}Open P&L ${signed(p.unrealised)}${p.stale?' · <em>stale mark</em>':''}`:b.cash<(bot.stake??state.config.stake)?`Available cash ${money(b.cash)} is below the ${money(bot.stake??state.config.stake)} entry budget.`:bot.checkpoint!=null?(elapsed()<150?'No position · waiting for the 2:30 checkpoint':'No position · one checkpoint attempt per market'):'No position in this market · watching for a qualifying entry';
    const pendingText=b.pending_settlements?`${b.pending_settlements} awaiting settlement · ${money(b.reserved)} reserved across all open positions. New rounds can trade using available cash.`:'';
    const win=b.closed?`${(b.wins/b.closed*100).toFixed(1)}%`:'—';
    return `<article class="bot-card bot-card-${bot.id}"><div class="bot-top"><span class="bot-name"><i class="dot"></i>${bot.name}</span><span class="bot-state">${status}</span></div><div class="bot-rules">${rules}</div><div class="bot-pnl"><strong class="${signClass(b.realised)}">${signed(b.realised)}</strong><span class="${signClass(b.return_pct)}">${b.return_pct>0?'+':''}${b.return_pct.toFixed(2)}%</span></div><div class="bot-pnl-label">REALISED P&L / STARTING BALANCE</div><div class="bot-metrics"><div><span>Closed / entries</span><strong>${b.closed} / ${b.entries}</strong></div><div><span>Win rate</span><strong>${win}</strong></div><div><span>Target exits</span><strong>${b.targets}</strong></div><div><span>Cash available</span><strong>${money(b.cash)}</strong></div><div><span>Fees paid</span><strong>${money(b.fees)}</strong></div><div><span>Closed drawdown</span><strong>${money(b.max_drawdown)}</strong></div></div><div class="position-info">${position}</div>${pendingText?`<div class="pending-positions">${pendingText}</div>`:""}</article>`;
  }).join('');
}
function renderTrades(){
  if(!state)return;
  const bot=$('bot-filter').value,status=$('trade-filter').value;
  const rows=state.trades.filter(t=>(bot==='all'||String(t.bot)===bot)&&(status==='all'||(status==='closed')===(t.closed!=null)));
  $('trades-empty').classList.toggle('hidden',rows.length>0);
  if(!rows.length){
    $('trades-empty').querySelector('strong').textContent=state.trades.length?'No trades match these filters':'No paper trades yet';
  }
  $('trade-rows').innerHTML=rows.map(t=>{
    const closed=t.closed!=null;
    const botInfo=state.bots.find(b=>b.bot.id===t.bot);
    const pending=!closed && botInfo?.positions?.some(p=>p.id===t.id && p.awaiting_settlement);
    const label=closed?(t.reason==='target'?'Target exit':t.exit===1?'Settled win':'Settled loss'):(pending?'Awaiting result':'Open');
    const start=Number(t.slug.split('-').at(-1));
    return `<tr><td>${time(t.entered)}<small>${date(t.entered)} · ${shortTime(start)}–${shortTime(start+300)}</small></td><td><span class="trade-bot"><i class="dot bot${t.bot}"></i>Bot ${t.bot}</span></td><td class="${t.side==='Up'?'up':'down'}">${esc(t.side)}</td><td>${cents(t.entry)}</td><td>${closed?cents(t.exit):'—'}</td><td>${t.shares.toFixed(3)}</td><td>${money(t.entry_fee+(t.exit_fee||0))}</td><td><span class="trade-status ${closed?'':'pending'}">${label}</span></td><td class="right ${closed?signClass(t.pnl):''}">${closed?signed(t.pnl):'—'}</td></tr>`;
  }).join('');
}
function renderRounds(){
  $('rounds').innerHTML=state.history.length?state.history.map(r=>`<div class="round"><div>${shortTime(r.start)} – ${shortTime(r.start+300)}<small>${date(r.start)} · ${r.entries} entries across bots</small></div><div class="round-result">${r.winner?`${esc(r.winner)} resolved`:currentNow()<r.start+300?'Current market':'Closed round'}<small>Combined closed P&L <span class="${signClass(r.pnl)}">${signed(r.pnl)}</span></small></div></div>`).join(''):'<div class="table-empty"><strong>No markets recorded</strong><p>Keep the collector running to build a forward sample.</p></div>';
}
function render(){
  const c=state.config,m=state.market;
  $('mode-tag').textContent=c.offline?'OFFLINE VIEW':c.mode==='demo'?'SYNTHETIC DEMO':'LIVE DATA';
  $('demo-banner').classList.toggle('hidden',c.mode!=='demo');
  $('market-count').textContent=state.totals.markets.toLocaleString();
  $('sample-count').textContent=state.totals.observations.toLocaleString();
  $('stake').textContent=money(c.stake);$('bankroll').textContent=money(c.bankroll);$('side-setting').textContent=c.side==='both'?'Up & Down':c.side;
  $('feed-message').textContent=state.status.message;
  $('pause').textContent=state.paused?'Resume entries':'Pause entries';$('pause').disabled=c.offline;
  $('entry-policy').textContent=`Bots 1–3: re-entry ${c.reentry?'enabled':'disabled'} · Bots 4–6: one attempt per market`;
  $('market-time').textContent=m?`${date(m.start)} · ${shortTime(m.start)} – ${shortTime(m.start+300)} · Your local time`:'Waiting for a market';
  $('market-link').classList.toggle('hidden',!m||c.mode==='demo');
  if(m&&c.mode==='live')$('market-link').href='https://polymarket.com/event/'+encodeURIComponent(m.slug);
  ['Up','Down'].forEach(side=>{
    const last=state.observations.filter(r=>r.side===side).at(-1),id=side.toLowerCase();
    $(id+'-ask').innerHTML=last?.ask!=null?`${(last.ask*100).toFixed(1)}<small>¢</small>`:'—';
    $(id+'-detail').textContent=last?`Buy ask · Sell bid ${cents(last.bid)}`:'Ask / bid unavailable';
  });
  $('sizing-copy').textContent=`Each bot starts with ${money(c.bankroll)}. Bots 1–3 spend up to ${money(c.stake)} per entry; Bots 4–6 use $10.00. These budgets include fees. ${c.side==='both'?'Both Up and Down are eligible. Bots 1–3 choose the cheaper qualifying outcome; Bots 4–6 require exactly one side above 80¢.':c.side+' is the only eligible outcome.'} ${c.reentry?'Bots 1–3 can re-enter after exiting while their entry windows remain open.':'Bots 1–3 enter at most once per market.'} Bots 4–6 make only one checkpoint attempt per market.`;
  $('fee-copy').textContent=m?`Current fee source: ${m.fee_source}. Fee = shares × ${m.fee_rate} × [price × (1 − price)]^${m.fee_exponent}. Rounded to five decimal places. Fees on entry and target exit; no settlement fee or rebates.`:'Fee metadata is loaded with each market. If unavailable, the documented crypto curve (rate 0.07, exponent 1) is used and labelled as assumed.';
  $('settlement-status').classList.toggle('hidden',!state.status.settlement_message);
  $('settlement-status').textContent=state.status.settlement_message||'';
  renderClock();renderPrices();renderPnl();renderBots();renderTrades();renderRounds();
}
async function refresh(){
  if(requesting)return;
  requesting=true;
  try{
    const response=await fetch('/api/state',{cache:'no-store',signal:AbortSignal.timeout(8000)});
    if(!response.ok)throw new Error(`Collector returned HTTP ${response.status}`);
    state=await response.json();receivedAt=Date.now();render();
  }catch(error){
    $('feed-light').classList.remove('ok');
    $('feed-message').textContent='Dashboard disconnected. Check that the Python process is still running. '+error.message;
    if(state)state.status.connected=false;
  }finally{requesting=false;}
}
$('pause').addEventListener('click',async()=>{
  if(!state)return;
  $('pause').disabled=true;
  try{
    const response=await fetch('/api/pause',{method:'POST',headers:{'Content-Type':'application/json','X-Paper-Lab':'1'},body:JSON.stringify({paused:!state.paused})});
    if(!response.ok)throw new Error('Could not change entry setting');
    await refresh();
  }catch(error){$('feed-message').textContent=error.message;}
  finally{$('pause').disabled=!!state.config.offline;}
});
$('outcome-filter').addEventListener('change',renderPrices);
$('bot-filter').addEventListener('change',renderTrades);
$('trade-filter').addEventListener('change',renderTrades);
$('price-chart').addEventListener('pointermove',event=>{
  if(!state?.observations.length||!state.market)return;
  const rect=event.currentTarget.getBoundingClientRect(),relative=(event.clientX-rect.left)/rect.width;
  const target=state.market.start+Math.max(0,Math.min(1,(relative*760-42)/(760-42-17)))*300;
  const lines=[];let stamp=null;
  ['Up','Down'].forEach(side=>{
    if($('outcome-filter').value!=='both'&&$('outcome-filter').value!==side)return;
    const values=state.observations.filter(p=>p.side===side);
    const near=values.reduce((a,b)=>Math.abs(b.at-target)<Math.abs(a.at-target)?b:a,values[0]);
    if(near){stamp=near.at;lines.push(`${side} · ask ${cents(near.ask)} / bid ${cents(near.bid)}`);}
  });
  if(!lines.length)return;
  const tip=$('price-tip');tip.textContent=`${time(stamp)}\n${lines.join('\n')}`;tip.classList.remove('hidden');
  tip.style.left=Math.max(8,Math.min(rect.width-185,event.clientX-rect.left+12))+'px';tip.style.top='10px';
});
$('price-chart').addEventListener('pointerleave',()=>$('price-tip').classList.add('hidden'));
document.querySelectorAll('.nav-link').forEach(link=>link.addEventListener('click',()=>{
  document.querySelectorAll('.nav-link').forEach(l=>l.classList.remove('active'));link.classList.add('active');
}));
refresh();setInterval(refresh,2000);setInterval(renderClock,250);


let researchState=null, selectedRun=null, loadingResearch=false;
const fullDate=n=>n==null?'—':new Date(n*1000).toLocaleString();
function replayChart(bots){
  const points=bots.flatMap(b=>b.curve),W=540,H=180,L=42,R=12,T=18,B=25;
  if(!points.length)return '<p class="research-note">No closed trades in this period.</p>';
  const low=Math.min(0,...points.map(p=>p.pnl)),high=Math.max(0,...points.map(p=>p.pnl));
  const first=Math.min(...points.map(p=>p.at)),last=Math.max(...points.map(p=>p.at));
  const x=t=>L+(t-first)/Math.max(1,last-first)*(W-L-R),y=v=>T+(high-v)/Math.max(1,high-low)*(H-T-B);
  let svg=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Closed trade cumulative P and L">`;
  [low,high].forEach(v=>svg+=`<text class="axis-label" x="2" y="${y(v)}">${Math.round(v)}</text>`);
  svg+=`<line class="grid" x1="${L}" x2="${W-R}" y1="${y(0)}" y2="${y(0)}"/>`;
  bots.forEach(b=>{if(!b.curve.length)return;let d=`M${x(first)},${y(0)}`;b.curve.forEach(p=>d+=`H${x(p.at)}V${y(p.pnl)}`);svg+=`<path class="price-line" stroke="${esc(b.bot.color)}" d="${d}"/>`;});
  return svg+'</svg>';
}
function showReplay(run){
  selectedRun=run;
  $('bt-export').classList.toggle('hidden',!run?.result);
  if(!run){$('bt-results').innerHTML='';return;}
  if(run.status!=='complete'){
    $('bt-results').textContent=run.status==='failed'?`Experiment failed: ${run.error}`:'Replay in progress. You can leave this page and return later.';
    return;
  }
  const r=run.result;
  $('bt-results').innerHTML=`<p class="research-note">${r.mode==='demo'?'SYNTHETIC DEMO — not profitability evidence. ':''}Candidate: ${r.parameters.candidate.windows.map(w=>`${cents(w[2])} during ${w[0]}–${w[1]}s`).join('; ')} → ${cents(r.parameters.candidate.target)}. ${money(r.parameters.stake)} stake / ${money(r.parameters.bankroll)} starting cash per bot.</p><div class="replay-grid">${[['Development',r.training],['Later validation',r.holdout]].map(([name,p])=>`<article class="replay-period"><h3>${name}</h3><p class="research-note">${fullDate(p.start)} – ${fullDate(p.end)}</p>${replayChart(p.bots)}<div class="table-scroll"><table><thead><tr><th>Strategy</th><th>Net closed P&L</th><th>Closed / entries</th><th>Win rate</th><th>Drawdown</th><th>Reserved</th></tr></thead><tbody>${p.bots.map(b=>`<tr class="${b.bot.id===4?'candidate-row':''}"><td>${esc(b.bot.name)}</td><td class="${signClass(b.realised)}">${signed(b.realised)}</td><td>${b.closed} / ${b.entries}</td><td>${b.closed?(100*b.wins/b.closed).toFixed(1)+'%':'—'}</td><td>${money(b.max_drawdown)}</td><td>${money(b.reserved)}</td></tr>`).join('')}</tbody></table></div><p class="replay-quality">${p.markets} markets · ${p.snapshots.toLocaleString()} paired snapshots · ${p.gaps_over_5s} gaps over 5s · ${p.skipped} rejected snapshots<br>${p.unresolved} markets unresolved at period end · ${p.assumed_fee_markets} markets with assumed fees</p></article>`).join('')}</div><p class="research-note">${esc(r.method)}</p>`;
}
async function refreshResearch(){
  if(loadingResearch)return;loadingResearch=true;
  try{
    const response=await fetch('/api/research',{cache:'no-store',signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new Error(`HTTP ${response.status}`);
    researchState=await response.json();
    const d=researchState.dataset;
    $('dataset-status').textContent=d.rows?`${d.markets} markets · ${Math.floor(d.rows/2).toLocaleString()} paired snapshots · ${fullDate(d.first)} to ${fullDate(d.last)} · ${(d.bytes/1024/1024).toFixed(1)} MB${d.legacy_rows?' · Older snapshots lack replay metadata; select newer dates.':''}`:'No price history yet. Keep the live collector running; backtesting needs at least two completed recorded markets.';
    const b=researchState.backup;
    $('backup-status').textContent=`Backup: ${b.available?fullDate(b.latest):'first backup pending'}. ${b.note}`;
    const running=researchState.runs.some(r=>r.status==='running');$('bt-run').disabled=running;
    $('bt-status').textContent=running?'Replaying recorded markets…':'Ready to test recorded history.';
    const chosen=$('bt-history').value;
    $('bt-history').innerHTML=researchState.runs.length?researchState.runs.map(r=>`<option value="${r.id}">#${r.id} · ${fullDate(r.created)} · ${r.status}</option>`).join(''):'<option value="">No experiments yet</option>';
    if(researchState.runs.some(r=>String(r.id)===chosen))$('bt-history').value=chosen;
    showReplay(researchState.runs.find(r=>String(r.id)===$('bt-history').value));
  }catch(e){$('dataset-status').textContent='Cannot load recorded history: '+e.message;}
  finally{loadingResearch=false;}
}
$('bt-history').addEventListener('change',()=>showReplay(researchState?.runs.find(r=>String(r.id)===$('bt-history').value)));
$('backtest-form').addEventListener('submit',async event=>{
  event.preventDefault();$('bt-run').disabled=true;
  const num=id=>Number($(id).value),windows=[[num('bt-from'),num('bt-until'),num('bt-buy')/100]];
  if($('bt-second').checked)windows.push([num('bt-until'),num('bt-until2'),num('bt-buy2')/100]);
  const timestamp=id=>$(id).value?new Date($(id).value).getTime()/1000:null;
  try{
    const response=await fetch('/api/backtest',{method:'POST',headers:{'Content-Type':'application/json','X-Paper-Lab':'1'},body:JSON.stringify({candidate:{id:4,name:'Candidate',target:num('bt-sell')/100,windows},stake:num('bt-stake'),bankroll:num('bt-bankroll'),side:$('bt-side').value,reentry:$('bt-reentry').value==='yes',start:timestamp('bt-start'),end:timestamp('bt-end')})});
    const data=await response.json();if(!response.ok)throw new Error(data.error||'Could not start replay');
    $('bt-history').value='';await refreshResearch();
  }catch(e){$('bt-status').textContent=e.message;$('bt-run').disabled=false;}
});
$('bt-export').addEventListener('click',()=>{
  if(!selectedRun?.result)return;
  const url=URL.createObjectURL(new Blob([JSON.stringify(selectedRun,null,2)],{type:'application/json'}));
  const a=document.createElement('a');a.href=url;a.download=`poly-backtest-${selectedRun.id}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
refreshResearch();setInterval(refreshResearch,10000);
