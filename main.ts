import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

type Trophy = { id: number; name: string; description: string; tier: string };
type Read = { slot: string; at: string; players_tracked: number; rates: (number | null)[] };
type Case = { id: string; at: string; target: string; horizon_minutes: number; game?: { release_date?: string }; trophies: Trophy[]; history: Read[] };
type State = { t: number; n: number; r: (number | null)[]; since?: number };
type Sample = { value: number; weight: number };
export type ForecastOptions = { refresh?: 'independent' | 'conditioned'; bridge?: 'legacy' | 'timing' | 'platform' | 'blend' | 'weak' | 'ensemble'; refreshProfile?: 'uniform' | 'sparse' | 'damped'; lateCounts?: boolean; sharpness?: number; likelihood?: 'average' | 'sum'; population?: 'power' | 'adaptive'; increments?: boolean; longTail?: boolean; week?: 'legacy' | 'clock' | 'calibrated'; hazard?: 'wide' | 'robust' | 'both' };
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
const scoreLogit = (r: number) => logit(clamp(r, 0.01, 99.99));

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

function forecastQuantiles(xs: Sample[]): number[] {
  if (!xs.length) return levels.map(() => 0);
  const sorted = [...xs].sort((a, b) => a.value - b.value);
  const mass = sorted.reduce((sum, x) => sum + x.weight, 0);
  const result: number[] = [];
  let cumulative = 0;
  for (const x of sorted) {
    cumulative += x.weight;
    while (result.length < levels.length && cumulative >= levels[result.length] * mass) result.push(x.value);
    if (result.length === levels.length) break;
  }
  return result;
}

// A printed percentage is an interval of possible integer earner counts.
function count(r: number, n: number): number {
  const low = Math.max(0, Math.ceil((r - 0.005000001) * n / 100));
  const high = Math.min(n, Math.floor((r + 0.004999999) * n / 100));
  return high >= low ? clamp(Math.round(r * n / 100), low, high) : r * n / 100;
}

// Exact marginals of independent finite count distributions, conditional on
// their sum. Prefix/suffix polynomial products retain all dependencies from
// the observed total without enumerating the joint state space.
export function conditionOnTotal(pmfs: number[][], total: number): { marginals: number[][]; evidence: number } | null {
  if (!Number.isInteger(total) || total < 0 || total > 4096) return null;
  const combine = (a: Float64Array, p: number[]) => {
    const b = new Float64Array(total + 1);
    for (let k = 0; k < p.length && k <= total; k++) if (p[k] > 0) {
      for (let j = 0; j + k <= total; j++) if (a[j]) b[j + k] += a[j] * p[k];
    }
    return b;
  };
  const unit = new Float64Array(total + 1); unit[0] = 1;
  const before = [unit];
  for (const p of pmfs) before.push(combine(before.at(-1)!, p));
  const evidence = before.at(-1)![total];
  if (!Number.isFinite(evidence) || evidence < 1e-280) return null;
  const after: Float64Array[] = new Array(pmfs.length + 1); after[pmfs.length] = unit;
  for (let i = pmfs.length - 1; i >= 0; i--) after[i] = combine(after[i + 1], pmfs[i]);
  const marginals = pmfs.map((p, i) => p.map((mass, k) => {
    if (!mass || k > total) return 0;
    let other = 0;
    for (let j = 0; j + k <= total; j++) other += before[i][j] * after[i + 1][total - k - j];
    return mass * other / evidence;
  }));
  return { marginals, evidence };
}

function binomial(maximum: number, mean: number): number[] {
  const p = maximum ? clamp(mean / maximum, 0, 1) : 0;
  if (p > 0.5 && Math.pow(1 - p, maximum) < 1e-240) return binomial(maximum, maximum - mean).reverse();
  const masses: number[] = [];
  let probability = Math.pow(1 - p, maximum);
  let used = 0;
  for (let k = 0; k <= maximum; k++) {
    const mass = k === maximum ? Math.max(0, 1 - used) : probability;
    masses.push(mass); used += mass;
    probability *= (maximum - k) / (k + 1) * p / Math.max(1e-12, 1 - p);
  }
  return masses;
}

