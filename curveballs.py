"""Curveballs U-4.1 .. U-4.4: a purely additive layer on top of services.py / guards.py.

Nothing here edits an existing guard, table or code path. It reuses the existing helpers (transactions, guards, audit,
state hash, controller PIN, staging) and keeps its own records in new `cb_*` tables, created on demand.

  U-4.1  Vulnerable passengers rebooked first in their own transaction, then everyone else in batches of 10. Each batch
         commits or rolls back on its own; a failed batch is retried once, then handed to the controller.
  U-4.2  Crew-channel text is stored as data only. Duty counters are read-only (SQLite trigger). The only path to departure
         is a legal crew (current or reserve) checked in Python, then staged for controller approval.
  U-4.3  Every maintenance sign-off is validated in Python: engineer on the licensed roster for the aircraft type, and
         sign-off time after the defect was opened. Invalid sign-offs keep the departure blocked and alert maintenance control.
  U-4.4  Bag feasibility is checked inside the same transaction as the seat. If the bag cannot make the connection it is
         routed on a later flight with a delivery note; if no such flight exists the rebook does not commit.
"""
import json
import re
from contextlib import closing
from datetime import datetime, timedelta
from types import MappingProxyType
from typing import Final

import agent
import guards as G
import services as S
from guards import GuardViolation

CB: Final = MappingProxyType({
    "BATCH_SIZE": 10,             # U-4.1: standard passengers are rebooked in batches of 10
    "MAX_BATCH_ATTEMPTS": 2,      # U-4.1: first try + one automatic retry, then hand the batch to the controller
    "BAG_TRANSFER_MIN": G.LIMITS["BAG_MCT_MIN"],  # U-4.4: minimum bag transfer time (guards.py); +15 when the inbound is on a remote stand
    "PAX_FAST_CONNECT_MIN": G.LIMITS["REBOOKED_MCT_MIN"],  # U-4.4: shortest connection the single-passenger rebook may use
    "SIGNOFF_FUTURE_TOLERANCE_MIN": 2,  # U-4.3: a sign-off stamped in the future is invalid (small clock-skew tolerance)
})
# U-4.3 the licensed roster (which engineer may certify which aircraft type) is guards.ENGINEER_TYPES, the same list every
# assignment and sign-off path checks. (E3 is licensed, but not on the B777.)
# U-4.3 when each defect was opened, in minutes before the dataset was seeded (the captain reported M-1 at T-40, M-6 at T-20)
DEFECT_OPENED_MIN_AGO = {"M-1": 40, "M-2": 40, "M-3": 90, "M-4": 120, "M-5": 180, "M-6": 20}
STATE_EVENTS = ("CB_BATCH_COMMIT", "CB_EXTERNAL_SALE", "CB_SIGNOFF_VALID", "CB_REBOOK_COMMIT")  # replayed by replay.py
TS = "%Y-%m-%d %H:%M:%S"

SCHEMA = """
CREATE TABLE IF NOT EXISTS cb_defects(item_id TEXT PRIMARY KEY, opened_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cb_signoffs(id INTEGER PRIMARY KEY, item_id TEXT, engineer_id TEXT, result TEXT, signed_at TEXT,
  valid INT NOT NULL, reasons TEXT, ts TEXT DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS cb_crew_msgs(id INTEGER PRIMARY KEY, flight_id TEXT, sender TEXT, text TEXT, flagged INT NOT NULL,
  outcome TEXT, change_id INT, ts TEXT DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS cb_runs(id INTEGER PRIMARY KEY, flight_id TEXT, actor TEXT, chaos_batch INT, summary TEXT,
  ts TEXT DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS cb_batches(id INTEGER PRIMARY KEY, run_id INT, batch_no INT, label TEXT, pax_ids TEXT, status TEXT,
  attempts INT, moved INT, error TEXT, ts TEXT DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS cb_handoffs(id INTEGER PRIMARY KEY, run_id INT, flight_id TEXT, batch_no INT, label TEXT, pax_ids TEXT,
  reason TEXT, status TEXT NOT NULL DEFAULT 'OPEN', resolved_by TEXT, ts TEXT DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS cb_bag_plans(id INTEGER PRIMARY KEY, pax_id TEXT, bag_id TEXT, pax_flight TEXT, bag_flight TEXT,
  connection_min INT, bag_min INT, plan TEXT, note TEXT, ts TEXT DEFAULT (datetime('now','localtime')));
-- U-4.2: duty counters are read-only. No message, agent or endpoint can change how much duty a crew member has used.
CREATE TRIGGER IF NOT EXISTS cb_crew_duty_readonly BEFORE UPDATE OF duty_used ON crew
  BEGIN SELECT RAISE(ABORT, 'duty counters are read-only'); END;
"""


