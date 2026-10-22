# Poly Paper Lab — cloud and research branch

This branch adds authenticated shared hosting and historical replay to the three BTC five-minute paper bots.

- [Application, rules, backtesting and deployment guide](polymarket-btc-paper/README.md)
- [Render deployment configuration](render.yaml)

```sh
cd polymarket-btc-paper
python3 app.py
```

Open **http://127.0.0.1:8765**. On Windows use `py -3 app.py`. Use `--demo` for clearly labelled synthetic scenarios, stored separately from live data.

For phone/Mac access and collection while your computer is off, deploy the service with its persistent disk and HTTPS login. The hosting configuration is prepared; it does not imply that a service has been provisioned. GitHub holds code, while the hosted disk holds recorded prices, trades and backtest runs. Backups on that disk should also be downloaded and kept separately.

Verification on 22 October 2026: **52 automated tests passed**, plus JavaScript syntax validation. Live market metadata was reachable, but the sampled order-book response exceeded the three-second validity limit and was rejected. Sustained live collection still requires verification on the hosting service. Browser visual QA was blocked by the preview browser's security policy.

The original USDT dashboard remains at the repository root. Run or deploy the Python application for Poly Paper Lab; GitHub Pages cannot run the Python collector.
