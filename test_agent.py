"""Autonomous agent (monitor.py): change detection, delay-from-call verification, re-planning, alerts. LLM mocked."""
import json

import pytest

import agent
import monitor
import replay
import seed
import services as S


@pytest.fixture(autouse=True)
def db(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DB", str(tmp_path / "test.sqlite"))
    monkeypatch.setattr(S, "_pin_failures", 0)
    monkeypatch.setattr(monitor, "COOLDOWN_S", 0)
    monkeypatch.setattr(monitor, "MAX_REPLANS", 20)
    monitor.reset()
    seed.build(S.DB)


def fake_llm(eta_updates=None):
    calls = []

    def f(system, user, **kw):
        calls.append(system[:20])
        if system == monitor.ETA_SYSTEM:
            return {"updates": eta_updates or []}
        raise agent.LLMUnavailable("offline test")  # report falls back to the labelled rule-based planner
    return f, calls


def notifications():
    with S.closing(S.connect()) as con:
        return S.rows(con, "SELECT * FROM notifications WHERE recipient LIKE 'AeroTurn agent%'")


def test_first_tick_plans_every_disrupted_flight_without_alerts(monkeypatch):
    f, _ = fake_llm()
    monkeypatch.setattr(agent, "llm_json", f)
    r = monitor.tick(force=True)
    assert r["watched"] == 11 and "EK812" in {x["flight_id"] for x in r["replanned"]}
    assert S.cached_report("EK812")["suggestions"]
    assert not notifications()  # baseline is not an alert
    assert monitor.tick(force=True)["replanned"] == []  # nothing changed -> nothing to do


def test_decision_elsewhere_is_noticed_and_replanned(monkeypatch):
    f, _ = fake_llm()
    monkeypatch.setattr(agent, "llm_json", f)
    monitor.tick(force=True)
    S.mark_task_done("EK812", "CLEAN")  # ramp update elsewhere in the system
    S.log_call("EK812", "Ramp control", "Ambulift now at R4.")
    r = monitor.tick(force=True)
    ek = next(x for x in r["replanned"] if x["flight_id"] == "EK812")
    assert ek["changes"] and notifications()


def test_delay_stated_on_a_call_is_verified_and_recorded(monkeypatch):
    S.log_call("QR069", "Dispatch QR069", "QR069 now estimating 60 minutes late, extra ATC holding over Vienna.")
    f, _ = fake_llm([{"line": 0, "flight_id": "QR069", "total_delay_min": 60, "additional_delay_min": None, "reason": "ATC holding"}])
    monkeypatch.setattr(agent, "llm_json", f)
    monitor.tick(force=True)  # baseline: the call was logged before the agent started watching
    S.log_call("QR069", "Dispatch QR069", "Update: QR069 now estimating 60 minutes late, extra ATC holding over Vienna.")
    r = monitor.tick(force=True)
    assert r["eta_updates"][0]["delay_min"] == 60 and r["eta_updates"][0]["was"] == 35
    qr = next(x for x in S.list_flights() if x["id"] == "QR069")
    assert qr["delay_min"] == 60
    assert any("QR069" in n["message"] and "delay 35 min → 60 min" in n["message"] for n in notifications())
    assert replay.run()["verified"]  # the ETA update is in the audit log and replays to the same state


def test_number_not_said_on_the_line_is_never_trusted(monkeypatch):
    monitor_f, _ = fake_llm([{"line": 0, "flight_id": "QR069", "total_delay_min": 95, "additional_delay_min": None}])
    monkeypatch.setattr(agent, "llm_json", monitor_f)
    monitor.tick(force=True)
    S.log_call("QR069", "Dispatch QR069", "QR069 is running late again, more holding.")
    assert monitor.tick(force=True)["eta_updates"] == []
    assert next(x for x in S.list_flights() if x["id"] == "QR069")["delay_min"] == 35


def test_arrived_flight_and_bad_values_refused():
    with pytest.raises(ValueError, match="on block"):
        monitor.apply_eta("EK812", 120, "test")
    with pytest.raises(ValueError):
        monitor.apply_eta("QR069", -5, "test")
    assert monitor.apply_eta("QR069", 35, "test")["status"] == "UNCHANGED"


def test_additional_delay_is_added(monkeypatch):
    f, _ = fake_llm([{"line": 0, "flight_id": "SA260", "total_delay_min": None, "additional_delay_min": 20}])
    monkeypatch.setattr(agent, "llm_json", f)
    monitor.tick(force=True)
    S.log_call("SA260", "Captain SA260", "We expect a further 20 minutes delay due to headwinds.")
    r = monitor.tick(force=True)
    assert r["eta_updates"][0]["delay_min"] == 60  # 40 + 20


def test_status_and_rebook_needs_pin(monkeypatch):
    f, _ = fake_llm()
    monkeypatch.setattr(agent, "llm_json", f)
    monitor.tick(force=True)
    st = monitor.status()
    assert st["watched_flights"] == 11 and st["events"]
    with pytest.raises(PermissionError):
        S._check_pin("x", "definitely-wrong-pin")


def test_pin_lockout_expires(monkeypatch):
    monkeypatch.setenv("OCC_CONTROLLER_PIN", "4321")
    for _ in range(5):
        with pytest.raises(PermissionError):
            S._check_pin("me", "0000")
    with pytest.raises(PermissionError, match="locked"):
        S._check_pin("me", "4321")
    monkeypatch.setattr(S, "_pin_locked_until", 1.0)  # lock period over
    assert S._check_pin("me", "4321") == "me"
    assert json.dumps(monitor.status())
