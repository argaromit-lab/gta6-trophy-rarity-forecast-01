import { fitTrajectory, trajectoryDefaults, trajectoryQuantiles } from '../main.ts';
import { scenario } from '../tests/rolling-scenarios.mjs';
import { scoreCase } from './grade-reference.mjs';

function games(audit = false) {
  const result = [];
  const populations = audit ? ['saturation', 'waves'] : ['power', 'saturation'];
  for (const population of populations) for (const kernel of ['weibull', 'loglogistic']) {
    for (const delay of audit ? [17, 53, 97] : [12, 40, 120]) {
      for (const shape of audit ? [1.1, 1.75, 2.2] : [.8, 1.5, 2.5]) {
        const windows = [];
        for (const horizon of [1.5, 108.5]) {
          for (const context of audit ? [{ at: 58, cadence: 3, phase: 1 }, { at: 58, cadence: 7, phase: 3 }, { at: 60, cadence: 4.5, phase: 2.5 }]
            : [{ at: 24 }, { at: 48 }, { at: 52, cadence: 4 }, { at: 56, cadence: 7, phase: 2 }]) {
            const { c, truth } = scenario({ population, kernel, delay, shape, horizon, ...context });
            windows.push({ fit: fitTrajectory(c), truth, horizon });
          }
        }
        result.push(windows);
      }
    }
  }
  return result;
}

const empty = () => ({ lossSum: 0, missSum: 0, coverage: 0, trophies: 0, items: 0, cases: 0 });
function add(total, counts, sign = 1) {
  for (const key of Object.keys(total)) total[key] += sign * counts[key];
  return total;
}
function summarize(counts) {
  return { loss: counts.lossSum / counts.items, typical_miss_pp: counts.missSum / counts.trophies,
    coverage_90: counts.coverage / counts.trophies, cases: counts.cases };
}

function scoreGame(windows, options) {
  const score = { quick: empty(), week: empty() };
  for (const { fit, truth, horizon } of windows) {
    const q = options ? trajectoryQuantiles(fit, options) : fit.prior;
    const summary = scoreCase(q.map((row, i) => ({ id: i + 1, q: row })), truth);
    add(score[horizon < 2 ? 'quick' : 'week'], { ...summary, cases: 1 });
  }
  return score;
}

function summarizeGames(scores) {
  const quick = scores.reduce((total, s) => add(total, s.quick), empty());
  const week = scores.reduce((total, s) => add(total, s.week), empty());
  return { total: summarize(add(add(empty(), quick), week)), quick: summarize(quick), week: summarize(week) };
}

const grid = {
  short: [0, .25, .50, .75, 1], week: [0, .10, .20, .35, .50, .75],
  width: [.60, .80, 1, 1.20, 1.40, 1.70, 2], tail: [1, 1.15, 1.35, 1.6, 2, 2.5],
  quickTail: [1, 1.2, 1.5, 1.8, 2.2, 2.6], radius: [.15, .30, .50, .70, 1, 1.4],
};
const development = games();
const audit = games(true);
const cache = new Map();
function evaluate(options) {
  const key = Object.keys(grid).map(k => options[k]).join('/');
  if (!cache.has(key)) {
    const rows = development.map(windows => scoreGame(windows, options));
    const total = rows.reduce((sum, score) => add(add(sum, score.quick), score.week), empty());
    cache.set(key, { rows, totals: total });
  }
  return cache.get(key);
}

function objective(options, heldOut) {
  const { rows, totals } = evaluate(options);
  const counts = { ...totals };
  if (heldOut >= 0) {
    add(counts, rows[heldOut].quick, -1);
    add(counts, rows[heldOut].week, -1);
  }
  const { loss, coverage_90: coverage } = summarize(counts);
  return loss + 2 * Math.max(.947 - coverage, 0) + .25 * Math.max(coverage - .98, 0);
}

function tune(heldOut) {
  let options = { short: .5, week: .20, width: 1, tail: 1.35, quickTail: 1.5, radius: .50 };
  let score = objective(options, heldOut);
  for (let sweep = 0; sweep < 3; sweep++) {
    for (const [name, values] of Object.entries(grid)) for (const value of values) {
      const candidate = { ...options, [name]: value };
      const loss = objective(candidate, heldOut);
      if (loss + 1e-9 < score) { options = candidate; score = loss; }
    }
  }
  return options;
}

const tuned = tune(-1);
const heldOut = development.map((_, i) => evaluate(tune(i)).rows[i]);
console.log(JSON.stringify({ kind: 'synthetic leave-one-game-out', game_groups: development.length,
  before: summarizeGames(development.map(windows => scoreGame(windows))), after: summarizeGames(heldOut) }));
console.log(JSON.stringify({ kind: 'independent synthetic audit', game_groups: audit.length,
  before: summarizeGames(audit.map(windows => scoreGame(windows))),
  current_defaults: summarizeGames(audit.map(windows => scoreGame(windows, trajectoryDefaults))),
  after: summarizeGames(audit.map(windows => scoreGame(windows, tuned))), tuned, configurations: cache.size }));
