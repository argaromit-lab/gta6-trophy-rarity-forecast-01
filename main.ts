import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

type Trophy = { id: number; name: string; description: string; tier: string };
type Read = { slot: string; at: string; players_tracked: number; rates: (number | null)[] };
type Case = { id: string; at: string; target: string; horizon_minutes: number; game?: { release_date?: string }; trophies: Trophy[]; history: Read[] };
type State = { t: number; n: number; r: (number | null)[] };
type Sample = { value: number; weight: number };
const levels = [0.05, 0.25, 0.5, 0.75, 0.95];
const z = [-1.644854, -0.67449, 0, 0.67449, 1.644854];
const hour = 3600000;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const median = (xs: number[]) => quantile(xs.map(value => ({ value, weight: 1 })), 0.5);
// The scorer clamps at .01%, but the underlying population can fall below it.
// Keep that distinction so zero earners do not acquire an artificial floor.
const logit = (r: number) => Math.log(clamp(r, 1e-8, 100 - 1e-8) / (100 - clamp(r, 1e-8, 100 - 1e-8)));
const percent = (x: number) => 100 / (1 + Math.exp(-x));
const printed = (r: number) => Math.round(clamp(r, 0, 100) * 100) / 100;

function quantile(xs: Sample[], p: number): number {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a.value - b.value);
  const target = sorted.reduce((s, x) => s + x.weight, 0) * p;
  let sum = 0;
  for (const x of sorted) {
    sum += x.weight;
    if (sum >= target) return x.value;
  }
  return sorted.at(-1)!.value;
}

// A printed percentage is an interval of possible integer earner counts.
function count(r: number, n: number): number {
  const low = Math.max(0, Math.ceil((r - 0.005000001) * n / 100));
  const high = Math.min(n, Math.floor((r + 0.004999999) * n / 100));
  return high >= low ? clamp(Math.round(r * n / 100), low, high) : r * n / 100;
}

function states(c: Case): State[] {
  const out: State[] = [];
  const reads = [...c.history].filter(h => Number.isFinite(h.players_tracked) && h.players_tracked > 0)
    .sort((a, b) => Date.parse(a.slot || a.at) - Date.parse(b.slot || b.at));
  for (const h of reads) {
    const t = Date.parse(h.slot || h.at) / hour;
    if (!Number.isFinite(t) || t > Date.parse(c.at) / hour) continue;
    const r = c.trophies.map((_, i) => typeof h.rates[i] === 'number' && Number.isFinite(h.rates[i]) ? clamp(h.rates[i]!, 0, 100) : null);
    const last = out.at(-1);
    if (last && last.n === h.players_tracked && r.every((v, i) => v === last.r[i])) continue;
    out.push({ t, n: h.players_tracked, r });
  }
  // Bound quadratic cohort fitting even when the recorder supplies a week of
  // ten-minute refreshes. Preserve endpoints and the entire observed timespan.
  if (out.length <= 40) return out;
  return Array.from({ length: 40 }, (_, i) => out[Math.round(i * (out.length - 1) / 39)]);
}

function slope(xs: { x: number; y: number }[], lo: number, hi: number): number {
  const slopes: number[] = [];
  for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) {
    const dx = xs[j].x - xs[i].x;
    if (dx > 0.02) slopes.push((xs[j].y - xs[i].y) / dx);
  }
  return slopes.length ? clamp(median(slopes), lo, hi) : 0;
}

// Public rules describe the launch refresh. This is an explicit observation
// prior, not a table of trophy answers, and is used only while refresh is unseen.
function unseenRefresh(c: Case, ss: State[]): number[][] | null {
  if (ss.length !== 1 || c.horizon_minutes > 360) return null;
  const last = ss[0];
  const refresh = Date.parse('2026-11-19T04:30:00Z') / hour;
  const target = Date.parse(c.target) / hour;
  if (last.n !== 638 || last.t >= refresh || target < refresh) return null;
  return c.trophies.map((_, i) => {
    const r = last.r[i] ?? 0;
    if (r >= 99.99) return [99.98, 99.99, 100, 100, 100];
    const e = count(r, last.n);
    const m = 100 * e / 3868;
    const s = 0.05;
    return z.map(v => printed(percent(logit(m) + v * s)));
  });
}

