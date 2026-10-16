'use strict';
// 2-player head-to-head win-rate matrix (row vs column). Run: node test/matrix.js [games]
const { newGame, resolveRound, standings } = require('../game');
const { POLICIES, viewFor } = require('../bots');
const N = Number(process.argv[2] || 2000);
const names = Object.keys(POLICIES).filter(n => n !== 'house'); // house is slow; see test/vs_house.js
function play(l) { const g = newGame(l.length); while (!g.over) resolveRound(g, l.map((p, s) => POLICIES[p](viewFor(g, s)))); return standings(g); }
console.log('row win% vs col'.padEnd(12) + names.map(n => n.padStart(10)).join(''));
for (const a of names) {
  const cells = names.map(b => {
    if (a === b) return '     -    ';
    let w = 0;
    for (let k = 0; k < N; k++) { const l = k % 2 ? [a, b] : [b, a]; const r = play(l); r.winners.forEach(s => { if (l[s] === a) w += 1 / r.winners.length; }); }
    return ((w / N) * 100).toFixed(0).padStart(9) + '%';
  });
  console.log(a.padEnd(12) + cells.join(''));
}
