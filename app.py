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

# Set during startup after the user chooses New Game or a saved game.
CURRENT_GAME_FILE = None


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


def find_saved_games():
    """
    Return JSON files that are reasonable candidates for saved games.

    Definition/configuration files and the immutable NewGame template are
    excluded. Root-level GameState.json remains discoverable, and any JSON
    files in ./saves are also included.
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


def choose_game_file():
    """
    Prompt in the terminal for New Game or Load Game.

    New Game copies the pristine NewGame.json template to ActiveGame.json.
    This prevents normal ticking/autosaving from ever modifying NewGame.json.
    Loading a save uses that selected save file directly, so subsequent ticks
    continue updating that save.
    """
    print()
    print("Homestead Simulation")
    print("--------------------")
    print("1. Start a new game")
    print("2. Load a saved game")

    while True:
        choice = input("Choose 1 or 2: ").strip()

        if choice == "1":
            if not NEW_GAME_FILE.exists():
                raise FileNotFoundError(
                    f"New-game template not found: {NEW_GAME_FILE}"
                )

            shutil.copyfile(NEW_GAME_FILE, ACTIVE_GAME_FILE)
            print(f"New game loaded from {NEW_GAME_FILE.name}.")
            print(f"Runtime state will autosave to {ACTIVE_GAME_FILE.name}.")
            return ACTIVE_GAME_FILE

        if choice == "2":
            saved_games = find_saved_games()

            if not saved_games:
                print("No saved games were found.")
                print("Choose 1 to start a new game.")
                continue

            print()
            print("Saved games:")
            for index, path in enumerate(saved_games, start=1):
                try:
                    display_name = path.relative_to(BASE_DIR)
                except ValueError:
                    display_name = path.name
                print(f"{index}. {display_name}")

            while True:
                selection = input(
                    "Choose a saved game number, or B to go back: "
                ).strip()

                if selection.lower() == "b":
                    break

                try:
                    save_index = int(selection) - 1
                except ValueError:
                    print("Please enter a valid number or B.")
                    continue

                if 0 <= save_index < len(saved_games):
                    selected = saved_games[save_index]
                    print(f"Loading saved game: {selected.name}")
                    return selected

                print("That save number is not valid.")

            print()
            print("1. Start a new game")
            print("2. Load a saved game")
            continue

        print("Please enter 1 or 2.")


def create_simulation(game_state_file):
    """
    Build the authoritative simulation object using the selected runtime/save
    state file.
    """
    return Simulation(
        facilities_file=FACILITIES_FILE,
        resources_file=RESOURCES_FILE,
        game_state_file=game_state_file,
    )


def get_simulation():
    simulation = app.extensions.get("simulation")
    if simulation is None:
        raise RuntimeError(
            "Simulation has not been initialized. Start the application with "
            "'python app.py' and choose New Game or Load Game."
        )
    return simulation


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/simulation")
def simulation_state():
    try:
        return jsonify(get_simulation().state())
    except RuntimeError as exc:
        return jsonify({"error": str(exc)}), 503


@app.post("/api/facilities")
def place_facility():
    payload = request.get_json(silent=True) or {}

    try:
        instance = get_simulation().place_facility(
            facility_id=payload.get("facility_id"),
            column=payload.get("column"),
            row=payload.get("row"),
            rotated=payload.get("rotated", False),
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
    """
    Reload the currently selected game-state file from disk without restarting
    Flask.
    """
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
    CURRENT_GAME_FILE = choose_game_file()
    app.extensions["simulation"] = create_simulation(CURRENT_GAME_FILE)

    # Disable Flask's automatic reloader so the startup prompt only appears
    # once. Debug mode remains enabled for development.
    app.run(debug=True, use_reloader=False)
