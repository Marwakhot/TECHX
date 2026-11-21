"""The live-demo workflow on AZ410, end to end, exactly as the presenter runs it (LLM offline: every agent falls back to rules).
on time -> delay call -> three agents -> maintenance fixed -> hub plan approved -> release -> decision log -> audit replay -> guard attacks."""
import json
import time

import pytest

import agent
import ledger
import monitor
import redteam
import replay
import seed
import services as S
import specialists as SP

PIN, FID = "4321", "AZ410"
LICENCE = {e[0]: e[2] for e in seed.ENGINEERS}


@pytest.fixture(autouse=True)
def db(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DB", str(tmp_path / "test.sqlite"))
    monkeypatch.setattr(S, "_pin_failures", 0)
    monkeypatch.setenv("OCC_CONTROLLER_PIN", PIN)
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monitor.reset()
    seed.build(S.DB)


def flight():
    return next(f for f in S.list_flights() if f["id"] == FID)


def follow(r):
    for _ in range(300):
        v = monitor.live(FID, r["since"])
        if v["run"] == r["run"] and v["status"] == "done":
            return v
        time.sleep(0.2)
    raise AssertionError("agents did not finish")


def hub_ok(k):
    """The Decision hub's five checks (app.js hubChecks): all must be green before the plan can be approved."""
    return (not k["at_risk"] and not k["vulnerable_at_risk"] and not (k["bags_rush"] + k["bags_short_connection"])
            and not k["crew_illegal"] and k["crew_min_margin"] >= 0 and not k["open_nogo"] and k["onward_delay_added"] <= 30)


def test_live_demo_workflow():
    # 1. on time: the problems are latent, nobody recommends anything
    f = flight()
    assert f["delay_min"] == 0 and f["at_risk"] == 0 and f["crew_illegal"] == 0
    assert agent.get_report(FID)["on_time"] and SP.crew(FID)["picks"] == []
    monitor.tick(force=True)

    # 2. the delay is stated on a call: the three agents respond, each with something to fix
    v = follow(monitor.call_logged(FID, "Dispatch AZ410", "AZ410 now estimating 60 minutes late, ATC holding over the Alps."))
    assert flight()["delay_min"] == 60 and "REPLANNED" in [e["kind"] for e in v["events"]]
    crew, pax, mx = SP.crew(FID), SP.passengers(FID), SP.maintenance_for(FID)
    assert {p["role"] for p in crew["picks"]} == {"CPT", "FO"} and crew["guard"]["ok"]
    hold = next(h for h in pax["holds"] if h["flight_id"] == "LH1830")
    assert hold["recommended"] and hold["covers_bags"] and hold["minutes"] <= 30 and len(pax["picks"]) == 10
    assert mx["actions"][0]["item_id"] == "M-6" and mx["release_slip_min"] > 0
    sug = agent.get_report(FID)["suggestions"]  # each a different plan (bags need 45 min like passengers here: no "shorter hold")
    assert len(sug) >= 2 and len({json.dumps(s["actions"], sort_keys=True) for s in sug}) == len(sug)

    # 3. maintenance page: assign the agent's engineer (PIN), the engineer signs off with their licence
    eng = mx["actions"][0]["engineer_id"]
    assert S.decide(FID, "Assign engineer", mx["actions"], "Ops", PIN)["status"] == "APPROVED"
    assert S.sign_off_maintenance("M-6", LICENCE[eng])["status"] == "SIGNED"
    monitor.tick(force=True)  # the background agent notices and re-plans

    # 4. decision hub: at least one scenario has all five checks green; approve it
    lab = agent.scenario_lab(FID, {"connections": True})
    ready = [s for s in lab["scenarios"] if s["ok"] and hub_ok(s["kpis"])]
    assert ready, [(s["title"], s["kpis"]) for s in lab["scenarios"]]
    assert {a["kind"] for a in ready[0]["actions"]} >= {"CREW_SWAP", "REBOOK"}
    gap, out = flight()["turn_gap"], S.get_turnaround_and_crew_state(FID)["outbound"]["id"]
    assert all(max([a["minutes"] for a in s["actions"] if a["kind"] == "DELAY" and a["flight_id"] == out] or [0]) >= gap
               for s in lab["scenarios"] if s["actions"])  # nobody leaves before the turnaround is done
    assert not any(a["kind"] == "DEPARTURE_RELEASE" for s in lab["scenarios"] for a in s["actions"])  # released later, when ready
    assert S.decide(FID, ready[0]["title"], ready[0]["actions"], "Ops", PIN, origin="Decision hub")["status"] == "APPROVED"
    # the Decision log lists it (via /api/hub) with where it was decided, who approved it and its dry-run effect
    plan = next(x for x in S.hub_status(FID)["decisions"] if x["title"] == ready[0]["title"])
    assert plan["source"] == "Decision hub · Ops" and plan["by"] == "Ops" and plan["kpis"]["at_risk"] == 0
    f = flight()
    assert f["at_risk"] == 0 and f["crew_illegal"] == 0 and f["open_nogo"] == 0

    # 5. decision log: the AZ410 departure call is offered there (and only there); the release it decides is now legal
    assert [c["id"] for c in ledger.view(FID)["demo_calls"]] == ["az410"] and not ledger.view("UA960")["demo_calls"]
    out = S.get_turnaround_and_crew_state(FID)["outbound"]["id"]
    assert S.decide(FID, "Release", [{"kind": "DEPARTURE_RELEASE", "flight_id": out}], "Ops", PIN)["status"] == "APPROVED"

    # 6. audit replay reproduces every step; 7. guard attack mode refuses everything and changes nothing
    assert replay.run()["verified"]
    rp = replay.run(FID)  # per flight: the whole log is verified, each step carries its flight and AZ410's figures
    mine = [s["action"] for s in rp["steps"] if s["flight"] == FID]
    assert rp["verified"] and {"ETA_UPDATED", "CHANGE_APPROVED", "MAINTENANCE_SIGNED"} <= set(mine)
    assert rp["steps"][-1]["kpis"]["outbound_status"] == "RELEASED" and rp["steps"][0]["kpis"]["open_nogo"] == 1
    r = redteam.run(FID, "fixed")
    assert r["state_unchanged"] and r["committed"] == 0 and len(r["attacks"]) >= 8
