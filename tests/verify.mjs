import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { forecast } from '../main.ts';

const epoch = Date.parse('2026-11-19T00:00:00Z');
const iso = h => new Date(epoch + h * 3600000).toISOString();
const round = x => Math.round(x * 100) / 100;
const levels = [0.05, 0.25, 0.5, 0.75, 0.95];
const z = [-1.644854, -0.67449, 0, 0.67449, 1.644854];
const logit = x => Math.log(Math.max(.01, Math.min(99.99, x)) / (100 - Math.max(.01, Math.min(99.99, x))));
const percent = x => 100 / (1 + Math.exp(-x));
let passed = 0;
const check = (label, fn) => { fn(); passed++; console.log(`PASS ${label}`); };

function valid(c, f) {
  assert.deepEqual(Object.keys(f), ['trophies']);
  assert.equal(f.trophies.length, c.trophies.length);
  assert.equal(new Set(f.trophies.map(t => t.id)).size, c.trophies.length);
  const ids = new Set(c.trophies.map(t => t.id));
  for (const row of f.trophies) {
    assert.deepEqual(Object.keys(row).sort(), ['id', 'q']);
    assert.ok(ids.has(row.id));
    assert.equal(row.q.length, 5);
    row.q.forEach((x, i) => assert.ok(Number.isFinite(x) && x >= 0 && x <= 100 && (!i || x >= row.q[i - 1])));
  }
  assert.ok(Buffer.byteLength(JSON.stringify(f)) <= 65536);
}

function loss(f, truth) {
  let s = 0;
  f.trophies.forEach((row, i) => row.q.forEach((q, j) => {
    const d = logit(truth[i]) - logit(q);
    s += 2 * Math.max(levels[j] * d, (levels[j] - 1) * d);
  }));
  return s / (truth.length * 5);
}

const trophies = [
  { id: 1, name: 'Completion', description: 'Attain 100% Completion.', tier: 'gold' },
  { id: 2, name: 'Story', description: 'Complete Chapter 2.', tier: 'bronze' },
  { id: 3, name: 'Side activity', description: 'Complete an arcade game.', tier: 'bronze' },
  { id: 4, name: 'Introduction', description: 'Complete the introduction.', tier: 'bronze' },
];
function synthetic({ delay = 30, shape = 1.3, power = .8, dilution = false, at = 48, horizon = 108.5, id = 'synthetic' } = {}) {
  const player = t => Math.round(1000 * Math.pow(1 + t / 4, power));
  const kernel = (a, d, b) => a <= 0 ? 0 : -Math.expm1(-Math.pow(a / d, b));
  const shares = [.05, .55, .3, 1];
  const seeds = [4, 7, 6, 1000];
  const rate = (t, i) => {
    if (i === 3) return 100;
    if (dilution) return round(100 * seeds[i] / player(t));
    const d = delay * [4, 1, .5, 0][i];
    let e = seeds[i] + (1000 - seeds[i]) * shares[i] * kernel(t, d, shape);
    for (let j = 1; j <= t; j++) e += (player(j) - player(j - 1)) * shares[i] * kernel(t - j + .5, d, shape);
    return round(100 * e / player(t));
  };
  const history = [];
  for (let t = 0; t <= at; t += 4) history.push({ slot: iso(t), at: iso(t), players_tracked: player(t), rates: trophies.map((_, i) => rate(t, i)) });
  return { c: { id, at: iso(at), target: iso(at + horizon), horizon_minutes: horizon * 60, game: { release_date: '2026-11-19' }, trophies, history }, truth: trophies.map((_, i) => rate(at + horizon, i)) };
}

