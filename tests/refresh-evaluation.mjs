import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { forecast, launchQuantiles, legacyRefresh, refreshBridge, refreshEnsemble } from '../main.ts';
import { scoreCase } from '../tools/grade-reference.mjs';

const levels = [.05, .25, .5, .75, .95];
const population = 3868;
const printed = (e, n) => Math.round(10000 * e / n) / 100;
const logit = x => Math.log(Math.max(.01, Math.min(99.99, x)) / (100 - Math.max(.01, Math.min(99.99, x))));
function score(predictions, truth) {
  return predictions.reduce((sum, row, i) => sum + row.reduce((subtotal, q, j) => {
    const d = logit(truth[i]) - logit(q);
    return subtotal + 2 * Math.max(levels[j] * d, (levels[j] - 1) * d) / levels.length;
  }, 0) / truth.length, 0);
}

function quantiles(pmf, seed) {
  let mass = 0;
  const cumulative = pmf.map(p => mass += p);
  return levels.map(tau => printed(seed + cumulative.findIndex(p => p >= tau * mass), population));
}

// The later total forces the second trophy to contribute two of three awards.
// With equal timing odds and one early award, each award is equally likely.
const exact = refreshBridge({ seed: [0, 0], lower: [1, 0], upper: [1, 2], lateTotal: 3, budget: 1, ratios: [.1, .1] }, 0, [0]);
assert.ok(Math.abs(exact[0][1] - 1 / 3) < 1e-12);
assert.ok(Math.abs(exact[1][1] - 2 / 3) < 1e-12);
const capped = refreshBridge({ seed: [0, 0], lower: [1, 0], upper: [1, 2], lateTotal: 3, budget: 1, ratios: [.1, .1], earlyCap: [0, 1] }, 0, [0]);
assert.deepEqual(capped, [[1, 0], [0, 1]]);

function simulated(seed, family) {
  let state = seed;
  const rand = () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return (state + .5) / 4294967296;
  };
  const initial = Array.from({ length: 54 }, () => 3 + Math.floor(5 * rand()));
  const later = initial.map((e, i) => e + (i < 5 ? 18 + Math.floor(175 * rand()) : i < 16 ? 2 + Math.floor(18 * rand()) : Math.floor(3 * rand())));
  const ratios = later.map((_, i) => i % 5 === 0 ? .06 : i % 4 === 0 ? .16 : .1);
  const platform = later.map((e, i) => i < 16 && rand() > .1 ? Math.round((e - initial[i]) * rand()) : 0);
  const clock = later.flatMap((e, i) => Array.from({ length: e - initial[i] }, (_, j) => {
    const base = ratios[i] ** (.75 + .5 * rand());
    const signal = family === 'platform' ? (platform[i] > 0 ? 1.5 : .35) : family === 'shift' ? (platform[i] > 0 ? .8 : 1.25) : 1;
    const sync = j === 0 && rand() < (family === 'imports' ? .50 : .10);
    return { i, time: sync ? 0 : -Math.log(rand()) / (base * signal) };
  })).sort((a, b) => a.time - b.time);
  const budget = Math.round(clock.length * (.12 + .10 * rand()));
  const early = [...initial];
  for (const event of clock.slice(0, budget)) early[event.i]++;
  const latePopulation = seed % 2 ? 14028 : 22617;
  const r = later.map(e => printed(e, latePopulation));
  const lower = r.map((p, i) => Math.max(initial[i], Math.ceil((p - .005000001) * latePopulation / 100)));
  const upper = r.map(p => Math.floor((p + .004999999) * latePopulation / 100));
  const lateTotal = later.reduce((a, b) => a + b, 0);
  return { data: { seed: initial, lower, upper, lateTotal, budget, ratios, platform }, truth: early.map(e => printed(e, population)) };
}

