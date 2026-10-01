# OffGrid

Minimal Flask starter with a plain HTML, CSS, and JavaScript frontend.

## Run locally

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python app.py
```

Open http://127.0.0.1:5000 in your browser.

## Simulation data

`facilities.json` defines buildable facility footprints, hourly inputs and outputs, labor requirements, and optional production hours. `resources.json` defines resource units, starting stock, storage limits, the simulation start time, and available labor per hour. Facility placements and simulation time are held in memory and reset when the Flask process restarts.

Use **Advance 1 hour** in the map header to run one simulation tick. A tick consumes facility inputs and labor, then adds facility outputs to the shared resource inventory.