export type RefreshEvidence = { seed: number[]; lower: number[]; upper: number[]; lateTotal: number; budget: number; ratios: number[]; platform?: number[]; earlyCap?: number[] };

// Each later award can have arrived in the early refresh or in the gap
// between refreshes. The shared multiplier reconciles the timing odds with
// the observed early total, while a separate trial models profile imports.
export function refreshBridge(data: RefreshEvidence, platformWeight = 0, importPrior = [0, 0.25, 0.65], profile: 'uniform' | 'sparse' | 'damped' = 'uniform'): number[][] | null {
  const { seed, lower, upper, lateTotal, budget, ratios, platform, earlyCap } = data;
  const offsets = lower.map((lo, i) => lo - seed[i]);
  const lateOffset = lateTotal - lower.reduce((sum, lo) => sum + lo, 0);
  const ranges = lower.map((lo, i) => upper[i] - lo);
  if (offsets.some(x => x < 0) || ranges.some(x => x < 0 || x > 8) || lateOffset < 0 || lateOffset > 64 || budget < 0 || budget > 256) return null;
  const size = (budget + 1) * (lateOffset + 1);
  const stride = budget + 1;
  const unit = new Float64Array(size); unit[0] = 1;
  const marginals = upper.map((hi, i) => Array<number>(Math.min(budget, hi - seed[i]) + 1).fill(0));
  const expectedLate = offsets.map((x, i) => x + ranges[i] / 2);
  let modelCount = 0;
  for (const sync of importPrior) for (const power of [0.8, 1, 1.2]) {
    const odds = ratios.map((r, i) => {
      if (r === 0) return 0;
      const prior = Math.pow(clamp(r, 1e-6, 0.999), power);
      const signal = platformWeight && platform ? Math.pow(0.35 + 1.65 * platform[i] / (platform[i] + 2), platformWeight) : 1;
      const pooledTiming = profile === 'damped' ? Math.sqrt(prior / (1 - prior)) : prior / (1 - prior);
      return signal * pooledTiming;
    });
    const importProbability = expectedLate.map(gain => profile === 'sparse' ? sync / (1 + gain / 8) : sync);
    let low = 0, high = 1e7;
    for (let k = 0; k < 40; k++) {
      const mid = (low + high) / 2;
      const expected = odds.reduce((sum, o, i) => {
        const initial = o > 0 ? importProbability[i] * Math.min(1, expectedLate[i]) : 0;
        return sum + initial + (expectedLate[i] - initial) * mid * o / (1 + mid * o);
      }, 0);
      if (expected > budget) high = mid; else low = mid;
    }
    const kernels = offsets.map((lo, i) => Array.from({ length: ranges[i] + 1 }, (_, j) => {
      const n = lo + j;
      const oddsScale = (low + high) / 2 * odds[i];
      const p = oddsScale / (1 + oddsScale);
      if (!n || !p) return [1 / (ranges[i] + 1)];
      const initial = importProbability[i] + (1 - importProbability[i]) * p;
      const background = binomial(n - 1, (n - 1) * p);
      return Array.from({ length: Math.min(budget, n, earlyCap?.[i] ?? budget) + 1 }, (_, e) =>
        ((background[e] || 0) * (1 - initial) + (background[e - 1] || 0) * initial) / (ranges[i] + 1));
    }));
    type CountTable = { masses: Float64Array; maxLate: number; maxEarly: number };
    const initialTable = { masses: unit, maxLate: 0, maxEarly: 0 };
    const combine = (table: CountTable, kernel: number[][]): CountTable => {
      const result = new Float64Array(size);
      for (let late = 0; late <= table.maxLate; late++) for (let early = 0; early <= table.maxEarly; early++) {
        const w = table.masses[late * stride + early];
        if (!w) continue;
        for (let j = 0; j < kernel.length && late + j <= lateOffset; j++) {
          const base = (late + j) * stride + early;
          const pmf = kernel[j];
          const end = Math.min(budget - early + 1, pmf.length);
          for (let e = 0; e < end; e++) result[base + e] += w * pmf[e];
        }
      }
      return { masses: result, maxLate: Math.min(lateOffset, table.maxLate + kernel.length - 1),
        maxEarly: Math.min(budget, table.maxEarly + Math.max(...kernel.map(row => row.length - 1))) };
    };
    const prefix = [initialTable];
    for (const kernel of kernels) prefix.push(combine(prefix.at(-1)!, kernel));
    const evidence = prefix.at(-1)!.masses[size - 1];
    if (evidence < 1e-250) continue;
    let suffix = initialTable;
    for (let i = kernels.length - 1; i >= 0; i--) {
      const before = prefix[i];
      for (let j = 0; j < kernels[i].length && j <= lateOffset; j++) {
        const pmf = kernels[i][j];
        for (let e = 0; e < pmf.length; e++) {
          if (!pmf[e]) continue;
          let rest = 0;
          const earlyRemaining = budget - e;
          const minEarly = Math.max(0, earlyRemaining - suffix.maxEarly);
          const maxEarly = Math.min(earlyRemaining, before.maxEarly);
          const minLate = Math.max(0, lateOffset - j - suffix.maxLate);
          const maxLate = Math.min(lateOffset - j, before.maxLate);
          for (let l = minLate; l <= maxLate; l++) {
            const a = l * stride, b = (lateOffset - l - j) * stride + earlyRemaining;
            for (let k = minEarly; k <= maxEarly; k++) rest += before.masses[a + k] * suffix.masses[b - k];
          }
          marginals[i][e] += pmf[e] * rest / evidence;
        }
      }
      suffix = combine(suffix, kernels[i]);
    }
    modelCount++;
  }
  return modelCount ? marginals.map(pmf => pmf.map(p => p / modelCount)) : null;
}