const summaries = [];
const integration = {};
const audit = process.env.REFRESH_HOLDOUT === 'audit';
for (const family of ['platform', 'timing', 'shift', 'imports']) {
  const sums = { legacy: 0, timing: 0, platform: 0, blend: 0, weakPlatform: 0, moreImports: 0, sparse: 0, damped: 0, joint: 0, weakerPlatform: 0, lowerImport: 0, diversified: 0, paired: 0 };
  for (let i = 0; i < 20; i++) {
    const seed = audit ? 314159 + 3559 * i : process.env.REFRESH_HOLDOUT ? 271828 + 2687 * i : 8753 + 2017 * i;
    const { data, truth } = simulated(seed, family);
    const timing = refreshBridge(data), platform = refreshBridge(data, 1);
    const weakPlatform = refreshBridge(data, .20), moreImports = refreshBridge(data, 0, [.15, .45, .75]);
    const sparse = refreshBridge(data, .20, undefined, 'sparse');
    const damped = refreshBridge(data, .20, undefined, 'damped');
    const joint = sparse.map((row, j) => row.map((p, k) => (p + damped[j][k]) / 2));
    const weakerPlatform = refreshBridge(data, .1);
    const lowerImport = refreshBridge(data, .2, [0, .1, .5]);
    const paired = weakPlatform.map((row, j) => row.map((p, k) => (p + sparse[j][k]) / 2));
    const diversified = weakPlatform.map((row, j) => row.map((p, k) => (2 * p + timing[j][k] + moreImports[j][k] + platform[j][k]) / 5));
    const compact = refreshEnsemble(data);
    const forecasts = { full: diversified.map((pmf, j) => quantiles(pmf, data.seed[j])) };
    for (const tail of [.05, .06, .075, .09, .10]) {
      forecasts[tail] = launchQuantiles(compact, data.seed, population, tail);
    }
    for (const [mode, rows] of Object.entries(forecasts)) {
      const s = scoreCase(rows.map((q, j) => ({ id: j + 1, q })), truth);
      integration[mode] ??= { loss: 0, miss: 0, coverage: 0 };
      integration[mode].loss += s.lossSum / s.items / 80;
      integration[mode].miss += s.missSum / s.trophies / 80;
      integration[mode].coverage += s.coverage / s.trophies / 80;
    }
    for (const variant of [timing, platform]) {
      assert.ok(variant);
      let total = 0;
      variant.forEach(pmf => {
        assert.ok(Math.abs(pmf.reduce((sum, p) => sum + p, 0) - 1) < 1e-10);
        total += pmf.reduce((sum, p, count) => sum + count * p, 0);
      });
      assert.ok(Math.abs(total - data.budget) < 1e-9);
    }
    const blend = timing.map((p, j) => p.map((v, k) => (v + platform[j][k]) / 2));
    sums.legacy += score(legacyRefresh(data, population), truth);
    for (const [variant, pmfs] of Object.entries({ timing, platform, blend, weakPlatform, moreImports, sparse, damped, joint, weakerPlatform, lowerImport, diversified, paired })) {
      sums[variant] += score(pmfs.map((pmf, j) => quantiles(pmf, data.seed[j])), truth);
    }
  }
  const result = Object.fromEntries(Object.entries(sums).map(([key, sum]) => [key, sum / 20]));
  summaries.push(result);
  console.log(JSON.stringify({ family, cases: 20, ...result }));
}
const mean = Object.fromEntries(Object.keys(summaries[0]).map(key => [key, summaries.reduce((sum, row) => sum + row[key], 0) / summaries.length]));
assert.ok(mean.weakPlatform < mean.legacy);
if (!audit) assert.ok(mean.diversified < mean.weakPlatform);
console.log(JSON.stringify({ mean }));
console.log(JSON.stringify({ integration }));

if (process.env.KIT_INPUT) {
  const c = JSON.parse(readFileSync(join(process.env.KIT_INPUT, 'p00.in'), 'utf8'));
  for (const bridge of ['legacy', 'timing', 'platform', 'blend', 'weak', 'ensemble']) {
    const q = forecast(c, { bridge }).trophies.map(t => t.q);
    console.log(JSON.stringify({ bridge, loss_floor: score(q, q.map(x => x[2])), median_awards: q.reduce((s, x) => s + Math.round(x[2] * population / 100), 0) }));
  }
  for (const refreshProfile of ['sparse', 'damped']) {
    const q = forecast(c, { refreshProfile }).trophies.map(t => t.q);
    console.log(JSON.stringify({ refreshProfile, loss_floor: score(q, q.map(x => x[2])), median_awards: q.reduce((s, x) => s + Math.round(x[2] * population / 100), 0) }));
  }
  assert.deepEqual(forecast(c), forecast(c, { bridge: 'ensemble' }));
  assert.notDeepEqual(forecast(c), forecast(c, { bridge: 'legacy' }));
  forecast(c).trophies.forEach(({ q }, i) => {
    const initial = c.history.at(-1).rates[i];
    if (initial < 100) assert.ok(q[4] < initial);
  });
}
