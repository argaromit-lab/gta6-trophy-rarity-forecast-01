import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { forecast } from '../main.ts';

const start = Date.parse('2026-11-19T00:00:00Z');
const iso = h => new Date(start + h * 3600000).toISOString();
const levels = [.05, .25, .5, .75, .95];
const normal = [-1.644854, -.67449, 0, .67449, 1.644854];
const logit = r => Math.log(Math.max(.01, Math.min(99.99, r)) / (100 - Math.max(.01, Math.min(99.99, r))));
const percent = x => 100 / (1 + Math.exp(-x));
const rounded = x => Math.round(100 * x) / 100;
function score(f, truth) {
  return f.trophies.reduce((total, row, i) => total + row.q.reduce((sum, q, j) => {
    const d = logit(truth[i]) - logit(q);
    return sum + 2 * Math.max(levels[j] * d, (levels[j] - 1) * d) / 5;
  }, 0) / truth.length, 0);
}

// Separate fixtures from the original 28-case grid: changed delays, changed
// ages, saturating population growth, a misspecified delay family, and cached
// recorder reads. Every reference is generated analytically, never taken from
// a forecast or assigned the scorer's hidden practice labels.
function scenario({ population, kernel, delay, shape, at, horizon }) {
  const players = t => Math.round(population === 'power' ? 1200 * Math.pow(1 + t / 6, .65) : 1200 + 14000 * -Math.expm1(-t / 32));
  const cdf = (age, scale) => age <= 0 ? 0 : kernel === 'weibull' ? -Math.expm1(-Math.pow(age / scale, shape)) : 1 / (1 + Math.pow(scale / age, shape));
  const trophies = [
    { id: 1, name: 'Completion', description: 'Attain 100% Completion.', tier: 'gold' },
    { id: 2, name: 'Story', description: 'Complete Chapter 2.', tier: 'bronze' },
    { id: 3, name: 'Activity', description: 'Complete an arcade game.', tier: 'bronze' },
    { id: 4, name: 'Opening', description: 'Complete the introduction.', tier: 'bronze' },
  ];
  const seed = [4, 7, 6, players(0)];
  const share = [.035, .58, .24, 1];
  const scales = [delay * 4, delay, delay * .5, 0];
  function rates(t) {
    return seed.map((e0, i) => {
      if (i === 3) return 100;
      let e = e0 + (players(0) - e0) * share[i] * cdf(t, scales[i]);
      for (let hour = 1; hour <= t; hour++) e += (players(hour) - players(hour - 1)) * share[i] * cdf(t - hour + .5, scales[i]);
      // Count rounding precedes page-percentage rounding.
      return rounded(100 * Math.round(e) / players(t));
    });
  }
  const history = [];
  for (let slot = 0; slot <= at; slot += 2) {
    const refresh = Math.floor(slot / 6) * 6;
    history.push({ slot: iso(slot), at: iso(slot), players_tracked: players(refresh), rates: rates(refresh) });
  }
  return {
    c: { id: 'rolling', at: iso(at), target: iso(at + horizon), horizon_minutes: horizon * 60, game: { release_date: '2026-11-19' }, trophies, history },
    truth: rates(at + horizon),
  };
}

const groups = new Map();
let cases = 0, previous = 0, likelihoodOnly = 0, candidate = 0, baseline = 0;
const began = performance.now();
for (const population of ['power', 'saturation']) for (const kernel of ['weibull', 'loglogistic']) {
  const group = { population, kernel, cases: 0, previous_loss: 0, likelihood_only_loss: 0, candidate_loss: 0, persistence_loss: 0 };
  for (const delay of [12, 40, 120]) for (const shape of [.8, 1.5, 2.5]) for (const at of [24, 48]) for (const horizon of [1.5, 108.5]) {
    const { c, truth } = scenario({ population, kernel, delay, shape, at, horizon });
    const oldScore = score(forecast(c, { likelihood: 'average', population: 'power' }), truth);
    const likelihoodScore = score(forecast(c, { likelihood: 'sum', population: 'power' }), truth);
    const newScore = score(forecast(c, { likelihood: 'sum', population: 'adaptive' }), truth);
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
console.log(JSON.stringify({ kind: 'out-of-family synthetic rolling evaluation; not official score', cases, previous_loss: previous, likelihood_only_loss: likelihoodOnly, candidate_loss: candidate, persistence_loss: baseline, improvement_percent: 100 * (1 - candidate / previous), elapsed_ms: performance.now() - began }));
for (const group of groups.values()) console.log(JSON.stringify(group));
console.log('RESULT synthetic rolling comparison passed; 0 failures');