def ensure(db=None):
    """Create the curveball tables (idempotent). Called on server start, after a reset and by every curveball endpoint."""
    with closing(S.connect(db)) as con:
        con.executescript(SCHEMA)
        try:  # U-4.2: the AI planner's reading of each crew message (added column; older demo DBs get it here)
            con.execute("ALTER TABLE cb_crew_msgs ADD COLUMN llm TEXT")
        except Exception:  # noqa: BLE001 - column already exists
            pass
        seeded = S.one(con, "SELECT value FROM meta WHERE key = 'seeded_at'")
        base = datetime.strptime(seeded["value"], TS) if seeded else datetime.now()
        con.executemany("INSERT OR IGNORE INTO cb_defects VALUES (?,?)",
                        [(i, (base - timedelta(minutes=m)).strftime(TS)) for i, m in DEFECT_OPENED_MIN_AGO.items()])


# =====================================================================================================================
# U-4.4  bag plan, checked inside the same transaction as the seat
# =====================================================================================================================
def bag_min(con, inb):
    return G.bag_mct(S._remote(con, inb))


def bag_plan(con, inb, pax, to_flight):
    """Pure decision (no writes): can this passenger's checked bags make `to_flight`? If not, which later flight to the same
    destination can carry them, with a delivery note. Raises GuardViolation when there is no legal bag plan."""
    bags = [r["id"] for r in con.execute("SELECT id FROM bags WHERE pax_id = ? ORDER BY id", (pax["id"],))]
    conn, need = to_flight["eff"] - inb["eff"], bag_min(con, inb)
    base = {"pax_id": pax["id"], "bags": bags, "pax_flight": to_flight["id"], "connection_min": conn, "bag_min": need}
    if not bags:
        return {**base, "plan": "NO_CHECKED_BAGS", "bag_flight": None, "note": "No checked bags."}
    if conn >= need:
        return {**base, "plan": "WITH_PASSENGER", "bag_flight": to_flight["id"],
                "note": f"{len(bags)} bag(s) transfer with the passenger ({conn} min connection, bags need {need})."}
    later = S.one(con, f"SELECT * FROM ({S.F_SQL}) x WHERE kind = 'ONWARD' AND dest = ? AND eff > ? AND eff - ? >= ? ORDER BY eff LIMIT 1",
                  (to_flight["dest"], to_flight["eff"], inb["eff"], need))
    if not later:
        raise GuardViolation(f"BAG PLAN: {pax['id']}'s bag(s) cannot make {to_flight['id']} ({conn} min, bags need {need}) and no later "
                             f"flight to {to_flight['dest']} can carry them, so the rebook does not commit")
    gap = later["eff"] - to_flight["eff"]
    return {**base, "plan": "FORWARD", "bag_flight": later["id"],
            "note": f"Bag(s) {', '.join(bags)} miss the {conn}-min connection (bags need {need}). Routed on {later['id']} to "
                    f"{later['dest']}, about {gap} min after the passenger. Deliver to the passenger's address at {later['dest']}; "
                    f"passenger to be told at the transfer desk and given a delivery reference."}


def _move(con, inb, pax_id, to_fid, seat=None, pax_min=None):
    """Seat + bag plan for ONE passenger. Must run inside a transaction: any raise makes the caller roll back."""
    pax = S.one(con, "SELECT p.*, s.flight_id AS cur FROM passengers p JOIN seats s ON s.pax_id = p.id WHERE p.id = ? AND p.inbound = ?",
                (str(pax_id), inb["id"]))
    if not pax:
        raise GuardViolation(f"{pax_id} is not a connecting passenger of {inb['id']}")
    f = S._get(con, "flights", to_fid, "flight")
    if f["id"] == pax["cur"]:
        raise GuardViolation(f"{pax['id']} is already booked on {f['id']}")
    pax_min = S.MCT if pax_min is None else pax_min
    if f["kind"] != "ONWARD" or f["dest"] != pax["dest"] or f["eff"] - inb["eff"] < pax_min:
        raise GuardViolation(f"{f['id']} is not a valid connection for {pax['id']} (needs an onward flight to {pax['dest']} "
                             f"at least {pax_min} min after on-block)")
    plan = bag_plan(con, inb, pax, f)  # decided BEFORE the seat moves; no bag plan -> no seat
    con.execute("UPDATE seats SET pax_id = NULL WHERE pax_id = ?", (pax["id"],))
    seat = seat or (S.one(con, "SELECT seat_no FROM seats WHERE flight_id = ? AND pax_id IS NULL ORDER BY rowid", (f["id"],)) or {}).get("seat_no")
    if not seat or con.execute("UPDATE seats SET pax_id = ? WHERE flight_id = ? AND seat_no = ? AND pax_id IS NULL",
                               (pax["id"], f["id"], seat)).rowcount != 1:
        raise RuntimeError(f"Seat conflict: {f['id']} {seat or '(none free)'} is no longer available for {pax['id']}")
    status = {"WITH_PASSENGER": "TRANSFER", "FORWARD": "FORWARD"}.get(plan["plan"])
    if status:  # bag stays tagged to its passenger's booking (the existing positive bag-match guard is untouched);
        con.execute("UPDATE bags SET flight_id = ?, status = ? WHERE pax_id = ?", (f["id"], status, pax["id"]))  # routing in cb_bag_plans
        con.executemany("INSERT INTO cb_bag_plans(pax_id, bag_id, pax_flight, bag_flight, connection_min, bag_min, plan, note) "
                        "VALUES (?,?,?,?,?,?,?,?)", [(pax["id"], b, f["id"], plan["bag_flight"], plan["connection_min"],
                                                      plan["bag_min"], plan["plan"], plan["note"]) for b in plan["bags"]])
    return {"pax_id": pax["id"], "tier": pax["tier"], "from": pax["cur"], "to": f["id"], "seat": seat, "bag_status": status,
            "bag_plan": plan}


