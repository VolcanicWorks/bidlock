'use strict';
// Bidlock server: zero dependencies. Serves the browser client and the HTTP/JSON API.
// Run: node server.js   (PORT, HOST, TURN_SECONDS, DATA_DIR env vars optional)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const G = require('./game');
const { POLICIES, viewFor } = require('./bots');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const DEFAULT_TURN = Number(process.env.TURN_SECONDS || 30);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_MATCHES = 2000;
const IDLE_EXPIRE_MS = 6 * 3600 * 1000;      // lobbies and live games
const FINISHED_KEEP_MS = 7 * 24 * 3600 * 1000; // finished games stay replayable
const BOT_NAMES = ['Ada', 'Turing', 'Grace', 'Lovelace', 'Hopper', 'Knuth', 'Shannon', 'Babbage'];

const matches = new Map();

// ---------- helpers ----------
const now = () => Date.now();
function code() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do { c = Array.from(crypto.randomBytes(5), b => A[b % A.length]).join(''); } while (matches.has(c));
  return c;
}
const token = () => crypto.randomBytes(16).toString('hex');
function cleanName(s, fallback) {
  const t = String(s || '').replace(/[^\p{L}\p{N} _.\-]/gu, '').trim().slice(0, 18);
  return t || fallback;
}
class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

// ---------- match lifecycle ----------
const BOT_LEVELS = { steady: { temp: 0.1, rollouts: 24 }, sharp: { temp: 0.04, rollouts: 44 } };

function createMatch({ seats = 2, turnSeconds = DEFAULT_TURN, bots = 0, isPublic = true, botLevel = 'steady' } = {}) {
  seats = Number(seats);
  if (!Number.isInteger(seats) || seats < 2 || seats > 4) throw new ApiError(400, 'seats must be 2, 3 or 4');
  turnSeconds = Number(turnSeconds);
  if (!Number.isFinite(turnSeconds) || turnSeconds < 5 || turnSeconds > 300) throw new ApiError(400, 'turnSeconds must be 5-300');
  bots = Number(bots) || 0;
  if (bots < 0 || bots >= seats) throw new ApiError(400, 'bots must leave at least one open seat');
  if (!BOT_LEVELS[botLevel]) throw new ApiError(400, 'botLevel must be "steady" or "sharp"');
  if (matches.size >= MAX_MATCHES) sweep(true);
  if (matches.size >= MAX_MATCHES) throw new ApiError(503, 'server is full, try again shortly');
  const m = {
    code: code(), seats, turnSeconds, isPublic: !!isPublic, botLevel,
    status: 'lobby', players: [], game: null, deadline: null,
    createdAt: now(), updatedAt: now(), version: 1, log: [], result: null,
  };
  matches.set(m.code, m);
  for (let i = 0; i < bots; i++) addBot(m);
  return m;
}

function addBot(m) {
  const used = new Set(m.players.map(p => p.name));
  const name = BOT_NAMES.find(n => !used.has(n + ' (bot)')) || 'Bot';
  m.players.push({ seat: m.players.length, name: name + ' (bot)', kind: 'bot', token: null, auto: false, lastSeen: now() });
}

function joinMatch(m, { name, kind = 'human' }) {
  if (m.status !== 'lobby') throw new ApiError(409, 'match already started');
  if (m.players.length >= m.seats) throw new ApiError(409, 'match is full');
  kind = kind === 'agent' ? 'agent' : 'human';
  const p = {
    seat: m.players.length,
    name: cleanName(name, kind === 'agent' ? `Agent ${m.players.length + 1}` : `Player ${m.players.length + 1}`),
    kind, token: token(), auto: false, lastSeen: now(), host: !m.players.some(x => x.host && x.kind !== 'bot'),
  };
  m.players.push(p);
  logEvent(m, `${p.name} joined (${kind})`);
  if (m.players.length === m.seats) startMatch(m);
  touch(m);
  return p;
}

function startMatch(m) {
  if (m.status !== 'lobby') throw new ApiError(409, 'match already started');
  while (m.players.length < m.seats) addBot(m);
  m.status = 'playing';
  m.game = G.newGame(m.seats);
  m.startedAt = now();
  logEvent(m, `Match started with ${m.seats} players`);
  beginRound(m);
}

function beginRound(m) {
  // +2.5 s so humans can watch the previous round's reveal before the clock bites.
  m.deadline = now() + m.turnSeconds * 1000 + (m.game.history.length ? 2500 : 0);
  // Bots decide after a short human-feeling pause.
  m.players.forEach(p => {
    if (p.kind === 'bot') setTimeout(() => botMove(m, p.seat), 500 + Math.random() * 1500);
  });
  touch(m);
}

