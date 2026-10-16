'use strict';
// Built-in bot policies. Each takes a view (what any player can see) and returns a chip.
// view = { my: [chips], others: [[chips], ...], pot: number, unseen: [prize values], rng }

function pick(arr, rng) { return arr[Math.floor(rng() * arr.length)]; }

// Plays a random chip. Baseline for balance testing.
function random(v) { return pick(v.my, v.rng); }

// Bids in proportion to the pot: big prize, big chip. Predictable.
function greedy(v) {
  const sorted = v.my.slice().sort((a, b) => a - b);
  const all = v.unseen.concat([v.pot]).map(Math.abs).sort((a, b) => a - b);
  const rank = all.indexOf(Math.abs(v.pot)) / Math.max(1, all.length - 1);
  const idx = Math.round(rank * (sorted.length - 1));
  return sorted[v.pot >= 0 ? idx : Math.floor(idx / 2)];
}

// Always dumps the lowest chip on positive pots it does not care about and
// the highest chip on big ones. Tests "all-or-nothing" strategies.
function extremist(v) {
  const sorted = v.my.slice().sort((a, b) => a - b);
  if (v.pot >= 6) return sorted[sorted.length - 1];
  if (v.pot < 0) return sorted[Math.min(1, sorted.length - 1)];
  return sorted[0];
}

// Reads the table: chips are public once played, so every opponent's hand is known.
// Takes sure wins cheaply, sidesteps likely clashes, adds a little noise.
function shark(v) {
  const rng = v.rng;
  const sorted = v.my.slice().sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const oppMax = Math.max(...v.others.map(h => Math.max(...h)));
  const oppMin = Math.min(...v.others.map(h => Math.min(...h)));
  const all = v.unseen.concat([v.pot]).map(Math.abs).sort((a, b) => a - b);
  const rank = all.indexOf(Math.abs(v.pot)) / Math.max(1, all.length - 1);

  if (v.pot > 0) {
    // A chip above every opponent's best can never clash or lose.
    const sure = sorted.filter(c => c > oppMax);
    if (sure.length && (rank > 0.4 || sure.length > 2)) return sure[0];
    if (rank < 0.35) return sorted[0]; // not worth fighting for: dump the lowest chip
    const target = Math.round(rank * (sorted.length - 1));
    const jitter = Math.round((rng() - 0.5) * 3);
    let c = sorted[Math.max(0, Math.min(sorted.length - 1, target + jitter))];
    // Avoid exact chips that every opponent still holds (a clash is likely).
    const everyoneHas = x => v.others.every(h => h.includes(x));
    if (everyoneHas(c) && rng() < 0.5) {
      const alt = sorted.find(x => x > c && !everyoneHas(x));
      if (alt !== undefined) c = alt;
    }
    return c;
  }
  if (v.pot < 0) {
    // Below every opponent's lowest chip means a sure loss of the bad card: avoid it.
    const safe = sorted.filter(c => c > oppMin);
    const pool = safe.length ? safe : sorted;
    const idx = Math.min(pool.length - 1, Math.floor(rng() * Math.min(3, pool.length)));
    return pool[idx];
  }
  return sorted[0];
}

// Assumes opponents bid "greedy" and plays one chip above their predicted bid
// when the pot is worth it. Strong against predictable players, weak against noise.
function reader(v) { return outguess(v, greedy); }

// One level deeper: assumes opponents are readers, and out-guesses them.
function deep(v) { return outguess(v, reader); }

function outguess(v, model) {
  const sorted = v.my.slice().sort((a, b) => a - b);
  // Predict each opponent by running the model from their seat.
  const preds = v.others.map((h, i) => model({
    my: h,
    others: [v.my].concat(v.others.filter((_, j) => j !== i)),
    pot: v.pot, unseen: v.unseen, rng: v.rng,
  }));
  const all = v.unseen.concat([v.pot]).map(Math.abs).sort((a, b) => a - b);
  const rank = all.indexOf(Math.abs(v.pot)) / Math.max(1, all.length - 1);
  if (v.pot >= 0) {
    const top = Math.max(...preds);
    const beat = sorted.find(c => c > top && !preds.includes(c));
    if (beat !== undefined && (rank >= 0.3 || beat - top <= 1)) return beat;
    return sorted.find(c => !preds.includes(c)) ?? sorted[0];
  }
  const low = Math.min(...preds);
  const above = sorted.find(c => c > low && !preds.includes(c));
  return above ?? sorted[sorted.length - 1];
}