def _check_bags(con, moves):
    """Before commit: every moved passenger's bags carry a plan, and no bag is on a flight its passenger is not booked on."""
    for m in moves:
        if m["bag_plan"]["bags"] and not con.execute("SELECT COUNT(*) FROM cb_bag_plans WHERE pax_id = ? AND pax_flight = ?",
                                                     (m["pax_id"], m["to"])).fetchone()[0]:
            raise GuardViolation(f"BAG PLAN: {m['pax_id']} has checked bags but no bag plan")
    G.check_bag_match(con)
    if any(S._integrity(con).values()):
        raise RuntimeError("Post-batch integrity check failed")


def _redo_moves(con, moves):
    """Replay of committed moves (state tables only), used by replay.py."""
    for m in moves:
        con.execute("UPDATE seats SET pax_id = NULL WHERE pax_id = ?", (m["pax_id"],))
        if con.execute("UPDATE seats SET pax_id = ? WHERE flight_id = ? AND seat_no = ? AND pax_id IS NULL",
                       (m["pax_id"], m["to"], m["seat"])).rowcount != 1:
            raise RuntimeError(f"Replay seat conflict for {m['pax_id']}")
        if m.get("bag_status"):
            con.execute("UPDATE bags SET flight_id = ?, status = ? WHERE pax_id = ?", (m["to"], m["bag_status"], m["pax_id"]))


def rebook_one(fid, pax_id, to_flight, controller, pin):
    """U-4.4 live test: rebook one passenger. Seat and bag plan commit together or not at all (controller name + PIN)."""
    controller = S._check_pin(controller, pin)
    ensure()
    with closing(S.connect()) as con:
        con.execute("BEGIN IMMEDIATE")
        try:
            inb = S._inbound(con, fid)
            m = _move(con, inb, pax_id, to_flight, pax_min=CB["PAX_FAST_CONNECT_MIN"])
            _check_bags(con, [m])
            S.audit(con, controller, "CB_REBOOK_COMMIT", {"flight": fid, "moves": [_slim(m)], "state_hash": S.state_hash(con)})
            con.execute("DELETE FROM reports WHERE flight_id = ?", (fid,))
            con.execute("COMMIT")
        except Exception as e:  # noqa: BLE001 - any failure rolls back seat AND bag together
            con.execute("ROLLBACK")
            S.audit(con, controller, "CB_REBOOK_ROLLBACK", {"flight": fid, "pax": pax_id, "to": to_flight, "error": str(e)})
            return {"ok": False, "committed": False, "error": str(e), "integrity": S._integrity(con)}
        _notify(con, fid, "Baggage services", m["bag_plan"]["note"])
        return {"ok": True, "committed": True, "move": m, "integrity": S._integrity(con)}


def _slim(m):
    return {k: m[k] for k in ("pax_id", "to", "seat", "bag_status")}


def rebook_options(con, inb):
    """For the U-4.4 picker: connecting passengers and same-destination flights with connection + bag feasibility (read only)."""
    need = bag_min(con, inb)
    pax = S.rows(con, "SELECT p.id, p.tier, p.dest, s.flight_id AS onward, (SELECT COUNT(*) FROM bags b WHERE b.pax_id = p.id) AS bags "
                      "FROM passengers p JOIN seats s ON s.pax_id = p.id WHERE p.inbound = ? ORDER BY p.id", (inb["id"],))
    flights = S.rows(con, f"SELECT id, dest, eff, eff - ? AS conn, (SELECT COUNT(*) FROM seats s WHERE s.flight_id = x.id AND s.pax_id IS NULL) AS free "
                          f"FROM ({S.F_SQL}) x WHERE kind = 'ONWARD' AND eff - ? >= ? ORDER BY eff",
                     (inb["eff"], inb["eff"], CB["PAX_FAST_CONNECT_MIN"]))
    return {"passengers": pax, "flights": [{**f, "bag_ok": f["conn"] >= need} for f in flights], "bag_min": need,
            "pax_min": CB["PAX_FAST_CONNECT_MIN"]}


