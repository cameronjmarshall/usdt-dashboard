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
  $('phase').textContent = !state.market ? 'Awaiting quotes' : elapsed()>=300 ? 'Round ended · rolling over' : elapsed()>=180 ? 'All bots: exits only' : elapsed()>=150 ? 'Bot 3 can still buy' : elapsed()>=120 ? 'Bot 3 buy limit: 45¢' : 'All entry windows open';
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
    if(state.config.offline)status='SAVED RESULTS';
    else if(!fresh()&&!p)status='WAITING FOR FEED';
    const rules=bot.id===3?'<strong>40¢</strong> before 2:00 · <strong>45¢</strong> from 2:00–3:00<br>Sell at <strong>60¢</strong> until expiry':`Buy <strong>35¢</strong> before 2:30<br>Sell at <strong>${Math.round(bot.target*100)}¢</strong> until expiry`;
    const position=p?`${esc(p.side)} · ${p.shares.toFixed(2)} shares @ ${cents(p.entry)} · ${p.awaiting_settlement?'Awaiting settlement · ':''}Open P&L ${signed(p.unrealised)}${p.stale?' · <em>stale mark</em>':''}`:b.cash<state.config.stake?`Available cash ${money(b.cash)} is below the ${money(state.config.stake)} entry budget.`:'No position in this market · watching for a qualifying entry';
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
  $('entry-policy').textContent=`One position per bot per market · Re-entry ${c.reentry?'enabled':'disabled'}`;
  $('market-time').textContent=m?`${date(m.start)} · ${shortTime(m.start)} – ${shortTime(m.start+300)} · Your local time`:'Waiting for a market';
  $('market-link').classList.toggle('hidden',!m||c.mode==='demo');
  if(m&&c.mode==='live')$('market-link').href='https://polymarket.com/event/'+encodeURIComponent(m.slug);
  ['Up','Down'].forEach(side=>{
    const last=state.observations.filter(r=>r.side===side).at(-1),id=side.toLowerCase();
    $(id+'-ask').innerHTML=last?.ask!=null?`${(last.ask*100).toFixed(1)}<small>¢</small>`:'—';
    $(id+'-detail').textContent=last?`Buy ask · Sell bid ${cents(last.bid)}`:'Ask / bid unavailable';
  });
  $('sizing-copy').textContent=`Each bot starts with ${money(c.bankroll)}. Each entry spends up to ${money(c.stake)}, including fees. ${c.side==='both'?'Both Up and Down are eligible; the cheaper qualifying outcome is chosen.':c.side+' is the only eligible outcome.'} ${c.reentry?'A bot can re-enter after exiting, while its entry window is still open.':'Each bot can enter only once per market.'}`;
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
