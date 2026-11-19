import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { forecast } from '../main.ts';

const levels = [.05, .25, .5, .75, .95];
const logit = r => {
  const p = Math.max(.01, Math.min(99.99, r)) / 100;
  return Math.log(p / (1 - p));
};
export function scoreCase(rows, actual) {
  if (!Array.isArray(actual) || actual.length !== rows.length || !actual.length) throw new Error('Reference must contain one rate per input trophy.');
  let lossSum = 0, missSum = 0, coverage = 0;
  rows.forEach((row, i) => {
    const y = actual[i];
    if (!Number.isFinite(y) || y < 0 || y > 100) throw new Error('Reference rate must be finite and within 0..100.');
    if (!Array.isArray(row.q) || row.q.length !== 5 || row.q.some((q, j) => !Number.isFinite(q) || q < 0 || q > 100 || (j && q < row.q[j - 1]))) throw new Error('Forecast has invalid quantiles.');
    row.q.forEach((q, j) => {
      const d = logit(y) - logit(q);
      lossSum += 2 * Math.max(levels[j] * d, (levels[j] - 1) * d);
    });
    missSum += Math.abs(y - row.q[2]);
    coverage += Number(row.q[0] <= y && row.q[4] >= y);
  });
  return { lossSum, missSum, coverage, trophies: rows.length, items: rows.length * 5 };
}
function main() {
  const args = process.argv.slice(2);
  const value = flag => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
  const input = value('--input'), reference = value('--reference');
  const target = Number(value('--target') || .005);
  if (!input || !reference) {
    console.log(JSON.stringify({ target_verified: false, loss: null, reason: 'Both --input and --reference are required. Public aggregate totals and synthetic benchmarks are not per-trophy reference labels.', usage: 'node tools/grade-reference.mjs --input <input directory> --reference <answer.json> [--target 0.005]' }));
    process.exitCode = 2; return;
  }
  if (!Number.isFinite(target) || target <= 0) throw new Error('Target loss must be a finite positive number.');
  const answer = JSON.parse(readFileSync(resolve(reference), 'utf8'));
  if (!Array.isArray(answer.cases)) throw new Error('Reference shape: {"source":"provenance", "cases":[{"id":"p00", "actual":[...]}]}.');
  const byId = new Map(answer.cases.map(c => [c.id, c.actual]));
  if (byId.size !== answer.cases.length) throw new Error('Duplicate reference case ids.');
  let lossSum = 0, missSum = 0, coverage = 0, trophies = 0, items = 0;
  const cases = [];
  for (const file of readdirSync(resolve(input)).filter(f => f.endsWith('.in')).sort()) {
    const c = JSON.parse(readFileSync(join(resolve(input), file), 'utf8'));
    if (!byId.has(c.id)) throw new Error(`No reference rates for ${c.id}.`);
    const s = scoreCase(forecast(c).trophies, byId.get(c.id));
    lossSum += s.lossSum; missSum += s.missSum; coverage += s.coverage; trophies += s.trophies; items += s.items;
    cases.push({ id: c.id, loss: s.lossSum / s.items });
  }
  if (!items) throw new Error('No input cases.');
  const loss = Number((lossSum / items).toFixed(6));
  const result = { source: answer.source || null, kind: 'local score against supplied reference; not a server receipt', loss, typical_miss_pp: missSum / trophies, coverage_90: coverage / trophies, valid: 1, target, target_verified: loss < target, cases };
  console.log(JSON.stringify(result, null, 2));
  if (!result.target_verified) process.exitCode = 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (e) { console.error(`grade-reference: ${e.message}`); process.exitCode = 1; }
}
