# Poly Paper Lab — three BTC five-minute bots

A browser dashboard plus a persistent Python paper-trading collector. All three strategies observe the same public Polymarket books and keep independent balances. **No real orders, credentials, wallets or money.** Python 3.10+; standard library only, with no `pip` or Conda installation step.

## Run on your Mac

In Terminal, for a fresh checkout:

```sh
git clone --branch codex/polymarket-five-minute-bots --single-branch https://github.com/cameronjmarshall/usdt-dashboard.git poly-five-minute
cd poly-five-minute/polymarket-btc-paper
python3 app.py
```

Open **http://127.0.0.1:8765** in your browser. Leave the Terminal running. A terminal that says the dashboard URL and then waits is normal: it is serving the dashboard and collecting data. Stop with Ctrl+C. For later runs, use `python3 app.py` from the same folder, or double-click `start-mac.command`.

If you already have the repository locally, first save any uncommitted changes, then:

```sh
git fetch origin
git switch codex/polymarket-five-minute-bots
cd polymarket-btc-paper
python3 app.py
```

## Run on Windows

```bat
git clone --branch codex/polymarket-five-minute-bots --single-branch https://github.com/cameronjmarshall/usdt-dashboard.git poly-five-minute
cd poly-five-minute\polymarket-btc-paper
py -3 app.py
```

Open the same URL. For later runs, double-click `start-work-pc.cmd`.

## Try the dashboard with generated scenarios

```sh
python3 app.py --demo
```

On Windows: `py -3 app.py --demo`, or double-click `start-demo.cmd`. On Mac you can also run `./start-mac.command --demo`. Stop the live process before running demo on the same port, or add `--port 8766`.

Demo runs at 10× speed by default (one five-minute round takes about 30 seconds). `--demo-speed 1` uses normal speed. A prominent **SYNTHETIC DEMO** banner identifies generated data, which is stored separately. It exercises target exits, reversals, settlement and the second entry window; its P&L is not evidence of profitability. Demo never connects to Polymarket, and live failures never fall back silently to generated data.

## Exact strategy rules

All prices are outcome-share prices in US dollars: 35 means 35¢, not BTC's spot price. Elapsed time is measured from the five-minute market's scheduled UTC epoch start, not from when the application launches.

| Bot | Eligible buying window | Buy limit | Sell target |
| --- | --- | --- | --- |
| 1 | 0:00 inclusive to 2:30 exclusive | 35¢ or less | 70¢ or more |
| 2 | 0:00 inclusive to 2:30 exclusive | 35¢ or less | 85¢ or more |
| 3 | 0:00 inclusive to 2:00 exclusive | 40¢ or less | 60¢ or more |
| 3 | 2:00 inclusive to 3:00 exclusive | 45¢ or less | 60¢ or more |

- All bots may sell after their buying windows close, strictly before 5:00. No forced midpoint sale or stop loss.
- Shares still held at expiry stay pending until official resolution. Winning shares redeem at $1 and losing shares at $0. Settlement has no simulated exit fee.
- Default: both Up and Down are eligible, with **one open position per bot per market**. A position awaiting settlement in an earlier round does not block entry in a new round. All open stakes, including likely losses, stay reserved until a target exit or official settlement; a new entry still needs enough available cash. The cheapest eligible outcome is selected; an exact tie uses alphabetical outcome name. There is no directional BTC forecast.
- Re-entry is allowed after a full exit while the buying window remains open. There is no same-snapshot sell-and-rebuy. Use `--single-entry` for at most one entry per bot per round.
- Each bot starts with $1,000 paper cash. Every entry budgets at most $10 **including entry fees**. Share quantity varies with the actual execution price. Trades require enough cash for the configured stake; no leverage or automatic top-ups.
- **Pause entries** prevents new buys but continues recording, target exits and settlement. The pause setting survives a restart.

## Change the experiment size

```sh
python3 app.py --stake 25 --bankroll 2000 --side Up --single-entry --db up-only.sqlite
```

`--side` accepts `both`, `Up`, or `Down`. Stakes and bankrolls are dollars, per bot. A fresh `--db` file starts a separate experiment. Existing databases remember their settings; launching with incompatible settings is rejected. Restart an experiment with `python3 app.py --db up-only.sqlite`. The three strategies are fixed in `engine.py`; changing rules requires a version bump and a new experiment database.

## Fill and fee model

This tests marketable **taker** execution when observed executable prices meet the thresholds, not a resting limit-order queue.

1. Public CLOB order books for both tokens are requested concurrently, approximately once per second plus network latency. Both books must be valid before any bot evaluates the observation.
2. A signal must remain eligible across two observations at least one second apart, with no intervening invalid/missed observation and no gap over five seconds. A change in Bot 3's buy threshold restarts confirmation. This confirmation screen is an approximation of execution delay, not an exchange latency model.
3. Each buy consumes asks from cheapest upwards, never above the bot's buy limit. Each sale consumes bids from highest downwards, never below its target. The entire stake or position must fit in the observed depth; insufficient depth means no fill, rather than an invented full or partial fill. VWAP reflects the displayed depth. Rounding reserves a tiny unused amount of entry cash.
4. Both the book minimum share size and Gamma's documented minimum notional screen entries. The default $10 stake clears ordinary minimums; very small stakes can produce no fills. Exit depth must cover all shares.
5. Fees use the market's Gamma `feeSchedule` or CLOB `fd` metadata. If unavailable, the **explicitly labelled assumption** is the documented crypto curve: `shares × 0.07 × price × (1-price)`. General metadata uses `shares × rate × [price × (1-price)]^exponent`. Fees are rounded to five decimals at each consumed price level. Entry fees are charged against the paper dollar budget (a cash-equivalent accounting approximation); actual fee denomination/rounding can differ. No maker rebates or taker rebates are assumed.
6. Each bot independently sees the same original depth. These are counterfactual comparisons; their results must not be treated as one jointly executable portfolio.