function botMove(m, seat) {
  if (m.status !== 'playing' || m.game.bids[seat] !== null) return;
  const chip = POLICIES.house(viewFor(m.game, seat), BOT_LEVELS[m.botLevel]);
  submitBidSafe(m, seat, chip);
}

function submitBid(m, seat, chip) {
  const g = m.game;
  if (m.status !== 'playing') throw new ApiError(409, `match is ${m.status}`);
  chip = Number(chip);
  if (!g.chips[seat].includes(chip)) throw new ApiError(400, `you do not hold chip ${chip}; you hold ${g.chips[seat].join(',')}`);
  if (g.bids[seat] !== null) throw new ApiError(409, 'you already locked a chip this round');
  g.bids[seat] = chip;
  touch(m);
  if (g.bids.every(b => b !== null)) finishRound(m);
}

function finishRound(m) {
  const g = m.game;
  const rec = G.resolveRound(g, g.bids.slice());
  rec.at = now();
  rec.auto = m.players.map(p => !!p._autoThisRound);
  m.players.forEach(p => { p._autoThisRound = false; });
  const name = s => m.players[s].name;
  const potTxt = rec.pot.join(' + ');
  logEvent(m, rec.winner === null
    ? `Round ${rec.round}: all chips clashed, pot (${potTxt}) carries over`
    : `Round ${rec.round}: ${name(rec.winner)} takes ${rec.value >= 0 ? '+' : ''}${rec.value} with chip ${rec.bids[rec.winner]}`);
  if (g.over) {
    const st = G.standings(g);
    m.status = 'finished';
    m.deadline = null;
    m.finishedAt = now();
    m.result = { winners: st.winners, standings: st.rows };
    logEvent(m, `Game over: ${st.winners.map(name).join(' & ')} win${st.winners.length > 1 ? '' : 's'} with ${g.scores[st.winners[0]]}`);
    persistFinished(m);
    touch(m);
  } else {
    beginRound(m);
  }
}

// Timer: anyone who has not locked in gets an automatic house-bot move.
function tick() {
  const t = now();
  for (const m of matches.values()) {
    if (m.status !== 'playing' || !m.deadline || t < m.deadline) continue;
    m.game.bids.forEach((b, seat) => {
      if (b !== null) return;
      const p = m.players[seat];
      p._autoThisRound = true;
      p.timeouts = (p.timeouts || 0) + 1;
      submitBidSafe(m, seat, POLICIES.house(viewFor(m.game, seat), BOT_LEVELS.steady));
    });
  }
}
function submitBidSafe(m, seat, chip) { try { submitBid(m, seat, chip); } catch (e) { /* round already resolved */ } }

function logEvent(m, text) { m.log.push({ at: now(), text }); if (m.log.length > 200) m.log.shift(); }

const waiters = new Map(); // code -> Set of resolve fns (long-poll)
function touch(m) {
  m.version += 1;
  m.updatedAt = now();
  const set = waiters.get(m.code);
  if (set) { waiters.delete(m.code); set.forEach(fn => fn()); }
}

// ---------- views ----------
function sortedUnseen(g) { return g.deck.slice().sort((a, b) => a - b); }

function publicState(m, me = null) {
  const g = m.game;
  const st = {
    code: m.code,
    status: m.status,
    version: m.version,
    seats: m.seats,
    turnSeconds: m.turnSeconds,
    botLevel: m.botLevel,
    round: g ? Math.min(g.round, G.TOTAL_ROUNDS) : 0,
    totalRounds: G.TOTAL_ROUNDS,
    deadline: m.deadline,
    secondsLeft: m.deadline ? Math.max(0, Math.round((m.deadline - now()) / 100) / 10) : null,
    pot: g && !g.over ? { cards: g.pot.slice(), value: G.potValue(g) } : null,
    unseenPrizes: g ? sortedUnseen(g) : G.PRIZES.slice(),
    players: m.players.map(p => ({
      seat: p.seat, name: p.name, kind: p.kind, host: !!p.host,
      score: g ? g.scores[p.seat] : 0,
      chips: g ? g.chips[p.seat].slice() : G.CHIPS.slice(),
      won: g ? g.won[p.seat].slice() : [],
      locked: g ? g.bids[p.seat] !== null : false,
      timeouts: p.timeouts || 0,
    })),
    lastRound: g && g.history.length ? roundView(g.history[g.history.length - 1]) : null,
    result: m.result,
    log: m.log.slice(-30),
  };
  if (me) {
    st.you = {
      seat: me.seat, name: me.name, host: !!me.host,
      chips: g ? g.chips[me.seat].slice() : G.CHIPS.slice(),
      lockedChip: g ? g.bids[me.seat] : null,
      mustMove: m.status === 'playing' && g.bids[me.seat] === null,
    };
  }
  return st;
}
function roundView(r) {
  return { round: r.round, pot: r.pot, value: r.value, bids: r.bids, clashed: r.clashed, winner: r.winner, carried: r.carried, discarded: r.discarded || null };
}
function replay(m) {
  return {
    code: m.code, status: m.status, seats: m.seats, botLevel: m.botLevel, turnSeconds: m.turnSeconds,
    players: m.players.map(p => ({ seat: p.seat, name: p.name, kind: p.kind })),
    rounds: m.game ? m.game.history.map(roundView) : [],
    result: m.result,
    log: m.log,
  };
}

