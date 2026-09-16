# Run Value Dashboard on your work PC

## First-time setup (Windows)

1. Install [Node.js 24 LTS](https://nodejs.org/en/about/previous-releases), Git for Windows and VS Code using your work PC's approved software process.
2. Open **Command Prompt** (PowerShell is not required).
3. Run:

```bat
git clone --branch codex/value-dashboard --single-branch https://github.com/cameronjmarshall/usdt-dashboard.git value-dashboard
cd value-dashboard\quality-stock-dashboard
npx --yes pnpm@11.19.0 install --frozen-lockfile
npx --yes pnpm@11.19.0 run dev:pc
```

4. Open http://localhost:3000 in your browser. Keep the Command Prompt window open while using the app. Press Ctrl+C to stop it.

No Python installation or API key is needed. Internet access to Yahoo Finance is needed for market data. The server binds only to this PC's loopback address.

If you do not have Git, select this branch on GitHub, choose **Code → Download ZIP**, extract it, open Command Prompt in the extracted `quality-stock-dashboard` folder, and run the two `npx` commands above. Git downloads make future updates easier.

## Start it next time

Open Command Prompt in the `quality-stock-dashboard` folder and run:

```bat
npx --yes pnpm@11.19.0 run dev:pc
```

Alternatively, double-click `start-work-pc.cmd` in that folder after the first-time installation.

## Open the code in VS Code

From the app folder:

```bat
code .
```

## Get updates

If you already cloned the original `codex/quality-stock-dashboard` branch, create a separate checkout using the commands above to open this refinement independently.

Stop the running app before updating. From the app folder:

```bat
git pull --ff-only
npx --yes pnpm@11.19.0 install --frozen-lockfile
npx --yes pnpm@11.19.0 run dev:pc
```

## Checks

```bat
npx --yes pnpm@11.19.0 test
npx --yes pnpm@11.19.0 typecheck
```

The local server is for use and development on your PC. Copying the source to GitHub does not host its server-side finance endpoints. The privately hosted website remains available separately.
