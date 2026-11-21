"""Specialist agents (specialists.py) + orchestrator (agent.get_report). LLM mocked; offline = rule fallback."""
import json
from contextlib import closing

import pytest

import agent
import monitor
import pax_impact
import seed
import services as S
import specialists as SP

PIN = "4321"


@pytest.fixture(autouse=True)
def db(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DB", str(tmp_path / "test.sqlite"))
    monkeypatch.setattr(S, "_pin_failures", 0)
    monkeypatch.setenv("OCC_CONTROLLER_PIN", PIN)
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monitor.reset()
    seed.build(S.DB)


def fake_llm(monkeypatch, replies):
    """replies: {system prompt: dict or callable(user)}; any other system -> LLM unavailable (rule fallback)."""
    calls = []

    def f(system, user, **kw):
        calls.append((system, user))
        if system in replies:
            r = replies[system]
            return r(user) if callable(r) else r
        raise agent.LLMUnavailable("offline test")
    monkeypatch.setattr(agent, "llm_json", f)
    return calls


def facts_in(user):
    return json.loads(user[len("<facts>"):-len("</facts>")])


# ---------- each specialist works on its own, offline ----------
def test_offline_specialists_use_rules_and_pass_the_guards():
    t = SP.team("EK812")
    assert all(v["source"].startswith("Rule-based") and v["guard"]["ok"] for v in t.values())
    c = t["crew"]
    standby = [p["standby_id"] for p in c["picks"]]
    assert len(c["picks"]) == 6 and len(set(standby)) == 6 and all(a["kind"] == "CREW_SWAP" for a in c["actions"])
    p = t["passengers"]
    first = {x["pax_id"] for x in p["picks"][:sum(x["protected"] for x in p["picks"])]}
    assert all(x["protected"] for x in p["picks"] if x["pax_id"] in first)  # vulnerable passengers get seats first
    assert t["maintenance"]["actions"] == [{"kind": "ASSIGN_ENGINEER", "item_id": "M-1", "engineer_id": "E1"}]


def test_orchestrator_builds_scenarios_from_specialist_bundles_offline():
    rep = agent.get_report("EK812")
    assert set(rep["agents"]) == {"crew", "passengers", "maintenance"} and "Crew agent:" in rep["report"]
    crew = SP.crew("EK812")["actions"]
    for s in rep["suggestions"]:
        assert all(a in s["actions"] for a in crew) and {"kind": "ASSIGN_ENGINEER", "item_id": "M-1", "engineer_id": "E1"} in s["actions"]
    lab = agent.scenario_lab("EK812", {"connections": True})
    assert all(s["ok"] and s["kpis"]["crew_illegal"] == 0 and s["kpis"]["vulnerable_at_risk"] == 0 for s in lab["scenarios"])


def test_small_rebooking_uses_the_passenger_agents_chosen_flights():
    pax = SP.passengers("MS785")
    rep = agent.get_report("MS785")
    on_time = next(s for s in rep["suggestions"] if s["title"] == "On-time network")
    moves = {a["pax_id"]: a["to_flight"] for a in on_time["actions"] if a["kind"] == "REBOOK"}
    assert moves == {x["pax_id"]: x["to_flight"] for x in pax["picks"]} and S.simulate("MS785", on_time["actions"])["ok"]


# ---------- the LLM decides, code checks ----------
def test_valid_llm_picks_are_used_and_invalid_ones_replaced_by_rules(monkeypatch):
    f = SP.crew_facts("EK812")
    m = next(c for c in f["crew"] if len(c["options"]) > 1)
    other = next(c for c in f["crew"] if c["id"] != m["id"])
    second = m["options"][1]["id"]
    fake_llm(monkeypatch, {SP.CREW_SYSTEM: {"picks": [
        {"crew_id": m["id"], "standby_id": second, "reason": "Keeps the most duty margin"},
        {"crew_id": other["id"], "standby_id": second, "reason": "duplicate standby"},          # same standby twice
        {"crew_id": "C-NOPE", "standby_id": "S-NOPE", "reason": "not on the list"}]}})
    c = SP.crew("EK812")
    by = {p["crew_id"]: p for p in c["picks"]}
    assert by[m["id"]]["standby_id"] == second and by[m["id"]]["by"] == "LLM" and by[m["id"]]["reason"] == "Keeps the most duty margin"
    assert by[other["id"]]["by"] == "rules" and by[other["id"]]["standby_id"] != second
    assert c["source"].startswith("LLM") and c["llm_picks"] == 1 and c["guard"]["ok"]


def test_llm_that_picks_nothing_usable_is_labelled_as_rules(monkeypatch):
    fake_llm(monkeypatch, {SP.CREW_SYSTEM: {"picks": [{"crew_id": "X", "standby_id": "Y"}]}})
    assert SP.crew("EK812")["source"].startswith("Rule-based fallback (the LLM picked nothing")


def test_specialist_redecides_only_when_its_area_changes(monkeypatch):
    calls = fake_llm(monkeypatch, {SP.CREW_SYSTEM: {"picks": []}})
    SP.crew("EK812")
    SP.crew("EK812")
    assert sum(s == SP.CREW_SYSTEM for s, _ in calls) == 1  # same facts: cached, no second LLM call
    a = SP.crew("EK812")["actions"][0]
    S.decide("EK812", "swap", [a], "Ops", PIN)  # an approved swap changes the crew picture
    again = SP.crew("EK812")
    assert sum(s == SP.CREW_SYSTEM for s, _ in calls) == 2 and a["crew_id"] not in {p["crew_id"] for p in again["picks"]}
    with closing(S.connect()) as con:
        assert S.rows(con, "SELECT * FROM agent_events WHERE kind = 'CREW_AGENT' AND flight_id = 'EK812'")


def test_passenger_agent_sees_no_names_or_care_category(monkeypatch):
    calls = fake_llm(monkeypatch, {SP.PAX_SYSTEM: {"holds": [], "picks": []}})
    SP.passengers("EK812")
    sent = facts_in(next(u for s, u in calls if s == SP.PAX_SYSTEM))
    pax = json.dumps([sent["passengers"], sent["hold_options"]])  # (ops call lines are free text, as in the live report)
    with closing(S.connect()) as con:
        names = [r["name"] for r in S.rows(con, "SELECT name FROM passengers WHERE inbound = 'EK812'")]
    assert not any(n in json.dumps(sent) for n in names) and not any(t in pax for t in ('"UM"', "PRM", "MEDICAL", "INFANT", "ELDERLY"))
    assert '"care": "protected"' in pax


def test_passenger_page_and_approval_follow_the_agents_pick(monkeypatch):
    fid = "QR069"
    p = next(x for x in SP.pax_facts(fid)["passengers"] if len([a for a in x["alternatives"] if a["bags_make_it"] or not x["bags"]]) > 1)
    later = [a for a in p["alternatives"] if a["bags_make_it"] or not p["bags"]][1]["flight"]
    fake_llm(monkeypatch, {SP.PAX_SYSTEM: {"holds": [], "picks": [{"pax_id": p["id"], "to_flight": later, "reason": "Keeps family together"}]}})
    row = next(r for r in SP.pax_view(fid)["passengers"] if r["ref"] == p["id"])
    assert row["agent_pick"] == {"flight": later, "reason": "Keeps family together", "by": "LLM"}
    r = pax_impact.recommend(fid, [p["id"]], "Ops")
    with closing(S.connect()) as con:
        acts = json.loads(S.one(con, "SELECT actions FROM changes WHERE id = ?", (r["staged"][0]["id"],))["actions"])
    assert acts == [{"kind": "REBOOK", "pax_id": p["id"], "to_flight": later}]


def test_llm_hold_choice_drives_protect_connections(monkeypatch):
    holds = SP.pax_facts("EK812")["hold_options"]
    longest = max(holds, key=lambda h: h["minutes"])["flight_id"]
    fake_llm(monkeypatch, {SP.PAX_SYSTEM: {"holds": [{"flight_id": longest, "reason": "Saves the most care passengers"}], "picks": []}})
    p = SP.passengers("EK812")
    assert [h["flight_id"] for h in p["holds"] if h["recommended"]] == [longest]
    protect = next(s for s in agent.get_report("EK812")["suggestions"] if s["title"] == "Protect connections")
    assert [a["flight_id"] for a in protect["actions"] if a["kind"] == "DELAY" and a["flight_id"] != "EK813"] == [longest]


def test_maintenance_agent_pick_shows_on_the_page(monkeypatch):
    item = next(i for i in SP.mx_facts()["items"] if i["id"] == "M-1")
    slower = item["options"][-1]["id"]
    fake_llm(monkeypatch, {SP.MX_SYSTEM: {"picks": [{"item_id": "M-1", "engineer_id": slower, "reason": "Keeps E1 free"},
                                                    {"item_id": "M-3", "engineer_id": slower, "reason": "same engineer twice"}]}})
    q = {i["id"]: i for i in SP.maintenance_view()["items"]}
    assert q["M-1"]["agent_pick"]["engineer_id"] == slower and q["M-1"]["agent_pick"]["by"] == "LLM"
    assert q["M-3"]["agent_pick"]["engineer_id"] != slower and q["M-3"]["agent_pick"]["by"] == "rules"
    assert SP.maintenance_for("EK812")["actions"] == [{"kind": "ASSIGN_ENGINEER", "item_id": "M-1", "engineer_id": slower}]


def test_no_go_item_never_left_without_engineer_for_a_deferrable_one(monkeypatch):
    f = SP.mx_facts()
    nogo = [i for i in f["items"] if i["blocks_departure"]]
    defer = [i for i in f["items"] if not i["blocks_departure"]]
    engineers = [o["id"] for o in f["items"][0]["options"]]
    assert len(engineers) < len(f["items"])  # more open items than free engineers
    picks = [{"item_id": i["id"], "engineer_id": e, "reason": "x"} for i, e in zip(defer + nogo, engineers)]  # deferrable first: wrong
    fake_llm(monkeypatch, {SP.MX_SYSTEM: {"picks": picks}})
    m = SP.maintenance()
    assert {p["item_id"] for p in m["picks"]} >= {i["id"] for i in nogo}
    assert all(not u["blocks_departure"] for u in m["unassigned"])
    # the case seen live: the LLM covers one NO-GO and a deferrable item, and leaves the other NO-GO items to the rules
    with closing(S.connect()) as con:
        con.execute("UPDATE flights SET delay_min = 60 WHERE id = 'AZ410'")  # a third NO-GO (M-6) competes for 3 engineers
    f = SP.mx_facts()
    nogo, defer = [i for i in f["items"] if i["blocks_departure"]], [i for i in f["items"] if not i["blocks_departure"]]
    first = nogo[0]["options"][0]["id"]  # options list only engineers licensed for the item's aircraft type
    # the deferrable item takes an engineer another NO-GO item needs: code must give that engineer back to the NO-GO item
    shared = next(o["id"] for o in defer[0]["options"] if o["id"] != first and any(o["id"] in {x["id"] for x in n["options"]} for n in nogo[1:]))
    fake_llm(monkeypatch, {SP.MX_SYSTEM: {"picks": [{"item_id": nogo[0]["id"], "engineer_id": first, "reason": "x"},
                                                    {"item_id": defer[0]["id"], "engineer_id": shared, "reason": "x"}]}})
    m = SP.maintenance()
    assert len(nogo) == 3 and {p["item_id"] for p in m["picks"]} >= {i["id"] for i in nogo}, m["picks"]


def test_llm_orchestrator_names_bundles_and_code_expands_them(monkeypatch):
    plan = {"report": "Crew agent swaps all six.", "suggestions": [
        {"title": "Agents only", "why": "w", "use": ["CREW", "MAINTENANCE", "REBOOK", "HOLD:NOPE", "DROP_TABLE"],
         "actions": [{"kind": "DELAY", "flight_id": "EK813", "minutes": 85}]}]}
    fake_llm(monkeypatch, {agent.SYSTEM: plan})
    rep = agent.get_report("EK812", force=True)
    s = rep["suggestions"][0]
    kinds = [a["kind"] for a in s["actions"]]
    assert rep["source"].startswith("LLM") and s["use"] == ["CREW", "MAINTENANCE", "REBOOK"]
    assert kinds.count("CREW_SWAP") == 6 and "ASSIGN_ENGINEER" in kinds and "REBOOK_AT_RISK" in kinds and kinds[-1] == "DELAY"
    assert S.simulate("EK812", s["actions"])["ok"]


def test_orchestrator_writing_specialist_actions_itself_gets_their_bundles(monkeypatch):
    plan = {"report": "r", "suggestions": [{"title": "Raw", "why": "w", "use": ["CREW"],  # seen live: REBOOK with no passenger
                                            "actions": [{"kind": "REBOOK"}, {"kind": "CREW_AUTOSWAP", "flight_id": "EK812"},
                                                        {"kind": "ASSIGN_ENGINEER", "item_id": "M-1", "engineer_id": "E3"}]}]}
    fake_llm(monkeypatch, {agent.SYSTEM: plan})
    s = agent.get_report("EK812", force=True)["suggestions"][0]
    assert set(s["use"]) == {"CREW", "REBOOK", "MAINTENANCE"} and S.simulate("EK812", s["actions"])["ok"]
    assert not any(a["kind"] == "CREW_AUTOSWAP" or (a["kind"] == "REBOOK" and not a.get("pax_id")) for a in s["actions"])


def test_outbound_never_retimed_less_than_its_turnaround_needs(monkeypatch):
    plan = {"report": "r", "suggestions": [{"title": "Too short", "why": "w", "use": ["CREW", "MAINTENANCE", "REBOOK"],
                                            "actions": [{"kind": "DELAY", "flight_id": "EK813", "minutes": 5}]},
                                           {"title": "No retime", "why": "w", "use": ["CREW", "MAINTENANCE", "REBOOK"], "actions": []}]}
    fake_llm(monkeypatch, {agent.SYSTEM: plan})
    gap = S.get_turnaround_and_crew_state("EK812")["kpis"]["turn_gap"]
    for s in agent.get_report("EK812", force=True)["suggestions"]:
        assert [a["minutes"] for a in s["actions"] if a["kind"] == "DELAY" and a["flight_id"] == "EK813"] == [gap]


def test_repeated_llm_scenario_is_replaced_by_a_distinct_rule_based_one(monkeypatch):
    same = {"title": "A", "why": "w", "use": ["CREW", "MAINTENANCE", "REBOOK"]}
    fake_llm(monkeypatch, {agent.SYSTEM: {"report": "r", "suggestions": [same, {**same, "title": "B"}, {**same, "title": "C"}]}})
    rep = agent.get_report("EK812", force=True)
    keys = [json.dumps(sorted(json.dumps(a, sort_keys=True) for a in s["actions"])) for s in rep["suggestions"]]
    assert len(set(keys)) == 3 and rep["suggestions"][0]["title"] == "A" and rep["suggestions"][1].get("rule_based")
    assert "rule-based option(s)" in rep["suggestions_source"]


def test_on_time_flight_gets_no_recommendations(monkeypatch):
    calls = fake_llm(monkeypatch, {})
    rep = agent.get_report("UA960")
    assert rep["on_time"] and rep["suggestions"] == [] and "only recommend when a flight is delayed" in rep["report"]
    assert agent.scenario_lab("UA960", {"connections": True}, regenerate=True)["scenarios"] == []
    assert SP.crew("UA960")["picks"] == [] and SP.passengers("UA960")["picks"] == [] and SP.passengers("UA960")["holds"] == []
    assert [c[0] for c in calls] == [agent.ON_TIME_SYSTEM]  # only the status report: no agent or planner call for an on-time flight
    assert rep["source"].startswith("Rule-based fallback")  # LLM offline here: the code status line says so
    r = monitor.tick(force=True)
    assert not {"UA960", "AA70"} & {x["flight_id"] for x in r["replanned"]}


def test_on_time_status_report_written_by_the_llm(monkeypatch):
    calls = fake_llm(monkeypatch, {agent.ON_TIME_SYSTEM: {"report": "UA960 is on time; LH... <b>watch</b> the crew margins."}})
    rep = agent.get_report("UA960")
    assert rep["source"].startswith("LLM") and rep["on_time"] and rep["suggestions"] == [] and "<b>" not in rep["report"]
    assert "Eve" not in calls[0][1] and len(calls) == 1  # the PII-free state, one call


def test_agent_headline_written_by_the_llm_only_when_it_matches_the_plan(monkeypatch):
    monitor.apply_eta("AZ410", 60, "test")
    def crew_reply(user):  # the LLM picks the first legal option for everyone and writes its headline
        f = json.loads(user[len("<facts>"):-len("</facts>")])
        return {"summary": f"Swap both pilots to standby, {len(f['crew'])} swaps ready.",
                "picks": [{"crew_id": c["id"], "standby_id": c["options"][k]["id"], "reason": "closest standby"} for k, c in enumerate(f["crew"])]}
    fake_llm(monkeypatch, {SP.CREW_SYSTEM: crew_reply, SP.MX_SYSTEM: {"summary": "Engineer E9 fixes 77 items.", "picks": []}})
    c, m = SP.crew("AZ410"), SP.maintenance()
    assert c["summary_by"] == "LLM" and c["summary"] == "Swap both pilots to standby, 2 swaps ready."
    assert m["summary_by"] == "rules" and "77" not in m["summary"]  # rules made the picks and 77 is not a real number: code writes it
    assert SP.maintenance_for("AZ410", m)["summary"].startswith("NO-GO M-6 → ")


def test_llm_reason_shown_only_when_true_to_the_facts(monkeypatch):
    monitor.apply_eta("AZ410", 60, "test")
    slack = next(o["slack"] for i in SP.mx_facts()["items"] if i["id"] == "M-6" for o in i["options"] if o["id"] == "E2")  # A320-licensed
    assert slack < 0  # the job ends after AZ411's departure
    for reason, shown in ((f"done {-slack} min before departure, AZ411 stays on time", "rules"),     # wrong direction
                          (f"done {-slack + 25} min after departure so AZ411 slips", "rules"),        # invented number
                          (f"done {-slack} min after departure so AZ411 slips {-slack} min", "LLM")):  # true
        with S.connect() as con:  # forget the cached decision
            con.execute(SP.TABLE)
            con.execute("DELETE FROM agent_proposals")
        fake_llm(monkeypatch, {SP.MX_SYSTEM: {"picks": [{"item_id": "M-6", "engineer_id": "E2", "reason": reason}]}})
        p = next(p for p in SP.maintenance()["picks"] if p["item_id"] == "M-6")
        assert p["by"] == "LLM" and p["reason_by"] == shown, (reason, p)
        assert (p["reason"] == reason) == (shown == "LLM") and ("after departure" in p["reason"])
    late = [{"item_id": "M-6", "outbound": "AZ411", "blocks_departure": True, "slack": -10},
            {"item_id": "M-3", "outbound": "QR070", "blocks_departure": True, "slack": 5}]
    assert not SP._timing_headline_ok("M-1 slips 33 min. M-3 and M-6 are on time.", late)   # M-6 is not on time
    assert not SP._timing_headline_ok("Three NO-GO items covered.", late)                   # hides the slip
    assert SP._timing_headline_ok("M-6: AZ411 slips 10 min; M-3 done 5 min before departure.", late)
    assert 5 in SP._fact_numbers(575) and 6 in SP._fact_numbers(575)  # 575 min = 9.6 h, said as 9.5 h too
    assert SP._bags_contradict("earliest flight, bags make it too", False) and not SP._bags_contradict("earliest, bags rush-tagged", False)
    assert SP._bags_contradict("bags will miss it", True) and not SP._bags_contradict("protected care, earliest flight", False)


def test_shorter_hold_is_a_third_real_option(monkeypatch):
    fake_llm(monkeypatch, {})
    with closing(S.connect()) as con:  # a shorter hold exists only when bags need longer than passengers: a remote stand (+15 min)
        con.execute("UPDATE flights SET gate = 'R6' WHERE id = 'AZ411'")
    monitor.apply_eta("AZ410", 60, "test")
    t = SP.team("AZ410")
    h = next(h for h in t["passengers"]["holds"] if h["flight_id"] == "LH1830")
    assert SP.short_hold(h) and SP.bundles(t)["HOLD_SHORT:LH1830"][0]["minutes"] == h["pax_minutes"] < h["minutes"]
    both = SP.expand(t, ["HOLD:LH1830", "HOLD_SHORT:LH1830", "REBOOK"])
    assert [a["minutes"] for a in both if a["kind"] == "DELAY"] == [h["minutes"]]  # one hold per flight: the full one wins
    rep = agent.get_report("AZ410", force=True)  # rule fallback: three different plans
    keys = {json.dumps(sorted(json.dumps(a, sort_keys=True) for a in s["actions"])) for s in rep["suggestions"]}
    assert len(keys) == 3 and rep["suggestions"][2]["title"] == "Shorter holds"
    raw = agent.validate({"suggestions": [{"title": "x", "use": ["CREW"], "actions": [{"kind": "DELAY", "flight_id": "LH1830", "minutes": h["pax_minutes"]}]}]}, t)
    s = raw["suggestions"][0]
    assert s["use"][:2] == ["CREW", "HOLD_SHORT:LH1830"]  # a raw short hold maps to the shorter bundle
    # the LLM left out the engineer assignment and the rebookings: code completes the scenario and says so
    assert s["completed_by_code"] == ["MAINTENANCE", "REBOOK"] and {"ASSIGN_ENGINEER", "REBOOK"} <= {a["kind"] for a in s["actions"]}


def test_maintenance_agent_ignores_items_on_on_time_flights():
    with closing(S.connect()) as con:
        con.execute("UPDATE flights SET delay_min = 0 WHERE id = 'MS785'")  # M-3's aircraft now on time
    assert "M-3" not in {i["id"] for i in SP.mx_facts()["items"]}
    assert "agent_pick" not in next(i for i in SP.maintenance_view()["items"] if i["id"] == "M-3")


def test_pages_get_what_their_agent_did_and_why(monkeypatch):
    fake_llm(monkeypatch, {})
    monitor.tick(force=True)  # the background agent runs every specialist for EK812
    c = SP.crew_view("EK812")
    assert c["picks"] and c["recent"] and c["recent"][0]["source"].startswith("Rule-based")
    assert c["recent"][0]["trigger"] and c["recent"][0]["trigger"]["changes"]  # what made it run
    pax = SP.pax_view("EK812")["agent"]
    assert pax["picks"] == 39 and pax["holds"] and pax["recent"] and pax["guard"]["ok"]
    mx = SP.maintenance_view()["agent"]
    assert {p["item_id"] for p in mx["picks"]} >= {"M-1"} and mx["recent"]


def test_monitor_replan_runs_the_specialists(monkeypatch):
    fake_llm(monkeypatch, {})
    monitor.tick(force=True)
    with closing(S.connect()) as con:
        kinds = {r["kind"] for r in S.rows(con, "SELECT kind FROM agent_events")}
        ev = S.one(con, "SELECT detail FROM agent_events WHERE kind = 'REPLANNED' AND flight_id = 'EK812'")
    assert {"CREW_AGENT", "PAX_AGENT", "MX_AGENT"} <= kinds
    assert set(json.loads(ev["detail"])["agents"]) == {"crew", "passengers", "maintenance"}
