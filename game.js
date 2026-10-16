'use strict';
// Bidlock: pure game rules. No I/O here, so it is easy to test and simulate.

const CHIPS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
const PRIZES = [-4, -3, -2, -1, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const TOTAL_ROUNDS = PRIZES.length;

function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function sum(a) { return a.reduce((s, x) => s + x, 0); }

/** Create a fresh game for n players (2-4). */
function newGame(n, rng = Math.random) {
  if (!(n >= 2 && n <= 4)) throw new Error('players must be 2-4');
  const deck = shuffle(PRIZES, rng);
  return {
    round: 1,
    deck: deck.slice(1),          // face-down prizes still to come
    pot: [deck[0]],               // prize cards up for grabs this round
    chips: Array.from({ length: n }, () => CHIPS.slice()),
    scores: Array(n).fill(0),
    won: Array.from({ length: n }, () => []), // prize cards each player took
    bids: Array(n).fill(null),    // sealed bids for the current round
    history: [],
    over: false,
  };
}

function potValue(g) { return sum(g.pot); }

/**
 * Resolve one round given a full bid array. Returns the round record.
 * Rules: any chip value played by 2+ players clashes and is void.
 * If the pot is worth >= 0 the highest surviving chip takes it,
 * otherwise the lowest surviving chip takes it. If every chip clashes
 * the pot carries over and the next prize is added to it.
 */
function resolveRound(g, bids) {
  const n = g.chips.length;
  for (let i = 0; i < n; i++) {
    if (!g.chips[i].includes(bids[i])) throw new Error(`seat ${i} does not hold chip ${bids[i]}`);
  }
  const counts = {};
  bids.forEach(b => { counts[b] = (counts[b] || 0) + 1; });
  const clashed = bids.map(b => counts[b] > 1);
  const value = potValue(g);
  let winner = null;
  const live = bids.map((b, i) => ({ b, i })).filter(x => !clashed[x.i]);
  if (live.length) {
    live.sort((a, b) => a.b - b.b);
    winner = value >= 0 ? live[live.length - 1].i : live[0].i;
  }
  const rec = {
    round: g.round,
    pot: g.pot.slice(),
    value,
    bids: bids.slice(),
    clashed,
    winner,
    carried: winner === null,
  };
  for (let i = 0; i < n; i++) g.chips[i] = g.chips[i].filter(c => c !== bids[i]);
  if (winner !== null) {
    g.scores[winner] += value;
    g.won[winner].push(...g.pot);
    g.pot = [];
  }
  g.history.push(rec);
  g.bids = Array(n).fill(null);
  if (g.deck.length === 0) {
    if (g.pot.length) rec.discarded = g.pot.slice(); // final round all clashed
    g.pot = [];
    g.over = true;
  } else {
    g.pot.push(g.deck.shift());
    g.round += 1;
  }
  return rec;
}

/** Final standings. Tiebreak: fewer negative cards taken, then shared. */
function standings(g) {
  const rows = g.scores.map((score, seat) => ({
    seat,
    score,
    negatives: g.won[seat].filter(c => c < 0).length,
  }));
  rows.sort((a, b) => b.score - a.score || a.negatives - b.negatives);
  const top = rows[0];
  const winners = rows.filter(r => r.score === top.score && r.negatives === top.negatives).map(r => r.seat);
  return { rows, winners };
}

module.exports = { CHIPS, PRIZES, TOTAL_ROUNDS, newGame, resolveRound, potValue, standings, shuffle, sum };