const c = synthetic().c;
check('JSON contract and deterministic forecast', () => {
  const f = forecast(c); valid(c, f); assert.deepEqual(f, forecast(structuredClone(c)));
});
check('duplicate reads within one polling slot do not add evidence', () => {
  const extra = structuredClone(c);
  extra.history = extra.history.flatMap(h => [h, { ...h, at: new Date(Date.parse(h.at) + 60000).toISOString() }]);
  assert.deepEqual(forecast(c), forecast(extra));
});
check('history sorting and future-read exclusion', () => {
  const shuffled = structuredClone(c);
  shuffled.history.reverse();
  shuffled.history.push({ slot: iso(1000), at: iso(1000), players_tracked: 1e9, rates: [90, 90, 90, 90] });
  assert.deepEqual(forecast(c), forecast(shuffled));
});
check('missing, zero, boundary and empty histories remain valid', () => {
  const missing = structuredClone(c);
  missing.history.forEach((h, i) => { h.rates = [null, i % 2 ? null : 0, 100, null]; });
  valid(missing, forecast(missing));
  missing.history = []; valid(missing, forecast(missing));
});
check('zero horizon returns last reported rates', () => {
  const now = structuredClone(c); now.target = now.at; now.horizon_minutes = 0;
  const f = forecast(now); valid(now, f);
  assert.deepEqual(f.trophies.map(t => t.q[2]), now.history.at(-1).rates);
});
check('zero earners stay at zero without an artificial probability floor', () => {
  const zero = structuredClone(c);
  zero.history.forEach(h => { h.rates[0] = 0; });
  const f = forecast(zero); valid(zero, f);
  assert.deepEqual(f.trophies[0].q, [0, 0, 0, 0, 0]);
});
check('short-horizon forecasts preserve already observed growth', () => {
  const sample = synthetic({ at: 24, horizon: 1.5 });
  const f = forecast(sample.c); valid(sample.c, f);
  assert.ok(loss(f, sample.truth) < .5);
});

check('later story milestones stay below their prerequisites at every quantile', () => {
  const chain = {
    ...c,
    trophies: [
      { id: 1, name: 'First chapter', description: 'Complete Chapter 1.', tier: 'bronze', points: 15 },
      { id: 2, name: 'Second chapter', description: 'Complete Chapter 2.', tier: 'bronze', points: 15 },
    ],
    history: [2, 4, 7, 12, 22, 35, 49].map((rate, i) => ({
      slot: iso(12 + i * 6), at: iso(12 + i * 6), players_tracked: 1000, trophies_earned: 500 + 10 * rate, rates: [50, rate],
    })),
  };
  const f = forecast(chain);
  valid(chain, f);
  assert.ok(f.trophies[1].q.every((rate, i) => rate <= f.trophies[0].q[i]));
});

const scenarios = [];
for (const delay of [15, 40, 100]) for (const shape of [.8, 1.3, 2]) for (const power of [.4, .8, 1.2]) scenarios.push(synthetic({ delay, shape, power }));
scenarios.push(synthetic({ dilution: true }));
let model = 0, baseline = 0;
const start = performance.now();
for (const { c, truth } of scenarios) {
  const f = forecast(c); valid(c, f); model += loss(f, truth);
  const last = c.history.at(-1).rates;
  const spread = .5 * Math.sqrt(c.horizon_minutes / 1440);
  baseline += loss({ trophies: last.map((r, i) => ({ id: i + 1, q: z.map(v => percent(logit(r) + v * spread)) })) }, truth);
}
model /= scenarios.length; baseline /= scenarios.length;
check('held-out synthetic cohort grid beats persistence baseline', () => assert.ok(model < baseline, `${model} >= ${baseline}`));
console.log(JSON.stringify({ kind: 'synthetic benchmark, not official practice score', cases: scenarios.length, loss: model, baseline_loss: baseline, improvement_percent: (1 - model / baseline) * 100, elapsed_ms: performance.now() - start }));

check('dense 55-trophy history fits within the eight-second sandbox budget', () => {
  const dense = synthetic().c;
  dense.trophies = Array.from({ length: 55 }, (_, i) => ({ ...trophies[i % 4], id: i + 1 }));
  const original = dense.history;
  dense.history = Array.from({ length: 289 }, (_, i) => {
    const a = original[Math.min(original.length - 1, Math.floor(i / 24))];
    return { slot: iso(i / 6), at: iso(i / 6), players_tracked: a.players_tracked + i, rates: dense.trophies.map((_, j) => a.rates[j % 4]) };
  });
  const begin = performance.now(); valid(dense, forecast(dense));
  const elapsed = performance.now() - begin;
  console.log(`Dense forecast: ${elapsed.toFixed(1)} ms, 55 trophies, 289 reads`);
  assert.ok(elapsed < 7500, `${elapsed} ms`);
});

