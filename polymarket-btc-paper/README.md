# Poly Paper Lab — shared dashboard and recorded-data research

A mobile-friendly browser dashboard, persistent Python paper-trading collector, and recorded-order-book replay lab. All three strategies observe the same public Polymarket books and keep independent balances. **No real orders, credentials, wallets or money.** Python 3.10+; standard library only, with no `pip` or Conda installation step.

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

`--side` accepts `both`, `Up`, or `Down`. Stakes and bankrolls are dollars, per bot. A fresh `--db` file starts a separate experiment. Existing databases remember their settings; launching with incompatible settings is rejected. Restart an experiment with `python3 app.py --db up-only.sqlite`. The three live strategies remain fixed. The Backtesting form compares a custom candidate with those three baselines without changing the live engine or ledger.

## Fill and fee model

This tests marketable **taker** execution when observed executable prices meet the thresholds, not a resting limit-order queue.

1. Public CLOB order books for both tokens are requested concurrently, approximately once per second plus network latency. Both books must be valid before any bot evaluates the observation.
2. A signal must remain eligible across two observations at least one second apart, with no intervening invalid/missed observation and no gap over five seconds. A change in Bot 3's buy threshold restarts confirmation. This confirmation screen is an approximation of execution delay, not an exchange latency model.
3. Each buy consumes asks from cheapest upwards, never above the bot's buy limit. Each sale consumes bids from highest downwards, never below its target. The entire stake or position must fit in the observed depth; insufficient depth means no fill, rather than an invented full or partial fill. VWAP reflects the displayed depth. Rounding reserves a tiny unused amount of entry cash.
4. Both the book minimum share size and Gamma's documented minimum notional screen entries. The default $10 stake clears ordinary minimums; very small stakes can produce no fills. Exit depth must cover all shares.
5. Fees use the market's Gamma `feeSchedule` or CLOB `fd` metadata. If unavailable, the **explicitly labelled assumption** is the documented crypto curve: `shares × 0.07 × price × (1-price)`. General metadata uses `shares × rate × [price × (1-price)]^exponent`. Fees are rounded to five decimals at each consumed price level. Entry fees are charged against the paper dollar budget (a cash-equivalent accounting approximation); actual fee denomination/rounding can differ. No maker rebates or taker rebates are assumed.
6. Each bot independently sees the same original depth. These are counterfactual comparisons; their results must not be treated as one jointly executable portfolio.

REST sampling can miss fast crossings. Two snapshots cannot prove liquidity stayed available between them or after submission. Market impact, other traders, queue priority, partial fills and outages can change actual profitability. The live ledger is a **forward paper experiment**. The separate replay lab backtests observations collected by this application; it does not supply earlier historical books or assure live returns.

## Dashboard and saved results

- Current market, countdown and Up/Down ask/bid chart. Hover over the chart for the recorded quotes.
- Three bot cards: realised net P&L, return on initial bankroll, closed/entered trades, win rate, target exits, cash, fees and realised drawdown. The current-market position is shown separately from the count awaiting settlement. Available cash, reserved stakes and marked equity include every open position, with stale marks identified.
- Shared cumulative **realised** P&L chart; results only change when positions close. Win rate includes both target exits and official settlements and excludes still-open positions.
- Open P&L and estimated equity use the last observed liquidation bids net of estimated fees. Uncovered depth is valued at zero for the remainder. These estimates become stale after five seconds and are not guaranteed sale values or official settlement values.
- Drawdown is measured on closed-trade P&L, not intratrade marked equity. The chart shows the latest 800 exits per bot while retaining lifetime cumulative P&L; summary statistics cover the whole experiment.
- Latest 500 trades with bot/status filters; **Export trades** downloads the full ledger. Full recorded order books can be exported under Experiment rules.
- Latest 20 observed rounds. Official outcomes are now checked for every observed market, including those with no trades. Unresolved markets are retried in rotating batches of 20.

`bots-live.sqlite` and `bots-demo.sqlite` are separate, local SQLite files. Each stores settings, market/fee metadata, observations, all entries/exits, feed errors and settlement evidence. The earlier single-bot `paper.sqlite` is never overwritten or migrated. Existing three-bot `bots-live.sqlite` and `bots-demo.sqlite` files are upgraded in place as described below. Database files are excluded from Git. The online backup service makes consistent copies through the SQLite backup API, including committed WAL data. Run only one collector per database.