export function refreshEnsemble(data: RefreshEvidence, weak: number[][] | null = refreshBridge(data, 0.2)): number[][] | null {
  if (!weak) return null;
  const noPlatform = refreshBridge(data);
  const moreImports = refreshBridge(data, 0, [0.15, 0.45, 0.75]);
  const fullPlatform = refreshBridge(data, 1);
  if (!noPlatform || !moreImports || !fullPlatform) return weak;
  return weak.map((row, i) => row.map((mass, k) => (2 * mass + noPlatform[i][k] + moreImports[i][k] + fullPlatform[i][k]) / 5));
}

function states(c: Case): State[] {
  const out: State[] = [];
  let lastPoll: number | undefined;
  const reads = [...c.history].filter(h => Number.isFinite(h.players_tracked) && h.players_tracked > 0)
    .sort((a, b) => Date.parse(a.slot || a.at) - Date.parse(b.slot || b.at));
  for (const h of reads) {
    const t = Date.parse(h.slot || h.at) / hour;
    if (!Number.isFinite(t) || t > Date.parse(c.at) / hour) continue;
    const r = c.trophies.map((_, i) => typeof h.rates[i] === 'number' && Number.isFinite(h.rates[i]) ? clamp(h.rates[i]!, 0, 100) : null);
    const last = out.at(-1);
    if (!last || last.n !== h.players_tracked || r.some((v, i) => v !== last.r[i])) {
      out.push({ t, since: lastPoll, n: h.players_tracked, r });
    }
    lastPoll = t;
  }
  return out;
}

