import json
import shutil
from pathlib import Path

from flask import Flask, jsonify, render_template, request

from simulation import Simulation


app = Flask(__name__)

BASE_DIR = Path(__file__).resolve().parent
FACILITIES_FILE = BASE_DIR / "facilities.json"
RESOURCES_FILE = BASE_DIR / "resources.json"
NEW_GAME_FILE = BASE_DIR / "NewGame.json"
ACTIVE_GAME_FILE = BASE_DIR / "ActiveGame.json"
SAVES_DIR = BASE_DIR / "saves"

CURRENT_GAME_FILE = None
CURRENT_GAME_NAME = None
app.extensions["simulation"] = None


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


def create_simulation(game_state_file):
    return Simulation(
        facilities_file=FACILITIES_FILE,
        resources_file=RESOURCES_FILE,
        game_state_file=game_state_file,
    )


def get_simulation():
    simulation = app.extensions.get("simulation")
    if simulation is None:
        raise RuntimeError("No game is currently loaded.")
    return simulation


def find_saved_games():
    """
    Return loadable JSON save files.

    NewGame.json is an immutable template and ActiveGame.json is the temporary
    working state for a newly started game, so neither is shown as a saved game.
    """
    excluded_names = {
        FACILITIES_FILE.name,
        RESOURCES_FILE.name,
        NEW_GAME_FILE.name,
        ACTIVE_GAME_FILE.name,
    }

    candidates = []

    for path in sorted(BASE_DIR.glob("*.json")):
        if path.name not in excluded_names:
            candidates.append(path)

    if SAVES_DIR.exists():
        for path in sorted(SAVES_DIR.glob("*.json")):
            candidates.append(path)

    return candidates


def save_record(path):
    """
    Create a browser-safe identifier for a save without exposing arbitrary
    filesystem paths to the load endpoint.
    """
    try:
        relative = path.relative_to(BASE_DIR)
    except ValueError:
        relative = Path(path.name)

    relative_text = relative.as_posix()

    return {
        "id": relative_text,
        "filename": path.name,
        "label": path.stem,
        "path": relative_text,
    }


def resolve_save_id(save_id):
    """
    Resolve only files that are already in the server-generated save list.
    """
    records = {
        record["id"]: path
        for path in find_saved_games()
        for record in [save_record(path)]
    }

    selected = records.get(save_id)

    if selected is None:
        raise ValueError("Unknown saved game.")

    return selected


def activate_game(game_state_file, game_name=None):
    global CURRENT_GAME_FILE, CURRENT_GAME_NAME

    simulation = create_simulation(game_state_file)
    CURRENT_GAME_FILE = game_state_file
    CURRENT_GAME_NAME = game_name or game_state_file.stem
    app.extensions["simulation"] = simulation

    return simulation


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/session")
def session_status():
    return jsonify({
        "game_loaded": app.extensions.get("simulation") is not None,
        "file": CURRENT_GAME_FILE.name if CURRENT_GAME_FILE else None,
        "game_name": CURRENT_GAME_NAME,
    })


@app.get("/api/saves")
def saved_games():
    return jsonify({
        "saves": [
            save_record(path)
            for path in find_saved_games()
        ]
    })


@app.post("/api/new-game")
def new_game():
    if not NEW_GAME_FILE.exists():
        return jsonify({
            "error": f"New-game template not found: {NEW_GAME_FILE.name}"
        }), 500

    try:
        shutil.copyfile(NEW_GAME_FILE, ACTIVE_GAME_FILE)
        simulation = activate_game(ACTIVE_GAME_FILE, "New Game")
    except (OSError, json.JSONDecodeError, TypeError, ValueError, KeyError) as exc:
        return jsonify({"error": str(exc)}), 500

    return jsonify({
        "status": "new_game",
        "file": ACTIVE_GAME_FILE.name,
        "game_name": CURRENT_GAME_NAME,
        "state": simulation.state(),
    })


@app.post("/api/load-game")
def load_game():
    payload = request.get_json(silent=True) or {}
    save_id = payload.get("save_id")

    if not isinstance(save_id, str) or not save_id.strip():
        return jsonify({"error": "A saved game must be selected."}), 400

    try:
        selected = resolve_save_id(save_id)
        simulation = activate_game(selected, selected.stem)
    except (
        OSError,
        json.JSONDecodeError,
        TypeError,
        ValueError,
        KeyError,
    ) as exc:
        return jsonify({"error": str(exc)}), 400

    return jsonify({
        "status": "loaded",
        "file": selected.name,
        "game_name": CURRENT_GAME_NAME,
        "state": simulation.state(),
    })


@app.get("/api/simulation")
def simulation_state():
    try:
        return jsonify(get_simulation().state())
    except RuntimeError as exc:
        return jsonify({"error": str(exc)}), 409


@app.post("/api/facilities")
def place_facility():
    payload = request.get_json(silent=True) or {}

    try:
        instance = get_simulation().place_facility(
            facility_id=payload.get("facility_id"),
            column=payload.get("column"),
            row=payload.get("row"),
            rotated=False,
        )
    except (RuntimeError, TypeError, ValueError, KeyError) as exc:
        return jsonify({"error": str(exc)}), 400

    return jsonify(instance), 201


@app.post("/api/tick")
def advance_simulation():
    try:
        result = get_simulation().advance_hour()
    except (RuntimeError, TypeError, ValueError, KeyError) as exc:
        return jsonify({"error": str(exc)}), 400

    return jsonify(result)


@app.post("/api/save")
def save_simulation():
    try:
        get_simulation().save()
    except (RuntimeError, OSError, TypeError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 500

    return jsonify({
        "status": "saved",
        "file": CURRENT_GAME_FILE.name if CURRENT_GAME_FILE else None,
    })


@app.post("/api/reload")
def reload_simulation():
    try:
        get_simulation().load_game_state()
    except (
        RuntimeError,
        OSError,
        json.JSONDecodeError,
        TypeError,
        ValueError,
        KeyError,
    ) as exc:
        return jsonify({"error": str(exc)}), 400

    return jsonify(get_simulation().state())


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
    # No terminal prompt. The browser startup overlay chooses New Game or Load Game.
    app.run(debug=True, use_reloader=False)
