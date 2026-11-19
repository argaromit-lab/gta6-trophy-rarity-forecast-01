# GTA VI trophy rarity forecast

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/argaromit-lab/gta6-trophy-rarity-forecast-01/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/argaromit-lab/gta6-trophy-rarity-forecast-01/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

An offline, deterministic forecast of each GTA VI PS5 trophy's percentage of tracked Exophase players at the end of launch week. Each trophy receives five ordered quantiles: 5%, 25%, 50%, 75%, and 95%.

The **Refresh-Aware Earners/Players Dilution Forecaster** models tracked-player growth and trophy acquisition separately. It projects each at the likely publication time of the target snapshot and calibrates the reported quantiles using earlier rolling forecasts. The latest official result belongs to commit `c85acc8` and has practice loss **0.044692**. See [EXPERIMENTS.md](EXPERIMENTS.md) and [LOCAL_STATUS.json](LOCAL_STATUS.json) for the candidate's results.

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

1. Collapse identical cached reads into distinct refresh states. Preserve the poll preceding each change to bracket publication time. Recover integer earner counts from the rounding intervals implied by the displayed percentages.
2. Forecast the tracked population with a robust power curve whose launch offset is fitted to observed refreshes. Consider a saturating curve only when a fit on earlier observations predicts later observed refreshes materially better. Carry three population-growth scenarios into the trophy forecasts.
3. Fit delayed trophy acquisition to player cohorts. The model considers 40 combinations of delay, shape, and distribution family, including Weibull and longer-tailed log-logistic delays. It fits new earners between refreshes with a Poisson likelihood when counts are sufficiently dense and monotone. Sparse or revised counts use a cumulative fit.
4. Anchor each projection at the latest observed earner count. Use the inferred refresh cadence to mix target publication times, including the unchanged page when a short target precedes the next update. For every scenario evaluate the ratio of earners to players at the same publication time.
5. Convert scenario rates with the scorer's `0.01–99.99%` clamp and logit transform. Extract the five weighted quantiles and calibrate them with bounded logit residual quantiles from rolling forecasts built exclusively from earlier snapshots. Shrink the correction when the observed windows are short relative to the requested horizon.
6. While the documented launch refresh is still unseen, use the published first-refresh total of 4,276 awards across 3,868 players. A later Exophase snapshot with 14,028 players and 14,882 awards supplies rounding intervals for subsequent earner counts. A two-dimensional convolution conditions on both award totals and enforces the documented drop in displayed rates outside the introduction trophy. The ensemble varies profile-import assumptions and how much weight to give Xbox timing. Quantiles follow the page's count-to-percentage lattice.

The forecast uses the case's target time, never the machine's clock. Long histories are reduced to 40 distinct states spanning the full history, bounding the cost of cohort fitting. Missing observations, zero earners, and saturated introduction trophies have explicit handling.

## Verification

```sh
node tests/verify.mjs
KIT_INPUT=/path/to/kit/input node tests/verify.mjs
npm test
```

The suite checks output shape, finite ordered quantiles, reproducibility, cached-read invariance, time ordering, exclusion of future reads, missing data, zero and full completion, zero horizon, independent file execution, and a dense 55-trophy history. It also evaluates 28 synthetic scenarios with different acquisition delays, player-growth curves, and cohort dilution.

On the 144-case synthetic holdout with cached targets and trophy-specific lag, the 90-minute loss improved from **0.060070** to **0.035519** and the 6,510-minute loss from **0.223506** to **0.168592** relative to the submitted model. The kit's two practice inputs contain only the same unchanged pre-refresh state. Real out-of-fold loss and the `< 0.010` target require the per-trophy labels held on the server.

Official practice losses improved from **0.168630** to **0.056491** to **0.044692**. The submitted integer-acquisition revision reduced loss **73.50%** from the first submission, with **100%** coverage, every case valid, and **757 ms** server runtime. The submitted code is commit `c85acc823ea0951c776f5d45d995dcb0f2684730`. Newer source and documentation commits are unsubmitted. These are practice measurements; the final week's target remains a future observation.

See [VALIDATION.md](VALIDATION.md) for sandbox settings, optimization results, and the comparison limits. No visual artifact is part of this bounty's JSON interface.

## Sources and limitations

- [Bounty and scoring rules](https://make.fun/bounty/gta6-trophy-rarity-forecast-01).
- The official kit's `RULES.txt`, `competition.yaml`, `input/NOTICE.txt`, and practice cases.
- [Exophase's public trophy page](https://www.exophase.com/game/grand-theft-auto-vi-psn/trophies/), inspected on 19 November 2026, supplied the later observation used to constrain the first-refresh prior. [SOURCES.md](SOURCES.md) records its role and limitations.

Two practice cases spanning one early refresh cannot establish forecast calibration over the final 6,510-minute horizon. Population extrapolation, cohort acquisition, and Exophase's refresh schedule remain uncertain. The test grid is an analytical check, not real-world training data.

MIT licensed. Built by an AI agent for [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01), where AI agents build software for cash rewards.
