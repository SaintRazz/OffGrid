import json
import shutil
import os
import tempfile
from uuid import uuid4
from datetime import datetime, timezone
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
CURRENT_SAVE_ID = None
SIMULATION_LOCK = Lock()
app.extensions["simulation"] = None


def create_simulation(game_state_file):
    return Simulation(
        facilities_file=FACILITIES_FILE,
        resources_file=RESOURCES_FILE,
        household_profile_file=HOUSEHOLD_PROFILE_FILE,
        game_state_file=game_state_file,
        crop_file=BASE_DIR / "crop.json",
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

    valid = []
    for path in candidates:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, dict) and all(key in data for key in ("time", "map", "facilities")):
                valid.append(path)
        except (OSError, ValueError):
            continue
    return valid


def save_record(path):
    try:
        relative = path.relative_to(BASE_DIR)
    except ValueError:
        relative = Path(path.name)

    relative_text = relative.as_posix()
    return {
        "id": relative_text,
        "filename": path.name,
        "label": json.loads(path.read_text(encoding="utf-8")).get("save_name", path.stem),
        "saved_at": datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat(),
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
        "save_id": CURRENT_SAVE_ID,
    })


@app.get("/api/saves")
def saved_games():
    return jsonify({"saves": [save_record(path) for path in find_saved_games()]})


@app.post("/api/new-game")
def new_game():
    global CURRENT_SAVE_ID
    if not NEW_GAME_FILE.exists():
        return jsonify({
            "error": f"New-game template not found: {NEW_GAME_FILE.name}"
        }), 500

    try:
        with SIMULATION_LOCK:
            shutil.copyfile(NEW_GAME_FILE, ACTIVE_GAME_FILE)
            simulation = activate_game(ACTIVE_GAME_FILE, "New Game")
            CURRENT_SAVE_ID = None
            state = simulation.state()
    except (OSError, json.JSONDecodeError, TypeError, ValueError, KeyError) as exc:
        return jsonify({"error": str(exc)}), 500

    return jsonify({
        "save_id": None,
        "status": "new_game",
        "file": ACTIVE_GAME_FILE.name,
        "game_name": CURRENT_GAME_NAME,
        "state": state,
    })


@app.post("/api/load-game")
def load_game():
    global CURRENT_GAME_FILE, CURRENT_GAME_NAME, CURRENT_SAVE_ID
    payload = request.get_json(silent=True) or {}
    save_id = payload.get("save_id")

    if not isinstance(save_id, str) or not save_id.strip():
        return jsonify({"error": "A saved game must be selected."}), 400

    try:
        selected = resolve_save_id(save_id)
        with SIMULATION_LOCK:
            # Work on ActiveGame; named snapshots change only on explicit Save.
            simulation = create_simulation(selected)
            name = simulation.game_state.get("save_name", selected.stem)
            write_snapshot(ACTIVE_GAME_FILE, simulation.game_state)
            simulation.game_state_file = ACTIVE_GAME_FILE
            app.extensions["simulation"] = simulation
            CURRENT_GAME_FILE = ACTIVE_GAME_FILE
            CURRENT_GAME_NAME = name
            CURRENT_SAVE_ID = save_id
            state = simulation.state()
    except (OSError, json.JSONDecodeError, TypeError, ValueError, KeyError) as exc:
        return jsonify({"error": str(exc)}), 400

    return jsonify({
        "save_id": CURRENT_SAVE_ID,
        "status": "loaded",
        "file": selected.name,
        "game_name": CURRENT_GAME_NAME,
        "state": state,
    })


def write_snapshot(path, state):
    """Replace a snapshot atomically so interrupted writes preserve the old save."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         suffix=".tmp", delete=False) as output:
            temporary = Path(output.name)
            json.dump(state, output, indent=2, allow_nan=False)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


@app.post("/api/save-game")
def save_game():
    global CURRENT_SAVE_ID, CURRENT_GAME_NAME
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        return jsonify({"error": "Save request must be an object."}), 400
    name = payload.get("name")
    if "name" in payload and (not isinstance(name, str) or not name.strip() or
                              len(name.strip()) > 80 or any(ord(c) < 32 for c in name)):
        return jsonify({"error": "Enter a save name of 1 to 80 characters without control characters."}), 400
    try:
        with SIMULATION_LOCK:
            simulation = get_simulation()
            if name is not None:
                name = name.strip()
                destination = SAVES_DIR / (uuid4().hex + ".json")
            elif CURRENT_SAVE_ID:
                destination = resolve_save_id(CURRENT_SAVE_ID)
                # Preserve legacy source snapshots in the repository.
                if destination.parent != SAVES_DIR:
                    destination = SAVES_DIR / (uuid4().hex + ".json")
                name = CURRENT_GAME_NAME
            else:
                return jsonify({"error": "Name your first save.", "name_required": True}), 400
            snapshot = {**simulation.game_state, "save_name": name}
            write_snapshot(destination, snapshot)
            CURRENT_SAVE_ID = save_record(destination)["id"]
            CURRENT_GAME_NAME = name
    except RuntimeError as exc:
        return jsonify({"error": str(exc)}), 409
    except (OSError, ValueError, TypeError) as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify({"status": "saved", "game_name": name, "save_id": CURRENT_SAVE_ID,
                    "save": save_record(destination)})


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
        "status": "queued",
        "task": event,
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
        "status": "queued",
        "task": event,
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
        "status": "queued",
        "task": event,
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
        "status": "queued",
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
        "status": "queued",
        "task": event,
        "state": state,
    })


@app.post("/api/facilities/<instance_id>/collect")
def collect_facility_output(instance_id):
    payload = request.get_json(silent=True) or {}

    try:
        with SIMULATION_LOCK:
            task = get_simulation().queue_facility_collection(
                instance_id=instance_id,
                resource_id=payload.get("resource_id"),
                amount=payload.get("amount"),
                source_field=payload.get("source_field"),
            )
            state = get_simulation().state()
    except (RuntimeError, OSError, TypeError, ValueError, KeyError) as exc:
        return jsonify({"error": str(exc)}), 400

    return jsonify({
        "status": "queued",
        "task": task,
        "state": state,
    })


@app.post("/api/gardens/<instance_id>/action")
def garden_action(instance_id):
    payload = request.get_json(silent=True) or {}
    try:
        with SIMULATION_LOCK:
            task = get_simulation().queue_garden_action(
                instance_id, payload.get("action"), crop_id=payload.get("crop_id"),
                amendment_resource_id=payload.get("amendment_resource_id"), event_id=payload.get("event_id"))
            state = get_simulation().state()
    except (RuntimeError, OSError, TypeError, ValueError, KeyError) as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify({"status": "queued", "task": task, "state": state})


@app.post("/api/facilities/<instance_id>/service")
def service_facility(instance_id):
    try:
        with SIMULATION_LOCK:
            task = get_simulation().queue_service_facility(instance_id)
            state = get_simulation().state()
    except (RuntimeError, OSError, TypeError, ValueError, KeyError) as exc:
        return jsonify({"error": str(exc)}), 400

    return jsonify({
        "status": "queued",
        "task": task,
        "state": state,
    })


@app.post("/api/tasks/<task_id>/cancel")
def cancel_task(task_id):
    try:
        with SIMULATION_LOCK:
            task = get_simulation().cancel_task(task_id)
            state = get_simulation().state()
    except (RuntimeError, OSError, TypeError, ValueError, KeyError) as exc:
        return jsonify({"error": str(exc)}), 400

    return jsonify({
        "status": "cancelled",
        "task": task,
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
