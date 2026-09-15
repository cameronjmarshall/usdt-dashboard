'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Search, ArrowRight, RefreshCw, Info, Database, CircleAlert, ExternalLink } from 'lucide-react';
import { AreaChart, Area, BarChart, Bar, LineChart, Line, CartesianGrid, XAxis, YAxis, Tooltip as ChartTooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { METRICS, RANGES, metricsFor, metricText, numberText, compact, isNumber, periodReturn, normaliseCurrency, type FxData, type PriceData, type Fundamentals, type Range, type Metric, type MetricId } from '@/lib/finance';

const LETTER = 'https://www.fundsmith.co.uk/media/4hcfd1pg/2025-fef-annual-letter-web.pdf';
const MANUAL = 'https://www.fundsmith.co.uk/media/mv3abv1h/fef-owners-manual-a4-2025.pdf';
const QUICK = ['MSFT', 'AAPL', 'NVDA', 'GOOGL', 'ULVR.L', 'DGE.L'];
const RANGE_LABEL: Record<Range, string> = { '1mo':'1M', '3mo':'3M', '6mo':'6M', ytd:'YTD', '1y':'1Y', '5y':'5Y', max:'MAX', custom:'Custom' };
const COLOURS = ['#c5ef69', '#71b7ff', '#b997ff'];
const AXIS = { fill:'#94a5bb', fontSize:12 };
const dateText = (date: string) => new Date(date + 'T12:00:00Z').toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric', timeZone:'UTC' });
const shortDate = (date: string) => new Date(date + 'T12:00:00Z').toLocaleDateString('en-GB', { month:'short', year:'2-digit', timeZone:'UTC' });
const timeText = (time: number | null | undefined) => time ? new Date(time * 1000).toLocaleString('en-GB', { day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit', timeZone:'Europe/London' }) + ' London' : 'Quote time unavailable';

function Choice({ value, onChange, label, options, className = '' }: { value: string; onChange: (v: string) => void; label: string; options: {value:string; label:string}[]; className?: string }) {
  return <Select value={value} onValueChange={onChange}><SelectTrigger aria-label={label} className={'select-control ' + className}><SelectValue /></SelectTrigger><SelectContent>{options.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent></Select>;
}
function Help({ metric, reason }: {metric:Metric; reason?:string | null}) {
  return <Tooltip><TooltipTrigger asChild><button className="info-button" aria-label={metric.label + ': formula and data notes'}><Info size={14} /></button></TooltipTrigger><TooltipContent className="formula-tooltip" side="top" sideOffset={7}><strong>{metric.formula}</strong>{reason && <p>{reason}</p>}<p>{metric.note}</p></TooltipContent></Tooltip>;
}
function StateBox({ loading, error, retry, label }: {loading:boolean; error?:string; retry?:()=>void; label:string}) {
  return <div className="state-box" role="status" aria-live="polite">{loading ? <RefreshCw size={25} className="spin" /> : <CircleAlert size={25} />}<strong>{loading ? 'Loading ' + label + '…' : label + ' unavailable'}</strong>{!loading && <p>{error || 'The provider did not return data for this selection.'}</p>}{!loading && retry && <button className="quiet-button" onClick={retry}>Try again</button>}</div>;
}
function PlotTooltip({ active, payload, label, money=false, currency='', date=false }: any) {
  if (!active || !payload?.length) return null;
  return <div className="chart-tooltip"><p>{date && typeof label === 'string' ? dateText(label) : label}</p>{payload.filter((p:any) => isNumber(p.value)).map((p:any) => <div key={p.dataKey}><span style={{color:p.color}}>{p.name}</span><strong>{money ? compact(p.value) : numberText(p.value, 2)}{money ? ' ' + currency : '%'}</strong></div>)}</div>;
}
export default function Dashboard() {
  const [symbol, setSymbol] = useState('MSFT');
  const [input, setInput] = useState('');
  const [range, setRange] = useState<Range>('1y');
  const [customOpen, setCustomOpen] = useState(false);
  const [start, setStart] = useState('2025-01-01');
  const [end, setEnd] = useState('');
  const [dates, setDates] = useState({start:'', end:''});
  const [formError, setFormError] = useState('');
  const [basis, setBasis] = useState('close');
  const [priceView, setPriceView] = useState('price');
  const [priceData, setPriceData] = useState<PriceData | null>(null);
  const [fundData, setFundData] = useState<Fundamentals | null>(null);
  const [priceLoading, setPriceLoading] = useState(true);
  const [fundLoading, setFundLoading] = useState(true);
  const [priceError, setPriceError] = useState('');
  const [fundError, setFundError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [fiscalDate, setFiscalDate] = useState('');
  const [financialRange, setFinancialRange] = useState('all');
  const [qualitySeries, setQualitySeries] = useState('margins');
  const [fx, setFx] = useState<FxData | null>(null);
  const [fxLoading, setFxLoading] = useState(false);
  const [fxError, setFxError] = useState('');
  useEffect(() => {
    setEnd(new Date().toISOString().slice(0,10));
    const oneYearAgo = new Date(); oneYearAgo.setUTCFullYear(oneYearAgo.getUTCFullYear()-1); setStart(oneYearAgo.toISOString().slice(0,10));
    const savedSymbol = new URLSearchParams(window.location.search).get('ticker');
    if (savedSymbol && /^[A-Za-z0-9^][A-Za-z0-9.^=\-]{0,23}$/.test(savedSymbol)) setSymbol(savedSymbol.toUpperCase());
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setPriceLoading(true); setPriceError(''); setPriceData(null);
    const query = new URLSearchParams({ symbol, range });
    if (range === 'custom') { query.set('start', dates.start); query.set('end', dates.end); }
    fetch('/api/chart?' + query, { signal:controller.signal }).then(async r => {
      const data = await r.json() as PriceData & {error?:string}; if (!r.ok) throw new Error(data.error || 'Unable to load prices.');
      if (!controller.signal.aborted) setPriceData(data);
    }).catch(e => { if (!controller.signal.aborted) setPriceError(e.message || 'Unable to load prices.'); }).finally(() => { if (!controller.signal.aborted) setPriceLoading(false); });
    return () => controller.abort();
  }, [symbol, range, dates, refresh]);
  useEffect(() => {
    const controller = new AbortController();
    setFundLoading(true); setFundError(''); setFundData(null); setFiscalDate('');
    fetch('/api/fundamentals?' + new URLSearchParams({symbol}), {signal:controller.signal}).then(async r => {
      const data = await r.json() as Fundamentals & {error?:string}; if (!r.ok) throw new Error(data.error || 'Unable to load financial statements.');
      if (!controller.signal.aborted) setFundData(data);
    }).catch(e => { if (!controller.signal.aborted) setFundError(e.message || 'Unable to load financial statements.'); }).finally(() => { if (!controller.signal.aborted) setFundLoading(false); });
    return () => controller.abort();
  }, [symbol, refresh]);
  const price = priceData?.symbol === symbol ? priceData : null;
  const fundamentals = fundData?.symbol === symbol ? fundData : null;
  const years = fundamentals?.years || [];
  const selected = Math.max(0, years.findIndex(y => y.date === fiscalDate));
  const year = years[selected], previous = years[selected + 1];
  const reportingCurrency = year?.currency || '';
  const tradingCurrency = normaliseCurrency(price?.currency || '').currency;
  useEffect(() => {
    const controller = new AbortController();
    setFx(null); setFxError(''); setFxLoading(false);
    if (!reportingCurrency || !tradingCurrency || reportingCurrency === tradingCurrency) return;
    setFxLoading(true);
    fetch('/api/fx?' + new URLSearchParams({from:reportingCurrency, to:tradingCurrency}), {signal:controller.signal}).then(async r => {
      const data = await r.json() as FxData & {error?:string};
      if (!r.ok) throw new Error(data.error || 'FX conversion is unavailable.');
      if (!controller.signal.aborted) setFx(data);
    }).catch(e => {if (!controller.signal.aborted) setFxError(e.message);}).finally(()=>{if (!controller.signal.aborted) setFxLoading(false);});
    return () => controller.abort();
  }, [reportingCurrency, tradingCurrency, refresh]);
  const activeFx = fx?.from === reportingCurrency && fx?.to === tradingCurrency ? fx : null;
  const values = metricsFor(year, previous, price, activeFx);
  const currentAnalysis = useRef<object>({});
  currentAnalysis.current = { symbol, range, financialYear:year?.date || null, reportingCurrency:year?.currency || null, price:price?.price ?? null, priceCurrency:price?.currency || null, quoteTime:price?.marketTime || null, fx:activeFx, fxLoading, fxError, metrics:values, loading:priceLoading || fundLoading, priceError, fundamentalsError:fundError };
  useEffect(() => {
    const context = (document as Document & { modelContext?: { registerTool: (tool: object, options: {signal:AbortSignal}) => unknown } }).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    try {
      void Promise.resolve(context.registerTool({
        name:'read_stock_analysis', title:'Read the visible stock analysis',
        description:'Read the selected ticker, displayed chart range, fiscal year, quote and calculated quality metrics. Does not change the selection or request another ticker.',
        inputSchema:{type:'object',properties:{},additionalProperties:false},
        annotations:{readOnlyHint:true,untrustedContentHint:true},
        execute(input:unknown) {
          if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw new Error('Expected an empty object.');
          return currentAnalysis.current;
        },
      }, {signal:lifecycle.signal})).catch(() => {});
    } catch { /* Browsers without WebMCP retain the full visible interface. */ }
    return () => lifecycle.abort();
  }, []);
  const oldValues = metricsFor(previous, years[selected + 2]);
  const change = price && isNumber(price.price) && isNumber(price.previousClose) && price.previousClose > 0 ? (price.price / price.previousClose - 1) * 100 : null;
  const adjustedAvailable = !!price?.points.length && price.points.every(p => isNumber(p.adjusted));
  const adjusted = basis === 'adjusted' && adjustedAvailable;
  const returnValue = price ? periodReturn(price.points, adjusted) : null;
  const seriesData = useMemo(() => (price?.points || []).map(p => ({...p, value: adjusted ? p.adjusted : p.close})), [price, adjusted]);
  const financialYears = years.filter(y => !year || y.currency === year.currency).slice(0, financialRange === '3' ? 3 : undefined).reverse();
  const financialChart = financialYears.map(y => {
    const i = years.findIndex(z => z.date === y.date), m = metricsFor(y, years[i+1]);
    return { date: 'FY ' + y.date.slice(0,4), revenue:y.revenue, cash:y.operatingCashFlow, capex:y.capex, fcf:y.freeCashFlow, roce:m.roce.value, gross:m.grossMargin.value, operating:m.operatingMargin.value, conversion:m.cashConversion.value };
  });
  function chooseTicker(next: string) {
    const normalized = next.trim().toUpperCase();
    if (!/^[A-Z0-9^][A-Z0-9.^=\-]{0,23}$/.test(normalized)) { setFormError('Enter a ticker such as MSFT, BRK-B or ULVR.L.'); return; }
    setFormError(''); setInput(''); setSymbol(normalized); setFiscalDate('');
    const url = new URL(window.location.href); url.searchParams.set('ticker', normalized); window.history.replaceState({}, '', url);
    if (normalized === symbol) setRefresh(n => n + 1);
  }
  function submit(event: FormEvent) { event.preventDefault(); chooseTicker(input || symbol); }
  function applyDates(event: FormEvent) {
    event.preventDefault();
    if (!start || !end || start >= end || end > new Date().toISOString().slice(0,10)) { setFormError('Choose a start before the end date, with neither date in the future.'); return; }
    setFormError(''); setDates({start,end}); setRange('custom');
  }
  const retry = () => setRefresh(n => n + 1);
  const shownDate = year ? 'FY ' + dateText(year.date) : 'Annual financial statements';
  const keyMetrics: {id:MetricId; label:string}[] = [{id:'roce',label:'Return on capital'}, {id:'fcfYield',label:'Free cash flow yield'}, {id:'cashConversion',label:'Cash conversion'}];

  return <TooltipProvider delayDuration={150}>
    <header className="topbar"><div className="brand"><span className="brand-mark" aria-hidden="true">Q</span><span className="brand-name">Quality</span><span className="brand-caption">EQUITY RESEARCH</span></div><div className="source-label"><Database size={15} /><span>Yahoo Finance · delayed data</span></div></header>
    <main className="workspace">
      <div className="search-row"><form className="ticker-form" onSubmit={submit}><label className="input-wrap"><Search size={18} /><span className="sr-only">Stock ticker symbol</span><input value={input} onChange={e=>setInput(e.target.value)} placeholder="Enter a ticker, e.g. MSFT or ULVR.L" autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={24} /></label><button className="primary-button" type="submit">Analyse <ArrowRight size={15} /></button></form><div className="quick-tickers"><span>Quick look</span>{QUICK.map(t => <button key={t} onClick={()=>chooseTicker(t)} className={symbol === t ? 'active' : ''} aria-pressed={symbol === t}>{t}</button>)}</div></div>
      {formError && <p className="inline-error" role="alert">{formError}</p>}
      <section className="company-row" aria-label="Selected company"><div className="company-identity"><div className="company-monogram" aria-hidden="true">{symbol.replace(/[^A-Z]/g,'').slice(0,2)}</div><div><h1>{price?.name || symbol}</h1><div className="company-meta"><span className="ticker-tag">{symbol}</span><span>{price?.exchange || 'Stock research'}</span>{price?.currency && <><span aria-hidden="true">/</span><span>{price.currency === 'GBp' ? 'GBp · pence' : price.currency}</span></>}</div></div></div><div className="price-block"><div className="price-number">{numberText(price?.price ?? null,2)}<small>{price?.currency}</small></div><div className="price-meta">{isNumber(change) && <span className={change>=0?'positive':'negative'}>{change>=0?'+':''}{numberText(change,2)}% today &nbsp; </span>}{priceLoading ? 'Fetching quote…' : timeText(price?.marketTime)}</div></div></section>
      {price && price.instrumentType && price.instrumentType !== 'EQUITY' && <div className="notice">This ticker represents {price.instrumentType.toLowerCase()}. The company-quality framework is intended for operating businesses; company statements may be unavailable.</div>}
      {(fundamentals?.warnings || []).map(w => <div className="notice" key={w}>{w}</div>)}
      <div className="overview-grid">
        <section className="panel" aria-labelledby="price-title"><div className="panel-heading"><h2 id="price-title">Market performance</h2><Choice label="Chart display" value={priceView} onChange={setPriceView} options={[{value:'price',label:'Share price'},{value:'volume',label:'Trading volume'}]} /></div>
          <div className="chart-summary"><strong className={isNumber(returnValue) && returnValue < 0 ? 'negative' : 'positive'}>{isNumber(returnValue) ? (returnValue >=0?'+':'') + numberText(returnValue,2) + '%' : '—'}</strong><span>{adjusted ? 'adjusted-price change' : 'price change'} over displayed period</span></div>
          <div className="chart-controls"><RadioGroup className="range-buttons" orientation="horizontal" value={customOpen?'custom':range} aria-label="Price chart timeframe" onValueChange={v=>{if(v==='custom')setCustomOpen(true);else{setCustomOpen(false);setRange(v as Range);}}}>{[...RANGES,'custom'].map(r=><label key={r} className={'range-button '+((customOpen?'custom':range)===r?'selected':'')} htmlFor={'range-'+r}><RadioGroupItem className="range-native" id={'range-'+r} value={r} aria-label={RANGE_LABEL[r as Range]+' chart period'}/><span>{RANGE_LABEL[r as Range]}</span></label>)}</RadioGroup><Choice className="basis-select" label="Price adjustment" value={basis} onChange={setBasis} options={[{value:'close',label:'Close price'},{value:'adjusted',label:'Adjusted close'}]} /></div>
          {customOpen && <form className="custom-range" onSubmit={applyDates}><label>From <input aria-label="Start date" type="date" value={start} max={end} onChange={e=>setStart(e.target.value)} required /></label><label>To <input aria-label="End date" type="date" value={end} min={start} max={new Date().toISOString().slice(0,10)} onChange={e=>setEnd(e.target.value)} required /></label><button className="quiet-button" type="submit">Apply</button></form>}
          {basis==='adjusted' && price && !adjustedAvailable && <p className="table-subtitle">Adjusted history is unavailable for this period. Showing close prices.</p>}
          {priceLoading || !price || !price.points.length ? <StateBox loading={priceLoading} error={priceError || 'There are no trading observations in this period. Try a wider date range.'} retry={retry} label="Price history" /> : <div className="price-chart" role="img" aria-label={symbol+' '+priceView+' chart. '+price.points.length+' observations. Period price change '+numberText(returnValue,2)+' percent.'}><ResponsiveContainer width="100%" height="100%">{priceView === 'price' ? <AreaChart data={seriesData} margin={{top:12,right:12,bottom:0,left:8}} accessibilityLayer><defs><linearGradient id="price-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#c5ef69" stopOpacity={.18}/><stop offset="100%" stopColor="#c5ef69" stopOpacity={0}/></linearGradient></defs><CartesianGrid vertical={false} stroke="#2b3643" strokeDasharray="3 6" /><XAxis dataKey="date" tickFormatter={shortDate} minTickGap={65} tick={AXIS} axisLine={false} tickLine={false} dy={10}/><YAxis domain={['auto','auto']} orientation="right" tickFormatter={v=>compact(v)} tick={AXIS} axisLine={false} tickLine={false} width={65}/><ChartTooltip content={<PlotTooltip money currency={price.currency} date />} cursor={{stroke:'#76855e',strokeDasharray:'4 4'}}/><Area type="linear" dataKey="value" name={adjusted?'Adjusted close':'Close'} stroke="#c5ef69" strokeWidth={2} fill="url(#price-fill)" isAnimationActive={false}/></AreaChart> : <BarChart data={seriesData} margin={{top:12,right:12,bottom:0,left:8}} accessibilityLayer><CartesianGrid vertical={false} stroke="#2b3643" strokeDasharray="3 6"/><XAxis dataKey="date" tickFormatter={shortDate} minTickGap={65} tick={AXIS} axisLine={false} tickLine={false} dy={10}/><YAxis orientation="right" tickFormatter={v=>compact(v)} tick={AXIS} axisLine={false} tickLine={false} width={65}/><ChartTooltip content={<PlotTooltip money date />} cursor={{fill:'#ffffff08'}}/><Bar dataKey="volume" name="Shares traded" fill="#71b7ff" isAnimationActive={false}/></BarChart>}</ResponsiveContainer></div>}
          <div className="chart-footer"><span>{price?.points.length ? dateText(price.points[0].date) + ' – ' + dateText(price.points.at(-1)!.date) : 'Daily, weekly or monthly observations'}</span><span>{price?.interval==='1mo'?'Monthly':price?.interval==='1wk'?'Weekly':'Daily'} observations · {adjusted?'splits & dividends adjusted':'excludes dividends'}</span></div>
        </section>
        <aside className="panel metric-strip" aria-label="Key company metrics"><div className="strip-heading">The quality lens</div>{keyMetrics.map(({id,label}) => {const m=METRICS.find(x=>x.id===id)!; return <div className="key-metric" key={id}><div className="key-metric-label">{label}<Help metric={m} reason={values[id].reason}/></div><div className="key-metric-value">{fundLoading || (id==='fcfYield' && fxLoading) ? '—' : metricText(m,values[id])}</div><div className="key-metric-note">{year ? 'FY ' + year.date.slice(0,4) : 'Annual'}{id==='roce'?' · average capital':id==='fcfYield'?' · current price proxy':' · FCF / net income'}</div></div>;})}</aside>
      </div>
      <div className="lower-grid">
        <section className="panel" aria-labelledby="metrics-title"><div className="panel-heading"><div><p className="eyebrow">Terry Smith’s investment lens</p><h2 id="metrics-title">Business quality & valuation</h2></div>{year && <Choice label="Financial year for output table" value={year.date} onChange={setFiscalDate} options={years.map(y=>({value:y.date,label:'FY '+y.date.slice(0,4)}))}/>}</div><div className="table-subtitle">{shownDate} · reported annual figures, not TTM</div>
          {fundLoading || !fundamentals ? <StateBox loading={fundLoading} error={fundError} retry={retry} label="Company financials"/> : <Table className="financial-table"><TableHeader><TableRow><TableHead>Metric / what it tells you</TableHead><TableHead className="numeric">FY {year?.date.slice(0,4)}<br/><span>{year && dateText(year.date)}</span></TableHead><TableHead className="numeric">{previous ? 'FY '+previous.date.slice(0,4) : 'Previous FY'}<br/><span>{previous && dateText(previous.date)}</span></TableHead></TableRow></TableHeader><TableBody>{METRICS.map(m => <TableRow key={m.id}><TableCell><div className="metric-name">{m.label}<Help metric={m} reason={values[m.id].reason}/></div><span className="metric-lens">{m.lens}</span></TableCell><TableCell className="numeric" title={values[m.id].reason || m.formula}>{metricText(m,values[m.id])}</TableCell><TableCell className="numeric muted" title={m.id==='fcfYield' ? 'Current-price valuation is only shown for the selected financial year.' : oldValues[m.id].reason || m.formula}>{m.id==='fcfYield'?'—':metricText(m,oldValues[m.id])}</TableCell></TableRow>)}</TableBody></Table>}
          {activeFx && <div className="table-subtitle">FCF yield FX: 1 {activeFx.from} = {numberText(activeFx.rate,4)} {activeFx.to} · {timeText(activeFx.marketTime)}</div>}
          {fxError && <div className="table-subtitle">FCF yield: {fxError}</div>}
          <details className="methodology"><summary>Calculations, limitations & sources</summary><p>Inspired by the measures in <a href={LETTER} target="_blank" rel="noreferrer">Fundsmith’s 2025 annual letter</a> (pages 12–14) and <a href={MANUAL} target="_blank" rel="noreferrer">Owner’s Manual</a>. These are transparent calculations from Yahoo annual statements, not Fundsmith’s adjusted Bloomberg figures or a stock recommendation.</p><p>Annual periods can differ between companies. Consistency over several years matters; there is no universal pass/fail threshold. This lens is less suitable for banks, insurers and other financial businesses.</p><div className="method-grid">{METRICS.map(m=><div key={m.id}><strong>{m.label}: {m.formula}</strong>{m.note}</div>)}</div><p>N/A means the necessary data are unavailable. N/M means the ratio is not meaningful. No missing data are replaced with zero.</p>{fundamentals && <p>Statements retrieved {new Date(fundamentals.fetchedAt).toLocaleString('en-GB',{timeZone:'Europe/London'})} London. Statement cache: up to one hour; prices: up to five minutes.</p>}</details>
        </section>
        <div className="side-stack">
          <section className="panel" aria-labelledby="cash-title"><div className="panel-heading"><h2 id="cash-title">Follow the cash</h2><Choice label="Annual charts timeframe" value={financialRange} onChange={setFinancialRange} options={[{value:'3',label:'Last 3 FYs'},{value:'all',label:'All available FYs'}]}/></div><Tabs defaultValue="cash" className="chart-tabs"><TabsList><TabsTrigger value="cash">Cash generation</TabsTrigger><TabsTrigger value="revenue">Revenue</TabsTrigger></TabsList><TabsContent value="cash">{fundLoading || !financialChart.length ? <StateBox loading={fundLoading} error={fundError} label="Cash flow"/> : <><div className="fund-chart"><ResponsiveContainer width="100%" height="100%"><BarChart data={financialChart} margin={{top:15,right:0,left:-8,bottom:5}} accessibilityLayer><CartesianGrid vertical={false} stroke="#2b3643" strokeDasharray="3 6"/><XAxis dataKey="date" tick={AXIS} axisLine={false} tickLine={false}/><YAxis tickFormatter={v=>compact(v)} tick={AXIS} axisLine={false} tickLine={false}/><ReferenceLine y={0} stroke="#526073"/><ChartTooltip content={<PlotTooltip money currency={year?.currency}/>} cursor={{fill:'#ffffff06'}}/><Bar dataKey="cash" name="Operating cash flow" fill="#71b7ff" radius={[3,3,0,0]} isAnimationActive={false}/><Bar dataKey="capex" name="Capital expenditure" fill="#51657d" radius={[3,3,0,0]} isAnimationActive={false}/><Bar dataKey="fcf" name="Free cash flow" fill="#c5ef69" radius={[3,3,0,0]} isAnimationActive={false}/></BarChart></ResponsiveContainer></div><div className="legend"><span><i style={{background:'#71b7ff'}}/>Operating cash</span><span><i style={{background:'#51657d'}}/>Capex</span><span><i style={{background:'#c5ef69'}}/>Free cash flow</span></div></>}</TabsContent><TabsContent value="revenue">{fundLoading || !financialChart.length ? <StateBox loading={fundLoading} error={fundError} label="Revenue"/> : <div className="fund-chart"><ResponsiveContainer width="100%" height="100%"><BarChart data={financialChart} margin={{top:15,right:0,left:-8,bottom:5}} accessibilityLayer><CartesianGrid vertical={false} stroke="#2b3643" strokeDasharray="3 6"/><XAxis dataKey="date" tick={AXIS} axisLine={false} tickLine={false}/><YAxis tickFormatter={v=>compact(v)} tick={AXIS} axisLine={false} tickLine={false}/><ChartTooltip content={<PlotTooltip money currency={year?.currency}/>} cursor={{fill:'#ffffff06'}}/><Bar dataKey="revenue" name="Revenue" fill="#71b7ff" radius={[4,4,0,0]} maxBarSize={42} isAnimationActive={false}/></BarChart></ResponsiveContainer></div>}</TabsContent></Tabs><div className="chart-footer"><span>{year?.currency || 'Reporting currency'} · annual statements</span><span>FCF = operating cash − capex</span></div></section>
          <section className="panel" aria-labelledby="trend-title"><div className="panel-heading"><h2 id="trend-title">Quality over time</h2><Choice label="Quality metric to plot" value={qualitySeries} onChange={setQualitySeries} options={[{value:'margins',label:'Profit margins'},{value:'roce',label:'Return on capital'},{value:'conversion',label:'Cash conversion'}]}/></div>{fundLoading || !financialChart.length ? <StateBox loading={fundLoading} error={fundError} label="Quality trends"/> : <><div className="fund-chart"><ResponsiveContainer width="100%" height="100%"><LineChart data={financialChart} margin={{top:12,right:24,left:0,bottom:5}} accessibilityLayer><CartesianGrid vertical={false} stroke="#2b3643" strokeDasharray="3 6"/><XAxis dataKey="date" tick={AXIS} axisLine={false} tickLine={false}/><YAxis tickFormatter={v=>numberText(v,0)+'%'} tick={AXIS} axisLine={false} tickLine={false} domain={['auto','auto']}/><ChartTooltip content={<PlotTooltip/>}/>{qualitySeries==='margins' ? <><Line dataKey="gross" name="Gross margin" stroke={COLOURS[0]} strokeWidth={2} dot={{r:4}} connectNulls={false} isAnimationActive={false}/><Line dataKey="operating" name="Operating margin" stroke={COLOURS[1]} strokeWidth={2} dot={{r:4}} connectNulls={false} isAnimationActive={false}/></> : <Line dataKey={qualitySeries} name={qualitySeries==='roce'?'ROCE proxy':'Cash conversion'} stroke={COLOURS[0]} strokeWidth={2} dot={{r:4}} connectNulls={false} isAnimationActive={false}/>}</LineChart></ResponsiveContainer></div><div className="legend">{qualitySeries==='margins' ? <><span><i style={{background:COLOURS[0]}}/>Gross margin</span><span><i style={{background:COLOURS[1]}}/>Operating margin</span></> : <span><i style={{background:COLOURS[0]}}/>{qualitySeries==='roce'?'ROCE · average capital employed':'FCF / net income'}</span>}</div></>}</section>
          <div className="quality-note"><p>Look for businesses that sustain high returns on capital, turn profits into cash and have room to reinvest.</p><a href={MANUAL} target="_blank" rel="noreferrer">The thinking behind the metrics <ExternalLink size={12} style={{display:'inline',marginLeft:5}}/></a></div>
        </div>
      </div>
      <footer className="app-footer"><span>Quality · Independent research tool. Not affiliated with Fundsmith or Yahoo.</span><span><a href={'https://finance.yahoo.com/quote/'+encodeURIComponent(symbol)+'/'} target="_blank" rel="noreferrer">View {symbol} on Yahoo Finance</a> &nbsp; · &nbsp; <a href="https://ranaroussi.github.io/yfinance/" target="_blank" rel="noreferrer">Data-use notes</a></span></footer>
    </main>
  </TooltipProvider>;
}
