import { isNumber, normaliseCurrency, type FinancialYear, type FxData, type Numeric, type PriceData } from './finance';

export type ValuationInputs = {
  cashFlowPerShare: Numeric;
  growth: Numeric;
  discount: Numeric;
  terminalGrowth: Numeric;
  years: Numeric;
  marginOfSafety: Numeric;
};
export type ValuationResult =
  | { ok: false; reason: string }
  | { ok: true; value: number; entryPrice: number; marginOfSafety: Numeric; upside: Numeric; terminalShare: number };

/** An end-of-year equity cash-flow model. All rates are percentages, not fractions. */
export function valueCashFlows(input: ValuationInputs, price: Numeric = null): ValuationResult {
  const { cashFlowPerShare: cash, growth, discount, terminalGrowth: terminal, years, marginOfSafety: safety } = input;
  if (!isNumber(cash) || cash <= 0) return { ok: false, reason: 'Enter positive sustainable shareholder cash flow per share. This model is not suitable for negative cash flow.' };
  if (!isNumber(growth) || growth <= -100 || growth > 100) return { ok: false, reason: 'Annual per-share growth must be greater than −100% and at most 100%.' };
  if (!isNumber(discount) || discount <= 0 || discount > 100) return { ok: false, reason: 'Required equity return must be greater than 0% and at most 100%.' };
  if (!isNumber(terminal) || terminal <= -100 || terminal >= discount) return { ok: false, reason: 'Terminal growth must be greater than −100% and below the required return.' };
  if (!isNumber(years) || !Number.isInteger(years) || years < 1 || years > 30) return { ok: false, reason: 'Forecast horizon must be a whole number from 1 to 30 years.' };
  if (!isNumber(safety) || safety < 0 || safety >= 100) return { ok: false, reason: 'Target margin of safety must be at least 0% and below 100%.' };
  const r = discount / 100, g = growth / 100, t = terminal / 100;
  let presentCashFlows = 0;
  for (let year = 1; year <= years; year++) {
    presentCashFlows += cash * (1 + g) ** year / (1 + r) ** year;
  }
  const terminalPV = cash * (1 + g) ** years * (1 + t) / (r - t) / (1 + r) ** years;
  const value = presentCashFlows + terminalPV;
  if (!isNumber(value) || value <= 0) return { ok: false, reason: 'These assumptions do not produce a finite positive model value.' };
  const validPrice = isNumber(price) && price > 0;
  return {
    ok: true, value, entryPrice: value * (1 - safety / 100),
    marginOfSafety: validPrice ? (1 - price / value) * 100 : null,
    upside: validPrice ? (value / price - 1) * 100 : null,
    terminalShare: terminalPV / value * 100,
  };
}

/** Solve only the explicit-period growth rate; other assumptions remain fixed. */
export function impliedGrowth(input: ValuationInputs, price: Numeric): { growth: Numeric; reason: string | null } {
  if (!isNumber(price) || price <= 0) return { growth: null, reason: 'A positive current share price is required.' };
  let low = -95, high = 100;
  const lower = valueCashFlows({ ...input, growth: low });
  const upper = valueCashFlows({ ...input, growth: high });
  if (!lower.ok) return { growth: null, reason: lower.reason };
  if (!upper.ok) return { growth: null, reason: upper.reason };
  if (price < lower.value || price > upper.value) return { growth: null, reason: 'Implied growth is outside the search range of −95% to 100% a year.' };
  for (let i = 0; i < 100; i++) {
    const mid = (low + high) / 2;
    const result = valueCashFlows({ ...input, growth: mid });
    if (!result.ok) return { growth: null, reason: result.reason };
    if (result.value < price) low = mid; else high = mid;
  }
  return { growth: (low + high) / 2, reason: null };
}

/** Convert both a reported FCF proxy and the quote into the quote's major currency. */
export function valuationBasis(year: FinancialYear, price: Pick<PriceData, 'currency' | 'price'>, fx?: FxData | null) {
  const quote = normaliseCurrency(price.currency);
  const report = normaliseCurrency(year.currency);
  const rate = report.currency === quote.currency ? 1
    : fx?.from === report.currency && fx.to === quote.currency && isNumber(fx.rate) && fx.rate > 0 ? fx.rate : null;
  const perShare = isNumber(year.freeCashFlow) && isNumber(year.basicAverageShares) && year.basicAverageShares > 0
    ? year.freeCashFlow / year.basicAverageShares * report.scale : null;
  return {
    currency: quote.currency,
    price: isNumber(price.price) && price.price > 0 ? price.price * quote.scale : null,
    cashFlowPerShare: isNumber(perShare) && isNumber(rate) ? perShare * rate : null,
    reason: rate === null ? 'Reporting-to-trading FX is unavailable. Enter a reviewed cash-flow estimate in the displayed currency or wait for FX.'
      : perShare === null ? 'Reported free cash flow or positive basic average shares are unavailable.' : null,
  };
}
