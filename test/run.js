'use strict';
// Rules tests plus an end-to-end match over the real HTTP API.
// Run: node test/run.js
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bidlock-'));
const G = require('../game');

let passed = 0;
const t = (name, fn) => Promise.resolve(fn()).then(() => { passed++; console.log('ok  ', name); });

function game(pot, chips) {
  const g = G.newGame(chips.length);
  g.pot = pot; g.deck = [1];
  return g;
}

(async () => {
  await t('highest unique chip takes a positive pot', () => {
    const g = game([5], [0, 0, 0]);
    const r = G.resolveRound(g, [9, 9, 4]);
    assert.deepStrictEqual(r.clashed, [true, true, false]);
    assert.strictEqual(r.winner, 2);
    assert.strictEqual(g.scores[2], 5);
  });
  await t('lowest unique chip is stuck with a negative pot', () => {
    const g = game([-3], [0, 0, 0]);
    const r = G.resolveRound(g, [2, 6, 2]);
    assert.strictEqual(r.winner, 1);
    assert.strictEqual(g.scores[1], -3);
  });
  await t('all clash carries the pot and adds the next card', () => {
    const g = game([4], [0, 0]);
    const r = G.resolveRound(g, [7, 7]);
    assert.strictEqual(r.carried, true);
    assert.deepStrictEqual(g.pot, [4, 1]);
    assert.ok(!g.chips[0].includes(7) && !g.chips[1].includes(7));
  });
  await t('cannot play a chip you do not hold', () => {
    const g = game([4], [0, 0]);
    G.resolveRound(g, [7, 3]);
    g.deck = [2];
    assert.throws(() => G.resolveRound(g, [7, 5]));
  });
  await t('full random games always end after 13 rounds with all chips spent', () => {
    for (let k = 0; k < 500; k++) {
      const n = 2 + (k % 3), g = G.newGame(n);
      let rounds = 0;
      while (!g.over) { G.resolveRound(g, g.chips.map(h => h[Math.floor(Math.random() * h.length)])); rounds++; }
      assert.strictEqual(rounds, 13);
      assert.ok(g.chips.every(h => h.length === 0));
      const totalWon = G.sum(g.scores) + G.sum(g.history.flatMap(h => h.discarded || []));
      assert.strictEqual(totalWon, G.sum(G.PRIZES));
    }
  });

  // ---- end-to-end over HTTP: 1 agent + 1 house bot + 1 agent that times out ----
  const { server } = require('../server');
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body, token) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };

  await t('API rejects bad input with clear errors', async () => {
    assert.strictEqual((await call('POST', '/api/matches', { seats: 9 })).status, 400);
    assert.strictEqual((await call('GET', '/api/matches/ZZZZZ/state')).status, 404);
  });

  await t('end-to-end match: agent vs house bot vs a sleeping agent', async () => {
    const c = (await call('POST', '/api/matches', { seats: 3, bots: 1, turnSeconds: 5 })).body;
    const a = (await call('POST', `/api/matches/${c.code}/join`, { name: 'A', kind: 'agent' })).body;
    const lobby = (await call('GET', '/api/matches')).body.open.map(o => o.code);
    assert.ok(lobby.includes(c.code), 'listed as open');
    const sleeper = (await call('POST', `/api/matches/${c.code}/join`, { name: 'Zzz', kind: 'agent' })).body;
    assert.strictEqual(sleeper.state.status, 'playing', 'starts when full');
    let bad = await call('POST', `/api/matches/${c.code}/move`, { chip: 99 }, a.token);
    assert.strictEqual(bad.status, 400);
    let version = 0, moves = 0, st;
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      st = (await call('GET', `/api/matches/${c.code}/state?wait=1&since=${version}`, null, a.token)).body;
      version = st.version;
      if (st.status === 'finished') break;
      if (st.you.mustMove) {
        const r = await call('POST', `/api/matches/${c.code}/move`, { chip: Math.max(...st.you.chips) }, a.token);
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        const again = await call('POST', `/api/matches/${c.code}/move`, { chip: st.you.chips[0] }, a.token);
        if (again.body.state === undefined) assert.strictEqual(again.status, 409);
        moves++;
      }
    }
    assert.strictEqual(st.status, 'finished');
    assert.strictEqual(moves, 13);
    assert.ok(st.players[2].timeouts === 13, 'sleeper auto-played every round');
    const rep = (await call('GET', `/api/matches/${c.code}/replay`)).body;
    assert.strictEqual(rep.rounds.length, 13);
    const saved = (await call('GET', `/api/replay/${c.code}`)).body;
    assert.strictEqual(saved.rounds.length, 13, 'replay persisted to disk');
  });

  console.log(`\n${passed} tests passed`);
  process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
