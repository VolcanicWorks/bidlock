#!/usr/bin/env python3
"""Bidlock sample bot. Python 3 standard library only.

Usage:
  python3 sample_bot.py                      # create a 2-seat match vs nobody yet, print the code, wait for a human
  python3 sample_bot.py --join K7Q2M         # join an existing match by code
  python3 sample_bot.py --quick              # create a 3-seat match with 1 house bot, start immediately
  python3 sample_bot.py --server https://your-host --join K7Q2M --name MyBot

Strategy (deliberately simple, about 20 lines): bid in proportion to the pot,
take a sure win when you hold a chip above every opponent's best, and never
play the lowest chip at the table on a negative pot. A little randomness
keeps two copies of this bot from clashing every round (try removing it).
"""
import argparse, json, random, sys, time, urllib.request, urllib.error

def call(server, method, path, body=None, token=None):
    req = urllib.request.Request(server.rstrip("/") + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    for attempt in range(6):
        try:
            with urllib.request.urlopen(req, timeout=40) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code in (429, 502, 503) and attempt < 5:   # busy or restarting: back off and retry
                time.sleep(0.5 * 2 ** attempt)
                continue
            raise SystemExit(f"{method} {path} -> {e.code}: {e.read().decode()}")
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt < 5:
                time.sleep(0.5 * 2 ** attempt)
                continue
            raise SystemExit(f"{method} {path} failed: {e}")

def choose(state):
    me = state["you"]["chips"]
    others = [p["chips"] for p in state["players"] if p["seat"] != state["you"]["seat"]]
    pot = state["pot"]["value"]
    mine = sorted(me)
    opp_max = max(max(h) for h in others)
    opp_min = min(min(h) for h in others)
    if pot >= 0:
        sure = [c for c in mine if c > opp_max]          # can't clash, can't lose
        if sure and pot >= 4:
            return sure[0]
        sizes = sorted(abs(x) for x in state["unseenPrizes"] + [pot])
        share = sizes.index(abs(pot)) / max(1, len(sizes) - 1)
        i = round(share * (len(mine) - 1))
        if random.random() < 0.3:                         # a little noise, or copies of this bot clash forever
            i = max(0, min(len(mine) - 1, i + random.choice((-1, 1))))
        return mine[i]
    safe = [c for c in mine if c > opp_min]              # someone is guaranteed to be lower
    return random.choice((safe or mine)[:2])

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--server", default="http://localhost:8080")
    ap.add_argument("--join")
    ap.add_argument("--quick", action="store_true")
    ap.add_argument("--name", default="SampleBot")
    a = ap.parse_args()

    code = a.join
    if not code:
        created = call(a.server, "POST", "/api/matches",
                       {"seats": 3, "bots": 1} if a.quick else {"seats": 2})
        code = created["code"]
        print(f"Created match {code}. Humans join at {a.server.rstrip('/')}/m/{code}")
    joined = call(a.server, "POST", f"/api/matches/{code}/join", {"name": a.name, "kind": "agent"})
    token, seat = joined["token"], joined["seat"]
    print(f"Joined {code} as seat {seat}")
    if a.quick and joined["state"]["status"] == "lobby":
        call(a.server, "POST", f"/api/matches/{code}/start", {}, token)

    version = 0
    while True:
        # Long-poll: returns as soon as anything changes (or after ~25 s).
        s = call(a.server, "GET", f"/api/matches/{code}/state?wait=1&since={version}", token=token)
        version = s["version"]
        if s["status"] == "finished":
            names = {p["seat"]: p["name"] for p in s["players"]}
            print("Final:", ", ".join(f"{p['name']} {p['score']}" for p in s["players"]))
            print("Winner(s):", " & ".join(names[w] for w in s["result"]["winners"]))
            return
        if s["status"] == "playing" and s["you"]["mustMove"]:
            chip = choose(s)
            call(a.server, "POST", f"/api/matches/{code}/move", {"chip": chip}, token)
            print(f"Round {s['round']}: pot {s['pot']['value']:+d} -> played {chip}")

if __name__ == "__main__":
    main()
