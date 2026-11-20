# Aviant

An AI control-room console that helps an airline hub (Frankfurt) recover when flights run late. It spots problems, suggests recovery plans and checks them against safety rules. A human controller approves every change.

## How to run

```bash
pip install -r requirements.txt
copy .env.example .env      # add OPENROUTER_API_KEY and OCC_CONTROLLER_PIN
python server.py            # open http://127.0.0.1:8000
```

Run the tests with `pytest`. Without an API key, simple built-in rules write the report instead of the AI.

## Features

- **Live overview**: a globe and a map of all inbound flights, coloured by delay.
- **Live report**: an AI summary of each flight built from staff calls and live data, with 3 suggested recovery plans.
- **Decision hub**: compare plans, see costs, review each area (network, maintenance, crew, baggage, passengers) and approve the whole plan in one step.
- **Crew**: duty time for every crew member, with legal standby replacements.
- **Connecting passengers**: who will miss their connection, rebooking with vulnerable passengers first, and bags that follow them.
- **Maintenance**: open aircraft faults, engineer assignment and licensed sign-off.
- **Decision log**: every call, decision and approval in one place.
- **Specialist agents**: a Crew agent (standby swaps), a Passenger agent (holds and rebookings) and a Maintenance agent (engineer assignments) each work out their own area and suggest what the Crew, Connecting passengers and Maintenance pages show. Code gives them only options the safety rules allow; each re-decides by itself when something in its area changes.
- **Orchestrator**: combines the three agents' proposals into the live report and the 3 Decision hub scenarios.
- **Background agent**: checks every 30 seconds for new delays and runs the specialists and the orchestrator by itself. A delay stated on a call saved on a live report starts them at once, and the report shows each agent working.
- **Live-demo flight AZ410** (Rome, on time): its crew, connections and a NO-GO item only become problems once a delay is stated on a call (e.g. "AZ410 now estimating 60 minutes late"), so all three agents have something to solve.
- **Safety**: hard rules the AI cannot bypass, a PIN for every approval, all-or-nothing changes and a tamper-proof audit log.
