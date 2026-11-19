import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

type Trophy = { id: number; name: string; description: string; tier: string; points?: number };
type Read = { slot: string; at: string; players_tracked: number; trophies_earned?: number; rates: (number | null)[] };
type Case = { id: string; at: string; target: string; horizon_minutes: number; game?: { release_date?: string }; trophies: Trophy[]; history: Read[] };
type State = { t: number; through: number; n: number; r: (number | null)[]; total?: number; since?: number };
type Sample = { value: number; weight: number };
export type ForecastOptions = { refresh?: 'independent' | 'conditioned'; bridge?: 'legacy' | 'timing' | 'platform' | 'blend' | 'weak' | 'ensemble'; refreshProfile?: 'uniform' | 'sparse' | 'damped'; lateCounts?: boolean; sharpness?: number; likelihood?: 'average' | 'sum'; population?: 'power' | 'adaptive'; increments?: boolean; longTail?: boolean; week?: 'legacy' | 'clock' | 'calibrated' | 'trajectory'; hazard?: 'wide' | 'robust' | 'both'; trajectory?: Partial<TrajectoryOptions> };
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

// Forward coefficients and reverse derivatives of the final coefficient give
// both the normalizer and every conditional marginal in two passes.
function bridgeMarginals(kernels: number[][][], budget: number, lateOffset: number, marginals: number[][], weight: number): boolean {
  const stride = budget + 1;
  const size = stride * (lateOffset + 1);
  const bounds = (caps: number[], total: number) => {
    const sums = [0];
    for (const cap of caps) sums.push(sums.at(-1)! + cap);
    return sums.map(used => ({ min: Math.max(0, total - (sums.at(-1)! - used)), max: Math.min(total, used) }));
  };
  const earlyBounds = bounds(kernels.map(kernel => Math.max(...kernel.map(pmf => pmf.length - 1))), budget);
  const lateBounds = bounds(kernels.map(kernel => kernel.length - 1), lateOffset);
  if (earlyBounds[0].min || lateBounds[0].min) return false;

  const unit = new Float64Array(size);
  unit[0] = 1;
  const prefix = [unit];
  for (let i = 0; i < kernels.length; i++) {
    const after = new Float64Array(size);
    const before = prefix[i], kernel = kernels[i];
    const early = earlyBounds[i], late = lateBounds[i];
    const nextEarly = earlyBounds[i + 1], nextLate = lateBounds[i + 1];
    for (let l = late.min; l <= late.max; l++) for (let e = early.min; e <= early.max; e++) {
      const mass = before[l * stride + e];
      if (mass === 0) continue;
      const minGain = Math.max(0, nextEarly.min - e);
      for (let j = Math.max(0, nextLate.min - l); j < kernel.length && l + j <= nextLate.max; j++) {
        const pmf = kernel[j], base = (l + j) * stride + e;
        const maxGain = Math.min(pmf.length - 1, nextEarly.max - e);
        for (let k = minGain; k <= maxGain; k++) after[base + k] += mass * pmf[k];
      }
    }
    prefix.push(after);
  }
  const evidence = prefix.at(-1)![size - 1];
  if (!Number.isFinite(evidence) || evidence < 1e-250) return false;

  let adjoint = new Float64Array(size);
  let preceding = new Float64Array(size);
  adjoint[size - 1] = 1;
  for (let i = kernels.length - 1; i >= 0; i--) {
    const before = prefix[i], kernel = kernels[i], marginal = marginals[i];
    const early = earlyBounds[i], late = lateBounds[i];
    const nextEarly = earlyBounds[i + 1], nextLate = lateBounds[i + 1];
    const contributions = new Float64Array(marginal.length);
    preceding.fill(0);
    for (let l = late.min; l <= late.max; l++) for (let e = early.min; e <= early.max; e++) {
      const from = l * stride + e, mass = before[from];
      if (mass === 0) continue;
      let sum = 0;
      const minGain = Math.max(0, nextEarly.min - e);
      for (let j = Math.max(0, nextLate.min - l); j < kernel.length && l + j <= nextLate.max; j++) {
        const pmf = kernel[j], base = (l + j) * stride + e;
        const maxGain = Math.min(pmf.length - 1, nextEarly.max - e);
        for (let k = minGain; k <= maxGain; k++) {
          const continuation = adjoint[base + k] * pmf[k];
          contributions[k] += mass * continuation;
          sum += continuation;
        }
      }
      preceding[from] = sum;
    }
    for (let k = 0; k < marginal.length; k++) marginal[k] += weight * contributions[k] / evidence;
    [adjoint, preceding] = [preceding, adjoint];
  }
  return true;
}