// The table bot that fills empty seats. For each chip it could play now, it
// plays the rest of the match out many times (opponents and its own future
// moves drawn from a mix of quick styles) and keeps the chip that wins most.
// That prices the cost of spending a strong chip automatically. It then picks
// with a little randomness, so two house bots at one table rarely mirror.
function ascending(v) { return Math.min(...v.my); }
function noisyGreedy(v) {
  const c = greedy(v);
  if (v.rng() < 0.35) {
    const s = v.my.slice().sort((a, b) => a - b);
    const i = s.indexOf(c) + (v.rng() < 0.5 ? -1 : 1);
    return s[Math.max(0, Math.min(s.length - 1, i))];
  }
  return c;
}
const MIX = [[noisyGreedy, 0.4], [shark, 0.2], [extremist, 0.1], [ascending, 0.05], [random, 0.25]];
function style(rng) {
  let r = rng();
  for (const [f, w] of MIX) { if ((r -= w) < 0) return f; }
  return random;
}
function resolve(bids, pot) {
  const cnt = {};
  bids.forEach(b => { cnt[b] = (cnt[b] || 0) + 1; });
  let w = -1, best = null;
  bids.forEach((b, i) => {
    if (cnt[b] !== 1) return;
    if (best === null || (pot >= 0 ? b > best : b < best)) { best = b; w = i; }
  });
  return w;
}
function house(v, opts = {}) {
  const rng = v.rng;
  const my = v.my.slice().sort((a, b) => a - b);
  if (my.length === 1) return my[0];
  const R = opts.rollouts || 36;
  const n = v.others.length + 1;
  const scores0 = v.scores || Array(n).fill(0);
  const carry0 = v.potCards || [v.pot];
  const util = new Map(my.map(c => [c, 0]));
  for (let k = 0; k < R; k++) {
    // Common random numbers: same deck order and opponent styles for every candidate.
    const deck = shuffleWith(v.unseen, rng);
    const styles = Array.from({ length: n }, () => style(rng));
    const seed = Math.floor(rng() * 2 ** 31);
    for (const c of my) {
      const r = mulberry(seed);
      const hands = [v.my.slice()].concat(v.others.map(h => h.slice()));
      const sc = scores0.slice();
      let pot = carry0.slice(), d = deck.slice(), first = true;
      while (true) {
        const pv = pot.reduce((a, b) => a + b, 0);
        const bids = hands.map((h, i) => {
          if (i === 0 && first) return c;
          return styles[i]({ my: h, others: hands.filter((_, j) => j !== i), pot: pv, unseen: d, rng: r });
        });
        first = false;
        const w = resolve(bids, pv);
        hands.forEach((h, i) => h.splice(h.indexOf(bids[i]), 1));
        if (w >= 0) { sc[w] += pv; pot = []; }
        if (!d.length || !hands[0].length) break;
        pot.push(d.shift());
      }
      const top = Math.max(...sc);
      const winners = sc.filter(x => x === top).length;
      const u = (sc[0] === top ? 1 / winners : 0) + 0.01 * (sc[0] - Math.max(...sc.slice(1)));
      util.set(c, util.get(c) + u / R);
    }
  }
  const temp = opts.temp ?? 0.04;
  const list = my.map(c => ({ c, u: util.get(c) }));
  const best = Math.max(...list.map(x => x.u));
  const wts = list.map(x => Math.exp((x.u - best) / temp));
  let t = rng() * wts.reduce((a, b) => a + b, 0);
  for (let i = 0; i < wts.length; i++) { if ((t -= wts[i]) < 0) return list[i].c; }
  return list[list.length - 1].c;
}
function shuffleWith(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function mulberry(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const POLICIES = { random, greedy, extremist, shark, reader, deep, ascending, house };

function viewFor(game, seat, rng = Math.random) {
  return {
    my: game.chips[seat].slice(),
    others: game.chips.filter((_, i) => i !== seat).map(h => h.slice()),
    pot: game.pot.reduce((s, x) => s + x, 0),
    unseen: game.deck.slice().sort((a, b) => a - b), // the order is hidden from everyone
    potCards: game.pot.slice(),
    scores: [game.scores[seat]].concat(game.scores.filter((_, i) => i !== seat)),
    rng,
  };
}

module.exports = { POLICIES, viewFor };
