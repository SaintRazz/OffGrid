import json
from pathlib import Path

from flask import Flask, jsonify, render_template, request

from simulation import Simulation


app = Flask(__name__)

BASE_DIR = Path(__file__).resolve().parent
FACILITIES_FILE = BASE_DIR / "facilities.json"
RESOURCES_FILE = BASE_DIR / "resources.json"
GAME_STATE_FILE = BASE_DIR / "GameState.json"


def calculate_system_preview(daily_load_kwh, solar_kw, battery_kwh, autonomy_days):
    """
    Legacy system-sizing helper retained for the existing UI/API.
    This is separate from the live homestead simulation.
    """
    if daily_load_kwh <= 0:
        raise ValueError("Daily load must be greater than zero.")
    if solar_kw < 0:
        raise ValueError("Solar capacity cannot be negative.")
    if battery_kwh < 0:
        raise ValueError("Battery capacity cannot be negative.")
    if autonomy_days <= 0:
        raise ValueError("Autonomy target must be greater than zero.")

    daily_generation_kwh = solar_kw * 4.0
    solar_coverage_pct = min(
        (daily_generation_kwh / daily_load_kwh) * 100,
        100.0,
    )

    effective_daily_demand_kwh = daily_load_kwh * 1.25
    estimated_autonomy_days = (
        battery_kwh / effective_daily_demand_kwh
        if effective_daily_demand_kwh > 0
        else 0
    )

    if estimated_autonomy_days >= autonomy_days and solar_coverage_pct >= 80:
        system_status = "Ready for off-grid use"
    elif estimated_autonomy_days >= autonomy_days:
        system_status = "Battery is sufficient"
    elif solar_coverage_pct >= 100:
        system_status = "Battery is the limiting factor"
    else:
        system_status = "Needs more capacity"

    return {
        "daily_generation_kwh": round(daily_generation_kwh, 2),
        "solar_coverage_pct": round(solar_coverage_pct, 2),
        "estimated_autonomy_days": round(estimated_autonomy_days, 2),
        "system_status": system_status,
    }


def create_simulation():
    """
    Build the authoritative simulation object from the project's definition
    files and persistent GameState.json.
    """
    return Simulation(
        facilities_file=FACILITIES_FILE,
        resources_file=RESOURCES_FILE,
        game_state_file=GAME_STATE_FILE,
    )


app.extensions["simulation"] = create_simulation()


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/simulation")
def simulation_state():
    return jsonify(app.extensions["simulation"].state())


@app.post("/api/facilities")
def place_facility():
    payload = request.get_json(silent=True) or {}

    try:
        instance = app.extensions["simulation"].place_facility(
            facility_id=payload.get("facility_id"),
            column=payload.get("column"),
            row=payload.get("row"),
            rotated=payload.get("rotated", False),
        )
    except (TypeError, ValueError, KeyError) as exc:
        return jsonify({"error": str(exc)}), 400

    return jsonify(instance), 201


@app.post("/api/tick")
def advance_simulation():
    try:
        result = app.extensions["simulation"].advance_hour()
    except (TypeError, ValueError, KeyError) as exc:
        return jsonify({"error": str(exc)}), 400

    return jsonify(result)


@app.post("/api/save")
def save_simulation():
    try:
        app.extensions["simulation"].save()
    except (OSError, TypeError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 500

    return jsonify({
        "status": "saved",
        "file": GAME_STATE_FILE.name,
    })


@app.post("/api/reload")
def reload_simulation():
    """
    Reload GameState.json from disk without restarting Flask.
    Useful while developing and manually editing the save-state file.
    """
    try:
        app.extensions["simulation"].load_game_state()
    except (OSError, json.JSONDecodeError, TypeError, ValueError, KeyError) as exc:
        return jsonify({"error": str(exc)}), 400

    return jsonify(app.extensions["simulation"].state())


@app.post("/api/system-preview")
def system_preview():
    payload = request.get_json(silent=True) or {}

    try:
        result = calculate_system_preview(
            float(payload.get("daily_load_kwh", 0)),
            float(payload.get("solar_kw", 0)),
            float(payload.get("battery_kwh", 0)),
            float(payload.get("autonomy_days", 1)),
        )
    except (TypeError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 400

    return jsonify(result)


if __name__ == "__main__":
    app.run(debug=True)
