# BTC Rebound Lab — paper trading

Python 3.12+ and a local browser dashboard. No third-party packages, API key, wallet or money required. Public Polymarket data only. This branch contains an independent project in `polymarket-btc-paper/`.

## Windows setup

Install Python 3.12 or later from python.org and Git. In Command Prompt:

```bat
git clone --branch codex/polymarket-btc-paper --single-branch https://github.com/cameronjmarshall/usdt-dashboard.git btc-rebound
cd btc-rebound\polymarket-btc-paper
py -3 app.py
```

Open http://127.0.0.1:8765. On subsequent runs, double-click `start-work-pc.cmd`. On macOS/Linux use `python3 app.py`. No pip install needed. Stop with Ctrl+C. Keep your PC awake and the process running; closing the browser does not stop collection. GitHub stores the code; GitHub Pages cannot run this Python collector. Continuous collection needs an always-on computer or server. Do not expose this unauthenticated local dashboard to the internet.

## Exact experiment

- Buy the first qualifying Up **or** Down outcome at an observed ask of 30 cents or less.
- Entry eligible from the market start inclusive until start + 150 seconds exclusive.
- Ten shares, at most one entry per market, no re-entry or second-side purchase.
- Sell the entire position at an observed bid of 55 cents or more at any time after purchase, strictly before start + 300 seconds.
- No stop loss or forced early exit. Unsold positions await confirmed official settlement.
- Each simulated buy/sell needs two qualifying samples at least one second apart, no intervening failure, a maximum five-second observation gap, and enough size at the best price for all ten shares. This is a conservative liquidity screen, not a realistic queue simulator or guaranteed fill.
- Ties between qualifying sides use the API outcome ordering; do not interpret this as a strategy advantage.
- Fees explicitly **assume** `shares × 0.07 × price × (1-price)` on entry and target exit. This is the documented crypto schedule at development time, not automatically verified market-specific fees. No rebates or settlement exit fee. Ten shares bought at .30 and sold at .55 give $2.17975 net under this model.

Change `CONFIG` in engine.py for a separate experiment and use `python app.py --db experiment-2.sqlite`. Existing databases reject changed settings to prevent silently mixing experiments.

## Data and interpretation

Gamma API discovers the current `btc-updown-5m-{UTC epoch start}` market and validates its identity, end time and Up/Down labels. Public CLOB REST order books are sampled approximately every second plus network latency; requests taking over three seconds are rejected. Quote timestamps must be within five seconds of receipt. A market with unchanged old snapshots may be skipped. Keep your system clock synchronized.

The SQLite database stores market metadata/rules, accepted bid/ask observations and sizes, experiment settings, and trades. Restart recovery prevents duplicate entries. Market metadata is retained because resolution rules can change. Settlement requires Gamma `closed=true`, `umaResolutionStatus=resolved` and exact binary outcome prices. If those fields are unavailable or change, positions stay pending rather than assigning a winner from a quote or another BTC feed.

This is a forward paper recorder, **not a historical backtest**. REST sampling misses brief moves. Quote availability, the confirmation delay, competition, fees and latency can make actual outcomes different. Data gaps are not reconstructed; pending positions and failed rebounds must remain in analysis. Target-hit count uses closed trades as denominator, with open/pending shown separately; it is not a settled strategy estimate while pending trades remain. Realised P&L excludes open exposure. No BTC spot-volatility model, confidence interval, drawdown analysis, WebSocket recorder or live execution is included in v1.

Read-only dashboard updates every two seconds. Export the ledger using the CSV link. Back up `paper.sqlite` while the app is stopped; do not commit research data to this public repository. The observation database grows with runtime. View existing results without network access with `python app.py --offline`.

## Validation

```sh
python -m unittest -v
```

Tests cover entry cutoff, sale eligibility until expiry, liquidity, fee math, settlement, stale observation gaps, and restart deduplication. Live connectivity depends on network and API availability; any error is displayed instead of fabricated market data.

## API references

- https://docs.polymarket.com/api-reference/markets/get-market-by-slug
- https://docs.polymarket.com/market-data/prices-orderbook
- https://docs.polymarket.com/market-data/realtime-data
- https://docs.polymarket.com/trading/fees

For a more precise second phase, replace sampled books with a WebSocket recorder and replay recorded depth with measured execution latency. Keep the paper engine separate from any future order execution adapter.