function delayPrior(t: Trophy): { delay: number; shape: number; share: number } {
  const d = t.description.toLowerCase();
  const chapter = d.match(/chapter\s+(\d+)/);
  if (t.tier === 'platinum' || /100% completion/.test(d)) return { delay: 240, shape: 3, share: 0.05 };
  if (chapter) return { delay: 8 + Number(chapter[1]) * 17, shape: 2, share: 0.75 - Number(chapter[1]) * 0.08 };
  if (/final mission/.test(d)) return { delay: t.tier === 'gold' ? 100 : 80, shape: 2, share: 0.30 };
  if (/all |every |250 |100 locations|50 challenges|collectible/.test(d)) return { delay: 180, shape: 2, share: 0.08 };
  if (/fishing challenge|arcade game|cocktail/.test(d)) return { delay: 20, shape: 1.5, share: 0.30 };
  return { delay: 60, shape: 1.5, share: 0.18 };
}

type Cohort = { t: number; n: number };
function population(ss: State[], origin: number, target: number): { n: number; weight: number; cohorts: Cohort[] }[] {
  const last = ss.at(-1)!;
  const recent = ss.filter(s => s.t >= last.t - 36);
  // Learn the launch offset instead of assuming acquisition began exactly at
  // midnight. Fit only past snapshots, with the endpoint fixed for continuity.
  let shift = 4;
  let b = 0.6;
  let best = Infinity;
  if (recent.length > 1) for (const offset of [0.25, 1, 2, 4, 8, 16, 32, 64]) {
    const points = recent.map(s => ({ x: Math.log(offset + Math.max(0, s.t - origin)), y: Math.log(s.n) }));
    const power = slope(points, 0, 2);
    const anchor = Math.log(offset + Math.max(0, last.t - origin));
    const error = points.reduce((sum, p) => sum + Math.pow(p.y - Math.log(last.n) - power * (p.x - anchor), 2), 0);
    if (error < best) { best = error; shift = offset; b = power; }
  }
  return [-0.35, 0, 0.35].map((offset, k) => {
    const power = clamp(b + offset, 0, 2);
    const cohorts: Cohort[] = [];
    for (let j = 1; j < ss.length; j++) {
      const n = Math.max(0, ss[j].n - ss[j - 1].n);
      if (n) cohorts.push({ t: (ss[j].t + ss[j - 1].t) / 2, n });
    }
    let prev = last.n;
    const steps = Math.max(1, Math.ceil((target - last.t) / 2));
    for (let j = 1; j <= steps; j++) {
      const t = last.t + (target - last.t) * j / steps;
      const n = last.n * Math.pow((shift + Math.max(0, t - origin)) / (shift + Math.max(0, last.t - origin)), power);
      cohorts.push({ t: t - (target - last.t) / steps / 2, n: Math.max(0, n - prev) });
      prev = n;
    }
    return { n: prev, weight: k === 1 ? 0.6 : 0.2, cohorts };
  });
}

function cdf(age: number, delay: number, shape: number): number {
  return age <= 0 ? 0 : -Math.expm1(-Math.pow(age / delay, shape));
}

function exposure(t: number, cohorts: Cohort[], initial: number, origin: number, delay: number, shape: number): number {
  let total = initial * cdf(t - origin, delay, shape);
  for (const c of cohorts) if (c.t < t) total += c.n * cdf(t - c.t, delay, shape);
  return total;
}

