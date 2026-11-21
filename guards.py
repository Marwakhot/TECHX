"""Immutable safety floors. Pure Python: the LLM has no tool, prompt or code path that can change or skip these."""
from types import MappingProxyType
from typing import Final

LIMITS: Final = MappingProxyType({
    "MAX_FDP_MIN": 780,         # legal flight-duty-period ceiling (13 h)
    "REPORT_MIN": 60,           # a fresh crew member reports 60 min before departure
    "POST_FLIGHT_MIN": 30,      # duty that continues after on-block
    "STANDBY_BUFFER_MIN": 60,   # extra margin demanded of a standby crew member
    "MAX_WALK_MIN": 30,         # terminal proximity for standby crew
    "MCT_MIN": 45,              # minimum connection time at the hub (passenger)
    "REBOOKED_MCT_MIN": 30,     # a passenger already moved by an approved rebooking may keep a connection this short
    "BAG_MCT_MIN": 45,          # minimum connection time for a checked bag to make the onward flight
    "REMOTE_BAG_PENALTY_MIN": 15,  # extra bag transfer time when the inbound parks on a remote stand
    "MAX_ONWARD_HOLD_MIN": 30,  # longest hold any single onward flight may take for connecting passengers
    "GATE_BUFFER_MIN": 15,      # a lent gate must be empty this long before the delayed aircraft that owns it arrives
})
VULNERABLE: Final = frozenset({"UM", "PRM", "MEDICAL", "INFANT", "ELDERLY"})
TIER_RANK: Final = MappingProxyType({"UM": 0, "PRM": 1, "MEDICAL": 2, "INFANT": 3, "ELDERLY": 4, "STANDARD": 9})
# Licensed roster: the aircraft types each engineer may certify. The one list every assignment and sign-off path checks.
ENGINEER_TYPES: Final = MappingProxyType({"E1": frozenset({"B777", "B788"}), "E2": frozenset({"B777", "A320"}),
                                          "E3": frozenset({"A359", "B788", "A320"})})


class GuardViolation(Exception):
    """Raised whenever a proposal breaks a legal, maintenance or priority floor."""


def projected_fdp(member, outbound):
    """Duty at the end of the next leg. Crew already on duty keep accruing until departure."""
    start = member["duty_used"] + outbound["eff"] if member["duty_used"] else LIMITS["REPORT_MIN"]
    return start + outbound["block_min"] + LIMITS["POST_FLIGHT_MIN"]


def check_crew_duty(member, outbound, buffer=0):
    if member["type_rating"] != outbound["aircraft_type"]:
        raise GuardViolation(f"CREW RATING: {member['id']} is rated {member['type_rating']}, aircraft is {outbound['aircraft_type']}")
    fdp = projected_fdp(member, outbound) + buffer
    if fdp > LIMITS["MAX_FDP_MIN"]:
        raise GuardViolation(f"CREW DUTY: {member['id']} would reach {fdp} min of duty; legal ceiling is {LIMITS['MAX_FDP_MIN']} min")


def check_standby(standby, member, outbound):
    if standby["status"] != "STANDBY":
        raise GuardViolation(f"{standby['id']} is not on standby (status {standby['status']})")
    if standby["role"] != member["role"]:
        raise GuardViolation(f"{standby['id']} is {standby['role']}, cannot replace a {member['role']}")
    if standby["walk_min"] > LIMITS["MAX_WALK_MIN"]:
        raise GuardViolation(f"{standby['id']} is {standby['walk_min']} min away (max {LIMITS['MAX_WALK_MIN']})")
    check_crew_duty(standby, outbound, LIMITS["STANDBY_BUFFER_MIN"])


def check_maintenance(items):
    open_items = [i["id"] for i in items if i["severity"] == "NO-GO" and i["status"] != "SIGNED"]
    if open_items:
        raise GuardViolation(f"MAINTENANCE: no departure while NO-GO items {open_items} lack a licensed engineer sign-off")