REST sampling can miss fast crossings. Two snapshots cannot prove liquidity stayed available between them or after submission. Market impact, other traders, queue priority, partial fills and outages can change actual profitability. This is a **forward paper experiment**, not a historical backtest or an assurance of live returns.

## Dashboard and saved results

- Current market, countdown and Up/Down ask/bid chart. Hover over the chart for the recorded quotes.
- Three bot cards: realised net P&L, return on initial bankroll, closed/entered trades, win rate, target exits, cash, fees and realised drawdown. The current-market position is shown separately from the count awaiting settlement. Available cash, reserved stakes and marked equity include every open position, with stale marks identified.
- Shared cumulative **realised** P&L chart; results only change when positions close. Win rate includes both target exits and official settlements and excludes still-open positions.
- Open P&L and estimated equity use the last observed liquidation bids net of estimated fees. Uncovered depth is valued at zero for the remainder. These estimates become stale after five seconds and are not guaranteed sale values or official settlement values.
- Drawdown is measured on closed-trade P&L, not intratrade marked equity. The chart shows the latest 800 exits per bot while retaining lifetime cumulative P&L; summary statistics cover the whole experiment.
- Latest 500 trades with bot/status filters; **Export trades** downloads the full ledger. Full recorded order books can be exported under Experiment rules.
- Latest 20 observed rounds. Markets with no open position do not require settlement queries, so some completed rounds remain labelled simply as closed rounds.

`bots-live.sqlite` and `bots-demo.sqlite` are separate, local SQLite files. Each stores settings, market/fee metadata, observations, all entries/exits, feed errors and settlement evidence. The earlier single-bot `paper.sqlite` is never overwritten or migrated. Existing three-bot `bots-live.sqlite` and `bots-demo.sqlite` files are upgraded in place as described below. Database files are excluded from Git. Back up your database while the process is stopped. Run only one collector per database.

Existing three-bot databases (version 2) upgrade automatically to the per-market position limit. The upgrade preserves all trades, observations, settings and pending stakes, and logs the policy change with a timestamp in the events table. Earlier results are retained as collected under the former global position limit; they are not recalculated. Use a fresh `--db` file if you want a sample entirely under the new policy.

To inspect results without collecting:

```sh
python3 app.py --offline --db bots-live.sqlite
python3 app.py --offline --db bots-demo.sqlite
```

Changing/closing browser tabs does not stop collection. Closing the Python process, turning off the machine or sleeping it does; no missing market history is reconstructed. For unattended collection, keep a computer awake or run the application on an always-on machine. GitHub stores the code; GitHub Pages cannot run this Python collector. The app listens only on `127.0.0.1` and has no remote login feature.

## Data quality and connection failures

The adapter validates the `btc-updown-5m-{start}` slug, outcome-token mapping and exactly five-minute end time. It rejects slow responses (over three seconds), stale quotes (over five seconds), future timestamps (over one second), crossed books and incorrect token IDs. An empty ask side can still support an exit; an empty bid side cannot produce an invented exit.

Keep your computer clock synchronized. Reconnection never executes old observations or retroactively catches up missed trades. A failed book pair clears pending signals. Metadata is refreshed every 30 seconds. Settlement checks run separately every 15 seconds so they do not block book polling; holdings require matching Gamma slug, `closed=true`, `umaResolutionStatus=resolved`, and exact binary outcome prices before settlement is recorded. If those fields are absent or the schema changes, positions remain pending and the dashboard says so.

HTTP 403, rate limits, missing markets, certificate errors and other feed problems are shown in the status line. The collector retries; these errors do not generate simulated prices or fills. On macOS, a certificate verification error with a python.org Python installation can require its bundled **Install Certificates.command**. No package manager is needed to run this app.

## Verification

```sh
python3 -m unittest -v
```

Tests cover the exact 2:00, 2:30, 3:00 and 5:00 boundaries; distinct bot targets; both outcome sides; ask/bid execution; depth/VWAP and fee math; re-entry; cash limits; paused entries with continuing exits; signal resets; stale/malformed data; official resolution; concurrent positions across successive markets; reserved cash and settlement accounting; upgrades that preserve existing results; pending exposures; restart recovery; and experiment isolation.

Live endpoint access from the build environment returned HTTP 403, so the live collector could not be exercised end to end there. The adapter is checked against official API formats and controlled fixtures; synthetic demo and local HTTP tests exercise the application without that access. Browser rendering could not be visually verified in the build environment because no local browser executable was available and the cloud browser blocked local-file previews. Local HTTP/CSV/control checks and JavaScript syntax checks passed. Verify that the dashboard says the public order books are connected when running on your machine before relying on a live observation sample.

## Official API references

- [Market discovery and metadata](https://docs.polymarket.com/market-data/market-details)
- [CLOB order book](https://docs.polymarket.com/api-reference/market-data/get-order-book)
- [CLOB fee configuration](https://docs.polymarket.com/api-reference/markets/get-clob-market-info)
- [Fee curve](https://docs.polymarket.com/trading/fees)
- [Order lifecycle and taker delays](https://docs.polymarket.com/concepts/order-lifecycle)
