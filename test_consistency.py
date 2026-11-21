"""Offline tests that one action shows up the same way in every section (Connecting passengers, Decision hub, Maintenance,
Crew, Ledger, overview KPIs). The LLM is never called: each test checks what CODE guarantees."""
import json
from contextlib import closing

import pytest

import agent
import curveballs
import ledger
import monitor
import pax_impact
import seed
import services as S
import specialists
from guards import GuardViolation, LIMITS

PIN = "2468"


@pytest.fixture(autouse=True)
def fresh_db(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DB", str(tmp_path / "test.sqlite"))
    monkeypatch.setattr(S, "_pin_failures", 0)
    monkeypatch.setenv("OCC_CONTROLLER_PIN", PIN)
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monitor.reset()
    seed.build(S.DB)
    curveballs.ensure()


def row(fid, pid):
    return next(r for r in pax_impact.analyse(fid)["passengers"] if r["ref"] == pid)


def test_curveballs_rebook_with_forwarded_bag_shows_the_same_everywhere():
    r = curveballs.rebook_one("AC876", "P0029", "LH902", "Ctl", PIN)  # 35-min connection: >= 30 for a rebook, bag needs 45
    assert r["ok"] and r["move"]["bag_plan"]["plan"] == "FORWARD"
    fwd = r["move"]["bag_plan"]["bag_flight"]
    p = row("AC876", "P0029")
    assert p["status"] == "Rebooked" and p["mct_min"] == LIMITS["REBOOKED_MCT_MIN"] and not p["missing"]
    assert p["bag_forwarded"] == fwd and any(fwd in f for f in p["factors"])
    assert not pax_impact.analyse("AC876")["data"]["conflicts"]
    d = S.get_turnaround_and_crew_state("AC876")
    assert not next(x for x in d["passengers"] if x["id"] == "P0029")["at_risk"] and d["kpis"]["at_risk"] == 0
    assert "P0029" not in {x["id"] for x in specialists.pax_facts("AC876")["passengers"]}  # the agents do not rebook them again
    hub = S.hub_status("AC876")["decisions"]
    assert any(x["title"] == "Rebooked P0029 to LH902" and x["status"] == "APPROVED" for x in hub)
    group = next(g for g in agent._pax_groups(d) if any(x["id"] == "P0029" for x in g["pax"]))
    assert group["bag_status"] == "FORWARD"  # the passenger message says the bag follows, not that it travels with them


def test_direct_rebook_counts_only_with_a_named_controller():
    S.execute_atomic_passenger_rebook("ET706", approved_by="Ctl")
    rows = [r for r in pax_impact.analyse("ET706")["passengers"] if r["itinerary"][1]["kind"].endswith(")")]  # moved
    assert rows and all(r["status"] == "Rebooked" and not r["missing"] for r in rows)
    assert any(x["title"].startswith("Rebooked") and x["by"] == "Ctl" for x in S.hub_status("ET706")["decisions"])
    S.execute_atomic_passenger_rebook("EK812")  # system path, no named approval: flagged, and not a decision
    assert pax_impact.analyse("EK812")["data"]["conflicts"] and not S.hub_status("EK812")["decisions"]


def test_batch_rebook_shows_its_real_outcome():
    r = curveballs.batch_rebook("MS785", "Ctl", PIN)
    moved = r["summary"]["moved"]
    assert moved and sum(x["status"] == "Rebooked" for x in pax_impact.analyse("MS785")["passengers"]) == moved
    entry = next(x for x in S.hub_status("MS785")["decisions"] if x["title"].startswith("Batch rebooking run"))
    assert entry["status"] == "APPROVED" and f"{moved} passenger(s) moved" in entry["title"]


def test_one_licence_roster_for_assignment_offer_and_sign_off():
    monitor.apply_eta("AZ410", 60, "test")
    sim = S.simulate("AZ410", [{"kind": "ASSIGN_ENGINEER", "item_id": "M-6", "engineer_id": "E1"}])
    assert not sim["ok"] and "ENGINEER LICENCE" in sim["reason"]  # E1 is not licensed for the A320
    q ={i["id"]: i for i in S.maintenance_queue()["items"]}
    assert {o["id"] for o in q["M-6"]["options"]} == {"E2", "E3"} and {o["id"] for o in q["M-1"]["options"]} == {"E1", "E2"}
    assert all(p["engineer_id"] in {"E2", "E3"} for p in specialists.maintenance()["picks"] if p["item_id"] in ("M-3", "M-6"))
    with closing(S.connect()) as con:  # an assignment made before the roster was enforced cannot be signed off
        con.execute("UPDATE maintenance SET engineer_id = 'E1', status = 'ASSIGNED' WHERE id = 'M-6'")
    with pytest.raises(GuardViolation, match="not licensed"):
        S.sign_off_maintenance("M-6", "B1-20417")


def test_curveballs_sign_off_shows_in_hub_history_and_notifications():
    r = curveballs.submit_signoff("M-6", "E2", S.one(S.connect(), "SELECT datetime('now','localtime') AS t")["t"])
    assert r["valid"], r["reasons"]  # M-6 has a defect-opened time now
    assert any(x["title"] == "Maintenance sign-off M-6" and x["status"] == "APPROVED" for x in S.hub_status("AZ410")["decisions"])
    assert next(i for i in S.maintenance_queue()["items"] if i["id"] == "M-6")["history"][-1]["what"] == "Signed off"
    assert any("M-6" in n["message"] for n in S.decisions()["notifications"])


def test_crew_legality_is_the_same_on_every_page():
    monitor.apply_eta("AZ410", 60, "test")  # AZ411 really leaves 50 min late; captain and first officer run out of duty
    d = S.get_turnaround_and_crew_state("AZ410")
    illegal = {c["id"] for c in d["crew"] if c["margin"] < 0}
    assert illegal == {"AZ410-1", "AZ410-2"} and d["kpis"]["crew_illegal"] == 2
    assert {c["id"] for c in specialists.crew_facts("AZ410", d)["crew"]} == illegal
    assert next(f for f in S.list_flights() if f["id"] == "AZ410")["crew_illegal"] == 2
    assert S.simulate("AZ410", [{"kind": "CREW_AUTOSWAP", "flight_id": "AZ410"}])["kpis"]["crew_illegal"] == 0


def test_ledger_shows_a_rejected_decision_as_rejected():
    cid = ledger.start_call("EK812", "t")["call_id"]
    ledger.add_line(cid, "OCC", "Call out the reserve crew.")
    with closing(S.connect()) as con:
        iid = con.execute("INSERT INTO ledger_items(call_id, flight_id, kind, problem, summary, line_n, actions, status) "
                          "VALUES (?, 'EK812', 'DECISION', 'Crew', 's', 1, ?, 'CONFIRMED')",
                          (cid, json.dumps([{"kind": "CREW_AUTOSWAP", "flight_id": "EK812"}]))).lastrowid
    staged = ledger.send_for_approval(iid)
    S.approve_change(staged["id"], "Ctl", PIN, approve=False)
    v = ledger.view("EK812")
    assert next(i for i in v["items"] if i["id"] == iid)["status"] == "REJECTED"
    assert next(b for b in v["board"] if b["problem"] == "Crew")["state"] == "OPEN"


def test_inbound_retime_is_dropped_and_option_titles_stay_distinct():
    d = S.get_turnaround_and_crew_state("AI131")
    s = agent.drop_noops(d, [{"title": "x", "actions": [{"kind": "DELAY", "flight_id": "AI131", "minutes": 25},
                                                       {"kind": "DELAY", "flight_id": "AI132", "minutes": 10}]}])
    assert s[0]["actions"] == [{"kind": "DELAY", "flight_id": "AI132", "minutes": 10}]
    a = {"kind": "DELAY", "flight_id": "AI132", "minutes": 10}
    out, _ = agent.distinct([{"title": "Protect Connections", "actions": [a]}, {"title": "Other", "actions": [a]}],
                            [{"title": "Protect connections", "actions": [{**a, "minutes": 20}]}])
    assert len({x["title"].lower() for x in out}) == 2


def test_every_gate_in_use_is_in_the_gates_table():
    with closing(S.connect()) as con:
        gates = {g["id"]: g["occupied_by"] for g in S.rows(con, "SELECT * FROM gates")}
        flights = S.rows(con, "SELECT id, gate FROM flights WHERE gate IS NOT NULL")
    assert all(f["gate"] in gates and gates[f["gate"]] == f["id"] for f in flights)
    assert all(occ is None or any(f["id"] == occ and f["gate"] == g for f in flights) for g, occ in gates.items())
