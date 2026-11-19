import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { conditionOnTotal, forecast } from '../main.ts';

const levels = [.05, .25, .5, .75, .95];
const close = (a, b, eps = 1e-10) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
function enumerate(pmfs) {
  const joint = [];
  function walk(i, counts, probability) {
    if (i === pmfs.length) { joint.push({ counts, probability, total: counts.reduce((a, b) => a + b, 0) }); return; }
    pmfs[i].forEach((p, k) => { if (p) walk(i + 1, [...counts, k], probability * p); });
  }
  walk(0, [], 1);
  return joint;
}
function brute(pmfs, total) {
  const joint = enumerate(pmfs).filter(x => x.total === total);
  const evidence = joint.reduce((sum, x) => sum + x.probability, 0);
  if (!evidence) return null;
  const marginals = pmfs.map(p => p.map(() => 0));
  joint.forEach(x => x.counts.forEach((k, i) => { marginals[i][k] += x.probability / evidence; }));
  return { evidence, marginals };
}

let checks = 0;
function check(name, fn) { fn(); checks++; console.log(`PASS ${name}`); }
check('dynamic program equals independent exhaustive enumeration', () => {
  for (const pmfs of [
    [[.25, .75], [.1, .3, .6], [.5, .5]],
    [[.001, .099, .9], [1], [.8, .2], [.1, .2, .3, .4]],
    [[.3, .7], [.6, .4], [.2, .5, .3], [.5, 0, .5]],
  ]) {
    const maximum = pmfs.reduce((sum, p) => sum + p.length - 1, 0);
    for (let total = 0; total <= maximum; total++) {
      const expected = brute(pmfs, total), actual = conditionOnTotal(pmfs, total);
      assert.equal(Boolean(actual), Boolean(expected));
      if (!actual) continue;
      close(actual.evidence, expected.evidence);
      actual.marginals.forEach((p, i) => {
        close(p.reduce((a, b) => a + b, 0), 1);
        p.forEach((mass, k) => close(mass, expected.marginals[i][k]));
      });
      close(actual.marginals.reduce((sum, p) => sum + p.reduce((s, mass, k) => s + mass * k, 0), 0), total);
    }
  }
});
check('impossible totals, degenerate counts and extreme probabilities', () => {
  assert.equal(conditionOnTotal([[1], [1]], 1), null);
  assert.equal(conditionOnTotal([[.5, .5]], -1), null);
  assert.equal(conditionOnTotal([[.5, .5]], .5), null);
  assert.equal(conditionOnTotal([[.5, .5]], 5000), null);
  assert.deepEqual(conditionOnTotal([[1], [1]], 0).marginals, [[1], [1]]);
  const rare = conditionOnTotal([[1 - 1e-12, 1e-12], [1 - 1e-12, 1e-12]], 1);
  close(rare.marginals[0][1], .5);
});
function qs(pmf) {
  return levels.map(tau => {
    let sum = 0;
    for (let k = 0; k < pmf.length; k++) { sum += pmf[k]; if (sum >= tau) return k; }
    return pmf.length - 1;
  });
}
const sharpen = (pmf, power) => {
  const p = pmf.map(x => Math.pow(x, power));
  const sum = p.reduce((a, b) => a + b, 0); return p.map(x => x / sum);
};
const logit = x => Math.log(Math.max(.01, Math.min(99.99, x)) / (100 - Math.max(.01, Math.min(99.99, x))));
function pinball(predicted, actual, base = 4, population = 4000) {
  const truth = logit(100 * (base + actual) / population);
  return predicted.reduce((sum, k, j) => {
    const d = truth - logit(100 * (base + k) / population);
    return sum + 2 * Math.max(levels[j] * d, (levels[j] - 1) * d) / levels.length;
  }, 0);
}