def check_engineer_licence(engineer_id, aircraft_type):
    if aircraft_type not in ENGINEER_TYPES.get(engineer_id, ()):
        raise GuardViolation(f"ENGINEER LICENCE: {engineer_id} is not licensed for the {aircraft_type}")


def priority_order(pax):
    """Vulnerable flyers always first, whatever order anyone (or the LLM) proposed."""
    return sorted(pax, key=lambda p: (TIER_RANK.get(p["tier"], 9), p["id"]))


def check_vulnerable_protection(assignments, at_risk):
    """A batch may not hand a seat on a route to someone of lower priority while a vulnerable flyer for that route is left
    out. (If seats run out and every seat already went to equal-or-higher-priority vulnerable flyers, that is not a violation.)"""
    chosen = {a["pax_id"] for a in assignments}
    lowest = {}  # destination -> lowest priority (highest rank number) that received a seat
    for p in at_risk:
        if p["id"] in chosen:
            lowest[p["dest"]] = max(lowest.get(p["dest"], -1), TIER_RANK.get(p["tier"], 9))
    skipped = [p["id"] for p in at_risk if p["tier"] in VULNERABLE and p["id"] not in chosen
               and TIER_RANK[p["tier"]] < lowest.get(p["dest"], -1)]
    if skipped:
        raise GuardViolation(f"PRIORITY: vulnerable passengers {skipped} must be rebooked before others on the same route")


def check_onward_hold(flight, minutes):
    """Holding someone else's departure to protect connections is capped; longer delays cascade into the network."""
    if flight["kind"] == "ONWARD" and minutes > LIMITS["MAX_ONWARD_HOLD_MIN"]:
        raise GuardViolation(f"HOLD: {flight['id']} may be held at most {LIMITS['MAX_ONWARD_HOLD_MIN']} min (asked {minutes})")


def check_gate_loan(gate, borrower, holder, holder_inbound, borrower_dep):
    """A contact gate whose aircraft is late may be lent to another flight, but only if that flight has left (plus the buffer)
    before the late aircraft reaches the gate. borrower_dep = the borrower's real departure (minutes from now)."""
    if gate["kind"] != "CONTACT":
        raise GuardViolation(f"GATE LOAN: {gate['id']} is a remote stand; only contact gates are lent")
    if not holder or holder["id"] == borrower["id"]:
        raise GuardViolation(f"GATE LOAN: {gate['id']} has no other flight to lend it")
    if not holder_inbound or holder_inbound["status"] != "ENROUTE" or holder_inbound["delay_min"] <= 0:
        raise GuardViolation(f"GATE LOAN: {holder['id']}'s aircraft is not a delayed arrival, so {gate['id']} is not idle")
    if borrower_dep < 0:
        raise GuardViolation(f"GATE LOAN: {borrower['id']} has already departed")
    need = borrower_dep + LIMITS["GATE_BUFFER_MIN"]
    if need > holder_inbound["eff"]:
        raise GuardViolation(f"GATE LOAN: {borrower['id']} leaves {gate['id']} at T+{borrower_dep}, but {holder_inbound['id']} reaches it at "
                             f"T+{holder_inbound['eff']} (needs {LIMITS['GATE_BUFFER_MIN']} min clear)")


def bag_mct(remote_stand):
    return LIMITS["BAG_MCT_MIN"] + (LIMITS["REMOTE_BAG_PENALTY_MIN"] if remote_stand else 0)


def check_bag_match(con):
    """Positive passenger-bag match: no checked bag may sit on a flight its passenger is not booked on."""
    n = con.execute("SELECT COUNT(*) FROM bags b LEFT JOIN seats s ON s.pax_id = b.pax_id "
                    "WHERE s.flight_id IS NULL OR s.flight_id <> b.flight_id").fetchone()[0]
    if n:
        raise GuardViolation(f"BAG MATCH: {n} bag(s) would travel without their passenger")
