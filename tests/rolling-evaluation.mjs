import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { forecast } from '../main.ts';
import { scenario } from './rolling-scenarios.mjs';

const levels = [.05, .25, .5, .75, .95];
const normal = [-1.644854, -.67449, 0, .67449, 1.644854];
const logit = r => Math.log(Math.max(.01, Math.min(99.99, r)) / (100 - Math.max(.01, Math.min(99.99, r))));
const percent = x => 100 / (1 + Math.exp(-x));
function score(f, truth) {
  return f.trophies.reduce((total, row, i) => total + row.q.reduce((sum, q, j) => {
    const d = logit(truth[i]) - logit(q);
    return sum + 2 * Math.max(levels[j] * d, (levels[j] - 1) * d) / 5;
  }, 0) / truth.length, 0);
}

const groups = new Map();
const variants = {
  increments: { longTail: false, week: 'legacy' }, longTail: { increments: false, week: 'legacy' },
  combined: { week: 'legacy' }, clock: { week: 'clock' }, calibrated: { week: 'calibrated' },
  wide: { week: 'calibrated', hazard: 'wide' }, robust: { week: 'calibrated', hazard: 'robust' }, both: { week: 'calibrated', hazard: 'both' },
};
const variantsLoss = Object.fromEntries(Object.keys(variants).map(name => [name, 0]));
const longLoss = Object.fromEntries(['prior', ...Object.keys(variants)].map(name => [name, 0]));
let cases = 0, previous = 0, likelihoodOnly = 0, candidate = 0, baseline = 0;
const began = performance.now();
for (const population of ['power', 'saturation']) for (const kernel of ['weibull', 'loglogistic']) {
  const group = { population, kernel, cases: 0, previous_loss: 0, likelihood_only_loss: 0, candidate_loss: 0, persistence_loss: 0 };
  for (const delay of [12, 40, 120]) for (const shape of [.8, 1.5, 2.5]) for (const at of [24, 48]) for (const horizon of [1.5, 108.5]) {
    const { c, truth } = scenario({ population, kernel, delay, shape, at, horizon });
    const legacyDelay = { increments: false, longTail: false, week: 'legacy' };
    const oldScore = score(forecast(c, { ...legacyDelay, likelihood: 'average', population: 'power' }), truth);
    const likelihoodScore = score(forecast(c, { ...legacyDelay, population: 'power' }), truth);
    const newScore = score(forecast(c, legacyDelay), truth);
    if (horizon > 100) longLoss.prior += newScore;
    for (const [name, options] of Object.entries(variants)) {
      const value = score(forecast(c, options), truth);
      variantsLoss[name] += value;
      if (horizon > 100) longLoss[name] += value;
    }
    const spread = .5 * Math.sqrt(horizon / 24);
    const persistence = { trophies: c.history.at(-1).rates.map((r, i) => ({ id: i + 1, q: normal.map(z => percent(logit(r) + z * spread)) })) };
    const baseScore = score(persistence, truth);
    for (const value of [oldScore, newScore, baseScore]) assert.ok(Number.isFinite(value));
    group.cases++; cases++;
    group.previous_loss += oldScore; previous += oldScore;
    group.likelihood_only_loss += likelihoodScore; likelihoodOnly += likelihoodScore;
    group.candidate_loss += newScore; candidate += newScore;
    group.persistence_loss += baseScore; baseline += baseScore;
  }
  for (const key of ['previous_loss', 'likelihood_only_loss', 'candidate_loss', 'persistence_loss']) group[key] /= group.cases;
  groups.set(`${population}/${kernel}`, group);
}
previous /= cases; likelihoodOnly /= cases; candidate /= cases; baseline /= cases;
assert.ok(candidate < previous, `candidate ${candidate} failed to improve on previous ${previous}`);
assert.ok(variantsLoss.combined / cases < candidate);
assert.ok(longLoss.combined < longLoss.prior);
console.log(JSON.stringify({ kind: 'out-of-family synthetic rolling evaluation; not official score', cases, previous_loss: previous, likelihood_only_loss: likelihoodOnly, candidate_loss: candidate, persistence_loss: baseline, improvement_percent: 100 * (1 - candidate / previous), elapsed_ms: performance.now() - began }));
console.log(JSON.stringify(Object.fromEntries(Object.entries(variantsLoss).map(([name, loss]) => [name, loss / cases]))));
console.log(JSON.stringify({ final_horizon: Object.fromEntries(Object.entries(longLoss).map(([name, loss]) => [name, 2 * loss / cases])) }));
for (const group of groups.values()) console.log(JSON.stringify(group));

const holdoutVariants = { submitted: { week: 'legacy', increments: false, longTail: false, likelihood: 'average', population: 'power' },
  prior: variants.combined, calibrated: variants.calibrated, wide: variants.wide };
const holdout = { quick: { count: 0 }, week: { count: 0 } };
for (const population of ['saturation', 'waves']) for (const kernel of ['weibull', 'loglogistic']) {
  for (const delay of [17, 53, 97]) for (const shape of [1.1, 1.75, 2.2]) for (const cadence of [3, 7]) for (const horizon of [1.5, 108.5]) {
    const { c, truth } = scenario({ population, kernel, delay, shape, at: 58, horizon, cadence, phase: 1 });
    const summary = horizon < 2 ? holdout.quick : holdout.week;
    summary.count++;
    for (const [name, options] of Object.entries(holdoutVariants)) summary[name] = (summary[name] ?? 0) + score(forecast(c, options), truth);
  }
}
for (const summary of Object.values(holdout)) {
  for (const name of Object.keys(holdoutVariants)) summary[name] /= summary.count;
  assert.ok(summary.calibrated < summary.prior && summary.calibrated < summary.submitted);
}
console.log(JSON.stringify({ cached_target_holdout: holdout }));
console.log('RESULT synthetic rolling comparison passed; 0 failures');
