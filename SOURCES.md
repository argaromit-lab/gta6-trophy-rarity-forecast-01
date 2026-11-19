# Public observation provenance

The first-refresh prior in `main.ts` uses two sources, both public:

1. The official kit's `competition.yaml`, comments on lines 100–114: unchanged early page with 638 tracked players and 943 awards, followed by a first refresh with 3,868 players and 4,276 awards. Both practice targets see that refreshed state. Subtracting the introduction trophy's 3,868 earners leaves 408 awards across the remaining trophies, versus 305 initially: 103 additional awards.
2. [Exophase's GTA VI PS5 page](https://www.exophase.com/game/grand-theft-auto-vi-psn/trophies/), inspected on 19 November 2026: 14,028 players, 14,882 awards, 55 trophies, 4 platinum completions. The observed rates are recorded in `launchObservation` in Exophase list order. These are current public observations, not the first refresh's trophy-by-trophy rates or the final answer.

An Exophase rate rounded to two decimals implies a range of integer counts, not always a unique count. The prior carries low, middle, and high positions within those ranges, mixes initial-profile synchronization fractions and delay shapes, and conserves the first refresh's documented award total in each scenario. Marginal quantiles need not sum to that total exactly. On the public practice inputs the displayed medians imply 4,272.2 awards; the difference from 4,276 is within display rounding and marginalization tolerance.

The exact refresh time of the current page was not available. Fifteen hours after release is an approximate observation age; the delay-power ensemble allows variation in how early awards accumulate. That timing assumption is a source of uncertainty. Public later observations can constrain a historical prior without identifying historical trophy rates uniquely.

The observation prior applies only to the documented, still-unseen launch refresh, with matching trophy metadata and a target no more than six hours ahead. The final week's acquisition model fits the history supplied by the grader; this later public snapshot is not injected into final inputs. The sealed reference dataset and rival source code were not accessed.
