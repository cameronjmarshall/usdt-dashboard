# Crypto Reconcile

A first working reconciliation app for exchange and wallet CSVs. It runs on your computer in a browser, with no installation, account, external packages or server. It is independent of the existing market dashboard at the repository root.

## Open the app

1. Select the `codex/crypto-reconcile` branch on GitHub.
2. Choose **Code → Download ZIP**, then extract the ZIP.
3. Open `reconcile/index.html` in a current Edge, Chrome, Firefox or Safari browser.
4. Choose **Try sample data** to explore a fictional example, or **Import CSV** for your export.

Keep `index.html`, `styles.css`, `core.js`, `app.js` and `examples/` together. GitHub’s source viewer displays the code; it does not run the app. The app works offline after download. The existing market dashboard has its own network behaviour; this reconciliation folder has no network calls, analytics, API keys or external scripts.

## Import workflow

Select one or more CSV files. Each file opens its own mapping preview. Give each actual exchange and ledger/account a consistent name, then check the suggested columns and fee convention. Choose **Preview import** and inspect the results before importing.

Three layouts are supported:

| Layout | Required information | Result |
| --- | --- | --- |
| Sent & received | Date, an outgoing amount/currency and/or incoming amount/currency | A trade with both legs, a deposit, or a withdrawal |
| Trade fills | Date, Buy/Sell, base quantity, quote total or price, base and quote currencies | Each fill becomes a trade with both legs |
| Signed movements | Date, signed amount, currency; type and shared reference for trade legs | Each ledger entry is retained; related trade legs can display as one order |

For trade fills, currencies can come from separate columns, a delimited pair such as `BTC/USDT`, or explicit defaults. Concatenated symbols such as `BTCUSDT` are not guessed. When quote total is absent, quantity × price is calculated exactly and noted for review. Prefer the exchange’s actual quote total where available.

The mapper recognises common header names, including the sent/received columns found in universal transaction exports. It is **not a verified native importer for every exchange**. Exchanges publish different report types, versions, preambles and fee conventions. A sample export is needed to verify a particular format or add an adapter. Trade-history CSVs alone do not contain a complete account history: also import deposits, withdrawals, rewards and fee entries as applicable.

`examples/` contains fictional files for all three layouts. Use **Deduct fee in addition** with these examples. Keep real CSVs and saved projects outside this source repository.

### Dates, quantities and fees

- ISO dates, explicit timezone offsets, Unix timestamps, and slash dates with an explicit DD/MM versus MM/DD choice are supported. Times are normalised to UTC; day/month grouping and period filters use UTC.
- Unzoned dates use the selected fixed offset. This does not apply daylight-saving rules. Split exports spanning offset changes or supply explicit offsets. Sub-millisecond timestamps are rejected for now.
- Decimal arithmetic uses BigInt coefficients and decimal scales, without converting financial quantities to floating-point numbers. Quote amounts, fee totals and balance differences retain their precision.
- Decimal-point input supports standard comma thousands separators. Decimal-comma input must omit thousands separators. Quoted fields, multiline fields, UTF-8 BOM, comma/semicolon/tab separators and CRLF are supported. Remove report preambles and give columns unique names.
- Fee treatment is mandatory. **Additional deduction** posts the fee separately to the fee currency. **Already included** records the fee without another balance movement. Do not include a separate fee ledger entry and also deduct that same fee from a trade. A fee-only row must deduct its fee.
- Currency symbols are kept as supplied, uppercased; exchange-specific token aliases are not guessed. Use consistent currencies and account names. Use distinct account names or explicit currency identifiers when networks/assets must remain separate.

## Grouping and audit trail

**Trade order** is the default. Full trade fills combine only when exchange, account, shared order ID, sent currency and received currency all match. A buy and a sell remain separate. Missing order IDs leave entries separate. Signed ledger entries labelled `trade`, `buy` or `sell` can combine by shared reference within the same exchange/account; their outgoing and incoming currency totals remain distinct.

**Daily totals** and **Monthly totals** summarise the same transaction type and currency direction within each exchange/account and UTC period. Signed trade legs remain separate directional totals in these modes; use **Trade order** to pair them. **Individual entries** removes grouping. Grouping changes the display, not the underlying ledger or balance calculation. Amounts in different currencies are never summed together.

Expand a summary to inspect individual entries, fees, entry IDs, original CSV row numbers and source values. Marking rows **Reviewed** records your review; it does not verify balances or approve tax treatment.

### Duplicates and rejected rows

- A unique fill/entry ID is scoped to its exchange and account. A repeated ID with identical economic details is a duplicate. Repeated IDs with conflicting details are excluded for review. An order ID or blockchain transaction hash is not a unique fill ID.
- Identical new fills without unique IDs remain separate. If matching entries already exist, the importer asks whether to keep or exclude the possible duplicates. It cannot reliably determine identity from amounts and times alone.
- Re-importing the exact file with the exact same mapping does not add it again.
- Invalid rows and conflicting IDs are listed before import. You must acknowledge their exclusion before importing valid rows. The source CSV, settings and excluded rows are retained in the saved project.

## Reconcile balances

Choose the period, exchange and account, then open **Balances**. For each token, enter the opening quantity and statement closing quantity:

`Calculated close = opening quantity + received − sent − additional fees`

`Difference = calculated close − statement close`

A missing opening or closing balance is labelled **Enter balances**, never **Matched**. A zero opening must be entered explicitly. Comparison is exact, with no hidden tolerance. Opening/closing GBP values and comments are manual. A matched quantity does not verify GBP valuations. Balance inputs are saved separately for each period/account/token; “All dates” is a separate reconciliation period. Search within transactions does not restrict the balance calculation.

This version has no automatic transfer matching, API/exchange connections, Xero connection, pooled-cost accounting, tax rules or realised-gain engine. Those require separate work and verified source formats. Transfers appear as their source deposit/withdrawal entries.

## Save and export

- **Save project** downloads a JSON project containing entries, source CSVs, import settings/errors, review flags, manual balances and comments. **Open project** restores it.
- The working data lives in memory. There is no automatic browser storage or server sync. Save before closing; keep the downloaded file on your computer. Project files contain the imported data and are not encrypted by this app.
- **Export this view** downloads the filtered/grouped table with amounts labelled by currency and source-row references. **Export balances** downloads the quantity reconciliation and manual GBP fields. Text is escaped to reduce spreadsheet formula-injection risk.
- Limits: 20 MB per CSV, 100,000 source rows per CSV and 100,000 imported entries per project. Imports that would make the compact project exceed 99 MB are refused; saved projects up to 100 MB can be reopened.

## Development and validation

No package installation or build is required. The UI uses plain HTML/CSS and classic JavaScript so it can open through `file://`. The Content Security Policy blocks connection requests and external resources. All imported text is escaped before rendering.

With Node installed, run from the repository root:

```sh
node --test reconcile/tests/core.test.cjs
node --check reconcile/core.js
node --check reconcile/app.js
```

The tests cover exact arithmetic, CSV edge cases, dates, trade grouping, signed trade legs, duplicate/conflict handling, fees, quantity reconciliation, rejected rows, export escaping and project roundtrip. Browser interaction testing has not yet been performed, and native exchange imports need validation against actual sample exports before operational use.
