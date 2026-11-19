const launch = Date.parse('2026-11-19T00:00:00Z');
const iso = hours => new Date(launch + hours * 3600000).toISOString();

// Independent synthetic trophy counts with distinct acquisition delays,
// player-growth curves, and snapshot publication lag.
export function scenario({ population, kernel, delay, shape, at, horizon, cadence = 0, phase = 0 }) {
  function players(t) {
    if (population === 'power') return Math.round(1200 * (1 + t / 6) ** .65);
    if (population === 'waves') {
      return Math.round(1200 - 9200 * Math.expm1(-t / 16) - 8000 * Math.expm1(-Math.max(0, t - 28) / 72));
    }
    return Math.round(1200 - 14000 * Math.expm1(-t / 32));
  }
  function cdf(age, scale) {
    if (age <= 0) return 0;
    return kernel === 'weibull' ? -Math.expm1(-((age / scale) ** shape)) : 1 / (1 + (scale / age) ** shape);
  }
  const trophies = [
    { id: 1, name: 'Completion', description: 'Attain 100% Completion.', tier: 'gold' },
    { id: 2, name: 'Story', description: 'Complete Chapter 2.', tier: 'bronze' },
    { id: 3, name: 'Activity', description: 'Complete an arcade game.', tier: 'bronze' },
    { id: 4, name: 'Opening', description: 'Complete the introduction.', tier: 'bronze' },
  ];
  const seeds = [4, 7, 6];
  const shares = [.035, .58, .24];
  const delays = [delay * 4, delay, delay * .5];
  const lags = cadence ? [1.5, .75, 0] : [0, 0, 0];

  function snapshot(t) {
    const tracked = players(t);
    const earners = seeds.map((seed, i) => {
      const published = Math.max(0, t - lags[i]);
      let count = seed + (players(0) - seed) * shares[i] * cdf(published, delays[i]);
      for (let hour = 1; hour <= published; hour++) {
        count += (players(hour) - players(hour - 1)) * shares[i] * cdf(published - hour + .5, delays[i]);
      }
      return Math.round(count);
    });
    earners.push(tracked);
    return { players_tracked: tracked, trophies_earned: earners.reduce((a, b) => a + b, 0),
      rates: earners.map(count => Math.round(10000 * count / tracked) / 100) };
  }

  const asOf = t => Math.max(0, phase + Math.floor((t - phase) / (cadence || 6)) * (cadence || 6));
  const history = [];
  for (let slot = 0; slot <= at; slot += 2) history.push({ slot: iso(slot), at: iso(slot), ...snapshot(asOf(slot)) });
  return {
    c: { id: 'rolling', at: iso(at), target: iso(at + horizon), horizon_minutes: horizon * 60, game: { release_date: '2026-11-19' }, trophies, history },
    truth: snapshot(cadence ? asOf(at + horizon) : at + horizon).rates,
  };
}
