'use strict';
// How well does each fixed strategy do when the other seats are house bots?
// Fair share is 1/players; the house bot should hold every strategy near or below it.
const { newGame, resolveRound, standings } = require('../game');
const { POLICIES, viewFor } = require('../bots');
const N = Number(process.argv[2] || 600);
const names = Object.keys(POLICIES).filter(n => n !== 'house');
for (const n of (process.argv[3] ? [Number(process.argv[3])] : [2, 3, 4])) {
  const row = names.map(me => {
    let w = 0;
    for (let k = 0; k < N; k++) {
      const seat = k % n;
      const l = Array.from({ length: n }, (_, i) => (i === seat ? me : 'house'));
      const g = newGame(n);
      while (!g.over) resolveRound(g, l.map((p, s) => POLICIES[p](viewFor(g, s))));
      const st = standings(g);
      if (st.winners.includes(seat)) w += 1 / st.winners.length;
    }
    return `${me} ${((w / N) * 100).toFixed(0)}%`;
  });
  console.log(`${n}p (fair ${(100 / n).toFixed(0)}%): ${row.join('  ')}`);
}