Existing three-bot databases (version 2) upgrade automatically to the per-market position limit. The upgrade preserves all trades, observations, settings and pending stakes, and logs the policy change with a timestamp in the events table. Earlier results are retained as collected under the former global position limit; they are not recalculated. Use a fresh `--db` file if you want a sample entirely under the new policy.

To inspect results without collecting:

```sh
python3 app.py --offline --db bots-live.sqlite
python3 app.py --offline --db bots-demo.sqlite
```

Changing/closing browser tabs does not stop collection. Closing the Python process, turning off the machine or sleeping it does; no missing market history is reconstructed. For unattended collection, keep a computer awake or run the application on an always-on machine. GitHub stores the code; GitHub Pages cannot run this Python collector. The default remains loopback-only. The hosted configuration below enables authenticated remote access behind HTTPS.

## Data quality and connection failures

The adapter validates the `btc-updown-5m-{start}` slug, outcome-token mapping and exactly five-minute end time. It rejects slow responses (over three seconds), stale quotes (over five seconds), future timestamps (over one second), crossed books and incorrect token IDs. An empty ask side can still support an exit; an empty bid side cannot produce an invented exit.

Keep your computer clock synchronized. Reconnection never executes old observations or retroactively catches up missed trades. A failed book pair clears pending signals. Metadata is refreshed every 30 seconds. Settlement checks run separately every 15 seconds so they do not block book polling; holdings require matching Gamma slug, `closed=true`, `umaResolutionStatus=resolved`, and exact binary outcome prices before settlement is recorded. If those fields are absent or the schema changes, positions remain pending and the dashboard says so.

HTTP 403, rate limits, missing markets, certificate errors and other feed problems are shown in the status line. The collector retries; these errors do not generate simulated prices or fills. On macOS, a certificate verification error with a python.org Python installation can require its bundled **Install Certificates.command**. No package manager is needed to run this app.

## Shared online deployment

The repository root `render.yaml` prepares one always-on Docker web service with a persistent 10 GB disk. It is a deployment recipe, **not evidence that hosting is active**. A connected Render account and reviewed hosting charges are required to provision it. GitHub Pages alone cannot run the collector or shared database.

1. In Render, create a Blueprint from this repository and the `codex/polymarket-cloud-research` branch. Review the paid service and disk charges before creation.
2. Use the generated HTTPS service URL on both phone and Mac. Sign in as **cameron** with the generated `PAPER_LAB_PASSWORD` from the service environment settings. Never put this secret in GitHub or a URL.
3. `RENDER_EXTERNAL_URL` automatically supplies the trusted origin. For a custom HTTPS domain, set `PUBLIC_ORIGIN` to that exact origin (no path).
4. Confirm the dashboard says **Public order books connected**, the quote timestamp advances, and snapshots accumulate. Deployment health only checks the web server, not Polymarket connectivity. If public API access is blocked, show the failure and investigate permitted availability; do not substitute synthetic data or bypass restrictions.
5. Keep exactly one process/instance using this database. Updates restart collection briefly and create a visible recording gap. Automatic deploys are disabled; deploy reviewed commits deliberately.

Remote binding fails closed without a password of at least 24 characters and a configured HTTPS origin. TLS termination belongs to Render or another trusted reverse proxy. The Python port must not be exposed directly over public HTTP. All dashboard, research, CSV and backup routes require login; only `/healthz` is public. Control requests enforce the configured host/origin and a custom header. This is a single-owner research app, not a multi-user trading service.

The source code and deployment recipe are backed up in GitHub. Trades, books, research runs and configuration are held on the server disk, never in Git. Phone and Mac read the same database through the server; no browser-local trading history is used. Existing databases on a Mac are **not automatically uploaded**; restore one deliberately if needed.

## Backtesting

Use **Test your next idea** to choose a candidate buy limit, sell target, entry timing, optional second window, stake, bankroll, allowed outcomes and re-entry policy. Date inputs use the device's local time. Blank dates use the recorded sample; for a large database select a smaller range. Each run is limited to 100,000 paired snapshots and three minutes per segment. One replay runs at a time. Saved parameters and the latest ten result reports appear on every device; older reports remain in the database. Export a selected report as JSON.

