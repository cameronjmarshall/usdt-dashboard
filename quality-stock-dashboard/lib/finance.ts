export const RANGES = ['1mo', '3mo', '6mo', 'ytd', '1y', '5y', 'max'] as const;
export type Range = typeof RANGES[number] | 'custom';
export type Numeric = number | null;
export type FxData = { from:string; to:string; rate:number; marketTime:Numeric; fetchedAt:string };
export type PricePoint = { date: string; timestamp: number; close: number; adjusted: Numeric; volume: Numeric };
export type PriceData = {
  symbol: string; name: string; exchange: string; currency: string;
  instrumentType: string; price: Numeric; previousClose: Numeric; marketTime: Numeric;
  points: PricePoint[]; fetchedAt: string; range: Range; interval: string;
  source: string; snapshot?: boolean;
};
export type FinancialYear = {
  date: string; currency: string; revenue: Numeric; grossProfit: Numeric;
  operatingIncome: Numeric; ebit: Numeric; interestExpense: Numeric; netIncome: Numeric;
  operatingCashFlow: Numeric; capex: Numeric; freeCashFlow: Numeric;
  totalAssets: Numeric; currentLiabilities: Numeric; basicAverageShares: Numeric;
  ordinaryShares: Numeric;
};
export type Fundamentals = {
  symbol: string; years: FinancialYear[]; fetchedAt: string; source: string;
  snapshot?: boolean; warnings: string[];
};
export type MetricId = 'roce' | 'grossMargin' | 'operatingMargin' | 'cashConversion' | 'interestCover' | 'fcfYield' | 'fcfGrowth';
export type MetricValue = { value: Numeric; reason: string | null };
export type Metric = { id: MetricId; label: string; unit: '%' | '×'; lens: string; formula: string; note: string };
export const METRICS: Metric[] = [
  { id: 'roce', label: 'Return on capital employed', unit: '%', lens: 'High, sustained returns', formula: 'EBIT ÷ average capital employed × 100', note: 'Proxy: capital employed is total assets less current liabilities, averaged across opening and closing year ends. Includes cash and goodwill; this is not Fundsmith’s proprietary operating-capital calculation.' },
  { id: 'grossMargin', label: 'Gross margin', unit: '%', lens: 'Pricing power & resilience', formula: 'Gross profit ÷ revenue × 100', note: 'Reported gross profit and revenue from the same full financial year. Sector and accounting differences matter.' },
  { id: 'operatingMargin', label: 'Operating margin', unit: '%', lens: 'Operating profitability', formula: 'Operating income ÷ revenue × 100', note: 'Uses reported operating income, without adjustments for exceptional items.' },
  { id: 'cashConversion', label: 'Cash conversion', unit: '%', lens: 'Profits backed by cash', formula: 'Free cash flow ÷ net income × 100', note: 'Company-level proxy for Fundsmith’s FCF per share / net income per share measure. FCF is operating cash flow less all capital expenditure. Zero or negative earnings make this ratio uninformative.' },
  { id: 'interestCover', label: 'Interest cover', unit: '×', lens: 'Capacity to service debt', formula: 'EBIT ÷ gross interest expense', note: 'Gross reported interest expense is used, never net interest income. Zero expense is shown as N/M, and a missing expense is N/A.' },
  { id: 'fcfYield', label: 'Free cash flow yield', unit: '%', lens: 'Cash return for the price', formula: 'Annual FCF per basic average share × reporting-to-trading FX ÷ latest share price × 100', note: 'Valuation proxy using the selected year’s basic weighted-average shares, not a current market-cap estimate. Pence are converted to pounds; other currency differences use a timestamped Yahoo FX quote. Missing FX gives N/A. Fundsmith may add back discretionary growth capex; this dashboard deducts all capex.' },
  { id: 'fcfGrowth', label: 'Free cash flow growth', unit: '%', lens: 'Capacity to compound', formula: '(Annual FCF ÷ previous annual FCF − 1) × 100', note: 'Year-on-year growth for comparable reporting currencies and annual periods. N/M when the earlier year’s free cash flow is zero or negative.' },
];
export function isNumber(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
export function ratio(numerator: Numeric, denominator: Numeric, scale = 100): Numeric {
  return isNumber(numerator) && isNumber(denominator) && denominator > 0 ? numerator / denominator * scale : null;
}
export function normaliseCurrency(currency: string) {
  if (currency === 'GBp' || currency === 'GBX') return { currency: 'GBP', scale: 0.01 };
  if (currency === 'ZAc') return { currency: 'ZAR', scale: 0.01 };
  if (currency === 'ILA') return { currency: 'ILS', scale: 0.01 };
  return { currency: currency.toUpperCase(), scale: 1 };
}
export function metricsFor(year: FinancialYear | undefined, previous: FinancialYear | undefined, price?: PriceData | null, fx?: FxData | null): Record<MetricId, MetricValue> {
  const missing = (reason: string): MetricValue => ({ value: null, reason });
  const value = (number: Numeric, reason = 'Required statement field is unavailable.'): MetricValue => isNumber(number) ? { value: number, reason: null } : missing(reason);
  if (!year) return Object.fromEntries(METRICS.map(m => [m.id, missing('Annual financial statements are unavailable.')])) as Record<MetricId, MetricValue>;
  const comparable = previous && previous.currency === year.currency && Math.abs((Date.parse(year.date) - Date.parse(previous.date)) / 86400000 - 365.25) < 25;
  const ce = isNumber(year.totalAssets) && isNumber(year.currentLiabilities) ? year.totalAssets - year.currentLiabilities : null;
  const priorCE = comparable && isNumber(previous.totalAssets) && isNumber(previous.currentLiabilities) ? previous.totalAssets - previous.currentLiabilities : null;
  const averageCE = isNumber(ce) && ce > 0 && isNumber(priorCE) && priorCE > 0 ? (ce + priorCE) / 2 : null;
  const quoteCurrency = normaliseCurrency(price?.currency || '');
  const fcfPerShare = ratio(year.freeCashFlow, year.basicAverageShares, 1);
  const fxRate = quoteCurrency.currency === year.currency.toUpperCase() ? 1 : fx?.from === year.currency.toUpperCase() && fx.to === quoteCurrency.currency && isNumber(fx.rate) && fx.rate > 0 ? fx.rate : null;
  const canValue = isNumber(fxRate) && isNumber(price?.price) && price.price > 0;
  return {
    roce: value(ratio(year.ebit, averageCE), 'Needs two comparable year-end balance sheets with positive capital employed and reported EBIT.'),
    grossMargin: value(ratio(year.grossProfit, year.revenue)),
    operatingMargin: value(ratio(year.operatingIncome, year.revenue)),
    cashConversion: value(ratio(year.freeCashFlow, year.netIncome), isNumber(year.netIncome) && year.netIncome <= 0 ? 'N/M: net income is zero or negative.' : 'Needs operating cash flow, capital expenditure and positive net income.'),
    interestCover: value(ratio(year.ebit, year.interestExpense === null ? null : Math.abs(year.interestExpense), 1), year.interestExpense === 0 ? 'N/M: no interest expense was reported.' : 'Gross interest expense or EBIT is unavailable.'),
    fcfYield: value(canValue && isNumber(fcfPerShare) ? ratio(fcfPerShare * fxRate!, price!.price! * quoteCurrency.scale) : null, !price ? 'A current share price is unavailable.' : fxRate === null ? 'Reporting currency ' + year.currency + ' differs from trading currency ' + price.currency + '; a conversion quote is required.' : 'Needs positive basic average shares and a share price.'),
    fcfGrowth: value(comparable && isNumber(year.freeCashFlow) && isNumber(previous.freeCashFlow) && previous.freeCashFlow > 0 ? (year.freeCashFlow / previous.freeCashFlow - 1) * 100 : null, comparable && isNumber(previous.freeCashFlow) && previous.freeCashFlow <= 0 ? 'N/M: previous free cash flow is zero or negative.' : 'Needs two comparable annual cash-flow statements in the same currency.'),
  };
}
export function numberText(value: Numeric, digits = 1) { return isNumber(value) ? new Intl.NumberFormat('en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value) : '—'; }
export function compact(value: Numeric) { return isNumber(value) ? new Intl.NumberFormat('en-GB', { notation: 'compact', maximumFractionDigits: 2 }).format(value) : '—'; }
export function metricText(metric: Metric, data: MetricValue | undefined) { return data && isNumber(data.value) ? numberText(data.value) + metric.unit : data?.reason?.startsWith('N/M') ? 'N/M' : 'N/A'; }
export function periodReturn(points: PricePoint[], adjusted = false) {
  const usable = points.map(p => adjusted ? p.adjusted : p.close).filter(isNumber);
  return usable.length > 1 && usable[0] > 0 ? (usable[usable.length - 1] / usable[0] - 1) * 100 : null;
}
