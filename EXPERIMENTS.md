# Refresh-aware forecast experiments

The public [practice leaderboard](https://make.fun/api/competitions/gta6-trophy-rarity-forecast-01/leaderboard?phase=dev&view=performance) placed `argaromit` 14th at inspection, with exact loss **0.044692**. The top three losses were **0.005976**, **0.012010**, and **0.015731**. The kit contains seven and eight polls for `p00` and `p01`, respectively. Across both cases, each poll has 638 players, 943 awards, and the same 55 rates. The two labels correspond to the same refreshed state. The published aggregates describe the first refresh, but per-trophy target rates are held on the server.

Each rolling fold fits only earlier snapshots. Calibration at a fold's cutoff uses internal hindcasts that end before that cutoff. All models score the same target in each fold using `2 × max(τd, (τ − 1)d)`, with `d = logit(actual) − logit(quantile)` after the scorer's clamp. The cached-target holdout changes launch growth profiles, the refresh phase and cadence, and the trophy-specific publication delay. The submitted-model settings are `week: 'legacy', increments: false, longTail: false, likelihood: 'average', population: 'power'`.

| Synthetic comparison | Submitted model | Previous branch with increment likelihood and long-tail delays | Refresh-aware calibrated forecast |
| --- | ---: | ---: | ---: |
| Original 144 rolling folds | 0.167469 | 0.141452 | **0.138725** |
| Cached-target holdout, 72 folds at 90 minutes | 0.060070 | 0.060722 | **0.035519** |
| Cached-target holdout, 72 folds at 6,510 minutes | 0.223506 | 0.178302 | **0.168592** |

The cached-target losses fell **40.87%** and **24.57%** against the submitted model. Adding the refresh clock without calibration gave 0.142051 on the original grid. A wider hazard grid lowered the original-grid score to 0.130517, but raised the final-horizon cached-target holdout loss to 0.170791. Overdispersed increments also did worse on the original grid. The retained configuration uses the original hazard grid and rolling logit calibration. The launch branch's convolution now skips unreachable count states and extracts all five quantiles from one cumulative pass. Its practice lower bound is **0.013191**, so the requested `< 0.010` practice loss is out of reach for these quantiles. Real out-of-fold validation requires more independent labeled refreshes.

## Prior offline optimization after submission c85acc8

The target is a practice loss below 0.005. Submission requires an explicit instruction from the user. The live official entry remains `01a1f461-0e7e-7169-b84e-d241088a06e4`, with loss 0.044692. The leading entry at inspection had exact official loss 0.005976.

## Launch-refresh count model

The next revision enforces the recorder's observation that every non-introduction rate fell in the first refresh. It also mixes four joint count models with weights 40% for the prior weak Xbox model and 20% each for the timing-only, higher profile-import, and full Xbox models. The mixture scored **0.046544** on development and **0.047485** on holdout, down from **0.046702** and **0.047602**. On a fresh 80-case audit with the same four regimes, loss rose from **0.046710** to **0.046827**. The mixture improves two of the three synthetic sets, with small differences in either direction. Varying profile import by trophy rarity, damping timing odds, and changing either prior alone failed to improve both selection sets. The practice forecast's mathematical loss floor decreased to **0.013191**. Use `REFRESH_HOLDOUT=audit` to reproduce the third set.

| Timing model | 80 development cases | 80 held-out cases |
| --- | ---: | ---: |
| Prior offline candidate | 0.049994 | 0.050447 |
| Joint date and award totals | 0.046802 | 0.048580 |
| Joint totals with full Xbox signal | 0.052989 | 0.052996 |
| Equal mixture of joint models with and without Xbox | 0.047017 | 0.047856 |
| Joint totals with 0.2 strength on Xbox timing odds | **0.046702** | **0.047602** |
| Joint totals with a stronger profile-import prior | 0.050805 | 0.052141 |

The selected model lowers mean held-out synthetic loss by **5.64%**. The test generates 54 trophy series per case across four regimes, including Xbox-aligned timing, timing independent of Xbox, platform shift, and profile imports. The holdout uses new seeds with the same four regimes. The selected model improves three held-out regimes and worsens the import-heavy regime (**0.047893 → 0.050150**). The game-specific practice inputs still have a best-case loss floor of **0.013273**. The model preserves observed award totals jointly and treats Xbox as a weak timing signal. See [SOURCES.md](SOURCES.md) for the public observations and modeling references.

Run `node tests/refresh-evaluation.mjs` for the development set and set `REFRESH_HOLDOUT=1` for the holdout. With `KIT_INPUT` set, the script checks that the official fixture uses the selected model and reports its practice loss floor. The official answer remains server-side.

## Final-horizon follow-up

| Forecast revision | 144 rolling cases | 72 cases at 6,510 minutes |
| --- | ---: | ---: |
| Prior offline candidate | 0.157730 | 0.254604 |
| Poisson likelihood on earner increments | 0.145713 | 0.230814 |
| Longer-tailed delay family | 0.152056 | 0.243360 |
| Increment likelihood and longer-tailed delays | **0.141452** | **0.222450** |
| Combined with continuous normal-mixture quantiles | 0.142253 | 0.223883 |

The retained combination lowers final-horizon synthetic loss by **12.63%** and lowers loss on the original 28-case grid from **0.159451** to **0.152883**. Scoring new earners between refreshes avoids reusing the same cumulative counts as independent evidence. Sparse or downward-revised series fall back to the cumulative fit. The second delay family lets forecast growth taper more gradually. Continuous mixture quantiles were discarded after they raised loss on the combined model.

At this stage the practice loss floor was **0.014029**. The long-horizon experiments did not alter the launch-refresh branch.

## Earlier offline comparison against the submitted model

| Experiment | Previous | Candidate | Evidence |
| --- | ---: | ---: | --- |
| Original 28-case cohort benchmark | 0.173356 | 0.159451 | Synthetic target rates |
| New 144-case rolling evaluation | 0.167469 | 0.157730 | Synthetic targets with changed delays, ages, population and delay families |
| Expected loss across 12 finite count populations | 0.055620 | 0.043057 | Exact enumeration of all synthetic joint outcomes |
| Official practice | 0.044692 | Unknown | Candidate was not submitted; labels unavailable |

The rolling comparison improved **5.82%** overall, with improvements in all four population/delay-family groups. The count comparison improved **22.59%** in its finite synthetic setting. These separate datasets and estimands cannot be compared as one scoreboard or substituted for a server grade.

## Retained changes

1. **Exact conditioning on totals.** The older binomial model matched the known additional 103 awards only in expectation. A prefix/suffix polynomial dynamic program now computes exact marginal acquisition probabilities conditional on the observed sum. The same algorithm conditions the later public rounding intervals on the observed total of 14,882 awards. Exhaustive enumeration verifies the algorithm on small distributions, including zero-probability and boundary cases.
2. **Evidence accumulates across refreshes.** The older fit averaged residual likelihoods over distinct refreshes, suppressing the information added by more observations. Summed likelihood residuals improved the original synthetic benchmark. A separate rolling test measures generalization beyond those fixtures.
3. **Population saturation with temporal validation.** A saturating alternative is considered only when an earlier fit predicts held-out later refreshes materially better than the power family. On the rolling evaluation, the likelihood-only candidate scored 0.163742; this population alternative reduced it to 0.157730 and improved the previously weaker saturating-population group.

The three count-inference variants on the same public practice input had these mean logit widths for their 90% bands: submitted independent model 0.252982, conditioning on the early total 0.249890, and conditioning on both totals 0.245799. Band width is a sharpness diagnostic, not an accuracy score.

## Rejected shortcut and target limitation

Raising posterior probabilities to powers 2, 4 and 8 makes intervals look more decisive. Exact synthetic expected loss worsened from 0.043057 to **0.046335**, **0.052966** and **0.061410**, respectively. These unsupported concentration settings were rejected.

For any fixed five ordered quantiles under this scoring rule, the loss as a function of the actual logit rate is minimized at the median quantile. Scoring each trophy against its own median therefore gives a lower bound on the loss those quantiles can achieve, independently of the hidden answer. The submitted forecast's bound is **0.020683**; the candidate's is **0.014029**. Since even this best-case lower bound exceeds **0.005**, the target has **not been reached** by this candidate. Conditioning improves coherence, but does not justify claiming near-perfect knowledge of historical trophy counts.

The current Exophase page was checked again and still showed 14,028 players and 14,882 awards. A public Wayback availability query for the 04:30 practice target returned no archived snapshot. The public aggregate totals do not identify the per-trophy answer uniquely. Narrowing until the lower bound falls below 0.005 would not demonstrate actual accuracy; the concentration experiment shows why that would be unreliable.

## Reproduce

```sh
npm test
KIT_INPUT=/path/to/kit/input node tests/count-inference.mjs
```

The full suite was also run in an offline Linux Node 22 container with one CPU, 1 GB memory, a read-only repository and root, non-root user, 64-process limit, and writable `/tmp` only. All four suites passed: 12 contract/regression checks, 5 count-inference checks, the 144-case rolling comparison, and reference-scoring checks. The dense 55-trophy/289-read forecast took **191.5 ms**; the two independent practice processes averaged **326.8 ms** in total. These are local measurements, not server `run_ms` values.

## Independent-reference scoring

`tools/grade-reference.mjs` reproduces the published pinball formula and checks the rules' worked example (loss 0.403404, typical miss 7, coverage 0.5). It requires real per-trophy reference rates:

```json
{"source":"where these observed rates came from","cases":[{"id":"p00","actual":[0.1,100]}]}
```

The short array above illustrates the schema only; a real p00 reference requires all 55 rates. Never use that example as labels.

```sh
node tools/grade-reference.mjs --input /path/to/input --reference /path/to/answer.json --target 0.005
```

Without a reference, it reports `loss: null` and `target_verified: false`. With one, it measures the candidate and returns status 2 when the target is not met, status 1 on invalid data, and status 0 only when valid supplied labels support the target. A local result remains distinct from a server receipt. `LOCAL_STATUS.json` records the current unverified state.