// These finite generative populations are independent of GTA practice answers.
// Exhaustive expectations make this a check of the value of a known total,
// not a claim to recover the server's hidden reference.
let independentRisk = 0, conditionedRisk = 0, populations = 0;
const sharpRisk = new Map([2, 4, 8].map(x => [x, 0]));
const begin = performance.now();
for (const tilt of [.2, .7, 1.4, 2.5]) for (const size of [3, 4, 5]) {
  const pmfs = Array.from({ length: size }, (_, i) => {
    const p = Array.from({ length: 3 + i % 2 }, (_, k) => Math.exp(-Math.abs(k - (i % 3)) * tilt));
    const sum = p.reduce((a, b) => a + b, 0); return p.map(x => x / sum);
  });
  const base = pmfs.map(qs);
  const byTotal = new Map();
  for (const x of enumerate(pmfs)) {
    if (!byTotal.has(x.total)) {
      const posterior = conditionOnTotal(pmfs, x.total).marginals;
      byTotal.set(x.total, { ordinary: posterior.map(qs), sharpened: new Map([...sharpRisk.keys()].map(power => [power, posterior.map(p => qs(sharpen(p, power)))])) });
    }
    const conditional = byTotal.get(x.total);
    x.counts.forEach((actual, i) => {
      independentRisk += x.probability * pinball(base[i], actual) / size;
      conditionedRisk += x.probability * pinball(conditional.ordinary[i], actual) / size;
      for (const [power, prediction] of conditional.sharpened) sharpRisk.set(power, sharpRisk.get(power) + x.probability * pinball(prediction[i], actual) / size);
    });
  }
  populations++;
}
independentRisk /= populations; conditionedRisk /= populations;
check('known totals reduce exact expected loss over finite synthetic populations', () => assert.ok(conditionedRisk < independentRisk));
console.log(JSON.stringify({ kind: 'exact finite synthetic expectation; not official score', populations, independent_loss: independentRisk, conditioned_loss: conditionedRisk, improvement_percent: 100 * (1 - conditionedRisk / independentRisk), elapsed_ms: performance.now() - begin }));
check('unsupported interval sharpening increases expected loss', () => {
  for (const [power, risk] of sharpRisk) {
    assert.ok(risk / populations >= conditionedRisk - 1e-12);
    console.log(JSON.stringify({ sharpness: power, expected_synthetic_loss: risk / populations, decision: 'reject unsupported concentration' }));
  }
});

if (process.env.KIT_INPUT) {
  const c = JSON.parse(readFileSync(join(process.env.KIT_INPUT, 'p00.in'), 'utf8'));
  const outputs = [];
  for (const [name, options] of [
    ['submitted-independent', { refresh: 'independent', lateCounts: false }],
    ['exact-first-total', { refresh: 'conditioned', lateCounts: false }],
    ['exact-both-totals', { refresh: 'conditioned', lateCounts: true }],
  ]) {
    const start = performance.now(), f = forecast(c, options);
    const runtime = performance.now() - start;
    outputs.push(f);
    const implied = f.trophies.reduce((sum, t) => sum + t.q[2] * 3868 / 100, 0);
    const band = f.trophies.reduce((sum, t) => sum + logit(t.q[4]) - logit(t.q[0]), 0) / f.trophies.length;
    const minimumPossibleLoss = f.trophies.reduce((sum, t) => sum + t.q.reduce((s, q, j) => {
      const d = logit(t.q[2]) - logit(q);
      return s + 2 * Math.max(levels[j] * d, (levels[j] - 1) * d) / levels.length;
    }, 0) / f.trophies.length, 0);
    console.log(JSON.stringify({ candidate: name, median_implied_awards: implied, mean_logit_90_band: band, minimum_possible_loss_for_these_quantiles: minimumPossibleLoss, runtime_ms: runtime, official_loss: null }));
  }
  check('inference alternatives are reproducible and preserve quantile ordering', () => {
    for (const f of outputs) for (const row of f.trophies) {
      assert.equal(row.q.length, 5);
      row.q.forEach((x, i) => assert.ok(Number.isFinite(x) && x >= 0 && x <= 100 && (!i || x >= row.q[i - 1])));
    }
    assert.deepEqual(outputs[1], forecast(c, { refresh: 'conditioned', lateCounts: false }));
  });
}
console.log(`RESULT ${checks} count-inference checks passed; 0 failures`);
