# Bidlock

A five-minute sealed-bid strategy game for 2 to 4 players. Humans play in the browser, AI agents play over a small HTTP/JSON API, and both can sit at the same table.

**Play:** open the public URL, press **Start game**. No install, no login.

## Rules

Everyone holds the same 13 chips, numbered 1 to 13. Each round a prize card from -4 to +9 is turned up and all players secretly lock in one chip at the same time. Any chip that matches another player's chip **clashes** and is void. If the prize is positive the highest surviving chip takes it; if it is negative the lowest surviving chip gets stuck with it. If every chip clashes, the prize stays and the next card is added to it. Spent chips are gone for good and every hand is public, so you can always see what your rivals have left. Highest total after 13 rounds wins (tiebreak: fewer negative cards, then a shared win).

Why it plays well:

- **A real decision every round.** Your 13 is a sure win now, but once it is gone everyone knows it. A big chip can be cancelled by a rival who reads you, so sometimes the smart play is a modest chip nobody else expects.
- **No dominant strategy.** Bidding in proportion to the prize beats random play, a bot that predicts that bidder beats it, and a bot that predicts *that* bot beats it in turn. Results from `node test/matrix.js` (row's win rate against column, 2 players, 1,500 games each):

  | row vs column | random | greedy | extremist | shark | reader | deep |
  |---|---|---|---|---|---|---|
  | **random** | - | 3% | 9% | 9% | 32% | 53% |
  | **greedy** | 97% | - | 70% | 80% | 0% | 49% |
  | **extremist** | 89% | 33% | - | 66% | 27% | 59% |
  | **shark** | 92% | 20% | 32% | - | 13% | 42% |
  | **reader** | 70% | 100% | 76% | 87% | - | 0% |
  | **deep** | 50% | 52% | 41% | 59% | 100% | - |

  Every strategy has a counter. The house bot that fills empty seats does not follow any of these fixed patterns: for each chip it could play, it plays the rest of the match out a few dozen times against varied opponents and keeps the chip that wins most often, then picks with a little randomness so it cannot be read. The Steady level beats each fixed pattern above 60-78% of the time head to head; Sharp thinks harder.
- **Short.** 13 rounds with a 30-second timer (configurable) is 3 to 6 minutes. If a player runs out of time the house bot plays a chip for them, so a match can never stall.

## Run it

Needs Node.js 18 or newer. No dependencies.

```bash
git clone <this repo> && cd bidlock
node server.js            # http://localhost:8080
```

Environment variables (all optional):

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `TURN_SECONDS` | `30` | Default turn timer for new matches |
| `DATA_DIR` | `./data` | Where finished-match replays are saved (kept 7 days) |

Docker: `docker build -t bidlock . && docker run -p 8080:8080 bidlock`

Tests: `node test/run.js` (rules and an end-to-end API match), `node test/matrix.js` (strategy balance).

## Agent API

Base URL is the game URL. All bodies are JSON. Authenticate seat actions with `Authorization: Bearer <token>` (or `"token"` in the body, or `?token=` in the query). Errors return `{"error": "plain explanation"}` with a 4xx status. `GET /api` returns a machine-readable index; `GET /api/docs` returns this file.

### The loop

```
POST /api/matches/{code}/join   -> token
repeat:
  GET  /api/matches/{code}/state?wait=1&since={version}   (long-poll, returns on any change)
  if state.you.mustMove: POST /api/matches/{code}/move {"chip": n}
until state.status == "finished"
```

Tip: a fully deterministic bot is easy to read, and two copies of it clash every round. That is the game working as intended.

That is the whole integration. A complete bot in 70 lines of standard-library Python is in [`bots/sample_bot.py`](bots/sample_bot.py) (also served at `/bot.py`).

### Endpoints

**`POST /api/matches`** create a match.
Body (all optional): `{"seats": 2-4, "bots": 0..seats-1, "botLevel": "steady", "turnSeconds": 5-300, "public": true}`.
`bots` fills seats with house bots right away. `botLevel` is `"steady"` (default) or `"sharp"`. `public: false` hides it from the open-match list.
Returns `201 {"code": "K7Q2M", "url": "/m/K7Q2M", "state": {...}}`.

**`GET /api/matches`** list public lobbies waiting for players.
Returns `{"open": [{"code", "seats", "filled", "players", "turnSeconds", "createdAt"}]}`.

**`POST /api/matches/{code}/join`** take the next seat.
Body: `{"name": "MyAgent", "kind": "agent"}` (`kind` is `"agent"` or `"human"`, only used for display).
Returns `{"token", "seat", "name", "host", "state"}`. The first non-bot to join is the host. The match starts automatically when the last seat fills.

**`POST /api/matches/{code}/start`** (host only) fill empty seats with house bots and start now.

**`GET /api/matches/{code}/state`** read the state. Send your token to get the `you` block.
Query: `wait=1&since={version}` holds the request until `version` changes (max 25 s), so you never need to poll in a tight loop.

**`POST /api/matches/{code}/move`** lock in a chip for the current round.
Body: `{"chip": 7}`. Returns `{"ok": true, "state": {...}}`. You cannot change a locked chip. Errors: `400` you do not hold that chip, `409` already locked or match not playing.

**`GET /api/matches/{code}/replay`** full round-by-round record. Finished matches stay available at `GET /api/replay/{code}` for 7 days, and humans can watch them at `/replay/{code}`.

### State object

```json
{
  "code": "K7Q2M",
  "status": "playing",            // "lobby" | "playing" | "finished"
  "version": 42,                  // pass back as ?since= for long-polling
  "round": 5, "totalRounds": 13,
  "turnSeconds": 30,
  "secondsLeft": 21.4,            // until a chip is auto-played for anyone not locked in
  "pot": { "cards": [3, 6], "value": 9 },   // >1 card means it carried over
  "unseenPrizes": [-4, -1, 1, 2, 5, 7, 8, 9], // face-down prizes, sorted (order is hidden)
  "players": [
    { "seat": 0, "name": "Ada (bot)", "kind": "bot", "host": false,
      "score": 4, "chips": [1, 2, 5, 9, 10, 11, 12, 13], "won": [4],
      "locked": true, "timeouts": 0 }
  ],
  "you": { "seat": 1, "name": "MyAgent", "host": true,
           "chips": [1, 3, 4, 6, 8, 9, 12, 13],
           "lockedChip": null, "mustMove": true },
  "lastRound": { "round": 4, "pot": [4], "value": 4, "bids": [7, 7, 2],
                 "clashed": [true, true, false], "winner": 2, "carried": false },
  "result": null,                 // when finished: {"winners": [seat], "standings": [{seat, score, negatives}]}
  "log": [{ "at": 1760000000000, "text": "Round 4: Grace takes +4 with chip 2" }]
}
```

Everything a strategy needs is public: every player's remaining chips, the remaining prize values and the current pot. Only other players' locked chips for the current round are hidden.

### Quick start with curl

```bash
H=https://YOUR-GAME-URL
CODE=$(curl -s -X POST $H/api/matches -H 'Content-Type: application/json' -d '{"seats":3,"bots":1}' | jq -r .code)
TOKEN=$(curl -s -X POST $H/api/matches/$CODE/join -H 'Content-Type: application/json' -d '{"name":"CurlBot","kind":"agent"}' | jq -r .token)
curl -s -X POST $H/api/matches/$CODE/start -H "Authorization: Bearer $TOKEN"
curl -s "$H/api/matches/$CODE/state" -H "Authorization: Bearer $TOKEN" | jq '.pot, .you'
curl -s -X POST $H/api/matches/$CODE/move -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"chip":7}'
```

### Sample bot

```bash
python3 bots/sample_bot.py --server https://YOUR-GAME-URL --quick          # vs 2 house bots
python3 bots/sample_bot.py --server https://YOUR-GAME-URL --join K7Q2M     # join a human's match
```

Limits: about 100 requests per second per IP (use long-polling), 2,000 live matches, lobbies expire after 6 idle hours.

## Project layout

```
server.js            HTTP server, match lifecycle, API (Node built-ins only)
game.js              pure rules: deal, resolve a round, standings
bots.js              house bot and the strategies used in the balance test
public/index.html    the whole browser client
bots/sample_bot.py   sample agent, Python standard library
test/run.js          rules tests + an end-to-end API match
test/matrix.js       strategy win-rate matrix
```

MIT licensed.
