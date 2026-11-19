# Offline optimization after submission c85acc8

The user requested continued upgrades and explicitly prohibited further submission until stronger evidence supports a loss below 0.005. No entry was submitted during this optimization batch. The live official entry remains `01a1f461-0e7e-7169-b84e-d241088a06e4`, loss 0.044692. The leading entry at inspection had exact official loss 0.005976; its source and the practice answers were withheld.

## What was measured

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