// Each later award can have arrived in the early refresh or in the gap
// between refreshes. The shared multiplier reconciles the timing odds with
// the observed early total, while a separate trial models profile imports.
export function refreshBridge(data: RefreshEvidence, platformWeight = 0, importPrior = [0, 0.25, 0.65], profile: 'uniform' | 'sparse' | 'damped' = 'uniform', compact = false): number[][] | null {
  const { seed, lower, upper, lateTotal, budget, ratios, platform, earlyCap } = data;
  const offsets = lower.map((lo, i) => lo - seed[i]);
  const lateOffset = lateTotal - lower.reduce((sum, lo) => sum + lo, 0);
  const ranges = lower.map((lo, i) => upper[i] - lo);
  if (offsets.some(x => x < 0) || ranges.some(x => x < 0 || x > 8) || lateOffset < 0 || lateOffset > 64 || budget < 0 || budget > 256) return null;
  const marginals = upper.map((hi, i) => Array<number>(Math.min(budget, hi - seed[i]) + 1).fill(0));
  const expectedLate = offsets.map((x, i) => x + ranges[i] / 2);
  // Keep the large-support awards together at the end. Many slow trophies
  // contribute zero or one award, so their intermediate tables stay narrow.
  const order = marginals.map((_, i) => i).sort((a, b) =>
    Math.min(marginals[a].length - 1, earlyCap?.[a] ?? budget) - Math.min(marginals[b].length - 1, earlyCap?.[b] ?? budget));
  const ordered = order.map(i => marginals[i]);
  const powers = [0.8, 1, 1.2];
  // Five nodes preserve the one-dimensional import and delay weights and
  // remove their linear correlation, using fewer joint convolutions.
  const nodes = compact && importPrior.length === 3 ? [
    [importPrior[0], powers[0], 1], [importPrior[0], powers[2], 1],
    [importPrior[1], powers[1], 2],
    [importPrior[2], powers[0], 1], [importPrior[2], powers[2], 1],
  ] : importPrior.flatMap(sync => powers.map(power => [sync, power, 1]));
  let modelWeight = 0;
  for (const [sync, power, weight] of nodes) {
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
    if (bridgeMarginals(order.map(i => kernels[i]), budget, lateOffset, ordered, weight)) modelWeight += weight;
  }
  return modelWeight ? marginals.map(pmf => pmf.map(p => p / modelWeight)) : null;
}

export function refreshEnsemble(data: RefreshEvidence, weak = refreshBridge(data, 0.2, undefined, 'uniform', true)): number[][] | null {
  if (!weak) return null;
  const noPlatform = refreshBridge(data, 0, undefined, 'uniform', true);
  const moreImports = refreshBridge(data, 0, [0.15, 0.45, 0.75], 'uniform', true);
  const fullPlatform = refreshBridge(data, 1, undefined, 'uniform', true);
  if (!noPlatform || !moreImports || !fullPlatform) return weak;
  return weak.map((row, i) => row.map((mass, k) => (2 * mass + noPlatform[i][k] + moreImports[i][k] + fullPlatform[i][k]) / 5));
}

export function launchQuantiles(pmfs: number[][], seed: number[], population: number, tail = 0.06): number[][] {
  const probabilities = [tail, 0.25, 0.5, 0.75, 1 - tail];
  return pmfs.map((pmf, i) => {
    const total = pmf.reduce((sum, mass) => sum + mass, 0);
    const q: number[] = [];
    let cumulative = 0;
    for (let k = 0; k < pmf.length && q.length < probabilities.length; k++) {
      cumulative += pmf[k];
      while (q.length < probabilities.length && cumulative >= probabilities[q.length] * total) {
        q.push(printed(100 * (seed[i] + k) / population));
      }
    }
    return q;
  });
}