// ---------- persistence (finished games survive restarts) ----------
function persistFinished(m) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, `${m.code}.json`), JSON.stringify({ ...replay(m), finishedAt: m.finishedAt }));
  } catch (e) { console.error('persist failed', e.message); }
}
function loadReplay(c) {
  if (!/^[A-Z0-9]{5}$/.test(c)) return null;
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${c}.json`), 'utf8')); } catch { return null; }
}

function sweep(aggressive = false) {
  const t = now();
  for (const [c, m] of matches) {
    const idle = t - m.updatedAt;
    if (m.status === 'finished' && (aggressive || idle > 3600 * 1000)) matches.delete(c); // replay stays on disk
    else if (idle > (aggressive ? 1800 * 1000 : IDLE_EXPIRE_MS)) matches.delete(c);
  }
  try {
    for (const f of fs.readdirSync(DATA_DIR)) {
      const fp = path.join(DATA_DIR, f);
      if (f.endsWith('.json') && t - fs.statSync(fp).mtimeMs > FINISHED_KEEP_MS) fs.unlinkSync(fp);
    }
  } catch { /* no data dir yet */ }
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.md': 'text/markdown; charset=utf-8', '.json': 'application/json', '.ico': 'image/x-icon', '.py': 'text/plain; charset=utf-8' };

function send(res, status, body, extra = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store',
    ...extra,
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 10000) { reject(new ApiError(413, 'body too large')); req.destroy(); } });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new ApiError(400, 'body must be JSON')); }
    });
    req.on('error', reject);
  });
}

function getMatch(c) {
  const m = matches.get(String(c || '').toUpperCase());
  if (!m) throw new ApiError(404, 'no such match (codes are 5 characters, e.g. K7Q2M)');
  return m;
}
function authPlayer(m, req, body, query) {
  const h = req.headers.authorization || '';
  const t = (h.startsWith('Bearer ') ? h.slice(7) : '') || body.token || query.get('token');
  if (!t) return null;
  const p = m.players.find(x => x.token && x.token === t);
  if (!p) throw new ApiError(403, 'token does not match a seat in this match');
  p.lastSeen = now();
  return p;
}
function requirePlayer(m, req, body, query) {
  const p = authPlayer(m, req, body, query);
  if (!p) throw new ApiError(401, 'send your token as "Authorization: Bearer <token>" or {"token": ...}');
  return p;
}

// Per-IP rate limit: generous enough for a host running several bots at once
// (burst 300, refills at 100/s), tight enough to stop runaway loops.
const buckets = new Map();
setInterval(() => { const t = now(); for (const [ip, b] of buckets) if (t - b.at > 60000) buckets.delete(ip); }, 60000);
function rateOk(ip) {
  const t = now();
  const b = buckets.get(ip) || { tokens: 300, at: t };
  b.tokens = Math.min(300, b.tokens + ((t - b.at) / 1000) * 100);
  b.at = t;
  if (b.tokens < 1) { buckets.set(ip, b); return false; }
  b.tokens -= 1;
  buckets.set(ip, b);
  return true;
}

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const q = url.searchParams;
  const method = req.method;
  const body = method === 'POST' ? await readBody(req) : {};

  // GET /api  -> machine-readable index
  if (parts.length === 1 && method === 'GET') {
    return send(res, 200, {
      game: 'Bidlock', docs: '/api/docs', rules: RULES,
      endpoints: [
        'POST /api/matches {seats, bots, botLevel, turnSeconds, public}',
        'GET  /api/matches            (open lobbies)',
        'POST /api/matches/{code}/join {name, kind}',
        'POST /api/matches/{code}/start   (host; fills empty seats with bots)',
        'GET  /api/matches/{code}/state?wait=1&since={version}',
        'POST /api/matches/{code}/move {chip}',
        'GET  /api/matches/{code}/replay',
      ],
    });
  }
  if (parts[1] === 'docs' && method === 'GET') {
    const md = fs.readFileSync(path.join(__dirname, 'README.md'), 'utf8');
    return send(res, 200, md, { 'Content-Type': 'text/markdown; charset=utf-8' });
  }
  if (parts[1] !== 'matches') throw new ApiError(404, 'unknown endpoint, see GET /api');

  // /api/matches
  if (parts.length === 2) {
    if (method === 'POST') {
      const m = createMatch({ seats: body.seats ?? 2, turnSeconds: body.turnSeconds ?? DEFAULT_TURN, bots: body.bots ?? 0, isPublic: body.public !== false, botLevel: body.botLevel ?? 'steady' });
      return send(res, 201, { code: m.code, url: `/m/${m.code}`, state: publicState(m) });
    }
    if (method === 'GET') {
      const open = [...matches.values()]
        .filter(m => m.status === 'lobby' && m.isPublic && m.players.length < m.seats)
        .sort((a, b) => b.createdAt - a.createdAt).slice(0, 20)
        .map(m => ({ code: m.code, seats: m.seats, filled: m.players.length, players: m.players.map(p => p.name), turnSeconds: m.turnSeconds, createdAt: m.createdAt }));
      return send(res, 200, { open });
    }
  }

  const m = getMatch(parts[2]);
  const action = parts[3] || 'state';

  if (action === 'join' && method === 'POST') {
    const p = joinMatch(m, body);
    return send(res, 200, { token: p.token, seat: p.seat, name: p.name, host: p.host, state: publicState(m, p) });
  }
  if (action === 'start' && method === 'POST') {
    const p = requirePlayer(m, req, body, q);
    if (!p.host) throw new ApiError(403, 'only the host (first player to join) can start early');
    startMatch(m);
    return send(res, 200, { state: publicState(m, p) });
  }
  if (action === 'move' && method === 'POST') {
    const p = requirePlayer(m, req, body, q);
    submitBid(m, p.seat, body.chip);
    return send(res, 200, { ok: true, state: publicState(m, p) });
  }
  if (action === 'replay' && method === 'GET') return send(res, 200, replay(m));
  if (action === 'state' && method === 'GET') {
    const p = authPlayer(m, req, body, q);
    const since = Number(q.get('since') || 0);
    const wait = q.get('wait') === '1' || q.get('wait') === 'true';
    if (wait && since >= m.version) {
      // Long-poll: hold until the state changes or 25 s pass.
      await new Promise(resolve => {
        const set = waiters.get(m.code) || new Set();
        const done = () => { clearTimeout(timer); set.delete(done); resolve(); };
        const timer = setTimeout(done, 25000);
        set.add(done);
        waiters.set(m.code, set);
        req.on('close', done);
      });
    }
    return send(res, 200, publicState(m, p));
  }
  throw new ApiError(405, `unsupported: ${method} ${url.pathname}`);
}

function serveStatic(req, res, url) {
  let p = url.pathname;
  // Replays of finished matches that are no longer in memory.
  const rm = p.match(/^\/api\/replay\/([A-Z0-9]{5})$/);
  if (rm) { const r = loadReplay(rm[1]); return r ? send(res, 200, r) : send(res, 404, { error: 'replay not found' }); }
  if (p === '/' || p.startsWith('/m/') || p.startsWith('/replay/')) p = '/index.html';
  if (p === '/bot.py') return sendFile(res, path.join(__dirname, 'bots', 'sample_bot.py'));
  const fp = path.normalize(path.join(PUBLIC_DIR, p));
  if (!fp.startsWith(PUBLIC_DIR)) return send(res, 403, 'forbidden');
  sendFile(res, fp);
}
function sendFile(res, fp) {
  fs.readFile(fp, (err, buf) => {
    if (err) return send(res, 404, 'not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=60' });
    res.end(buf);
  });
}

const RULES = 'Everyone holds chips 1-13. Each of 13 rounds a prize card (-4 to +9) is revealed and all players secretly lock in one chip at the same time. Chips that match another player\'s chip clash and are void. If the pot is positive the highest surviving chip takes it; if negative the lowest surviving chip is stuck with it. If every chip clashes the pot carries over and grows. Spent chips are gone for good, so every hand is public knowledge. Most points after 13 rounds wins.';

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  try {
    if (req.method === 'OPTIONS') return send(res, 204, '');
    if (url.pathname === '/healthz') return send(res, 200, { ok: true, matches: matches.size });
    if (url.pathname.startsWith('/api/replay/')) return serveStatic(req, res, url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      if (!rateOk(ip)) throw new ApiError(429, 'slow down: max ~100 requests/second per IP; use ?wait=1 long-polling instead of tight loops');
      return await api(req, res, url);
    }
    serveStatic(req, res, url);
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: e.message || 'server error' });
  }
});

setInterval(tick, 250);
setInterval(() => sweep(false), 10 * 60 * 1000);
server.requestTimeout = 60000;

if (require.main === module) {
  server.listen(PORT, HOST, () => console.log(`Bidlock on http://${HOST}:${PORT}`));
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
module.exports = { server, matches };