The earliest 70% of selected market windows form the development period and the later 30% form validation. Both start with fresh balances and compare the candidate with the three original bots. Live pause decisions are deliberately ignored by replay: candidate strategies are evaluated as if entries were enabled. Only markets whose entire scheduled window fits in the date range are included, but their recording can still be partial. No coverage is fabricated. Each result shows snapshot counts, gaps over five seconds, rejected pairs, unresolved markets and markets whose fees were assumed.

Replay uses the same execution engine, depth/VWAP, fees, receipt/source timestamps, minimum share sizes, confirmation delay and reserved-cash accounting as forward trading. Feed interruptions and collector restarts reset confirmations. Settlement is applied at its recorded discovery time, only if it falls before that period ends: future outcomes cannot release cash early. Unsettled costs remain reserved and closed P&L must not be read as total profitability. Drawdown is realised-only. Sparse REST snapshots cannot prove executable liquidity between observations, model queue position, or reconstruct missed spikes. BTC spot/reference prices are not yet recorded; candidate rules currently use outcome order books and elapsed market time.

Backtesting cannot recover prices before collection started. The older schema omitted receipt/minimum-size details; those rows are retained and clearly counted, but replay refuses date ranges containing them instead of inventing inputs. The upgrade adds nullable metadata columns without changing prior trades. New records contain the required fields. Repeated tuning against the validation period makes it development data; recheck chosen settings on genuinely later observations.

## Backups and restoration

At startup and every 24 hours the service makes a compressed, integrity-checked SQLite backup. It keeps seven completed copies under the database's `backups/` directory, on the same persistent disk. **These are not off-site disaster-recovery backups.** Download the most recent copy with the dashboard button and retain it separately; the dashboard shows its timestamp. An external automatic backup destination is not configured yet. Book history grows continuously; monitor disk usage and arrange capacity/archive policy before it fills. No history is silently deleted.

To restore: stop the application, preserve the current database and its `-wal`/`-shm` companions together, decompress the chosen `.sqlite.gz` into a new database path, and start with `--db <new-path>`. Do not replace a running database. The restored file includes settings, trades, recorded books, market outcomes and research reports. The service marks interrupted replay jobs failed after restart; rerun them. Backups themselves do not contain the login password, which stays in hosting environment settings.

## Verification

```sh
python3 -m unittest -v
```

Tests cover the exact 2:00, 2:30, 3:00 and 5:00 boundaries; distinct bot targets; both outcome sides; ask/bid execution; depth/VWAP and fee math; re-entry; cash limits; paused entries with continuing exits; signal resets; stale/malformed data; official resolution; concurrent positions across successive markets; reserved cash and settlement accounting; upgrades that preserve existing results; pending exposures; restart recovery; and experiment isolation.

The cloud/research upgrade is verified with controlled fixtures for chronological replay, delayed settlement, reserved cash, minimum sizes, feed resets, legacy data rejection, missing pairs, authentication/CSRF and online backup restoration, alongside the existing engine tests. Check the delivery notes for the current test result and any live-feed/browser/deployment verification limits.

## Official API references

- [Market discovery and metadata](https://docs.polymarket.com/market-data/market-details)
- [CLOB order book](https://docs.polymarket.com/api-reference/market-data/get-order-book)
- [CLOB fee configuration](https://docs.polymarket.com/api-reference/markets/get-clob-market-info)
- [Fee curve](https://docs.polymarket.com/trading/fees)
- [Order lifecycle and taker delays](https://docs.polymarket.com/concepts/order-lifecycle)



### Bot 4: midpoint favourite trial

Forward paper trial added alongside the original three bots, with its own balance.
At the first valid paired snapshot crossing 150 seconds, buy the single side with
ask strictly above 80 cents, spending $10 including fees using available ask depth.
Hold until official settlement; no profit target, stop loss, or re-entry.
The previous valid observation must precede 150 seconds by no more than the
configured five-second gap; execution must be less than five seconds late.
A missed checkpoint, paused collector, insufficient funds/depth, or no unique
qualifying side skips the market permanently, including across restarts.
Existing trades and settings are retained. No historical Bot 4 trades are invented.
The custom backtest editor still compares its candidate with the original three
strategies; the new midpoint strategy is currently a forward trial.