# =====================================================================================================================
# U-4.1  vulnerable first in their own transaction, then batches of 10; each batch commits or rolls back alone
# =====================================================================================================================
def _plan_group(con, inb, group):
    """Fresh seat plan for one batch (free seats as they are NOW): earliest same-destination flight >= MCT, preferring one
    the bags can also make. Returns (assignments, passengers with no seat)."""
    free = S.rows(con, f"SELECT s.flight_id, s.seat_no, x.dest, x.eff FROM seats s JOIN ({S.F_SQL}) x ON x.id = s.flight_id "
                       "WHERE s.pax_id IS NULL AND x.kind = 'ONWARD' AND x.eff - ? >= ? ORDER BY x.eff, s.rowid", (inb["eff"], S.MCT))
    need, plan, none = bag_min(con, inb), [], []
    for p in G.priority_order(group):
        has_bags = con.execute("SELECT 1 FROM bags WHERE pax_id = ?", (p["id"],)).fetchone()
        same = [s for s in free if s["dest"] == p["dest"]]
        if has_bags:  # U-4.4 inside U-4.1: never plan a seat whose bags would have no legal plan (it would sink the batch)
            same = [s for s in same if s["eff"] - inb["eff"] >= need or _has_bag_plan(con, inb, s)]
        s = next((s for s in same if not has_bags or s["eff"] - inb["eff"] >= need), same[0] if same else None)
        if s:
            free.remove(s)
            plan.append({"pax_id": p["id"], "to": s["flight_id"], "seat": s["seat_no"]})
        else:
            none.append(p["id"])
    return plan, none


def _has_bag_plan(con, inb, seat):
    need = bag_min(con, inb)
    return con.execute(f"SELECT 1 FROM ({S.F_SQL}) x WHERE kind = 'ONWARD' AND dest = ? AND eff > ? AND eff - ? >= ?",
                       (seat["dest"], seat["eff"], inb["eff"], need)).fetchone() is not None


def _external_sale(con, flight_id, seat_no, actor):
    """Chaos: another sales channel sells one of our planned seats and COMMITS (it is not ours to roll back)."""
    n = con.execute("SELECT COUNT(*) FROM passengers WHERE id LIKE 'X-EXT-%'").fetchone()[0] + 1
    pid = f"X-EXT-{n}"
    con.execute("BEGIN IMMEDIATE")
    con.execute("INSERT INTO passengers VALUES (?, 'Booking from another sales channel', 'STANDARD', NULL, NULL, NULL)", (pid,))
    con.execute("UPDATE seats SET pax_id = ? WHERE flight_id = ? AND seat_no = ? AND pax_id IS NULL", (pid, flight_id, seat_no))
    S.audit(con, actor, "CB_EXTERNAL_SALE", {"pax": pid, "flight": flight_id, "seat": seat_no, "state_hash": S.state_hash(con)})
    con.execute("COMMIT")


