'use client';

import { useState } from 'react';
import { isNumber, numberText, type FinancialYear, type FxData, type PriceData } from '@/lib/finance';
import { impliedGrowth, valuationBasis, valueCashFlows, type ValuationInputs } from '@/lib/valuation';

type Props = { year?: FinancialYear; price: PriceData | null; fx: FxData | null; loading: boolean };
const parse = (text: string) => text.trim() === '' || !Number.isFinite(Number(text)) ? null : Number(text);
const cases = ['Bear', 'Base', 'Bull'] as const;

function NumberField({ label, value, onChange, step = '0.5', min, max, placeholder }: {
  label: string; value: string; onChange: (value: string) => void;
  step?: string; min?: number; max?: number; placeholder?: string;
}) {
  return <label className="valuation-field"><span>{label}</span><input type="number" inputMode="decimal" value={value}
    onChange={e => onChange(e.target.value)} step={step} min={min} max={max} placeholder={placeholder} /></label>;
}

export function ValuationWorkbench({ year, price, fx, loading }: Props) {
  const [cashOverride, setCashOverride] = useState<string | null>(null);
  const [growth, setGrowth] = useState(['0', '5', '10']);
  const [discount, setDiscount] = useState('10');
  const [terminal, setTerminal] = useState('2');
  const [horizon, setHorizon] = useState('10');
  const [safety, setSafety] = useState('25');
  const ready = !!year && !!price && !loading;
  const basis = year && price ? valuationBasis(year, price, fx) : null;
  const cash = cashOverride === null ? basis?.cashFlowPerShare ?? null : parse(cashOverride);
  const shared = { cashFlowPerShare: cash, discount: parse(discount), terminalGrowth: parse(terminal), years: parse(horizon), marginOfSafety: parse(safety) };
  const inputs: ValuationInputs = { ...shared, growth: parse(growth[1]) };
  const results = growth.map(g => valueCashFlows({ ...shared, growth: parse(g) }, basis?.price ?? null));
  const reverse = impliedGrowth(inputs, basis?.price ?? null);
  const money = (value: number | null) => numberText(value, 2) + (basis ? ' ' + basis.currency : '');
  const growthRates = isNumber(inputs.growth) ? [inputs.growth - 2, inputs.growth, inputs.growth + 2] : [];
  const discounts = isNumber(inputs.discount) ? [inputs.discount - 2, inputs.discount, inputs.discount + 2] : [];
  const ordered = growth.every(g => isNumber(parse(g))) && Number(growth[0]) <= Number(growth[1]) && Number(growth[1]) <= Number(growth[2]);

  return <section className="panel valuation-panel" aria-labelledby="valuation-title">
    <div className="panel-heading"><div><p className="eyebrow">Buffett & Graham · price versus value</p><h2 id="valuation-title">What would you pay?</h2></div><span className="valuation-badge">Scenario model</span></div>
    <p className="valuation-intro">Estimate a range of values, set a margin of safety and work backwards from today’s price. Starting assumptions are illustrative and editable.</p>
    {!ready ? <div className="valuation-empty" role="status">{loading ? 'Loading the quote and annual cash flows…' : 'Load a company with annual statements and a current quote to use the valuation workbench.'}</div> : <>
      <div className="valuation-source">
        <div><strong>{cashOverride === null ? 'Starting cash flow: reported FCF proxy' : 'Starting cash flow: your estimate'}</strong>
          <p>FY {year.date} · OCF less all capex / basic weighted-average shares. Model values and price use {basis?.currency} per share{price.currency !== basis?.currency ? ' (quote units converted)' : ''}.</p>
          {basis?.reason && cashOverride === null && <p className="valuation-warning">{basis.reason}</p>}
          {fx && <p>FX: 1 {fx.from} = {numberText(fx.rate, 4)} {fx.to} · retrieved {new Date(fx.fetchedAt).toLocaleString('en-GB', { timeZone: 'Europe/London' })} London.</p>}
        </div>
        <div><NumberField label={'Sustainable cash flow / share (' + basis?.currency + ')'}
          value={cashOverride === null ? (isNumber(cash) ? String(Number(cash.toPrecision(8))) : '') : cashOverride}
          onChange={setCashOverride} step="0.01" min={0} placeholder="Enter reviewed cash flow" />
          {cashOverride !== null && <button type="button" className="valuation-reset" onClick={() => setCashOverride(null)}>Use reported FCF again</button>}
        </div>
      </div>
      <div className="valuation-controls">
        <NumberField label="Required equity return (%)" value={discount} onChange={setDiscount} min={0} max={100} />
        <NumberField label="Terminal growth (%)" value={terminal} onChange={setTerminal} min={-99.9} max={99.9} />
        <NumberField label="Forecast horizon (years)" value={horizon} onChange={setHorizon} step="1" min={1} max={30} />
        <NumberField label="Target margin of safety (%)" value={safety} onChange={setSafety} min={0} max={99.9} />
      </div>
      <p className="valuation-caption">Current quote: <strong>{money(basis?.price ?? null)}</strong> · Shareholder cash-flow model; the discount rate is a required equity return.</p>
      {!ordered && <p className="valuation-warning" role="status">Set Bear ≤ Base ≤ Bull growth to keep scenario labels consistent.</p>}
      <div className="valuation-cases" aria-live="polite">
        {cases.map((name, index) => {
          const result = results[index];
          return <article className={'valuation-case ' + (index === 1 ? 'valuation-base' : '')} key={name}>
            <div className="valuation-case-heading"><h3>{name} case</h3>{index === 1 && <span>Central assumption</span>}</div>
            <NumberField label={name + ' annual cash-flow / share growth (%)'} value={growth[index]} min={-99.9} max={100} onChange={v => setGrowth(growth.map((g, i) => i === index ? v : g))} />
            {result.ok ? <>
              <p className="valuation-value">{money(result.value)}<span>Model value per share</span></p>
              <dl><div><dt>Price at target safety margin</dt><dd>{money(result.entryPrice)}</dd></div>
                <div><dt>Current margin of safety</dt><dd className={isNumber(result.marginOfSafety) && result.marginOfSafety < 0 ? 'negative' : ''}>{numberText(result.marginOfSafety)}%</dd></div>
                <div><dt>Upside / downside to model</dt><dd>{numberText(result.upside)}%</dd></div>
                <div><dt>Value from terminal period</dt><dd>{numberText(result.terminalShare)}%</dd></div></dl>
            </> : <p className="valuation-warning" role="status">{result.reason}</p>}
          </article>;
        })}
      </div>
      <div className="valuation-detail-grid">
        <div className="reverse-dcf"><p className="eyebrow">Reverse DCF</p><h3>What is today’s price assuming?</h3>
          <p className="reverse-value">{isNumber(reverse.growth) ? numberText(reverse.growth, 2) + '%' : '—'}<span>annual cash-flow growth per share</span></p>
          <p>{reverse.reason || ('Growth required for the model to match the current quote over ' + horizon + ' years, with ' + discount + '% required return and ' + terminal + '% terminal growth. This is an implied scenario, not a market forecast.')}</p>
        </div>
        <div className="valuation-sensitivity"><h3>How sensitive is the base case?</h3><p>Model value per share · {basis?.currency}. Growth and required return varied by ±2 percentage points.</p>
          <div className="valuation-table-scroll"><table><caption className="sr-only">Model value sensitivity to annual growth and required equity return</caption>
            <thead><tr><th scope="col">Required return ↓ / Growth →</th>{growthRates.map(g => <th scope="col" key={g}>{numberText(g)}%</th>)}</tr></thead>
            <tbody>{discounts.map((r, row) => <tr key={r}><th scope="row">{numberText(r)}%</th>{growthRates.map((g, col) => {
              const v = valueCashFlows({ ...inputs, growth: g, discount: r });
              return <td className={row === 1 && col === 1 ? 'valuation-central-cell' : ''} key={g} title={v.ok ? 'Model value per share' : v.reason}>{v.ok ? numberText(v.value, 2) : '—'}</td>;
            })}</tr>)}</tbody>
          </table></div>
        </div>
      </div>
      <p className="valuation-footnote">Assumptions apply to this ticker and financial year in this session. They reset when you change ticker or financial year, refresh statement data or reload the page.</p>
    </>}
    <details className="methodology"><summary>Valuation method & what to review</summary>
      <p>For annual cash flow per share C, growth g, required equity return r and horizon N, model value is the sum of C × (1 + g)^t / (1 + r)^t for t = 1…N, plus C × (1 + g)^N × (1 + terminal growth) / (r − terminal growth) / (1 + r)^N. Cash flows arrive at year end. There is no growth fade before the terminal period.</p>
      <p>Margin of safety = 1 − price / model value. Price at target safety margin = model value × (1 − target margin). Upside = model value / price − 1. These percentages have different denominators.</p>
      <p>The imported OCF less capex figure is a starting proxy, not a verified estimate of cash available to shareholders or Buffett’s owner earnings. Review maintenance versus growth capex, working capital, stock compensation, dilution, interest classification, financing flows and one-offs. Basic average shares may differ from today’s diluted share count. Per-share growth must include the effect of future dilution or buybacks.</p>
      <p>This model assumes cash available to equity after required reinvestment and financing needs. Do not enter unlevered free cash flow and discount it at a cost of equity; that requires a separate enterprise-value model and debt bridge. No cash or debt adjustment is added automatically. Negative cash-flow companies, banks and insurers need a different valuation method.</p>
      <p>Historical annual cash flow is used as the base at today’s valuation date. Review whether the selected year is representative. FX is held constant. Terminal growth must stay below the required return; a high terminal share exposes the result to distant assumptions. Reverse DCF searches annual growth between −95% and 100%.</p>
      <p>Ideas informed by <a href="https://www.berkshirehathaway.com/letters/1986.html" target="_blank" rel="noreferrer">Buffett’s owner-earnings discussion</a> and <a href="https://www.berkshirehathaway.com/letters/1992.html" target="_blank" rel="noreferrer">his discussion of Graham’s margin of safety</a>. Defaults are illustrative, not rules endorsed by those investors.</p>
    </details>
  </section>;
}
