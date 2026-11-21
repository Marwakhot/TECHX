# Aviant

An AI control-room console that helps an airline hub (Frankfurt) recover when flights run late. It spots problems, suggests recovery plans and checks them against safety rules. A human controller approves every change.

## Run it locally

You need **Python 3.10+**.

```bash
pip install -r requirements.txt
copy .env.example .env      # macOS / Linux: cp .env.example .env
```

Open `.env` and set two values:

- `OCC_CONTROLLER_PIN`: any PIN you like. Every approval in the console asks for it.
- `OPENROUTER_API_KEY` (optional): with a key the AI agents decide; without one, built-in rules do the same work.

Start the console:

```bash
python server.py
```

Then open **http://localhost:8000** (use `localhost`, not `127.0.0.1`: the 3D airport map only works on `localhost:8000`).

- Every start resets the demo data to the same day, so each run begins the same way. Set `AVIANT_KEEP_DB=1` to keep changes between restarts. **Reset demo** (top right) also resets it.
- Only one console can run on port 8000. If it says the port is in use, stop the other one first (Ctrl+C in its terminal).
- Tests: `pytest`

## Demo script

1. **AZ410** (Rome, on time): open its live report and log the call
   *"AZ410 now estimating 60 minutes late, ATC holding over the Alps."* (speaker: *Dispatch AZ410*).
   The agents then find a crew problem (Crew tab), passengers and bags that miss their connections (Connecting passengers tab)
   and a NO-GO maintenance item (Maintenance tab). Its Decision log already shows a release the guards refused.
2. **Gates** tab: **AA70** + **60** are pre-selected. Click *Report delay*: the Gate agent sees gate B26 go idle, lends it to
   LH1124, and after your PIN the map shows LH1124 taxi in, take off, and AA70 land back into B26.

## On Vercel

The same app runs on Vercel as a serverless function (`api/index.py`, `vercel.json`). Set `OCC_CONTROLLER_PIN` and
`OPENROUTER_API_KEY` in the Vercel project settings. Good to know:

- **The first page load can take a few seconds** (cold start) and agent steps take longer than locally, because the AI calls
  run inside each request. Wait for them to finish.
- Each cold start begins from fresh demo data, so state can reset after the site has been idle.
- The **3D map** needs a logostream embed key for the Vercel address (keys are bound to one site). Add it to `EMBED_KEYS` in
  `static/gates.js`; until then the Gates tab works without the map and says so.

## Features

- **Live overview**: a globe and a map of all inbound flights, coloured by delay.
- **Live report**: an AI summary of each flight built from staff calls and live data, with 3 suggested recovery plans.
- **Decision hub**: compare plans, see costs, review each area (network, maintenance, crew, baggage, passengers) and approve the whole plan in one step.
- **Crew**: duty time for every crew member, with legal standby replacements.
- **Connecting passengers**: who will miss their connection, rebooking with vulnerable passengers first, and bags that follow them.
- **Maintenance**: open aircraft faults, engineer assignment and licensed sign-off.
- **Decision log**: every call, decision and approval in one place.
- **Gates**: a live 3D map of Frankfurt (logostream's embeddable airport map) with every arrival, turnaround and departure at its real gate.
- **Specialist agents**: a Crew agent (standby swaps), a Passenger agent (holds and rebookings), a Maintenance agent (engineer assignments) and a Gate agent (lends the gate a late arrival leaves empty, moves flights off remote stands) each work out their own area and suggest what the Crew, Connecting passengers, Maintenance and Gates pages show. Code gives them only options the safety rules allow; each re-decides by itself when something in its area changes.
- **Orchestrator**: combines the four agents' proposals into the live report and the 3 Decision hub scenarios.
- **Background agent**: checks every 30 seconds for new delays and runs the specialists and the orchestrator by itself. A delay stated on a call saved on a live report starts them at once, and the report shows each agent working.
- **Live-demo flight AZ410** (Rome, on time): its crew, connections and a NO-GO item only become problems once a delay is stated on a call (e.g. "AZ410 now estimating 60 minutes late"), so all three agents have something to solve.
- **Safety**: hard rules the AI cannot bypass, a PIN for every approval, all-or-nothing changes and a tamper-proof audit log.