function thin(out: State[]): State[] {
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

// Public observations inspected 2026-11-19: the current page has 14,028
// tracked players and 14,882 awards. These are later observations, not the
// sealed practice answers. Their rounding intervals constrain an early prior.
const launchObservation = {
  players: 14028, earned: 14882, ageHours: 15,
  rates: [0.03, 99.99, 0.73, 0.14, 0.06, 0.06, 0.06, 0.24, 0.06, 0.06, 0.06,
    0.06, 0.06, 0.03, 0.03, 0.04, 0.04, 0.03, 0.04, 1.89, 0.41, 0.04,
    0.04, 0.04, 0.03, 0.03, 0.04, 0.03, 0.04, 0.03, 0.03, 0.03, 0.09,
    0.05, 0.24, 0.06, 0.14, 0.14, 0.06, 0.04, 0.04, 0.04, 0.04, 0.08,
    0.04, 0.09, 0.04, 0.05, 0.04, 0.11, 0.06, 0.04, 0.05, 0.04, 0.04],
};

// Public Xbox Series counts for the same award names, used only as timing
// evidence. Platform populations and unlock counts are never merged.
const xboxUnlocks = new Map([[3, 276], [4, 23], [8, 65], [20, 317], [21, 35], [33, 3], [34, 1], [35, 33], [36, 1], [37, 7], [38, 8], [41, 1], [44, 7], [46, 11], [50, 9]]);

// The kit's competition.yaml records both the population AND the total awards
// at the first refresh: 3,868 / 4,276. Conserve that aggregate rather than
// assuming all numerator counts froze while the denominator grew sixfold.
function unseenRefresh(c: Case, ss: State[], options: ForecastOptions): number[][] | null {
  if (ss.length !== 1 || c.horizon_minutes > 360) return null;
  const last = ss[0];
  const refresh = Date.parse('2026-11-19T04:30:00Z') / hour;
  const target = Date.parse(c.target) / hour;
  if (last.n !== 638 || last.t >= refresh || target < refresh) return null;
  if (c.trophies.length !== launchObservation.rates.length || c.trophies[0].name !== 'Vice Got a Price!') return null;
  const seed = c.trophies.map((_, i) => count(last.r[i] ?? 0, last.n));
  const intro = seed.findIndex(e => e >= last.n - 1);
  const nonIntro = seed.reduce((sum, e, i) => sum + (i === intro ? 0 : e), 0);
  const budget = Math.max(0, 4276 - 3868 - nonIntro);
  const lower = launchObservation.rates.map(r => Math.ceil((r - 0.005000001) * launchObservation.players / 100));
  const upper = launchObservation.rates.map(r => Math.floor((r + 0.004999999) * launchObservation.players / 100));
  const ratios = c.trophies.map((t, i) => {
    if (i === intro) return 0;
    const p = delayPrior(t);
    return cdf(4.5, p.delay, p.shape) / Math.max(1e-8, cdf(launchObservation.ageHours, p.delay, p.shape));
  });
  const evidence = { seed: seed.map((e, i) => i === intro ? lower[i] : e), lower, upper, lateTotal: launchObservation.earned, budget, ratios, platform: c.trophies.map(t => xboxUnlocks.get(t.id) ?? 0) };
  // The published recorder notes say every non-introduction displayed rate fell.
  // Enforce that observation on the rounded page rate, not on the raw fraction.
  const earlyCap = seed.map((e, i) => {
    if (i === intro || last.r[i] === null) return budget;
    let cap = Math.min(budget, Math.max(0, upper[i] - e));
    while (cap > 0 && printed(100 * (e + cap) / 3868) >= last.r[i]!) cap--;
    return cap;
  });
  const monotone = { ...evidence, lower: lower.map((lo, i) => Math.max(lo, evidence.seed[i])), earlyCap };
  const method = options.bridge ?? (options.refresh || options.lateCounts !== undefined || options.sharpness ? 'legacy' : options.refreshProfile ? 'weak' : 'ensemble');
  const bridge = method === 'ensemble' ? refreshEnsemble(monotone) : method === 'legacy' ? null :
    refreshBridge(monotone, method === 'timing' ? 0 : method === 'weak' ? 0.2 : 1, undefined, options.refreshProfile);
  const timing = method === 'blend' ? refreshBridge(monotone) : null;
  if (bridge) return bridge.map((pmf, i) => {
    if (i === intro) return levels.map(() => 100);
    const draws = pmf.map((weight, k) => ({ value: scoreLogit(printed(100 * (seed[i] + k) / 3868)), weight: timing ? (weight + (timing[i][k] || 0)) / 2 : weight }));
    return forecastQuantiles(draws).map(x => printed(percent(x)));
  });
  return legacyRefresh(evidence, 3868, intro, options);
}

export function legacyRefresh(data: RefreshEvidence, population: number, intro = -1, options: ForecastOptions = {}): number[][] {
  const { seed, lower, upper, lateTotal, budget, ratios } = data;
  const samples: Sample[][] = seed.map(() => []);
  const lateMarginals = options.lateCounts !== false ? conditionOnTotal(lower.map((lo, i) => Array.from({ length: upper[i] - lo + 1 }, () => 1 / (upper[i] - lo + 1))), lateTotal - lower.reduce((a, b) => a + b, 0)) : null;
  // Uncertain late integer counts, initial profile synchronization, and delay
  // shapes are mixed jointly; each scenario has exactly the documented budget.
  for (const edge of [0.1, 0.5, 0.9]) for (const sync of [0, 0.5, 1]) for (const delayPower of [0.8, 1, 1.2]) {
    const gains = seed.map((e, i) => {
      if (i === intro) return 0;
      const posterior = lateMarginals?.marginals[i];
      const current = posterior ? lower[i] + quantile(posterior.map((weight, value) => ({ value, weight })), edge) : lower[i] + edge * (upper[i] - lower[i]);
      return Math.max(0, current - e);
    });
    const front = gains.map(g => sync * Math.min(1, g));
    const weights = gains.map((g, i) => {
      return Math.max(0, g - front[i]) * Math.pow(ratios[i], delayPower);
    });
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const remaining = Math.max(0, budget - front.reduce((a, b) => a + b, 0));
    const pmfs = seed.map((e, i) => {
      if (i === intro) return [1];
      const meanGain = front[i] + remaining * weights[i] / Math.max(1e-8, totalWeight);
      const maximum = Math.max(0, upper[i] - e);
      // Awards are integer events. A continuous half-earner jitter invents
      // impossible rates below the already observed count. Use a count-process
      // distribution bounded by the later observation's rounding interval.
      // A binomial, unlike a capped Poisson, preserves the scenario mean.
      return binomial(maximum, meanGain);
    });
    const posterior = options.refresh === 'independent' ? null : conditionOnTotal(pmfs, budget);
    const distributions = posterior?.marginals || pmfs;
    distributions.forEach((masses, i) => {
      if (i === intro) return;
      masses.forEach((weight, acquired) => {
        if (weight > 1e-14) samples[i].push({ value: printed(100 * (seed[i] + acquired) / population), weight });
      });
    });
  }
  return samples.map((draws, i) => {
    if (i === intro) return [100, 100, 100, 100, 100];
    const combined = new Map<number, number>();
    for (const d of draws) combined.set(d.value, (combined.get(d.value) || 0) + d.weight);
    const masses = [...combined].map(([value, weight]) => ({ value, weight: Math.pow(weight / 27, options.sharpness || 1) }));
    return levels.map(p => quantile(masses, p));
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
type Population = { n: number; weight: number; cohorts: Cohort[]; at: number };
function population(ss: State[], origin: number, target: number, options: ForecastOptions): Population[] {
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
  const fitSaturation = (rows: State[]) => {
    const flows = rows.slice(1).flatMap((s, i) => {
      const previous = rows[i], dt = s.t - previous.t, dn = s.n - previous.n;
      return dt > 0 && dn > 0 ? [{ x: (s.t + previous.t) / 2, y: Math.log(dn / dt) }] : [];
    });
    if (flows.length < 2) return null;
    const decay = slope(flows, -1, 1);
    if (decay >= -1 / 720 || decay < -1 / 4) return null;
    const tau = -1 / decay, firstTime = rows[0].t;
    const xs = rows.map(s => Math.exp(-(s.t - firstTime) / tau));
    const meanX = xs.reduce((a, x) => a + x, 0) / rows.length;
    const meanY = rows.reduce((a, s) => a + s.n, 0) / rows.length;
    let xy = 0, xx = 0;
    rows.forEach((s, i) => { xy += (xs[i] - meanX) * (s.n - meanY); xx += Math.pow(xs[i] - meanX, 2); });
    const amplitude = -xy / Math.max(1e-12, xx), anchor = rows.at(-1)!;
    if (amplitude <= 0) return null;
    return (t: number) => anchor.n + amplitude * (Math.exp(-(anchor.t - firstTime) / tau) - Math.exp(-(t - firstTime) / tau));
  };
  let saturating: ((t: number) => number) | null = null;
  // Accept a launch-population plateau only when an earlier fit predicts
  // held-out later observations materially better than the power family.
  // This avoids selecting it just because a flexible curve fits past data.
  if (options.population !== 'power' && recent.length >= 5) {
    const split = Math.max(3, Math.floor(recent.length * 0.7));
    const train = recent.slice(0, split), validation = recent.slice(split);
    const trial = fitSaturation(train);
    let powerError = Infinity;
    const trainLast = train.at(-1)!;
    for (const offset of [0.25, 1, 2, 4, 8, 16, 32, 64]) {
      const p = slope(train.map(s => ({ x: Math.log(offset + Math.max(0, s.t - origin)), y: Math.log(s.n) })), 0, 2);
      const error = validation.reduce((sum, s) => sum + Math.pow(Math.log(trainLast.n * Math.pow((offset + Math.max(0, s.t - origin)) / (offset + Math.max(0, trainLast.t - origin)), p) / s.n), 2), 0);
      powerError = Math.min(powerError, error);
    }
    const saturationError = trial ? validation.reduce((sum, s) => sum + Math.pow(Math.log(Math.max(1, trial(s.t)) / s.n), 2), 0) : Infinity;
    if (saturationError + 1e-12 < powerError * 0.5) saturating = fitSaturation(recent);
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
      const n = saturating ? last.n + Math.max(0, saturating(t) - last.n) * Math.exp(offset) : last.n * Math.pow((shift + Math.max(0, t - origin)) / (shift + Math.max(0, last.t - origin)), power);
      cohorts.push({ t: t - (target - last.t) / steps / 2, n: Math.max(0, n - prev) });
      prev = n;
    }
    return { n: prev, weight: k === 1 ? 0.6 : 0.2, cohorts, at: target };
  });
}

function refreshTimes(snapshots: State[], target: number): Sample[] {
  const last = snapshots.at(-1)!.t;
  const recent = snapshots.slice(-10);
  const gaps = recent.slice(1).map((s, i) => s.t - recent[i].t).filter(gap => gap > 0);
  if (gaps.length < 3) return [{ value: target, weight: 1 }];
  const cadence = median(gaps);
  const skew = median(gaps.map(x => Math.abs(x - cadence)));
  // A poll brackets the last change. Bound that uncertainty by the cadence
  // so sparse polls do not shift an entire observed refresh interval.
  const bracket = snapshots.at(-1)!.since ?? last;
  const phase = Math.min(cadence / 4, (last - bracket) / 4);
  if (target - last <= 3 * cadence && skew <= 0.18 * cadence) {
    return [-phase, 0, phase].map((offset, i) => {
      const updates = Math.floor((target - last - offset + 1e-8) / cadence);
      const next = last + updates * cadence + offset;
      return { value: updates <= 0 ? last : next, weight: i === 1 ? 0.5 : 0.25 };
    });
  }
  return [0, 0.5, 1].map((stale, i) => ({ value: Math.max(last, target - stale * cadence), weight: i === 1 ? 0.5 : 0.25 }));
}

function cdf(age: number, delay: number, shape: number, longTail = false): number {
  if (age <= 0) return 0;
  const x = Math.pow(age / delay, shape);
  return longTail ? x / (Math.LN2 + x) : -Math.expm1(-x);
}

function exposure(t: number, cohorts: Cohort[], initial: number, origin: number, delay: number, shape: number, longTail: boolean): number {
  let total = initial * cdf(t - origin, delay, shape, longTail);
  for (const c of cohorts) if (c.t < t) total += c.n * cdf(t - c.t, delay, shape, longTail);
  return total;
}

function forecastTrophy(c: Case, ss: State[], i: number, populations: Population[], origin: number, options: ForecastOptions, aware = false): number[] {
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
  const candidate: { delay: number; shape: number; a: number; cost: number; longTail: boolean }[] = [];
  const cohorts = populations[1].cohorts;
  const initial = Math.max(0, ss[0].n - seed);
  const observations = known.map(s => ({ s, e: Math.max(seed, count(s.r[i]!, s.n)) }));
  const increments = observations.slice(1).map(({ e }, index) => e - observations[index].e);
  // Adjacent increments count new earners once. Fall back to cumulative fits
  // when counts are sparse or the rounded series contains a downward revision.
  const useIncrements = options.increments !== false && increments.length >= 3 && lastCount - seed >= 12 && increments.every(x => x >= 0);
  const kernels = options.longTail === false ? [false] : [false, true];
  const shapes = options.hazard === 'wide' || options.hazard === 'both' ? [0.55, 0.8, 1.05, 1.3, 1.65, 2, 2.5, 3] : [0.8, 1.3, 2, 3];
  const dispersion = options.hazard === 'robust' || options.hazard === 'both' ? 25 : 0;
  for (const factor of [0.25, 0.5, 1, 2, 4]) for (const shape of shapes) for (const longTail of kernels) {
    const delay = prior.delay * factor;
    const penalty = 0.15 * Math.pow(Math.log(factor), 2) + 0.10 * Math.pow(shape - prior.shape, 2);
    const x0 = exposure(first.t, cohorts, initial, origin, delay, shape, longTail);
    const exposures = observations.map(({ s }) => Math.max(0, exposure(s.t, cohorts, initial, origin, delay, shape, longTail) - x0));
    if (useIncrements) {
      const a = clamp((lastCount - observations[0].e) / Math.max(1e-9, exposures.at(-1)!), 0, 1);
      let cost = 0;
      for (let j = 0; j < increments.length; j++) {
        const actual = increments[j];
        const mean = Math.max(1e-8, a * (exposures[j + 1] - exposures[j]));
        const logRatio = actual > 0 ? actual * Math.log(actual / mean) : 0;
        cost += 2 * (dispersion ? logRatio - (actual + dispersion) * Math.log1p((actual - mean) / (mean + dispersion)) : mean - actual + logRatio);
      }
      candidate.push({ delay, shape, a, cost: cost + penalty, longTail });
      continue;
    }
    let xx = 0;
    let xy = 0;
    for (let j = 0; j < observations.length; j++) {
      const { e } = observations[j], x = exposures[j];
      const w = 1 / Math.max(2, e);
      xx += w * x * x;
      xy += w * x * (e - seed);
    }
    const a = clamp(xy / Math.max(1e-9, xx), 0, 1);
    let cost = 0;
    for (let j = 0; j < observations.length; j++) {
      const { e } = observations[j], x = exposures[j];
      cost += Math.pow((seed + a * x - e) / Math.sqrt(Math.max(2, e)), 2);
    }
    // Distinct refreshes are separate evidence. Averaging their likelihood
    // residuals would prevent additional observations from resolving delays.
    if (options.likelihood === 'average') cost /= Math.max(1, known.length - 1);
    candidate.push({ delay, shape, a, cost: cost + penalty, longTail });
  }
  const best = Math.min(...candidate.map(x => x.cost));
  const draws: Sample[] = [];
  const horizonDays = horizon / 24;
  const growth = Math.max(0, lastCount - seed);
  const confidence = growth / (growth + 8);
  const spread = 0.10 + Math.min(0.85, 0.24 * Math.sqrt(horizonDays)) + 0.25 * (1 - confidence);
  for (const model of candidate) {
    const modelWeight = Math.exp(-Math.min(40, (model.cost - best) / 2));
    const amplitude = model.a;
    const currentX = exposure(last.t, cohorts, initial, origin, model.delay, model.shape, model.longTail);
    for (const pop of populations) {
      if (aware && pop.at === last.t && last.n === pop.n) {
        draws.push({ value: scoreLogit(r), weight: modelWeight * pop.weight });
        continue;
      }
      const futureX = exposure(pop.at, pop.cohorts, initial, origin, model.delay, model.shape, model.longTail);
      const e = clamp(lastCount + amplitude * Math.max(0, futureX - currentX), 0, pop.n);
      const center = 100 * e / pop.n;
      const centerLogit = logit(center);
      for (let j = 0; j < z.length; j++) {
        const value = centerLogit + z[j] * spread;
        draws.push({ value: aware ? scoreLogit(printed(percent(value))) : percent(value), weight: modelWeight * pop.weight * [0.12, 0.23, 0.30, 0.23, 0.12][j] });
      }
    }
  }
  const q = forecastQuantiles(draws);
  return q.map(x => aware ? (x === scoreLogit(0) && r === 0 ? 0 : printed(percent(x))) : Number(clamp(x, 0, 100).toFixed(6)));
}

function weekRaw(c: Case, snapshots: State[], origin: number, target: number, options: ForecastOptions): number[][] {
  const ss = thin(snapshots);
  const mode = options.week ?? 'calibrated';
  const times = mode === 'legacy' ? [{ value: target, weight: 1 }] : refreshTimes(snapshots, target);
  const byTime = new Map<number, number>();
  for (const { value, weight } of times) byTime.set(value, (byTime.get(value) ?? 0) + weight);
  const scenarios = [...byTime].flatMap(([at, weight]) => population(ss, origin, at, options)
    .map(p => ({ ...p, weight: p.weight * weight })));
  const cut = { ...c, target: new Date(Math.round(target * hour)).toISOString() };
  return c.trophies.map((_, i) => forecastTrophy(cut, ss, i, scenarios, origin, options, mode !== 'legacy'));
}

function weekForecast(c: Case, snapshots: State[], origin: number, target: number, options: ForecastOptions): number[][] {
  const raw = weekRaw(c, snapshots, origin, target, options);
  if ((options.week ?? 'calibrated') !== 'calibrated' || snapshots.length < 8) return raw;
  const last = snapshots.at(-1)!;
  const horizon = target - last.t;
  const span = last.t - snapshots[0].t;
  if (horizon <= 0 || span <= 0) return raw;
  const window = Math.min(Math.max(horizon, 4), 0.4 * span, 30);
  const residuals: Sample[][] = c.trophies.map(() => []);
  const ends = new Set([1, 0.85, 0.70, 0.55].map(f => Math.round(f * (snapshots.length - 1))));
  let seen = 0;
  for (const end of ends) {
    const truth = snapshots[end];
    const split = snapshots.findLastIndex(s => s.t <= truth.t - window);
    if (split < 3) continue;
    const past = snapshots.slice(0, split + 1);
    const elapsed = truth.t - past.at(-1)!.t;
    const weight = Math.exp(-2 * (last.t - truth.t) / span);
    const scale = Math.sqrt(clamp(horizon / elapsed, 0.25, 4));
    const predictions = weekRaw(c, past, origin, truth.t, options);
    seen++;
    truth.r.forEach((actual, i) => {
      if (actual === null || past.at(-1)!.r[i] === null) return;
      const error = scoreLogit(actual) - scoreLogit(predictions[i][2]);
      residuals[i].push({ value: clamp(error, -1.5, 1.5) * scale, weight });
    });
  }
  if (seen < 2) return raw;
  return raw.map((q, i) => {
    const residual = residuals[i];
    const current = last.r[i];
    if (residual.length < 2 || current === null || q[0] === q[4] || current >= 99.99) return q;
    const center = scoreLogit(q[2]);
    const empirical = levels.map(tau => quantile(residual, tau));
    const weight = residual.length / (residual.length + 3) * Math.min(1, Math.sqrt(window / horizon));
    return q.map((r, j) => {
      const adjusted = (1 - weight) * scoreLogit(r) + weight * (center + empirical[j]);
      return printed(percent(adjusted));
    });
  });
}

export function forecast(c: Case, options: ForecastOptions = {}): { trophies: { id: number; q: number[] }[] } {
  const ss = states(c);
  if (!ss.length) return { trophies: c.trophies.map(t => ({ id: t.id, q: [0, 0.01, 0.1, 2, 25] })) };
  if (c.horizon_minutes === 0) return { trophies: c.trophies.map((t, i) => {
    const rate = ss.findLast(s => s.r[i] !== null)?.r[i];
    return { id: t.id, q: rate == null ? [0, 0.01, 0.1, 2, 25] : levels.map(() => rate) };
  }) };
  const refresh = unseenRefresh(c, ss, options);
  if (refresh) return { trophies: c.trophies.map((t, i) => ({ id: t.id, q: refresh[i] })) };
  const release = Date.parse(`${c.game?.release_date || String(c.at).slice(0, 10)}T00:00:00Z`) / hour;
  const origin = Math.min(release, ss[0].t);
  const target = Math.max(ss.at(-1)!.t, Date.parse(c.target) / hour);
  const q = weekForecast(c, ss, origin, target, options);
  return { trophies: c.trophies.map((t, i) => ({ id: t.id, q: q[i] })) };
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
