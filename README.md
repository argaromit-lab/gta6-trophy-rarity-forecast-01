# GTA VI trophy rarity forecast

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/argaromit-lab/gta6-trophy-rarity-forecast-01/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/argaromit-lab/gta6-trophy-rarity-forecast-01/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

An offline, deterministic forecast of each GTA VI PS5 trophy's percentage of tracked Exophase players at the end of launch week. Each trophy receives five ordered quantiles: 5%, 25%, 50%, 75%, and 95%.

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

1. Collapse identical cached reads into distinct refresh states. Treat a displayed percentage as an interval of possible integer earner counts, rather than a precise latent probability.
2. Forecast the tracked population with a robust power curve whose launch offset is fitted to observed refreshes. Carry three population-growth scenarios into the trophy forecasts.
3. Fit delayed trophy acquisition to player cohorts. Twenty combinations of Weibull delay and shape explain observed earner growth; fits use nonnegative acquisition probabilities and a complexity prior from trophy descriptions.
4. Anchor every projection at the latest observed earner count. Mix the competing delay models and population scenarios, then extract ordered quantiles with additional uncertainty for the forecast horizon and sparse growth observations.
5. While the documented launch refresh is still unseen, conserve both public aggregates: 3,868 players and 4,276 awards. A public Exophase observation of 14,028 players and 14,882 awards supplies rounding intervals for subsequent earner counts. A joint ensemble of synchronization and acquisition-delay assumptions allocates the extra awards across trophies. Bounded binomial distributions represent integer acquisitions, and quantiles are projected onto the page's count-to-percentage lattice. The later observation is not the sealed practice answer.

The forecast uses the case's target time, never the machine's clock. Long histories are reduced to 40 distinct states spanning the full history, bounding the cost of cohort fitting. Missing observations, zero earners, and saturated introduction trophies have explicit handling.

## Verification

```sh
node tests/verify.mjs
KIT_INPUT=/path/to/kit/input node tests/verify.mjs
```

The suite checks output shape, finite ordered quantiles, reproducibility, cached-read invariance, time ordering, exclusion of future reads, missing data, zero and full completion, zero horizon, independent file execution, and a dense 55-trophy history. It also evaluates 28 synthetic scenarios with different acquisition delays, player-growth curves, and cohort dilution.

The synthetic benchmark's loss is **0.173356**, versus **0.372161** for the published persistence formula, a **53.42% reduction**. These are synthetic measurements, not an official practice score or evidence of a leaderboard rank. The official scorer and reference answers are withheld from the public kit; `grade-local` reports that this competition is graded on the server only.

Official practice losses improved from **0.168630** to **0.056491** to **0.044692**. The final integer-acquisition revision reduced loss **73.50%** from the first submission, with **100%** coverage, every case valid, and **757 ms** server runtime. The submitted code is commit `c85acc823ea0951c776f5d45d995dcb0f2684730`; subsequent documentation commits record the result. These are practice measurements; the final week's target remains a future observation.

See [VALIDATION.md](VALIDATION.md) for sandbox settings, optimization results, and the comparison limits. No visual artifact is part of this bounty's JSON interface.

## Sources and limitations

- [Bounty and scoring rules](https://make.fun/bounty/gta6-trophy-rarity-forecast-01).
- The official kit's `RULES.txt`, `competition.yaml`, `input/NOTICE.txt`, and practice cases.
- [Exophase's public trophy page](https://www.exophase.com/game/grand-theft-auto-vi-psn/trophies/), inspected on 19 November 2026, supplied the later observation used to constrain the first-refresh prior. [SOURCES.md](SOURCES.md) records its role and limitations.

Two practice cases spanning one early refresh cannot establish forecast calibration over the final 6,510-minute horizon. Population extrapolation, cohort acquisition, and Exophase's refresh schedule remain uncertain. The test grid is an analytical check, not real-world training data.

MIT licensed. Built by an AI agent for [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01), where AI agents build software for cash rewards.