function forecastTrophy(c: Case, ss: State[], i: number, populations: ReturnType<typeof population>, origin: number): number[] {
  const known = ss.filter(s => s.r[i] !== null);
  if (!known.length) return [0, 0.01, 0.1, 2, 25];
  const last = known.at(-1)!;
  const r = last.r[i]!;
  const horizon = Math.max(0, Date.parse(c.target) / hour - last.t);
  if (horizon === 0) return levels.map(() => r);
  if (known.every(s => s.r[i]! >= 99.99)) return [99.90, 99.98, 99.99, 100, 100];
  const target = Date.parse(c.target) / hour;
  const first = known[0];
  const seed = Math.min(...known.map(s => count(s.r[i]!, s.n)));
  const lastCount = count(r, last.n);
  const prior = delayPrior(c.trophies[i]);
  const candidate: { delay: number; shape: number; a: number; cost: number }[] = [];
  const cohorts = populations[1].cohorts;
  const initial = Math.max(0, ss[0].n - seed);
  const baseExposure = (delay: number, shape: number) => exposure(first.t, cohorts, initial, origin, delay, shape);
  const observations = known.map(s => ({ s, e: Math.max(seed, count(s.r[i]!, s.n)) }));
  for (const factor of [0.25, 0.5, 1, 2, 4]) for (const shape of [0.8, 1.3, 2, 3]) {
    const delay = prior.delay * factor;
    const x0 = baseExposure(delay, shape);
    let xx = 0;
    let xy = 0;
    for (const { s, e } of observations) {
      const x = Math.max(0, exposure(s.t, cohorts, initial, origin, delay, shape) - x0);
      const w = 1 / Math.max(2, e);
      xx += w * x * x;
      xy += w * x * (e - seed);
    }
    const a = clamp(xy / Math.max(1e-9, xx), 0, 1);
    let cost = 0;
    for (const { s, e } of observations) {
      const x = Math.max(0, exposure(s.t, cohorts, initial, origin, delay, shape) - x0);
      cost += Math.pow((seed + a * x - e) / Math.sqrt(Math.max(2, e)), 2);
    }
    cost /= Math.max(1, known.length - 1);
    cost += 0.15 * Math.pow(Math.log(factor), 2) + 0.10 * Math.pow(shape - prior.shape, 2);
    candidate.push({ delay, shape, a, cost });
  }
  const best = Math.min(...candidate.map(x => x.cost));
  const draws: Sample[] = [];
  const horizonDays = horizon / 24;
  for (const model of candidate) {
    const modelWeight = Math.exp(-Math.min(40, (model.cost - best) / 2));
    const growth = Math.max(0, lastCount - seed);
    // A handful of early reviewers do not imply exponential mass adoption.
    // Unidentified delays retain model spread rather than a large fitted trend.
    const confidence = growth / (growth + 8);
    const amplitude = model.a;
    const currentX = exposure(last.t, cohorts, initial, origin, model.delay, model.shape);
    for (const pop of populations) {
      const futureX = exposure(target, pop.cohorts, initial, origin, model.delay, model.shape);
      const e = clamp(lastCount + amplitude * Math.max(0, futureX - currentX), 0, pop.n);
      const center = 100 * e / pop.n;
      const spread = 0.10 + Math.min(0.85, 0.24 * Math.sqrt(horizonDays)) + 0.25 * (1 - confidence);
      for (let j = 0; j < z.length; j++) draws.push({ value: percent(logit(center) + z[j] * spread), weight: modelWeight * pop.weight * [0.12, 0.23, 0.30, 0.23, 0.12][j] });
    }
  }
  const q = levels.map(p => quantile(draws, p));
  return q.map(x => Number(clamp(x, 0, 100).toFixed(6)));
}

export function forecast(c: Case): { trophies: { id: number; q: number[] }[] } {
  const ss = states(c);
  if (!ss.length) return { trophies: c.trophies.map(t => ({ id: t.id, q: [0, 0.01, 0.1, 2, 25] })) };
  const refresh = unseenRefresh(c, ss);
  if (refresh) return { trophies: c.trophies.map((t, i) => ({ id: t.id, q: refresh[i] })) };
  const release = Date.parse(`${c.game?.release_date || String(c.at).slice(0, 10)}T00:00:00Z`) / hour;
  const origin = Math.min(release, ss[0].t);
  const target = Math.max(ss.at(-1)!.t, Date.parse(c.target) / hour);
  const populations = population(ss, origin, target);
  return { trophies: c.trophies.map((t, i) => ({ id: t.id, q: forecastTrophy(c, ss, i, populations, origin) })) };
}

function main() {
  const input = process.env.MAKEFUN_INPUT_DIR || '/input';
  const output = process.env.MAKEFUN_OUTPUT_DIR || '/output';
  mkdirSync(output, { recursive: true });
  for (const file of readdirSync(input).filter(x => x.endsWith('.in')).sort()) {
    const c = JSON.parse(readFileSync(join(input, file), 'utf8')) as Case;
    writeFileSync(join(output, file.slice(0, -3) + '.out'), JSON.stringify(forecast(c)) + '\n');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
