# Quality — Stock Research

A responsive stock research website with Yahoo Finance price history and a company-quality table inspired by Terry Smith. The default ticker is MSFT; any supported Yahoo ticker can be entered, including UK exchange suffixes such as `ULVR.L` and `DGE.L`.

## What it does

- Price and volume charts: 1M, 3M, 6M, YTD, 1Y, 5Y, maximum history and custom date ranges.
- Close prices by default; dividend-adjusted close is an explicit option.
- Seven financial metrics with the selected financial year and the previous year side by side.
- Annual operating cash flow, capital expenditure, free cash flow and revenue charts.
- Historical gross/operating margins, ROCE and cash conversion, with 3-year or all-available-year views.
- Reporting dates, quote timestamps, trading/reporting currencies and formula explanations.
- Separate price and statement loading/error states. Missing data are never filled with zero.

## Run locally

Requires Node 22.13+ and the pnpm version specified by `packageManager` in `package.json`.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

Open the local URL printed by the development command. No API key is required for the current Yahoo adapter. See [runtime details](docs/runtime.md) for the underlying Vinext/Cloudflare starter. The browser communicates only with this application's `/api/chart`, `/api/fundamentals` and `/api/fx` endpoints; server code requests and normalises Yahoo data.

```sh
pnpm build
pnpm start
node scripts/test-finance.mjs
pnpm exec tsc --noEmit
```

This is a React/TypeScript application using Vinext and Recharts, with server endpoints compatible with Cloudflare Workers. **yfinance is a Python library, rather than the API itself.** Using the underlying Yahoo endpoints avoids needing a separate Python service for this version. The provider boundary is isolated in `lib/market-data.ts` so a licensed API can replace it later.

## Metric definitions

All accounting inputs use reported **annual** statements, not trailing-twelve-month figures or analyst forecasts. The provider typically supplies around four years, with coverage varying by ticker. The first ROCE observation may be unavailable because calculating average capital requires the previous balance sheet.

| Metric | Dashboard calculation |
| --- | --- |
| ROCE | EBIT / average of opening and closing (total assets − current liabilities) |
| Gross margin | Gross profit / revenue |
| Operating margin | Operating income / revenue |
| Cash conversion | (operating cash flow − all capital expenditure) / net income |
| Interest cover | EBIT / gross interest expense |
| Free cash flow yield | Annual FCF / basic weighted-average shares × reporting-to-trading FX / latest share price |
| Free cash flow growth | Annual FCF / previous annual FCF − 1 |

Percentage metrics are multiplied by 100. Interest cover is a multiple. Negative capex in the provider's cash-flow statement is converted to a positive expenditure before subtraction.

ROCE, cash conversion and FCF yield are explicitly documented **proxies**, not an exact reproduction of Fundsmith's adjusted Bloomberg ratios. Fundsmith's cash conversion compares FCF per share with net income per share. Its valuation work may add back discretionary growth capex; our reproducible measure deducts all capex. Our ROCE denominator includes cash and goodwill. Our FCF yield uses fiscal-year average shares, which can differ from current shares after buybacks or issuance, and is shown only for the selected fiscal year at the current price.

Pence (`GBp`/`GBX`) are converted to pounds when comparing with GBP statements. Different reporting and trading currencies use a timestamped Yahoo FX quote; the conversion is displayed below the table. If FX is unavailable, FCF yield is N/A. Negative or zero net-income denominators, zero interest expense and negative or zero prior FCF produce N/M where appropriate. Comparisons require consecutive annual periods in the same currency. Banks and insurers are less suited to this operating-company framework.

## Research sources

- [Fundsmith's 2025 annual shareholder letter](https://www.fundsmith.co.uk/media/4hcfd1pg/2025-fef-annual-letter-web.pdf), pages 12–14: ROCE, gross margin, operating margin, cash conversion, interest cover, FCF growth and FCF yield.
- [Fundsmith Owner's Manual](https://www.fundsmith.co.uk/media/mv3abv1h/fef-owners-manual-a4-2025.pdf), investment approach and valuation methodology.
- [yfinance documentation and Yahoo data-use notes](https://ranaroussi.github.io/yfinance/).

Yahoo data may be delayed or restricted, and the endpoints are unofficial and can change. yfinance's documentation describes Yahoo's API as intended for personal use. Check data rights and use an appropriately licensed provider before sharing market data commercially or across a work team. There is no Fundsmith or Yahoo affiliation.

## Data behaviour

Price requests cache for up to five minutes per active server instance; annual statements for one hour. Caches are bounded and identical in-flight requests are deduplicated. There is no persistent data store. Query values are validated and provider hosts are fixed; URLs cannot be supplied by users. Request timeouts and provider errors return safe messages, not raw exceptions. A failed request does not silently display a different ticker or demo data.

Daily observations are used for short periods, weekly for five years/long custom ranges and monthly for maximum history. The displayed percentage is first-to-last displayed price change. It is not an exact reinvested total return or a return measured from the prior calendar-period close. Yahoo Close is split-adjusted but excludes dividend adjustments; adjusted close includes Yahoo's split/dividend adjustments. Latest price timestamps are shown separately from the chart observation dates.

## GitHub and work-PC setup

This standalone app lives in `quality-stock-dashboard/` on branch `codex/quality-stock-dashboard` of `cameronjmarshall/usdt-dashboard`.

See [WORK-PC-SETUP.md](WORK-PC-SETUP.md) for Windows installation and start instructions. Use `pnpm run dev:pc` for the Windows-friendly Next.js development server. The original Vinext commands remain available for the Cloudflare build.

The export does not contain the hosted Site's identity or any credentials. The existing hosted website is independent of this GitHub branch. GitHub stores the source; this server-backed app cannot run on static GitHub Pages alone.

## Validation

`node scripts/test-finance.mjs` runs five focused checks covering calculation integrity, denominator edge cases, capex signs, currency mismatches, history parsing and invalid API inputs. TypeScript checking and the production build are separate checks.

A feature-detected `read_stock_analysis` WebMCP tool reads the same state shown in the interface, including availability flags and calculation notes. Browsers without WebMCP work normally. Browser and WebMCP runtime QA were not performed in this creation session; no browser testing was requested.