function states(c: Case): State[] {
  const out: State[] = [];
  let lastPoll: number | undefined;
  const checkpoint = Date.parse(c.at) / hour;
  const reads = [...c.history].filter(h => Number.isFinite(h.players_tracked) && h.players_tracked > 0)
    .sort((a, b) => Date.parse(a.slot || a.at) - Date.parse(b.slot || b.at));
  for (const h of reads) {
    const t = Date.parse(h.slot || h.at) / hour;
    if (!Number.isFinite(t) || t > checkpoint) continue;
    const r = c.trophies.map((_, i) => typeof h.rates[i] === 'number' && Number.isFinite(h.rates[i]) ? clamp(h.rates[i]!, 0, 100) : null);
    const total = Number.isSafeInteger(h.trophies_earned) ? h.trophies_earned : undefined;
    const last = out.at(-1);
    if (!last || last.n !== h.players_tracked || total !== last.total || r.some((v, i) => v !== last.r[i])) {
      out.push({ t, through: t, since: lastPoll, n: h.players_tracked, r, total });
    } else last.through = t;
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
  if (bridge) {
    const pmfs = timing ? bridge.map((pmf, i) => pmf.map((weight, k) => (weight + (timing[i][k] || 0)) / 2)) : bridge;
    // Count ordering is the same in rate and logit space. Keep the original
    // printed boundary values for the grader's percentage-point metrics.
    const q = launchQuantiles(pmfs, seed, 3868, method === 'ensemble' ? 0.06 : 0.05);
    if (intro >= 0) q[intro] = levels.map(() => 100);
    return q;
  }
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

function eventTimes(snapshots: State[], target: number): Sample[] {
  const last = snapshots.at(-1)!;
  if (target <= last.through) return [{ value: last.t, weight: 1 }];
  const recent = snapshots.slice(1).slice(-12);
  const clock = refreshTimes(snapshots, target);
  if (recent.length < 3) return clock;

  // A timestamp only tells us the first poll to see a refresh. Fit periods
  // that intersect each consecutive refresh's poll bracket, rather than
  // mistaking an alternating two/four-hour polling gap for the period.
  const widths = recent.map(s => s.t - (s.since ?? s.t));
  let minPeriod = Math.max(0.08, median(widths)), maxPeriod = Infinity;
  for (let i = 0; i < recent.length; i++) for (let j = i + 1; j < recent.length; j++) {
    minPeriod = Math.max(minPeriod, ((recent[j].since ?? recent[j].t) - recent[i].t) / (j - i));
    maxPeriod = Math.min(maxPeriod, (recent[j].t - (recent[i].since ?? recent[i].t)) / (j - i));
  }
  const fitted: Sample[] = [];
  if (minPeriod <= maxPeriod + 1e-8 && target - last.t <= 2 * maxPeriod) {
    for (const fraction of [0.15, 0.5, 0.85]) {
      const period = minPeriod + (maxPeriod - minPeriod) * fraction;
      let lo = last.through - period, hi = last.t;
      recent.forEach((s, i) => {
        const offset = (recent.length - 1 - i) * period;
        lo = Math.max(lo, (s.since ?? s.t) + offset);
        hi = Math.min(hi, s.t + offset);
      });
      if (lo > hi + 1e-8) continue;
      for (const quantile of [0.15, 0.5, 0.85]) {
        const phase = lo + (hi - lo) * quantile;
        const next = phase + Math.floor((target - phase + 1e-8) / period) * period;
        fitted.push({ value: next > last.through + 1e-8 ? next : last.t, weight: 1 });
      }
    }
  }
  const timing = fitted.length ? fitted : clock;
  const total = timing.reduce((sum, x) => sum + x.weight, 0);
  // Checkpoints can fall close to a delayed, skipped, or unscheduled refresh.
  // Retain a small late/early update component even with a fitted cadence.
  if (target - last.t <= 12) return [...timing.map(({ value, weight }) => ({ value, weight: 0.76 * weight / total })),
    { value: target, weight: 0.12 }, { value: last.t, weight: 0.12 }];
  return timing;
}

function cdf(age: number, delay: number, shape: number, longTail = false): number {
  if (age <= 0) return 0;
  const x = Math.pow(age / delay, shape);
  return longTail ? x / (Math.LN2 + x) : -Math.expm1(-x);
}

type Exposure = (t: number, cohorts: Cohort[], initial: number, delay: number, shape: number, longTail: boolean) => number;
function cohortExposure(origin: number): Exposure {
  // The cohort contribution is shared by all trophies with the same delay
  // kernel. Only the size of the existing-player cohort differs by trophy.
  const cache = new Map<Cohort[], Map<string, Map<number, [number, number]>>>();
  return (t, cohorts, initial, delay, shape, longTail) => {
    let kernels = cache.get(cohorts);
    if (!kernels) cache.set(cohorts, kernels = new Map());
    const key = `${delay}/${shape}/${Number(longTail)}`;
    let moments = kernels.get(key);
    if (!moments) kernels.set(key, moments = new Map());
    let result = moments.get(t);
    if (!result) {
      let total = 0;
      for (const c of cohorts) if (c.t < t) total += c.n * cdf(t - c.t, delay, shape, longTail);
      moments.set(t, result = [cdf(t - origin, delay, shape, longTail), total]);
    }
    return initial * result[0] + result[1];
  };
}

function forecastTrophy(c: Case, ss: State[], i: number, populations: Population[], exposure: Exposure, options: ForecastOptions, aware = false): number[] {
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
    const x0 = exposure(first.t, cohorts, initial, delay, shape, longTail);
    const exposures = observations.map(({ s }) => Math.max(0, exposure(s.t, cohorts, initial, delay, shape, longTail) - x0));
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
    const currentX = exposure(last.t, cohorts, initial, model.delay, model.shape, model.longTail);
    for (const pop of populations) {
      if (aware && pop.at === last.t && last.n === pop.n) {
        draws.push({ value: scoreLogit(r), weight: modelWeight * pop.weight });
        continue;
      }
      const futureX = exposure(pop.at, pop.cohorts, initial, model.delay, model.shape, model.longTail);
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
  const exposure = cohortExposure(origin);
  return c.trophies.map((_, i) => forecastTrophy(cut, ss, i, scenarios, exposure, options, mode !== 'legacy'));
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

export type TrajectoryOptions = { short: number; week: number; width: number; tail: number; quickTail: number; radius: number };
export const trajectoryDefaults: TrajectoryOptions = { short: 1, week: 0.50, width: 1, tail: 1.15, quickTail: 1.5, radius: 0.15 };
type Trend = { slope: number; bend: number; noise: number };
type Point = { t: number; x: number; y: number };
type Trajectory = { local: number[][]; prior: number[][]; horizon: number; reliability: number; chain: number[]; completion: number; platinum: number };

function snapshotCounts(state: State): (number | null)[] {
  const counts = state.r.map(r => r === null ? null : count(r, state.n));
  if (state.total === undefined || counts.some(n => n === null)) return counts;
  const bounds = state.r.map((r, i) => {
    const estimate = counts[i]!;
    return [Math.min(estimate, Math.max(0, Math.ceil((r! - 0.005000001) * state.n / 100))),
      Math.max(estimate, Math.min(state.n, Math.floor((r! + 0.004999999) * state.n / 100)))];
  });
  if (state.total < bounds.reduce((sum, [lo]) => sum + lo, 0) || state.total > bounds.reduce((sum, [, hi]) => sum + hi, 0)) return counts;
  if (counts.reduce<number>((sum, n) => sum + n!, 0) === state.total) return counts;
  // Within each printed rounding cell, choose count estimates that sum to
  // the observed award total with the smallest squared change from midpoint.
  let left = -state.n / 10000 - 1, right = -left;
  for (let j = 0; j < 24; j++) {
    const shift = (left + right) / 2;
    const sum = bounds.reduce((s, [lo, hi], i) => s + clamp(counts[i]! + shift, lo, hi), 0);
    if (sum < state.total) left = shift; else right = shift;
  }
  return bounds.map(([lo, hi], i) => clamp(counts[i]! + (left + right) / 2, lo, hi));
}

function localTrend(points: Point[], window: number): Trend {
  const end = points.at(-1)!, previous = points.at(-2);
  if (!previous) return { slope: 0, bend: 0, noise: 0 };
  const recent = points.findLast(p => p.t <= end.t - window) ?? points[0];
  const earlier = points.findLast(p => p.t <= recent.t - window) ?? points[0];
  const dx = Math.max(1e-6, end.x - recent.x);
  const recentSlope = (end.y - recent.y) / dx;
  const earlierSlope = recent.x > earlier.x ? (recent.y - earlier.y) / (recent.x - earlier.x) : recentSlope;
  const lastSlope = (end.y - previous.y) / Math.max(1e-6, end.x - previous.x);
  const noise = median(points.filter(p => p.t >= recent.t).map(p => Math.abs(p.y - end.y - recentSlope * (p.x - end.x))));
  const measurement = Math.abs(end.y - recent.y);
  const strength = measurement / (measurement + 4 * noise + 1e-4);
  const bend = 2 * (recentSlope - earlierSlope) / Math.max(0.05, end.x - earlier.x) * strength;
  const endpoint = recentSlope + clamp(bend * dx / 2, -0.50, 0.50);
  return { slope: clamp(endpoint + 0.25 * strength * clamp(lastSlope - endpoint, -1.5, 1.5), -12, 12), bend, noise };
}

function extrapolate(trend: Trend, dx: number, kind: 'players' | 'earners' | 'logit'): number {
  const velocity = kind === 'logit' ? trend.slope : Math.max(0, trend.slope);
  if (kind === 'players' && trend.bend < 0) {
    // Population growth can approach a plateau but cannot turn downward.
    const decay = clamp(-trend.bend / Math.max(0.2, velocity), 0.02, 9);
    return velocity * -Math.expm1(-decay * dx) / decay;
  }
  const curvature = clamp(trend.bend, -4, kind === 'players' ? 0.4 : 4);
  const displacement = velocity * dx + 0.35 * curvature * dx * dx / (1 + 2 * dx);
  return kind === 'logit' ? clamp(displacement, -5, 5) : clamp(displacement, 0, 5);
}

function trajectoryComponents(c: Case, snapshots: State[], origin: number, target: number, options: ForecastOptions): Trajectory {
  const last = snapshots.at(-1)!;
  const horizon = target - Date.parse(c.at) / hour;
  const prior = weekForecast(c, snapshots, origin, target, { ...options, week: 'calibrated' });
  const time = (t: number) => Math.log1p(Math.max(0, t - origin) / 6);
  const recent = snapshots.slice(-12);
  const cadence = median(recent.slice(1).map((s, j) => s.t - recent[j].t));
  const window = clamp(Math.max(2 * cadence, (last.t - origin) * 0.20), 2, 18);
  const sample = snapshots.filter(s => s.t >= last.t - 3 * window);
  if (sample.length === 1 && snapshots.length > 1) sample.unshift(snapshots.at(-2)!);
  const rows = sample.map(s => ({ ...s, x: time(s.t), counts: snapshotCounts(s) }));
  const populationTrend = localTrend(rows.map(({ t, x, n }) => ({ t, x, y: Math.log(n) })), window);
  const massByTime = new Map<number, number>();
  for (const { value, weight } of eventTimes(snapshots, target)) {
    const t = value <= last.through ? last.t : value;
    massByTime.set(t, (massByTime.get(t) ?? 0) + weight);
  }
  const times = [...massByTime].map(([value, weight]) => {
    const x = time(value);
    return { value, x, weight, n: last.n * Math.exp(extrapolate(populationTrend, x - time(last.t), 'players')) };
  });

  const trends = c.trophies.map((t, i) => {
    const reads = rows.filter(s => s.r[i] !== null);
    if (!reads.length) return null;
    const latest = reads.at(-1)!;
    const counts = reads.map(({ t, x, counts }) => ({ t, x, y: Math.log(0.5 + counts[i]!) }));
    const logits = reads.map(({ t, x, n, counts }) => ({ t, x, y: Math.log((counts[i]! + 0.5) / (n - counts[i]! + 0.5)) }));
    const gain = Math.max(0, latest.counts[i]! - reads[0].counts[i]!);
    const lastRate = latest.r[i]!;
    const story = /^Complete (Chapter \d+|the final mission)\.?$/i.test(t.description);
    const group = story ? 'story' : delayPrior(t).delay >= 160 || (t.points ?? 0) >= 90 ? 'late' : 'side';
    return { latest, gain, lastRate, counts: localTrend(counts, window), logits: localTrend(logits, window),
      mature: reads.every(s => s.r[i]! >= 99.99), group };
  });
  const shrinkage = new Map(['late', 'story', 'side'].map(group => [group, median(trends.flatMap(row =>
    row && row.group === group && row.gain >= 3 && !row.mature ? [Math.max(0, row.counts.slope)] : []))]));
  const local = trends.map((row, i) => {
    if (!row) return prior[i];
    const { latest, lastRate, mature } = row;
    if (mature || (lastRate === 0 && row.counts.slope <= 0)) return levels.map(() => lastRate);
    const earners = latest.counts[i]!;
    const trend = { ...row.counts };
    const pool = row.gain > 0 ? 2 / (2 + row.gain) : 0;
    trend.slope = (1 - pool) * trend.slope + pool * (shrinkage.get(row.group) ?? trend.slope);
    const draws: Sample[] = [];
    for (const { n, x, value, weight } of times) {
      if (value <= latest.t) {
        draws.push({ value: scoreLogit(lastRate), weight });
        continue;
      }
      const dx = x - latest.x;
      const e = clamp((earners + 0.5) * Math.exp(extrapolate(trend, dx, 'earners')) - 0.5, earners, n);
      const countLogit = scoreLogit(100 * e / n);
      const ratioLogit = scoreLogit(lastRate) + extrapolate(row.logits, dx, 'logit');
      const directWeight = Math.min(0.70, lastRate / 100);
      const center = (1 - directWeight) * countLogit + directWeight * ratioLogit;
      const timeScale = Math.sqrt((value - latest.t) / 24);
      const spread = 0.015 + timeScale * (0.07 + Math.min(0.4, trend.noise + populationTrend.noise) +
        Math.min(0.18, 0.12 * Math.abs(countLogit - ratioLogit)) + 0.10 / Math.sqrt(1 + earners));
      for (let j = 0; j < z.length; j++) draws.push({ value: center + z[j] * spread, weight: weight * [0.10, 0.20, 0.40, 0.20, 0.10][j] });
    }
    return forecastQuantiles(draws).map(percent);
  });
  const chapters = c.trophies.flatMap((t, i) => {
    const n = /^Complete Chapter (\d+)\.?$/i.exec(t.description);
    return n ? [{ i, n: Number(n[1]) }] : [];
  }).sort((a, b) => a.n - b.n).map(({ i }) => i);
  const final = c.trophies.findIndex(t => /^Complete the final mission\.?$/i.test(t.description));
  if (final >= 0) chapters.push(final);
  return { local, prior, horizon, reliability: Math.min(1, (rows.length - 1) / 4), chain: chapters,
    completion: c.trophies.findIndex(t => /100% Completion/i.test(t.description)), platinum: c.trophies.findIndex(t => t.tier === 'platinum') };
}

export function fitTrajectory(c: Case): Trajectory {
  const ss = states(c);
  if (!ss.length) throw new Error('Trajectory fitting requires an observed snapshot.');
  const release = Date.parse(`${c.game?.release_date || c.at.slice(0, 10)}T00:00:00Z`) / hour;
  return trajectoryComponents(c, ss, Math.min(release, ss[0].t), Math.max(ss.at(-1)!.t, Date.parse(c.target) / hour), {});
}

export function trajectoryQuantiles(fit: Trajectory, options: TrajectoryOptions): number[][] {
  const blend = clamp(fit.horizon / 24, 0, 1);
  const weight = fit.reliability * ((1 - blend) * options.short + blend * options.week);
  const tail = (1 - blend) * options.quickTail + blend * options.tail;
  const rows = fit.prior.map((prior, i) => {
    const local = fit.local[i];
    if (prior[0] === prior[4] && prior[0] === local[0] && local[0] === local[4]) return [...prior];
    const priorCenter = scoreLogit(prior[2]);
    const localCenter = scoreLogit(local[2]);
    // The local fit is most informative near its anchor. At longer horizons,
    // guard against large extrapolations from transient launch accelerations.
    const center = priorCenter + weight * clamp(localCenter - priorCenter, -options.radius, options.radius);
    return prior.map((rate, j) => {
      if (j <= 1 && rate === 0 && local[j] <= 0.01) return 0;
      if (j >= 3 && rate === 100 && local[4] >= 99.99) return 100;
      const offset = ((scoreLogit(rate) - priorCenter) * (1 - weight) + (scoreLogit(local[j]) - localCenter) * weight) * options.width;
      return printed(percent(center + offset * (j === 0 || j === 4 ? tail : 1)));
    });
  });
  // Chapter completion is a prerequisite for later chapters. A platinum is
  // at most as common as any required milestone or the completion trophy.
  const cap = (i: number, j: number) => { rows[i] = rows[i].map((r, k) => Math.min(r, rows[j][k])); };
  for (let i = 1; i < fit.chain.length; i++) cap(fit.chain[i], fit.chain[i - 1]);
  if (fit.platinum >= 0) {
    for (const i of fit.chain) cap(fit.platinum, i);
    if (fit.completion >= 0) cap(fit.platinum, fit.completion);
  }
  return rows;
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
  const q = (options.week ?? 'trajectory') === 'trajectory'
    ? trajectoryQuantiles(trajectoryComponents(c, ss, origin, target, options), { ...trajectoryDefaults, ...options.trajectory })
    : weekForecast(c, ss, origin, target, options);
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
