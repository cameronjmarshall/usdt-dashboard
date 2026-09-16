# Value Dashboard — research roadmap

## Purpose

Help an investor assess the quality of a business, the price paid, its ability to withstand stress and the evidence behind the investment thesis. Keep assumptions, facts and judgement distinguishable. A single score should not conceal a weak balance sheet, an excessive price or an untested forecast.

## Imported baseline and first refinement

Source: `cameronjmarshall/usdt-dashboard`, branch `codex/quality-stock-dashboard`, commit `bd6e192`. This project continues on `codex/value-dashboard` in the same repository; it has not been moved to a new GitHub repository or redeployed to the existing hosted website.

| Area | Implemented now |
| --- | --- |
| Prices | Yahoo ticker lookup, price/volume charts, custom periods, close/adjusted-close selection |
| Quality | Seven existing metrics: ROCE, gross/operating margins, cash conversion, interest cover, FCF yield and FCF growth |
| History | Annual cash/revenue charts and quality trends with reported periods and currencies |
| Valuation | New editable bear/base/bull shareholder cash-flow scenarios, margin-of-safety entry prices, reverse DCF and sensitivity table |
| Transparency | Formulas, missing-data explanations, FX/pence handling, explicit proxy labels and terminal-value contribution |

The original seven metrics are preserved. The valuation module is a first research tool, not a complete valuation engine: reported FCF is a starting proxy, assumptions are session-only and banks/insurers require a different approach.

## Four complementary approaches

These are proposed product features inspired by the investors' published principles, not endorsements, exact replicas of their methods or claims about what they would buy.

| Approach | Research question | Proposed additions |
| --- | --- | --- |
| Buffett | Can the business compound cash for owners over time? | Owner-earnings bridge with analyst maintenance-capex estimates; moat evidence; capital allocation; dilution; incremental returns on reinvestment |
| Graham | What protects capital if the thesis is wrong? | Margin of safety; liquidity; net debt; maturities; pension obligations; contingent liabilities; sector-appropriate asset backing |
| Terry Smith | Are returns on capital durable and backed by cash? | Longer ROCE/ROIC series; cash conversion consistency; margin stability; organic growth; reinvestment runway; acquisition dependence |
| Dalio | How vulnerable is the portfolio to changes in growth and inflation? | Portfolio holdings and weights; risk contributions; FX/geography concentration; correlation; explicit growth/inflation and rate scenarios |

Buffett's [1986 letter](https://www.berkshirehathaway.com/letters/1986.html) explains why owner earnings require judgement about maintenance capital expenditure and working capital. His [1992 letter](https://www.berkshirehathaway.com/letters/1992.html) discusses business valuation and Graham's margin-of-safety principle. These inform the proposed valuation and evidence workflow.

Fundsmith's [investment criteria](https://www.fundsmith.co.uk/factsheet/) emphasise durable returns on operating capital, repeatable competitive advantages, reinvestment and limited leverage. Bridgewater's [All Weather explanation](https://www.bridgewater.com/research-and-insights/the-all-weather-story) informs the proposed portfolio scenario work. A collection of equity tickers alone is insufficient to reproduce a portfolio designed for different growth and inflation outcomes.

## Recommended build order

### 1. Data confidence and financial resilience

Show input-level provenance, fiscal period, retrieval time, units and coverage. Add current assets, cash, debt, leases, equity, diluted shares and stock compensation where reliably available. Distinguish missing from not applicable. Reconcile a few representative US and UK companies to their published statements, including differing reporting/trading currencies and exceptional items.

Use a liquidity/debt view with current ratio, net debt, debt-to-cash-flow and coverage only where the denominators and business model make those ratios meaningful. Debt maturities, covenants and pension commitments require source documents or reviewed manual entry. Do not infer solvency from a high interest-cover ratio alone.

For longer histories, evaluate provider coverage and licensing. The current adapter generally returns only around four annual periods; requesting ten years does not create ten years of reliable data. Financial companies need a separate template.

### 2. Save the investment case

Add a watchlist and versioned per-company research: thesis, source links, assumptions, bear case, risks, catalysts, valuation range, review date and explicit evidence that would invalidate the thesis. Save model inputs with their underlying quote/statement snapshot so a later refresh does not rewrite the historical decision.

A concise investment memo/export is more useful than adding numerous loosely interpreted ratios. For team use, research needs shared persistence, authentication and permissions; browser-only storage would not provide that workflow.

### 3. Deepen valuation and business quality

Add a sustainable owner-earnings bridge with separately entered maintenance capex, growth capex, working-capital normalisation and dilution assumptions. Do not automatically call OCF minus capex owner earnings. Allow normalisation across comparable annual periods and record analyst adjustments with sources.

Add a distinct enterprise DCF using unlevered cash flow, WACC and an explicit net-debt/non-operating-assets bridge. Never mix that model with the current equity cash-flow model. Add growth fade, expected-return scenarios and reinvestment requirements so high growth is not treated as free.

Assess moat strength through evidence about switching costs, network effects, cost advantages, brand/pricing power and regulation. Pair these judgements with the persistence of returns and margins. Avoid an automatic moat verdict inferred from one year's gross margin.

### 4. Portfolio resilience

Start with holdings, weights, base currency, asset classes and rebalancing assumptions. Add concentration, correlations, drawdowns and risk contributions with stated historical windows. Document whether returns are price or total return and treat missing/stale prices explicitly.

Provide user-defined scenarios for weaker growth, higher inflation, rising real yields and adverse FX. Separate historical estimates from hypothetical shocks; equity-only diversification does not establish all-weather resilience. Scenario results must show the assumptions driving each holding's estimated impact.

## Design principles

- Make the next research question obvious: quality, value, resilience, then thesis.
- Keep reported inputs and analyst adjustments visible; avoid unsupported precision.
- Use sector-aware comparisons and explain denominators, currencies and periods.
- Label unavailable data instead of substituting zeros or optimistic grades.
- Preserve an audit trail of assumptions and decisions before adding recommendations or composite scores.
