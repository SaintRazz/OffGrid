import json
import shutil
from pathlib import Path
from threading import Lock

from flask import Flask, jsonify, render_template, request

from simulation import Simulation


app = Flask(__name__)

BASE_DIR = Path(__file__).resolve().parent
FACILITIES_FILE = BASE_DIR / "facilities.json"
RESOURCES_FILE = BASE_DIR / "resources.json"
HOUSEHOLD_PROFILE_FILE = BASE_DIR / "HouseholdProfile.json"
NEW_GAME_FILE = BASE_DIR / "NewGame.json"
ACTIVE_GAME_FILE = BASE_DIR / "ActiveGame.json"
SAVES_DIR = BASE_DIR / "saves"

CURRENT_GAME_FILE = None
CURRENT_GAME_NAME = None
SIMULATION_LOCK = Lock()
app.extensions["simulation"] = None


def create_simulation(game_state_file):
    return Simulation(
        facilities_file=FACILITIES_FILE,
        resources_file=RESOURCES_FILE,
        household_profile_file=HOUSEHOLD_PROFILE_FILE,
        game_state_file=game_state_file,
    )


def get_simulation():
    simulation = app.extensions.get("simulation")
    if simulation is None:
        raise RuntimeError("No game is currently loaded.")
    return simulation


def find_saved_games():
    excluded_names = {
        FACILITIES_FILE.name,
        RESOURCES_FILE.name,
        HOUSEHOLD_PROFILE_FILE.name,
        NEW_GAME_FILE.name,
        ACTIVE_GAME_FILE.name,
    }

    candidates = []
    for path in sorted(BASE_DIR.glob("*.json")):
        if path.name not in excluded_names:
            candidates.append(path)

    if SAVES_DIR.exists():
        candidates.extend(sorted(SAVES_DIR.glob("*.json")))

    return candidates


