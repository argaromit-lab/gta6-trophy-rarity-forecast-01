# Validation record

## Accuracy experiments

### Upgrade after the first official submission

The first official entry scored **0.168630** practice loss, **0.436364** coverage, all cases valid, and **607 ms** server runtime. Both cases had the same loss. That evidence exposed an overly confident frozen-numerator assumption in the launch-refresh branch.

The upgrade conserves the public award total as well as the public player total, using later public observations as count intervals. The candidate passed **12 Linux checks, 0 failures**, including the new aggregate-award consistency assertion. Its dense-history workload took **186.2 ms** and the independent practice processes took **229.4 ms**. The synthetic long-horizon benchmark is unchanged, because this upgrade targets the first-refresh prior. Official accuracy must be measured again by the server after submission.

That upgrade was submitted at commit `b19d54a0bc3a0b970fac6088ec307762423e7116`, submission `01a1f45c-e069-7251-9263-bb00c6fc9c71`. Its official practice loss was **0.056491**, coverage **0.781818**, typical miss **0.02 percentage points**, server runtime **576 ms**, and all cases valid. This is a **66.50%** loss reduction from the original submission.

A subsequent candidate replaces continuous half-earner jitter with a bounded binomial acquisition distribution. Its support starts at the initial count and ends at the upper count compatible with the later public observation. Each quantile therefore maps to an integer earner count and the observed page's two-decimal reporting precision. Added assertions check these constraints for every practice trophy. All **12 Docker checks passed**, with dense-history runtime **188.4 ms** and independent-practice runtime **302.9 ms**.

The integer candidate was submitted at commit `c85acc823ea0951c776f5d45d995dcb0f2684730`, submission `01a1f461-0e7e-7169-b84e-d241088a06e4`. Its official practice loss is **0.044692**, coverage **1.000000**, typical miss **0.02 percentage points**, runtime **757 ms**, and every case valid. It is the best of this account's three submitted candidates and reduces loss **73.50%** from the original. The API reports stage `scored`, no failed checks, and `Force_Last` with no override, so this latest submission is the one that counts.

The quota after that submission is **3 of 3** used for 19 November UTC, with **17 of 20** total attempts left. The next daily reset is **2026-11-20T00:00:00Z**. The explicit `phase=dev&view=performance` leaderboard subsequently confirmed **rank 8** for this submission under `argaromit`. Rank 1 had loss **0.00598** and rank 10 **0.0500** at that inspection. These are live, unofficial practice standings and can change as further submissions are graded.

### Original model experiments

The reference generator covers 28 synthetic scenarios: 27 combinations of three acquisition delays, three delay shapes, and three player-growth exponents, plus pure cohort dilution. The comparison baseline is the rules' last-rate forecast with logit spread `0.5 * sqrt(horizon_days)`. Both forecasts are evaluated against the same generated, two-decimal target rates using the published pinball formula.

| Experiment | Synthetic mean pinball loss | Decision |
| --- | ---: | --- |
| Initial cohort ensemble | 0.174869 | Initial reference |
| Learned population offset with a wider delay grid | 0.177355 | Rejected |
| Learned population offset with the compact delay grid | 0.173356 | Retained |
| Round every projected quantile to two decimals | 0.173483 | Rejected |
| Persistence baseline | 0.372161 | Comparison |

The final implementation keeps the improved population fit and compact delay grid. A separate numerical correction preserves zero-earner predictions below the scorer's clamp and passes the zero-earner regression check.

## Linux sandbox

Verification runs in `node:22-slim` with one CPU, 1,024 MB memory and the same swap limit, 64 processes, user `65534:65534`, disabled networking, a read-only root and repository, dropped capabilities, no new privileges, and a 256 MB writable `/tmp`. The public kit is mounted read-only.

```powershell
docker run --rm --cpus="1.0" --memory="1024m" --memory-swap="1024m" --network none --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 64 --tmpfs /tmp:rw,size=256m -u 65534:65534 -v "G:\bounties\gta6-trophy-rarity-forecast-01:/bot:ro" -v "G:\kits\gta6-trophy-rarity-forecast-01-kit:/kit:ro" -w /bot -e KIT_INPUT=/kit/input node:22-slim node tests/verify.mjs
```

The final run passed **12 checks with 0 failures**. The dense workload has 55 trophies and 289 changing reads and took **246 ms** inside the constrained Linux container, against the bounty's **8,000 ms** per-case budget. Running both official practice cases in separate Node processes, each twice, took **242.3 ms** in total averaged over the two executions. These times include ordinary process startup, and fluctuate with host load; they are not the server's `run_ms` measurement.

## Submission preflight

The kit's `check --worktree --transcripts` audit returned **14 passed, 0 failed, 5 skipped**, with five additional repository checks deferred to submission. Authored coverage was **99.4%** (385 of 387 counted lines), with **0% unwritten lines**. All **34 usage records** in that bundle priced to known models. The recorded session passed the timestamp, turns, revision, run-record, and own-work checks.

The transcript bundle uses the same user-provided prompt-file configuration as the existing `auto-submit.ps1` wrapper. Bundles and verbose logs are excluded from Git and are regenerated for the final commit at the submission checkpoint. The skipped checks include a signature that the submit command creates and beacon freshness, which does not apply to a GitHub entry.

## Leaderboard comparison

At inspection, the first three public entries had official practice losses of **0.022048**, **0.023847**, and **0.034981**, with reported program times of **398**, **388**, and **719 ms** respectively. Their source files and the official reference answers were withheld. Their practice losses cannot be compared with this repository's synthetic loss as though they used the same data.

The official command was attempted with the applicable `--kit`, `--bot`, and `--worktree` flags. It reports: `its scorer and reference data are not published in the kit, so it is graded on the server only`. An official loss and rank require a submission. The final answer is a future recorded Exophase snapshot, which is also unavailable locally.

## Scope

This entry produces JSON forecasts and has no HTML interface, screenshot deliverable, or visual judge. Browser overlap tests and vision scoring do not apply. Submission and its official grading remain a separate checkpoint after repository publication.
