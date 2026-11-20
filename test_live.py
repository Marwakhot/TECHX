"""A call saved on the live report starts the agents at once, and live() reports every step (monitor.call_logged / live)."""
import time

import pytest

import agent
import monitor
import seed
import services as S


@pytest.fixture(autouse=True)
def db(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DB", str(tmp_path / "test.sqlite"))
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.delenv("VERCEL", raising=False)
    monitor.reset()
    seed.build(S.DB)


def offline(monkeypatch, eta=None):
    def f(system, user, **kw):
        if eta is not None and system == monitor.ETA_SYSTEM:
            return {"updates": eta}
        raise agent.LLMUnavailable("offline test")
    monkeypatch.setattr(agent, "llm_json", f)


def follow(fid, r, timeout=60):
    t0 = time.time()
    while time.time() - t0 < timeout:
        v = monitor.live(fid, r["since"])
        if v["run"] == r["run"] and v["status"] == "done":
            return v
        time.sleep(0.2)
    raise AssertionError("agents did not finish")


def kinds(v):
    return [e["kind"] for e in v["events"]]


def test_call_on_an_on_time_flight_triggers_the_whole_agent_chain(monkeypatch):
    offline(monkeypatch)  # LLM down: the call is read by the narrow rules, the agents and orchestrator fall back to rules
    assert next(f for f in S.list_flights() if f["id"] == "UA960")["delay_min"] == 0
    r = monitor.call_logged("UA960", "Dispatch UA960", "UA960 now 60 minutes late, holding over Shannon.")  # first call after a reset
    v = follow("UA960", r)
    k = kinds(v)
    assert v["error"] is None and v["result"]["replanned"]
    assert k.index("DELAY_FROM_CALL") < k.index("REPLANNING") < k.index("ORCHESTRATOR") < k.index("REPLANNED")
    assert {"CREW_AGENT", "PAX_AGENT"} <= set(k)
    delay = next(e for e in v["events"] if e["kind"] == "DELAY_FROM_CALL")
    assert delay["detail"]["read_by"] == "rules" and delay["detail"]["was"] == 0 and delay["detail"]["delay_min"] == 60
    assert "delay 0 min → 60 min" in next(e for e in v["events"] if e["kind"] == "REPLANNING")["summary"]
    assert next(f for f in S.list_flights() if f["id"] == "UA960")["delay_min"] == 60
    rep = S.cached_report("UA960")
    assert rep and set(rep["agents"]) == {"crew", "passengers", "maintenance"}  # ready before the page reloads


def test_llm_reading_is_used_when_available(monkeypatch):
    offline(monkeypatch, eta=[{"line": 0, "flight_id": "QR069", "total_delay_min": 60, "additional_delay_min": None, "reason": "ATC"}])
    v = follow("QR069", monitor.call_logged("QR069", "Dispatch QR069", "QR069 now estimating an hour late, sixty minutes behind."))
    e = next(e for e in v["events"] if e["kind"] == "DELAY_FROM_CALL")
    assert e["detail"]["read_by"] == "LLM" and e["detail"]["was"] == 35 and e["detail"]["delay_min"] == 60


def test_call_without_a_delay_on_a_landed_flight_records_nothing(monkeypatch):
    offline(monkeypatch)
    v = follow("EK812", monitor.call_logged("EK812", "Ramp control", "Ambulift now on stand R4."))
    assert "DELAY_FROM_CALL" not in kinds(v) and v["error"] is None
    assert next(f for f in S.list_flights() if f["id"] == "EK812")["delay_min"] == 75


def test_call_does_not_wait_for_a_busy_background_pass(monkeypatch):
    offline(monkeypatch)
    monitor.tick(force=True)  # baseline
    assert monitor._tick_lock.acquire(blocking=False)  # the background agent is busy (e.g. a slow re-plan of another flight)
    try:
        v = follow("UA960", monitor.call_logged("UA960", "Dispatch UA960", "UA960 now 40 minutes late."), timeout=30)
    finally:
        monitor._tick_lock.release()
    assert "REPLANNED" in kinds(v) and "delay 0 min → 40 min" in next(e for e in v["events"] if e["kind"] == "REPLANNING")["summary"]


def test_additional_delay_is_applied_once_with_a_background_pass_running(monkeypatch):
    import threading
    offline(monkeypatch)
    monitor.tick(force=True)
    r = monitor.call_logged("QR069", "Dispatch QR069", "QR069 another 20 minutes, more holding.")
    bg = threading.Thread(target=monitor.tick, kwargs={"force": True})
    bg.start()
    follow("QR069", r)
    bg.join()
    monitor.tick(force=True)
    assert next(f for f in S.list_flights() if f["id"] == "QR069")["delay_min"] == 55  # 35 + 20, never + 40


def test_number_not_on_the_line_is_not_read_by_the_rules():
    assert monitor._rule_updates([{"flight_id": "UA960", "text": "UA960 running late again, more holding."}]) == []
    assert monitor._rule_updates([{"flight_id": "UA960", "text": "UA960 another 20 minutes, sorry."}])[0]["additional_delay_min"] == 20