def save_record(path):
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
    records = {
        save_record(path)["id"]: path
        for path in find_saved_games()
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
    return jsonify({"saves": [save_record(path) for path in find_saved_games()]})


@app.post("/api/new-game")
def new_game():
    if not NEW_GAME_FILE.exists():
        return jsonify({
            "error": f"New-game template not found: {NEW_GAME_FILE.name}"
        }), 500

    try:
        with SIMULATION_LOCK:
            shutil.copyfile(NEW_GAME_FILE, ACTIVE_GAME_FILE)
            simulation = activate_game(ACTIVE_GAME_FILE, "New Game")
            state = simulation.state()
    except (OSError, json.JSONDecodeError, TypeError, ValueError, KeyError) as exc:
        return jsonify({"error": str(exc)}), 500

    return jsonify({
        "status": "new_game",
        "file": ACTIVE_GAME_FILE.name,
        "game_name": CURRENT_GAME_NAME,
        "state": state,
    })


@app.post("/api/load-game")
def load_game():
    payload = request.get_json(silent=True) or {}
    save_id = payload.get("save_id")

    if not isinstance(save_id, str) or not save_id.strip():
        return jsonify({"error": "A saved game must be selected."}), 400

    try:
        selected = resolve_save_id(save_id)
        with SIMULATION_LOCK:
            simulation = activate_game(selected, selected.stem)
            state = simulation.state()
    except (OSError, json.JSONDecodeError, TypeError, ValueError, KeyError) as exc:
        return jsonify({"error": str(exc)}), 400

    return jsonify({
        "status": "loaded",
        "file": selected.name,
        "game_name": CURRENT_GAME_NAME,
        "state": state,
    })


@app.get("/api/simulation")
def simulation_state():
    try:
        with SIMULATION_LOCK:
            state = get_simulation().state()
        return jsonify(state)
    except RuntimeError as exc:
        return jsonify({"error": str(exc)}), 409


@app.post("/api/subtick")
def advance_subtick():
    """Advance one simulated minute.

    The browser calls this once per real-time second. Facility and household
    processing runs only when the 60th sub-tick closes the simulated hour.
    """
    try:
        with SIMULATION_LOCK:
            result = get_simulation().advance_subtick()
    except (RuntimeError, OSError, TypeError, ValueError, KeyError) as exc:
        return jsonify({"error": str(exc)}), 400

    return jsonify(result)




@app.post("/api/advance")
def advance_minutes():
    payload = request.get_json(silent=True) or {}

    try:
        with SIMULATION_LOCK:
            result = get_simulation().advance_minutes(payload.get("minutes"))
    except (RuntimeError, OSError, TypeError, ValueError, KeyError) as exc:
        return jsonify({"error": str(exc)}), 400

    return jsonify(result)


@app.post("/api/player/inventory/transfer")
def transfer_player_inventory():
    payload = request.get_json(silent=True) or {}

    try:
        with SIMULATION_LOCK:
            event = get_simulation().transfer_player_inventory(
                resource_id=payload.get("resource_id"),
                amount=payload.get("amount"),
                direction=payload.get("direction"),
            )
            state = get_simulation().state()
    except (RuntimeError, OSError, TypeError, ValueError, KeyError) as exc:
        return jsonify({"error": str(exc)}), 400

    return jsonify({
        "status": "transferred",
        "event": event,
        "state": state,
    })


@app.post("/api/house/pickup")
def pickup_house_output():
    payload = request.get_json(silent=True) or {}

    try:
        with SIMULATION_LOCK:
            event = get_simulation().pickup_house_output(
                resource_id=payload.get("resource_id"),
                amount=payload.get("amount"),
            )
            state = get_simulation().state()
    except (RuntimeError, OSError, TypeError, ValueError, KeyError) as exc:
        return jsonify({"error": str(exc)}), 400

    return jsonify({
        "status": "picked_up",
        "event": event,
        "state": state,
    })


@app.post("/api/house/storage/transfer")
def transfer_house_storage():
    payload = request.get_json(silent=True) or {}

    try:
        with SIMULATION_LOCK:
            event = get_simulation().transfer_house_storage(
                resource_id=payload.get("resource_id"),
                amount=payload.get("amount"),
                direction=payload.get("direction"),
            )
            state = get_simulation().state()
    except (RuntimeError, OSError, TypeError, ValueError, KeyError) as exc:
        return jsonify({"error": str(exc)}), 400

    return jsonify({
        "status": "transferred",
        "event": event,
        "state": state,
    })


@app.post("/api/orders")
def order_material():
    payload = request.get_json(silent=True) or {}

    try:
        with SIMULATION_LOCK:
            event = get_simulation().order_house_material(
                resource_id=payload.get("resource_id"),
                amount=payload.get("amount"),
            )
            state = get_simulation().state()
    except (RuntimeError, OSError, TypeError, ValueError, KeyError) as exc:
        return jsonify({"error": str(exc)}), 400

    return jsonify({
        "status": "delivered",
        "event": event,
        "state": state,
    })


@app.post("/api/player/walk")
def walk_player():
    payload = request.get_json(silent=True) or {}

    try:
        column = float(payload.get("column"))
        row = float(payload.get("row"))
        with SIMULATION_LOCK:
            player = get_simulation().start_walk(column, row)
            state = get_simulation().state()
    except (RuntimeError, OSError, TypeError, ValueError, KeyError) as exc:
        return jsonify({"error": str(exc)}), 400

    return jsonify({
        "status": "walking" if player.get("current_task") else "already_there",
        "player": player,
        "state": state,
    })


@app.post("/api/facilities")
def place_facility():
    payload = request.get_json(silent=True) or {}

    try:
        with SIMULATION_LOCK:
            instance = get_simulation().place_facility(
                facility_id=payload.get("facility_id"),
                column=payload.get("column"),
                row=payload.get("row"),
                rotated=False,
            )
            state = get_simulation().state()
    except (RuntimeError, TypeError, ValueError, KeyError) as exc:
        return jsonify({"error": str(exc)}), 400

    return jsonify({"instance": instance, "state": state}), 201


@app.post("/api/facilities/<instance_id>/fill")
def fill_facility(instance_id):
    payload = request.get_json(silent=True) or {}

    try:
        with SIMULATION_LOCK:
            event = get_simulation().fill_facility(
                instance_id=instance_id,
                resource_id=payload.get("resource_id"),
                amount=payload.get("amount"),
            )
            state = get_simulation().state()
    except (RuntimeError, OSError, TypeError, ValueError, KeyError) as exc:
        return jsonify({"error": str(exc)}), 400

    return jsonify({
        "status": "staged",
        "event": event,
        "state": state,
    })


@app.post("/api/tick")
def advance_simulation_legacy():
    """Legacy/manual full-tick endpoint retained for debugging only."""
    try:
        with SIMULATION_LOCK:
            result = get_simulation().advance_hour()
    except (RuntimeError, OSError, TypeError, ValueError, KeyError) as exc:
        return jsonify({"error": str(exc)}), 400

    return jsonify(result)


@app.post("/api/save")
def save_simulation():
    try:
        with SIMULATION_LOCK:
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
        with SIMULATION_LOCK:
            get_simulation().load_game_state()
            state = get_simulation().state()
    except (
        RuntimeError,
        OSError,
        json.JSONDecodeError,
        TypeError,
        ValueError,
        KeyError,
    ) as exc:
        return jsonify({"error": str(exc)}), 400

    return jsonify(state)


if __name__ == "__main__":
    app.run(debug=True, use_reloader=False)
