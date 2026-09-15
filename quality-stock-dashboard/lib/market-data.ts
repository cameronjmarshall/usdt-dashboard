import { isNumber, RANGES, type FinancialYear, type Fundamentals, type PriceData, type Range, type FxData } from './finance';

export class FinanceError extends Error {
  constructor(message: string, public status = 502) { super(message); }
}
type Json = Record<string, any>;
const cache = new Map<string, { expires: number; value: unknown }>();
const pending = new Map<string, Promise<unknown>>();
async function cached<T>(key: string, ttl: number, getter: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as T;
  if (pending.has(key)) return pending.get(key) as Promise<T>;
  if (pending.size > 60) throw new FinanceError('The data service is busy. Please try again shortly.', 503);
  const request = getter().then(value => {
    if (cache.size >= 120) cache.delete(cache.keys().next().value!);
    cache.set(key, { expires: Date.now() + ttl, value });
    return value;
  }).finally(() => pending.delete(key));
  pending.set(key, request);
  return request;
}
async function yahoo(path: string): Promise<Json> {
  let error: unknown;
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const response = await fetch('https://' + host + path, {
        headers: { 'User-Agent': 'QualityStockResearch/1.0', Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
      if (response.status === 429) throw new FinanceError('Yahoo Finance is limiting requests. Please try again in a few minutes.', 429);
      if (response.status === 404) throw new FinanceError('No data found for this ticker. Check the exchange suffix, for example ULVR.L.', 404);
      if (response.status === 401 || response.status === 403) throw new FinanceError('Yahoo Finance is temporarily refusing this data request. Please try again later.', 503);
      if (!response.ok) throw new FinanceError('The market-data provider is temporarily unavailable.', 502);
      const data: Json = await response.json();
      const providerError = data.chart?.error || data.timeseries?.error;
      if (providerError) throw new FinanceError(providerError.code === 'Not Found' ? 'No data found for this ticker.' : 'The provider could not return this data.', providerError.code === 'Not Found' ? 404 : 502);
      return data;
    } catch (e) {
      error = e;
      if (e instanceof FinanceError && [404, 429, 503].includes(e.status)) throw e;
    }
  }
  throw error instanceof FinanceError ? error : new FinanceError('The market-data request timed out. Please retry.', 504);
}
export function validateSymbol(input: string | null): string {
  const symbol = (input || '').trim().toUpperCase();
  if (!/^[A-Z0-9^][A-Z0-9.^=\-]{0,23}$/.test(symbol)) throw new FinanceError('Enter a valid Yahoo ticker, such as MSFT, BRK-B or ULVR.L.', 400);
  return symbol;
}
export function chartParams(params: URLSearchParams): { symbol: string; range: Range; start?: string; end?: string } {
  const symbol = validateSymbol(params.get('symbol'));
  const range = params.get('range') || '1y';
  if (![...RANGES, 'custom'].includes(range as Range)) throw new FinanceError('Choose a supported chart period.', 400);
  if (range !== 'custom') return { symbol, range: range as Range };
  const start = params.get('start') || '', end = params.get('end') || '';
  const validDate = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
  if (!validDate(start) || !validDate(end) || start >= end || end > new Date().toISOString().slice(0, 10) || start < '1970-01-01') throw new FinanceError('Choose a start date before the end date, with neither date in the future.', 400);
  return { symbol, range: 'custom', start, end };
}
export function parseChart(data: Json, symbol: string, range: Range, interval: string): PriceData {
  const item = data.chart?.result?.[0];
  if (!item?.meta) throw new FinanceError('No price history is available for this ticker.', 404);
  const meta = item.meta, quotes = item.indicators?.quote?.[0] || {}, adjusted = item.indicators?.adjclose?.[0]?.adjclose || [];
  const dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: meta.exchangeTimezoneName || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' });
  const points = (item.timestamp || []).flatMap((stamp: number, i: number) => {
    if (!isNumber(quotes.close?.[i]) || quotes.close[i] <= 0 || !isNumber(stamp)) return [];
    return [{ date: dateFormat.format(new Date(stamp * 1000)), timestamp: stamp, close: quotes.close[i], adjusted: isNumber(adjusted[i]) ? adjusted[i] : null, volume: isNumber(quotes.volume?.[i]) ? quotes.volume[i] : null }];
  }).sort((a: {timestamp: number}, b: {timestamp: number}) => a.timestamp - b.timestamp);
  const marketPrice = isNumber(meta.regularMarketPrice) ? meta.regularMarketPrice : null;
  const percent = meta.regularMarketChangePercent;
  const previousClose = isNumber(meta.previousClose) ? meta.previousClose : isNumber(marketPrice) && isNumber(percent) && percent > -100 ? marketPrice / (1 + percent / 100) : null;
  return { symbol, name: meta.longName || meta.shortName || symbol, currency: meta.currency || '', exchange: meta.fullExchangeName || meta.exchangeName || '', instrumentType: meta.instrumentType || '', price: marketPrice, previousClose, marketTime: isNumber(meta.regularMarketTime) ? meta.regularMarketTime : null, points, fetchedAt: new Date().toISOString(), range, interval, source: 'Yahoo Finance' };
}
export async function getChart({symbol, range, start, end}: {symbol: string; range: Range; start?: string; end?: string}): Promise<PriceData> {
  const key = ['chart', symbol, range, start || '', end || ''].join(':');
  return cached(key, 300000, async () => {
    const interval = range === 'max' ? '1mo' : range === '5y' || (start && end && Date.parse(end) - Date.parse(start) > 5 * 366 * 86400000) ? '1wk' : '1d';
    const query = new URLSearchParams({ interval, includePrePost: 'false', events: 'div,splits', includeAdjustedClose: 'true' });
    if (range === 'custom') { query.set('period1', String(Date.parse(start!) / 1000)); query.set('period2', String(Date.parse(end!) / 1000 + 86400)); }
    else query.set('range', range);
    return parseChart(await yahoo('/v8/finance/chart/' + encodeURIComponent(symbol) + '?' + query), symbol, range, interval);
  });
}
const FIELDS: Record<string, keyof FinancialYear> = {
  TotalRevenue: 'revenue', GrossProfit: 'grossProfit', OperatingIncome: 'operatingIncome', EBIT: 'ebit', InterestExpense: 'interestExpense',
  NetIncome: 'netIncome', OperatingCashFlow: 'operatingCashFlow', CapitalExpenditure: 'capex', TotalAssets: 'totalAssets',
  CurrentLiabilities: 'currentLiabilities', BasicAverageShares: 'basicAverageShares', OrdinarySharesNumber: 'ordinaryShares',
};
export function parseFundamentals(data: Json, symbol: string): Fundamentals {
  const result = data.timeseries?.result;
  if (!Array.isArray(result)) throw new FinanceError('Annual statements are unavailable for this ticker.', 404);
  const years = new Map<string, FinancialYear>();
  const currencies = new Map<string, Set<string>>();
  for (const series of result) {
    const name = series.meta?.type?.[0] || '';
    const field = FIELDS[name.replace(/^annual/, '')];
    if (!field || !name.startsWith('annual')) continue;
    for (const entry of series[name] || []) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.asOfDate || '') || entry.periodType !== '12M' || !isNumber(entry.reportedValue?.raw)) continue;
      const date = entry.asOfDate;
      if (date > new Date().toISOString().slice(0,10)) continue;
      if (!years.has(date)) {
        years.set(date, {date, currency: '', revenue: null, grossProfit: null, operatingIncome: null, ebit: null, interestExpense: null, netIncome: null, operatingCashFlow: null, capex: null, freeCashFlow: null, totalAssets: null, currentLiabilities: null, basicAverageShares: null, ordinaryShares: null});
        currencies.set(date, new Set());
      }
      const year = years.get(date)!;
      (year[field] as number | null) = entry.reportedValue.raw;
      if (entry.currencyCode && !['basicAverageShares', 'ordinaryShares'].includes(field)) currencies.get(date)!.add(entry.currencyCode.toUpperCase());
    }
  }
  const warnings: string[] = [];
  const normalized = [...years.values()].filter(y => isNumber(y.revenue) || isNumber(y.operatingCashFlow)).sort((a,b) => b.date.localeCompare(a.date)).flatMap(year => {
    const available = [...currencies.get(year.date)!];
    if (available.length !== 1) { warnings.push('Omitted ' + year.date + ' because the provider did not supply a consistent reporting currency.'); return []; }
    year.currency = available[0];
    if (isNumber(year.capex)) year.capex = Math.abs(year.capex);
    year.freeCashFlow = isNumber(year.operatingCashFlow) && isNumber(year.capex) ? year.operatingCashFlow - year.capex : null;
    return [year];
  });
  if (!normalized.length) throw new FinanceError('Annual company statements are unavailable for this ticker. Indices, funds and some listings do not provide these fields.', 404);
  return { symbol, years: normalized, warnings, fetchedAt: new Date().toISOString(), source: 'Yahoo Finance annual financial statements' };
}
export async function getFundamentals(symbol: string): Promise<Fundamentals> {
  return cached('financials:' + symbol, 3600000, async () => {
    const query = new URLSearchParams({ type: Object.keys(FIELDS).map(k => 'annual' + k).join(','), merge: 'false', period1: String(Math.floor(Date.now()/1000 - 6*366*86400)), period2: String(Math.floor(Date.now()/1000)) });
    return parseFundamentals(await yahoo('/ws/fundamentals-timeseries/v1/finance/timeseries/' + encodeURIComponent(symbol) + '?' + query), symbol);
  });
}
export function errorResponse(error: unknown) {
  const safe = error instanceof FinanceError ? error : new FinanceError('Unable to load market data. Please try again.');
  return Response.json({ error: safe.message }, { status: safe.status, headers: {'Cache-Control': 'no-store'} });
}
export async function getFx(from: string, to: string): Promise<FxData> {
  if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) throw new FinanceError('Currency codes must have three uppercase letters.', 400);
  if (from === to) return {from, to, rate:1, marketTime:null, fetchedAt:new Date().toISOString()};
  const quote = await getChart({symbol:from+to+'=X', range:'1mo'});
  if (!isNumber(quote.price) || quote.price <= 0 || !quote.marketTime) throw new FinanceError('The FX conversion quote is unavailable.', 502);
  return {from, to, rate:quote.price, marketTime:quote.marketTime, fetchedAt:quote.fetchedAt};
}
