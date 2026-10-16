'use strict';
// Balance check: every policy against every other, many games, seats rotated.
// Run: node test/simulate.js
const { newGame, resolveRound, standings } = require('../game');
const { POLICIES, viewFor } = require('../bots');

function play(policies) {
  const g = newGame(policies.length);
  while (!g.over) {
    const bids = policies.map((p, s) => POLICIES[p](viewFor(g, s)));
    resolveRound(g, bids);
  }
  return { g, ...standings(g) };
}

const names = Object.keys(POLICIES);
const N = Number(process.argv[2] || 4000);
let carries = 0, rounds = 0;
for (const players of [2, 3, 4]) {
  const wins = Object.fromEntries(names.map(n => [n, 0]));
  const games = Object.fromEntries(names.map(n => [n, 0]));
  for (let k = 0; k < N; k++) {
    const lineup = Array.from({ length: players }, () => names[Math.floor(Math.random() * names.length)]);
    const r = play(lineup);
    lineup.forEach(p => { games[p] += 1; });
    r.winners.forEach(s => { wins[lineup[s]] += 1 / r.winners.length; });
    r.g.history.forEach(h => { rounds++; if (h.carried) carries++; });
  }
  const fair = 1 / players;
  console.log(`${players}p  (fair share ${(fair * 100).toFixed(0)}%)  ` +
    names.map(n => `${n}: ${((wins[n] / games[n]) * 100).toFixed(1)}%`).join('  '));
}
console.log(`carry-over rate: ${((carries / rounds) * 100).toFixed(1)}% of rounds`);

// Head to head: shark vs each, 2p.
for (const opp of names.filter(n => n !== 'shark')) {
  let w = 0;
  for (let k = 0; k < N; k++) {
    const lineup = k % 2 ? ['shark', opp] : [opp, 'shark'];
    const r = play(lineup);
    r.winners.forEach(s => { if (lineup[s] === 'shark') w += 1 / r.winners.length; });
  }
  console.log(`shark vs ${opp} (2p): shark wins ${((w / N) * 100).toFixed(1)}%`);
}