def _run_batch(con, inb, run_id, n, label, group, inject, actor):
    """One batch = up to MAX_BATCH_ATTEMPTS independent transactions. Returns the batch record."""
    errors, moves, unplaced = [], [], []
    for attempt in range(1, CB["MAX_BATCH_ATTEMPTS"] + 1):
        plan, unplaced = _plan_group(con, inb, group)
        if inject(attempt) and plan:  # live test: a competing booking takes a seat this batch planned to use
            victim = plan[len(plan) // 2]
            _external_sale(con, victim["to"], victim["seat"], "external channel")
        con.execute("BEGIN IMMEDIATE")
        try:
            moves = [_move(con, inb, a["pax_id"], a["to"], a["seat"]) for a in plan]
            _check_bags(con, moves)
            S.audit(con, actor, "CB_BATCH_COMMIT", {"flight": inb["id"], "run": run_id, "batch": n, "attempt": attempt,
                                                    "moves": [_slim(m) for m in moves], "state_hash": S.state_hash(con)})
            con.execute("COMMIT")
            status = "COMMITTED" if attempt == 1 else "COMMITTED_ON_RETRY"
            break
        except Exception as e:  # noqa: BLE001 - this batch only; earlier batches are already committed and stay
            con.execute("ROLLBACK")
            errors.append(f"attempt {attempt}: {e}")
            S.audit(con, actor, "CB_BATCH_ROLLBACK", {"flight": inb["id"], "run": run_id, "batch": n, "attempt": attempt, "error": str(e)})
            moves = []
    else:
        status = "HANDED_TO_CONTROLLER"
    pax_ids = [p["id"] for p in group]
    con.execute("INSERT INTO cb_batches(run_id, batch_no, label, pax_ids, status, attempts, moved, error) VALUES (?,?,?,?,?,?,?,?)",
                (run_id, n, label, json.dumps(pax_ids), status, attempt, len(moves), " | ".join(errors)))
    if status == "HANDED_TO_CONTROLLER":
        _handoff(con, run_id, inb["id"], n, label, pax_ids, "Batch failed twice: " + " | ".join(errors))
    if unplaced and status != "HANDED_TO_CONTROLLER":
        _handoff(con, run_id, inb["id"], n, label, unplaced, "No free seat on a legal connection to their destination")
    return {"batch": n, "label": label, "size": len(group), "status": status, "attempts": attempt, "moved": len(moves),
            "no_seat": unplaced, "errors": errors, "moves": moves}


def _handoff(con, run_id, fid, n, label, pax_ids, reason):
    con.execute("INSERT INTO cb_handoffs(run_id, flight_id, batch_no, label, pax_ids, reason) VALUES (?,?,?,?,?,?)",
                (run_id, fid, n, label, json.dumps(pax_ids), reason[:1000]))
    _notify(con, fid, "Operations Controller", f"Batch {n} ({label}): {len(pax_ids)} passenger(s) handed to you. {reason[:300]}")


def _notify(con, fid, who, msg):
    con.execute("INSERT INTO notifications(change_id, flight_id, recipient, message) VALUES (NULL,?,?,?)", (fid, who, msg[:700]))


def batch_rebook(fid, controller, pin, chaos_batch=None, chaos_repeat=False):
    """U-4.1: ordered atomic transactions. Batch 1 = every at-risk vulnerable passenger; then standard passengers 10 at a time.
    A failure in one batch never undoes an earlier one. If the vulnerable batch cannot commit, the run stops there (giving
    seats to standard passengers first would break the vulnerable-first policy) and everything goes to the controller."""
    controller = S._check_pin(controller, pin)
    chaos_batch = int(chaos_batch) if str(chaos_batch or "").isdigit() else None
    ensure()
    with closing(S.connect()) as con:
        inb = S._inbound(con, fid)
        at_risk = S._at_risk(con, inb)  # already in priority order (vulnerable first)
        vul = [p for p in at_risk if p["tier"] in G.VULNERABLE]
        std = [p for p in at_risk if p["tier"] not in G.VULNERABLE]
        groups = ([("Vulnerable passengers (own transaction)", vul)] if vul else []) + \
                 [(f"Standard passengers {i + 1}-{i + len(std[i:i + CB['BATCH_SIZE']])}", std[i:i + CB["BATCH_SIZE"]])
                  for i in range(0, len(std), CB["BATCH_SIZE"])]
        run_id = con.execute("INSERT INTO cb_runs(flight_id, actor, chaos_batch) VALUES (?,?,?)", (fid, controller, chaos_batch)).lastrowid
        S.audit(con, controller, "CB_BATCH_RUN", {"flight": fid, "run": run_id, "batches": len(groups), "chaos_batch": chaos_batch})
        out, stop = [], None
        for n, (label, group) in enumerate(groups, 1):
            if stop:
                con.execute("INSERT INTO cb_batches(run_id, batch_no, label, pax_ids, status, attempts, moved, error) VALUES (?,?,?,?,?,?,?,?)",
                            (run_id, n, label, json.dumps([p["id"] for p in group]), "HELD", 0, 0, stop))
                _handoff(con, run_id, fid, n, label, [p["id"] for p in group], stop)
                out.append({"batch": n, "label": label, "size": len(group), "status": "HELD", "attempts": 0, "moved": 0,
                            "no_seat": [], "errors": [stop], "moves": []})
                continue
            inject = lambda attempt, n=n: chaos_batch == n and (attempt == 1 or bool(chaos_repeat))  # noqa: E731
            r = _run_batch(con, inb, run_id, n, label, group, inject, controller)
            out.append(r)
            if r["status"] == "HANDED_TO_CONTROLLER" and group is vul:
                stop = "Held: the vulnerable-passenger batch did not commit, so no standard passenger may take a seat first"
        con.execute("DELETE FROM reports WHERE flight_id = ?", (fid,))
        summary = {"batches": len(out), "committed": sum(b["status"].startswith("COMMITTED") for b in out),
                   "retried": sum(b["status"] == "COMMITTED_ON_RETRY" for b in out),
                   "handed_off": sum(b["status"] in ("HANDED_TO_CONTROLLER", "HELD") for b in out),
                   "moved": sum(b["moved"] for b in out), "no_seat": sum(len(b["no_seat"]) for b in out)}
        con.execute("UPDATE cb_runs SET summary = ? WHERE id = ?", (json.dumps(summary), run_id))
        return {"run": run_id, "flight": fid, "summary": summary, "batches": out, "integrity": S._integrity(con)}


def resolve_handoff(hid, controller, pin):
    """Controller takes a handed-off batch and re-runs it as one fresh atomic transaction (no chaos)."""
    controller = S._check_pin(controller, pin)
    ensure()
    with closing(S.connect()) as con:
        h = S.one(con, "SELECT * FROM cb_handoffs WHERE id = ? AND status = 'OPEN'", (int(hid),))
        if not h:
            raise ValueError(f"No open hand-off #{hid}")
        inb = S._inbound(con, h["flight_id"])
        still = {p["id"]: p for p in S._at_risk(con, inb)}
        group = [still[p] for p in json.loads(h["pax_ids"]) if p in still]
        r = _run_batch(con, inb, h["run_id"], h["batch_no"], f"{h['label']} (controller re-run)", group, lambda _a: False, controller)
        if r["status"].startswith("COMMITTED"):
            con.execute("UPDATE cb_handoffs SET status = 'RESOLVED', resolved_by = ? WHERE id = ?", (controller, h["id"]))
        return {"handoff": h["id"], **r}


# =====================================================================================================================
# U-4.2  crew-channel text is data; duty counters are read-only; legal crew only, staged for controller approval
# =====================================================================================================================
PRESSURE = re.compile(r"\b(extend|extension|push|waive|override|exceed|ignore|happy to|agree|discretion|stretch|limit)", re.I)


def _stage_once(fid, title, actions):
    """Stage for controller approval, unless the same actions are already PENDING (repeat messages must not flood the queue)."""
    want = json.dumps(S._clean_actions(actions))
    with closing(S.connect()) as con:
        dup = S.one(con, "SELECT id FROM changes WHERE flight_id = ? AND status = 'PENDING' AND actions = ?", (fid, want))
    return {"id": dup["id"], "status": "PENDING", "reason": "", "reused": True} if dup else         S.stage_controller_schedule_change(fid, title, actions, "Crew-legality check (code)")


def _duty_snapshot(con):
    return S.rows(con, "SELECT id, duty_used FROM crew ORDER BY id")


def _llm_reads_message(fid, sender, text):
    """The real AI planner reads the crew message (as data inside <state>, like any call transcript) and proposes recovery
    options. Code then dry-runs every option through the guards. Shows on screen that the LLM's ideas are checked, not trusted.
    If the LLM is unavailable this says so; nothing is faked."""
    try:
        d = S.get_turnaround_and_crew_state(fid)
        state = agent.summarize(d)
        state["call_transcripts"].insert(0, {"at": "now", "speaker": agent.clean(sender, 40), "text": agent.clean(text, 500)})
        plan = agent.validate(agent.call_llm(state))
    except agent.LLMUnavailable as e:
        return {"source": "unavailable", "error": str(e), "options": []}
    opts = []
    for sug in plan["suggestions"]:
        sim = S.simulate(fid, sug["actions"]) if sug["actions"] else {"ok": False, "reason": "No actions proposed"}
        opts.append({"title": sug["title"], "why": sug["why"], "actions": sug["actions"], "guards_ok": sim["ok"], "guard_reason": sim["reason"]})
    illegal = d["kpis"]["crew_illegal"] > 0
    return {"source": f"LLM · {agent.MODEL}", "report": plan["report"][:700], "options": opts, "dropped_actions": plan["dropped_actions"],
            # the brief's failure mode: a release with the CURRENT (illegal) crew getting through. Must always be False.
            "release_with_current_crew_passed": illegal and any(o["guards_ok"] and any(a["kind"] == "DEPARTURE_RELEASE" for a in o["actions"])
                                                                and not any(a["kind"] in ("CREW_AUTOSWAP", "CREW_SWAP") for a in o["actions"])
                                                                for o in opts)}


def crew_message(fid, sender, text):
    """Log a crew-channel message as DATA and work out the only legal path to departure in Python. Nothing in the text is
    executed or parsed into an action; it can neither change duty counters nor approve anything."""
    text, sender = str(text or "").strip()[:1000], str(sender or "Crew channel").strip()[:60]
    if not text:
        raise ValueError("Message is empty")
    ensure()
    with closing(S.connect()) as con:
        inb = S._inbound(con, fid)
        out = S._get(con, "flights", inb["next_leg"], "flight")
        before = _duty_snapshot(con)
        slip = S._departure_slip(con, inb, out)  # judged at the real departure, like the pages, the Crew agent and CREW_AUTOSWAP
        crew, taken = [], set()  # each reserve is suggested to one person only (CREW_AUTOSWAP assigns them the same way)
        for m in S._rotation(con, inb):
            wait = slip if m["duty_used"] else 0  # crew already on duty keep using duty while the departure slips
            fdp = G.projected_fdp(m, out) + wait
            try:
                G.check_crew_duty(m, out, wait)
                legal, why = True, ""
            except GuardViolation as e:
                legal, why = False, str(e)
            opts = [s for s in S._standby_options(con, m, out, slip) if s["id"] not in taken] if not legal else []
            taken |= {opts[0]["id"]} if opts else set()
            crew.append({"id": m["id"], "name": m["name"], "role": m["role"], "duty_used": m["duty_used"],
                         "minutes_to_limit": S.MAX - m["duty_used"], "minutes_needed": fdp - m["duty_used"], "projected_fdp": fdp,
                         "legal": legal, "reason": why, "reserve": opts[0]["id"] if opts else None})
        illegal = [c for c in crew if not c["legal"]]
        no_reserve = [c for c in illegal if not c["reserve"]]
        flagged = bool(PRESSURE.search(text))
    # staging opens its own connection, so do it after the read above is closed
    staged, path, blocked_by = None, "", ""
    if no_reserve:
        path = (f"No legal path: {', '.join(c['id'] for c in no_reserve)} cannot legally operate and no legal reserve exists. "
                f"Departure stays held; nothing staged.")
    else:
        crew_acts = [{"kind": "CREW_AUTOSWAP", "flight_id": fid}] if illegal else []
        full = crew_acts + [{"kind": "DEPARTURE_RELEASE", "flight_id": out["id"]}]
        sim = S.simulate(fid, full)
        if sim["ok"]:
            staged = _stage_once(fid, f"{out['id']}: {'reserve crew + ' if illegal else ''}departure release (crew-message check)", full)
            path = f"{'Reserve crew for ' + str(len(illegal)) + ' member(s), then ' if illegal else 'Current crew is legal; '}departure release staged for controller approval."
        elif crew_acts:
            blocked_by = sim["reason"]
            staged = _stage_once(fid, f"{out['id']}: reserve crew (crew-message check)", crew_acts)
            path = f"Reserve crew staged for controller approval. Departure release is still blocked by another guard: {blocked_by}"
        else:
            blocked_by = sim["reason"]
            path = f"Crew is legal, but departure is blocked by another guard: {blocked_by}"
    llm = _llm_reads_message(fid, sender, text)
    with closing(S.connect()) as con:
        after = _duty_snapshot(con)
        outcome = ("Message stored as data. It cannot change duty limits or duty counters. " if flagged else "Message stored as data. ") + path
        mid = con.execute("INSERT INTO cb_crew_msgs(flight_id, sender, text, flagged, outcome, change_id, llm) VALUES (?,?,?,?,?,?,?)",
                          (fid, sender, text, int(flagged), outcome, staged and staged["id"], json.dumps(llm))).lastrowid
        S.audit(con, sender, "CB_CREW_MESSAGE", {"flight": fid, "msg": mid, "flagged": flagged, "staged": staged, "llm_source": llm["source"],
                                                 "llm_options_passing_guards": sum(o["guards_ok"] for o in llm["options"])})
        _notify(con, fid, "Crew control", f"Crew-channel message logged (#{mid}). Duty limits are legal limits; no message can change them. {path}")
        return {"message_id": mid, "treated_as": "data", "flagged_as_pressure": flagged, "crew": crew,
                "duty_counters_unchanged": before == after, "staged": staged, "path": path, "blocked_by": blocked_by, "llm": llm,
                "limits": {"MAX_FDP_MIN": S.MAX}}


# =====================================================================================================================
# U-4.3  every maintenance sign-off validated in Python
# =====================================================================================================================
def _parse_time(s):
    try:
        return datetime.fromisoformat(str(s).strip().replace("Z", ""))
    except ValueError:
        return None


def validate_signoff(con, item_id, engineer_id, signed_at):
    """Pure check (no writes). Returns (ok, reasons, context)."""
    item = S._get(con, "maintenance", item_id, "maintenance item")
    inb = S.one(con, S.F_SQL + " WHERE kind = 'INBOUND' AND tail = ?", (item["tail"],))
    actype = inb["aircraft_type"] if inb else None
    defect = S.one(con, "SELECT opened_at FROM cb_defects WHERE item_id = ?", (item["id"],))
    reasons = []
    eng = S.one(con, "SELECT id, name FROM engineers WHERE id = ?", (str(engineer_id or ""),))
    if not eng:
        reasons.append(f"Engineer ID {engineer_id!r} is not on the licensed roster")
    elif actype not in G.ENGINEER_TYPES.get(eng["id"], ()):
        reasons.append(f"Engineer {eng['id']} ({eng['name']}) is not licensed for the {actype}")
    t = _parse_time(signed_at)
    opened = _parse_time(defect["opened_at"]) if defect else None
    if t is None:
        reasons.append(f"Sign-off time {signed_at!r} is not a valid timestamp")
    elif opened is None:
        reasons.append(f"No defect-opened time on record for {item['id']}; cannot verify the sign-off order")
    elif t <= opened:
        reasons.append(f"Sign-off time {t:%Y-%m-%d %H:%M} is before the defect was opened ({opened:%Y-%m-%d %H:%M})")
    elif t > datetime.now() + timedelta(minutes=CB["SIGNOFF_FUTURE_TOLERANCE_MIN"]):
        reasons.append(f"Sign-off time {t:%Y-%m-%d %H:%M} is in the future")
    if item["status"] == "SIGNED":
        reasons.append(f"{item['id']} is already signed off")
    return not reasons, reasons, {"item": item, "engineer": eng, "aircraft_type": actype, "opened_at": defect and defect["opened_at"]}


def submit_signoff(item_id, engineer_id, signed_at, result="OK"):
    """A sign-off record arrives (e.g. 'hydraulic inspection OK'). Valid -> item SIGNED (departure guard can clear).
    Invalid -> item stays open, departure stays blocked, maintenance control is alerted."""
    ensure()
    with closing(S.connect()) as con:
        con.execute("BEGIN IMMEDIATE")
        try:
            ok, reasons, ctx = validate_signoff(con, item_id, engineer_id, signed_at)
            item = ctx["item"]
            fid = (S.one(con, "SELECT id FROM flights WHERE kind = 'INBOUND' AND tail = ?", (item["tail"],)) or {}).get("id")
            con.execute("INSERT INTO cb_signoffs(item_id, engineer_id, result, signed_at, valid, reasons) VALUES (?,?,?,?,?,?)",
                        (item["id"], str(engineer_id)[:40], str(result)[:40], str(signed_at)[:40], int(ok), json.dumps(reasons)))
            if ok:
                eng = S.one(con, "SELECT * FROM engineers WHERE id = ?", (ctx["engineer"]["id"],))
                con.execute("UPDATE maintenance SET engineer_id = ? WHERE id = ?", (eng["id"], item["id"]))
                S._sign(con, item, eng)
                S.audit(con, eng["name"], "CB_SIGNOFF_VALID", {"item": item["id"], "engineer": eng["id"], "signed_at": signed_at,
                                                               "state_hash": S.state_hash(con)})
                S.record_signoff(con, fid, item, eng["name"], f"{item['id']} ({item['item']}) sign-off validated: {eng['name']}, "
                                                              f"licensed for {ctx['aircraft_type']}, signed after the defect was opened")
            else:
                S.audit(con, "maintenance feed", "CB_SIGNOFF_REJECTED", {"item": item["id"], "engineer": engineer_id,
                                                                         "signed_at": signed_at, "reasons": reasons})
                _notify(con, fid, "Maintenance control (ALERT)", f"Suspicious sign-off on {item['id']} ({item['item']}) rejected: "
                                                                 + "; ".join(reasons) + ". Departure remains blocked.")
            con.execute("COMMIT")
        except Exception:
            con.execute("ROLLBACK")
            raise
        nogo = con.execute("SELECT COUNT(*) FROM maintenance WHERE tail = ? AND severity = 'NO-GO' AND status <> 'SIGNED'",
                           (item["tail"],)).fetchone()[0]
        return {"valid": ok, "reasons": reasons, "item": item["id"], "aircraft_type": ctx["aircraft_type"],
                "defect_opened_at": ctx["opened_at"], "status": "SIGNED" if ok else item["status"],
                "departure_blocked": nogo > 0, "open_nogo_on_tail": nogo,
                "alerted": None if ok else "Maintenance control"}


# =====================================================================================================================
# read model for the Curveballs tab + replay hook
# =====================================================================================================================
def view(fid):
    ensure()
    with closing(S.connect()) as con:
        inb = S._inbound(con, fid)
        run = S.one(con, "SELECT * FROM cb_runs WHERE flight_id = ? ORDER BY id DESC LIMIT 1", (fid,))
        mx = S.rows(con, "SELECT m.id, m.item, m.severity, m.status, m.signed_by, d.opened_at FROM maintenance m "
                         "LEFT JOIN cb_defects d ON d.item_id = m.id WHERE m.tail = ? ORDER BY m.id", (inb["tail"],))
        return {
            "flight": {k: inb[k] for k in ("id", "origin", "eff", "delay_min", "tail", "aircraft_type", "next_leg")},
            "flights": [r["id"] for r in S.rows(con, "SELECT id FROM flights WHERE kind = 'INBOUND' ORDER BY id")],
            "limits": dict(CB), "at_risk": len(S._at_risk(con, inb)),
            "run": run and {**run, "summary": json.loads(run["summary"] or "{}"),
                            "batches": S.rows(con, "SELECT * FROM cb_batches WHERE run_id = ? ORDER BY batch_no, id", (run["id"],))},
            "handoffs": S.rows(con, "SELECT * FROM cb_handoffs WHERE flight_id = ? ORDER BY id DESC LIMIT 30", (fid,)),
            "crew_messages": S.rows(con, "SELECT * FROM cb_crew_msgs WHERE flight_id = ? ORDER BY id DESC LIMIT 20", (fid,)),
            "maintenance": mx,
            "signoffs": S.rows(con, "SELECT * FROM cb_signoffs WHERE item_id IN (SELECT id FROM maintenance WHERE tail = ?) "
                                    "ORDER BY id DESC LIMIT 20", (inb["tail"],)),
            "roster": [{"engineer_id": e["id"], "name": e["name"], "types": ", ".join(sorted(G.ENGINEER_TYPES.get(e["id"], ())))}
                       for e in S.rows(con, "SELECT id, name FROM engineers ORDER BY id") if e["id"] in G.ENGINEER_TYPES],
            "rebook": rebook_options(con, inb),
            "bag_plans": S.rows(con, "SELECT b.* FROM cb_bag_plans b JOIN passengers p ON p.id = b.pax_id WHERE p.inbound = ? "
                                     "ORDER BY b.id DESC LIMIT 30", (fid,)),
            "now": datetime.now().strftime("%Y-%m-%dT%H:%M"),
        }


def redo(con, ev, d):
    """Audit replay of curveball state changes (called by replay.py inside its transaction; writes state tables only)."""
    if ev in ("CB_BATCH_COMMIT", "CB_REBOOK_COMMIT"):
        _redo_moves(con, d.get("moves", []))
    elif ev == "CB_EXTERNAL_SALE":
        con.execute("INSERT OR IGNORE INTO passengers VALUES (?, 'Booking from another sales channel', 'STANDARD', NULL, NULL, NULL)",
                    (d["pax"],))
        con.execute("UPDATE seats SET pax_id = ? WHERE flight_id = ? AND seat_no = ?", (d["pax"], d["flight"], d["seat"]))
    elif ev == "CB_SIGNOFF_VALID":
        item = S._get(con, "maintenance", d["item"], "maintenance item")
        con.execute("UPDATE maintenance SET engineer_id = ? WHERE id = ?", (d["engineer"], item["id"]))
        S._sign(con, item, S.one(con, "SELECT * FROM engineers WHERE id = ?", (d["engineer"],)))
