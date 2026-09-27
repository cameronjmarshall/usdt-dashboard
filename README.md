# Polymarket BTC five-minute bot dashboard

This branch contains **Poly Paper Lab**, a local dashboard comparing three paper-trading strategies using the same live Polymarket BTC five-minute Up/Down markets.

The application and run instructions are in [polymarket-btc-paper/README.md](polymarket-btc-paper/README.md).

```sh
cd polymarket-btc-paper
python3 app.py
```

Then open **http://127.0.0.1:8765**. On Windows use `py -3 app.py`.

For a synthetic preview, run `python3 app.py --demo`. No wallet, API key or Python packages are needed. Keep the Python process running to collect markets and simulate trades.

The original USDT dashboard remains at the repository root. Run the Python application above for this experiment.
