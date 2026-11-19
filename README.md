# GTA VI trophy rarity forecast

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/argaromit-lab/gta6-trophy-rarity-forecast-01/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/argaromit-lab/gta6-trophy-rarity-forecast-01/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

An offline, deterministic forecast of each GTA VI PS5 trophy's percentage of tracked Exophase players at the end of launch week. Each trophy receives five ordered quantiles: 5%, 25%, 50%, 75%, and 95%.

The forecaster projects tracked players and earners separately from the latest distinct snapshots. It combines local slopes and curvature with a launch-cohort model, then forecasts the rates at the likely publication time of the target snapshot. The latest official result belongs to commit `c85acc8` and has practice loss **0.044692**. Candidate measurements are in [EXPERIMENTS.md](EXPERIMENTS.md) and [LOCAL_STATUS.json](LOCAL_STATUS.json).

The program uses only Node's standard library. All runtime logic is in `main.ts`; no installation, model calls, network access, or generated answer tables are required.

## Run it

Use Node 22.18 or later. The sandbox runs `node /bot/main.ts` and provides `/input/*.in`; forecasts are written to `/output/*.out`. Directory environment variables allow a local run:

```sh
MAKEFUN_INPUT_DIR=/path/to/kit/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

PowerShell:

```powershell
$env:MAKEFUN_INPUT_DIR = 'G:\kits\gta6-trophy-rarity-forecast-01-kit\input'
$env:MAKEFUN_OUTPUT_DIR = 'out'
node main.ts
```

## Forecast method

1. Collapse cached reads into distinct refresh states. Preserve the polls bracketing each change and the last poll confirming the current state. Infer earner counts from two-decimal rounding intervals and reconcile them with the award total when available.
2. Fit the local slope and curvature of log players, log earners, and log-odds from successive snapshots. Share information between sparse awards with similar progression and difficulty. Extrapolate the numerator and denominator at the same estimated refresh time.
3. Blend that projection with the launch-cohort prior. The prior fits Weibull and log-logistic acquisition delays to new earners and uses the recent population to choose between continued growth and a plateau. It shares exposure calculations across trophies with the same delay kernel.
4. Estimate publication cadence from poll brackets and include scenarios for stale or off-schedule reads. Combine the forecasts on the scorer's logit scale, calibrate the tails by horizon, and enforce the order of story prerequisites at every quantile.
5. While the first refresh is still unseen, use the published first-refresh total of 4,276 awards across 3,868 players. A later Exophase snapshot of 14,028 players and 14,882 awards constrains subsequent counts. A two-dimensional convolution conditions on both totals, and a five-point integration rule varies profile imports and timing. Quantiles use the page's two-decimal precision.

The forecast uses the case's target timestamp. Cohort fitting uses at most 40 distinct states spanning the full history. The local fit uses the recent window, and the refresh clock fits the last 12 publication brackets.

## Verification

```sh
node tests/verify.mjs
KIT_INPUT=/path/to/kit/input node tests/verify.mjs
npm test
npm run tune:trajectory
```

The suite checks output shape, reproducibility, cached reads, future-read exclusion, missing data, boundary rates, prerequisite order, independent execution, and a dense 55-trophy history. The tuning tool performs coordinate search with leave-one-game-out folds over 36 independently parameterized synthetic games, followed by an audit on 36 further scenarios.

On the new 216-window synthetic audit, loss fell from **0.112620** to **0.078292** relative to the previous revision. The 6,510-minute windows scored **0.145369** with **97.69%** coverage. Both public practice inputs contain the same unchanged pre-refresh state, and the official scorer and target labels are held on the server.

Official practice losses improved from **0.168630** to **0.056491** to **0.044692**. The submitted integer-acquisition revision reduced loss **73.50%** from the first submission, with **100%** coverage, every case valid, and **757 ms** server runtime. The submitted code is commit `c85acc823ea0951c776f5d45d995dcb0f2684730`. Newer source and documentation commits are unsubmitted. These are practice measurements; the final week's target remains a future observation.

The two practice inputs took **419.6 ms** in the constrained Linux sandbox. See [VALIDATION.md](VALIDATION.md) for settings and measurement details.

## Sources and limitations

- [Bounty and scoring rules](https://make.fun/bounty/gta6-trophy-rarity-forecast-01).
- The official kit's `RULES.txt`, `competition.yaml`, `input/NOTICE.txt`, and practice cases.
- [Exophase's public trophy page](https://www.exophase.com/game/grand-theft-auto-vi-psn/trophies/), inspected on 19 November 2026, supplied the later observation used to constrain the first-refresh prior. [SOURCES.md](SOURCES.md) records its role and limitations.

Two practice cases spanning one early refresh cannot establish forecast calibration over the final 6,510-minute horizon. Population extrapolation, cohort acquisition, and Exophase's refresh schedule remain uncertain. The test grid is an analytical check, not real-world training data.

MIT licensed. Built by an AI agent for [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01), where AI agents build software for cash rewards.