const kitInput = process.env.KIT_INPUT;
if (kitInput) {
  const inputs = readdirSync(kitInput).filter(x => x.endsWith('.in')).sort();
  check('official practice inputs: shape, determinism and documented refresh', () => {
    for (const file of inputs) {
      const practice = JSON.parse(readFileSync(join(kitInput, file), 'utf8'));
      const f = forecast(practice); valid(practice, f); assert.deepEqual(f, forecast(practice));
      const platinum = f.trophies.find(t => t.id === 1);
      assert.ok(platinum.q[2] < practice.history.at(-1).rates[0]);
      const projectedAwards = f.trophies.reduce((sum, t) => sum + t.q[2] * 3868 / 100, 0);
      // Marginal medians and display rounding need not sum exactly, but must
      // agree with the public 4,276-award observation within rounding error.
      assert.ok(Math.abs(projectedAwards - 4276) < 20, `${projectedAwards} projected awards`);
      assert.equal(f.trophies.find(t => t.id === 2).q[2], 100);
      f.trophies.forEach((row, i) => {
        const seed = Math.round(practice.history[0].rates[i] * 638 / 100);
        if (i === 1) return;
        for (const q of row.q) {
          const e = Math.round(q * 3868 / 100);
          assert.ok(e >= seed, `trophy ${row.id} predicted fewer than its observed earners`);
          assert.ok(Math.abs(q - Math.round(e * 10000 / 3868) / 100) < 1e-9, `trophy ${row.id} off count lattice`);
        }
      });
      console.log(`${file}: median-implied awards ${projectedAwards.toFixed(1)} vs documented 4276`);
    }
  });
  check('official practice files run independently through the real entrypoint', () => {
    let totalMs = 0;
    for (const file of inputs) {
      const temp = mkdtempSync(join(tmpdir(), 'gta6-practice-'));
      const input = join(temp, 'input'); mkdirSync(input);
      const raw = readFileSync(join(kitInput, file), 'utf8');
      writeFileSync(join(input, file), raw);
      const outputs = [];
      for (let run = 0; run < 2; run++) {
        const output = join(temp, `out${run}`);
        const begin = performance.now();
        const result = spawnSync(process.execPath, [resolve('main.ts')], { env: { ...process.env, MAKEFUN_INPUT_DIR: input, MAKEFUN_OUTPUT_DIR: output }, encoding: 'utf8' });
        totalMs += (performance.now() - begin) / 2;
        assert.equal(result.status, 0, result.stderr);
        const bytes = readFileSync(join(output, file.replace(/\.in$/, '.out')), 'utf8');
        valid(JSON.parse(raw), JSON.parse(bytes)); outputs.push(bytes);
      }
      assert.equal(outputs[0], outputs[1]);
    }
    console.log(`Practice process runtime (two cases, mean of two executions): ${totalMs.toFixed(1)} ms`);
  });
}
check('real entrypoint reads independent files and writes valid byte-identical output', () => {
  const temp = mkdtempSync(join(tmpdir(), 'gta6-forecast-'));
  const input = join(temp, 'input'), out1 = join(temp, 'out1'), out2 = join(temp, 'out2');
  mkdirSync(input); writeFileSync(join(input, 'one.in'), JSON.stringify(c));
  writeFileSync(join(input, 'two.in'), JSON.stringify(synthetic({ delay: 100 }).c));
  for (const output of [out1, out2]) {
    const result = spawnSync(process.execPath, [resolve('main.ts')], { env: { ...process.env, MAKEFUN_INPUT_DIR: input, MAKEFUN_OUTPUT_DIR: output }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readdirSync(output).sort(), ['one.out', 'two.out']);
  }
  for (const file of ['one.out', 'two.out']) assert.equal(readFileSync(join(out1, file), 'utf8'), readFileSync(join(out2, file), 'utf8'));
  valid(c, JSON.parse(readFileSync(join(out1, 'one.out'), 'utf8')));
});
console.log(`RESULT ${passed} checks passed; 0 failures`);
