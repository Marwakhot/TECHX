"""Offline tests for the U-4 curveballs (curveballs.py). Each one is the brief's live test, asserted in code."""
from contextlib import closing
from datetime import datetime, timedelta
import sqlite3

import pytest

import curveballs as C
import replay
import seed
import services as S

PIN = "2468"


@pytest.fixture(autouse=True)
def fresh_db(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DB", str(tmp_path / "test.sqlite"))
    monkeypatch.setattr(S, "_pin_failures", 0)
    monkeypatch.setenv("OCC_CONTROLLER_PIN", PIN)
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    seed.build(S.DB)
    C.ensure()


def seat_of(pid):
    with closing(S.connect()) as con:
        return S.one(con, "SELECT flight_id FROM seats WHERE pax_id = ?", (pid,))["flight_id"]


# ---------- U-4.1 ----------
def test_u41_vulnerable_first_and_conflict_in_batch3_only_rolls_back_batch3():
    r = C.batch_rebook("EK812", "Ctl", PIN, chaos_batch=3)
    b = r["batches"]
    assert b[0]["label"].startswith("Vulnerable") and all(m["tier"] in C.G.VULNERABLE for m in b[0]["moves"])
    assert all(m["tier"] == "STANDARD" for x in b[1:] for m in x["moves"])
    assert all(len(x["moves"]) <= 10 for x in b[1:])
    assert [x["status"] for x in b[:3]] == ["COMMITTED", "COMMITTED", "COMMITTED_ON_RETRY"]
    assert "Seat conflict" in b[2]["errors"][0]
    assert r["integrity"] == {"double_bookings": 0, "orphan_bags": 0}
    assert replay.run()["verified"]


def test_u41_persistent_failure_is_handed_to_controller_and_earlier_batches_stay():
    r = C.batch_rebook("EK812", "Ctl", PIN, chaos_batch=2, chaos_repeat=True)
    assert r["batches"][0]["status"] == "COMMITTED"            # batch 1 survives batch 2's failure
    assert r["batches"][1]["status"] == "HANDED_TO_CONTROLLER"
    moved_b1 = [m["pax_id"] for m in r["batches"][0]["moves"]]
    assert all(seat_of(p) == m["to"] for p, m in zip(moved_b1, r["batches"][0]["moves"]))
    h = next(x for x in C.view("EK812")["handoffs"] if x["batch_no"] == 2 and x["status"] == "OPEN")
    assert C.resolve_handoff(h["id"], "Ctl", PIN)["status"].startswith("COMMITTED")
    assert replay.run()["verified"]


def test_u41_failed_vulnerable_batch_holds_everyone_else():
    r = C.batch_rebook("EK812", "Ctl", PIN, chaos_batch=1, chaos_repeat=True)
    assert r["batches"][0]["status"] == "HANDED_TO_CONTROLLER"
    assert all(b["status"] == "HELD" for b in r["batches"][1:]) and r["summary"]["moved"] == 0


def test_u41_needs_pin():
    with pytest.raises(PermissionError):
        C.batch_rebook("EK812", "Ctl", "0000")


# ---------- U-4.2 ----------
def test_u42_message_is_data_duty_counters_read_only_and_reserve_staged():
    r = C.crew_message("EK812", "Crew channel", "Crew agree to extend duty, push the departure.")
    assert r["flagged_as_pressure"] and r["duty_counters_unchanged"] and r["treated_as"] == "data"
    cpt = next(c for c in r["crew"] if c["id"] == "EK812-1")
    assert cpt["minutes_to_limit"] == 20 and cpt["minutes_needed"] > cpt["minutes_to_limit"] and not cpt["legal"]
    assert len({c["reserve"] for c in r["crew"]}) == len(r["crew"])  # one distinct legal reserve per member
    assert r["staged"]["status"] == "PENDING"  # reserve crew waits for the controller; nothing applied
    with closing(S.connect()) as con:
        assert S.one(con, "SELECT status FROM changes WHERE id = ?", (r["staged"]["id"],))["status"] == "PENDING"
        assert S.one(con, "SELECT status FROM flights WHERE id = 'EK813'")["status"] == "SCHEDULED"
        with pytest.raises(sqlite3.IntegrityError, match="read-only"):
            con.execute("UPDATE crew SET duty_used = 0 WHERE id = 'EK812-1'")


# ---------- U-4.3 ----------
def test_u43_bad_signoff_rejected_then_valid_one_accepted():
    opened = datetime.fromisoformat(C.view("EK812")["maintenance"][0]["opened_at"])
    bad = C.submit_signoff("M-1", "ENG-7731", (opened - timedelta(minutes=15)).isoformat(timespec="minutes"))
    assert not bad["valid"] and bad["departure_blocked"] and bad["alerted"] == "Maintenance control"
    assert any("roster" in x for x in bad["reasons"]) and any("before the defect" in x for x in bad["reasons"])
    assert not C.submit_signoff("M-1", "E3", datetime.now().isoformat(timespec="minutes"))["valid"]  # not licensed on B777
    good = C.submit_signoff("M-1", "E1", datetime.now().isoformat(timespec="minutes"))
    assert good["valid"] and good["status"] == "SIGNED" and not good["departure_blocked"]
    assert replay.run()["verified"]


# ---------- U-4.4 ----------
def test_u44_35_min_connection_commits_with_bag_on_later_flight():
    r = C.rebook_one("AC876", "P0029", "LH902", "Ctl", PIN)
    assert r["ok"] and seat_of("P0029") == "LH902"
    p = r["move"]["bag_plan"]
    assert p["connection_min"] == 35 and p["bag_min"] == 45 and p["plan"] == "FORWARD" and p["bag_flight"] == "LH906" and p["note"]
    assert r["integrity"] == {"double_bookings": 0, "orphan_bags": 0}
    assert replay.run()["verified"]


def test_u44_no_bag_plan_means_no_commit():
    with closing(S.connect()) as con:
        con.execute("UPDATE flights SET delay_min = 200 WHERE id = 'AC876'")  # LH906 becomes a 35-min, last-of-day LHR flight
        con.execute("UPDATE seats SET pax_id = NULL WHERE flight_id = 'LH906' AND pax_id = 'P0049'")
        con.execute("UPDATE seats SET pax_id = 'P0049' WHERE flight_id = 'LH902' AND pax_id IS NULL AND rowid = "
                    "(SELECT MIN(rowid) FROM seats WHERE flight_id = 'LH902' AND pax_id IS NULL)")
        con.execute("UPDATE bags SET flight_id = 'LH902' WHERE pax_id = 'P0049'")
    r = C.rebook_one("AC876", "P0049", "LH906", "Ctl", PIN)
    assert not r["ok"] and "BAG PLAN" in r["error"] and seat_of("P0049") == "LH902"
