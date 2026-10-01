import json
from copy import deepcopy
from datetime import datetime, timedelta
from pathlib import Path

from flask import Flask, jsonify, render_template, request

app = Flask(__name__)
DATA_DIR = Path(__file__).resolve().parent
FACILITIES_FILE = DATA_DIR / "facilities.json"
RESOURCES_FILE = DATA_DIR / "resources.json"
MAP_SIZE = 42


def calculate_system_preview(daily_load_kwh, solar_kw, battery_kwh, autonomy_days):
    if daily_load_kwh <= 0:
        raise ValueError("Daily load must be greater than zero.")
    if solar_kw < 0:
        raise ValueError("Solar capacity cannot be negative.")
    if battery_kwh < 0:
        raise ValueError("Battery capacity cannot be negative.")
    if autonomy_days <= 0:
        raise ValueError("Autonomy target must be greater than zero.")

    daily_generation_kwh = solar_kw * 4.0
    solar_coverage_pct = min((daily_generation_kwh / daily_load_kwh) * 100, 100.0)

    effective_daily_demand_kwh = daily_load_kwh * 1.25
    estimated_autonomy_days = battery_kwh / effective_daily_demand_kwh

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


class Simulation:
    def __init__(self, facilities_file=FACILITIES_FILE, resources_file=RESOURCES_FILE):
        with facilities_file.open(encoding="utf-8") as definition_file:
            self.facility_definitions = json.load(definition_file)["facilities"]
        with resources_file.open(encoding="utf-8") as definition_file:
            self.resource_config = json.load(definition_file)

        self.resource_definitions = self.resource_config["resources"]
        for facility in self.facility_definitions:
            for resource_id in (*facility["inputs"], *facility["outputs"]):
                if resource_id not in self.resource_definitions:
                    raise ValueError(f"Unknown resource '{resource_id}' in {facility['id']}.")
        self.reset()

    def reset(self):
        self.current_time = datetime.fromisoformat(self.resource_config["starting_at"])
        self.tick_count = 0
        self.next_instance_id = 1
        self.inventory = {
            resource_id: resource["initial_stock"]
            for resource_id, resource in self.resource_definitions.items()
        }
        self.instances = []

    def state(self):
        return {
            "current_time": self.current_time.isoformat(),
            "tick_count": self.tick_count,
            "labor_hours_per_tick": self.resource_config["labor_hours_per_tick"],
            "resources": {
                resource_id: {
                    **definition,
                    "amount": round(self.inventory[resource_id], 4),
                }
                for resource_id, definition in self.resource_definitions.items()
            },
            "facility_definitions": deepcopy(self.facility_definitions),
            "instances": deepcopy(self.instances),
        }

    def place_facility(self, facility_id, column, row, rotated=False):
        definition = next(
            (item for item in self.facility_definitions if item["id"] == facility_id), None
        )
        if definition is None:
            raise ValueError("Unknown facility type.")
        if type(column) is not int or type(row) is not int:
            raise ValueError("Map coordinates must be integers.")
        if type(rotated) is not bool:
            raise ValueError("Rotation must be a boolean.")

        width, height = definition["width"], definition["height"]
        if rotated:
            width, height = height, width
        if column < 0 or row < 0 or column + width > MAP_SIZE or row + height > MAP_SIZE:
            raise ValueError("Facility footprint is outside the map.")
        for placed in self.instances:
            if not (
                column + width <= placed["column"]
                or placed["column"] + placed["width"] <= column
                or row + height <= placed["row"]
                or placed["row"] + placed["height"] <= row
            ):
                raise ValueError("Facility footprint overlaps another structure.")

        instance = {
            "instance_id": f"facility-{self.next_instance_id}",
            "facility_id": facility_id,
            "column": column,
            "row": row,
            "width": width,
            "height": height,
            "rotated": rotated,
            "last_operation": None,
        }
        self.next_instance_id += 1
        self.instances.append(instance)
        return deepcopy(instance)

    def advance_hour(self):
        processed_at = self.current_time
        available = self.inventory.copy()
        staged_outputs = {resource_id: 0.0 for resource_id in self.resource_definitions}
        labor_remaining = self.resource_config["labor_hours_per_tick"]
        operations = []

        for instance in self.instances:
            definition = next(
                item for item in self.facility_definitions
                if item["id"] == instance["facility_id"]
            )
            output_multiplier = self._production_multiplier(definition, processed_at.hour)
            limiters = []
            utilization = 0.0 if output_multiplier == 0 else 1.0

            for resource_id, amount in definition["inputs"].items():
                if amount > 0:
                    ratio = available[resource_id] / amount
                    limiters.append((ratio, f"not enough {self.resource_definitions[resource_id]['name'].lower()}"))
                    utilization = min(utilization, ratio)

            labor_required = definition["labor_hours"]
            if labor_required > 0:
                ratio = labor_remaining / labor_required
                limiters.append((ratio, "not enough labor"))
                utilization = min(utilization, ratio)

            for resource_id, hourly_output in definition["outputs"].items():
                amount = hourly_output * output_multiplier
                capacity = self.resource_definitions[resource_id].get("capacity")
                if amount > 0 and capacity is not None:
                    room = capacity - available[resource_id] - staged_outputs[resource_id]
                    ratio = room / amount
                    limiters.append((ratio, f"{self.resource_definitions[resource_id]['name'].lower()} storage full"))
                    utilization = min(utilization, ratio)

            utilization = max(0.0, min(1.0, utilization))
            consumed = {}
            produced = {}
            for resource_id, amount in definition["inputs"].items():
                used = amount * utilization
                available[resource_id] -= used
                if used > 0:
                    consumed[resource_id] = round(used, 4)
            labor_used = labor_required * utilization
            labor_remaining -= labor_used
            for resource_id, hourly_output in definition["outputs"].items():
                amount = hourly_output * output_multiplier * utilization
                staged_outputs[resource_id] += amount
                if amount > 0:
                    produced[resource_id] = round(amount, 4)

            reason = None
            if output_multiplier == 0:
                reason = "outside production hours"
            elif utilization < 1:
                reason = min(limiters, key=lambda limiter: limiter[0])[1]
            operation = {
                "status": "operating" if utilization > 0 and output_multiplier > 0 else "idle",
                "utilization_pct": round(utilization * 100, 1),
                "labor_used": round(labor_used, 4),
                "consumed": consumed,
                "produced": produced,
                "reason": reason,
            }
            instance["last_operation"] = operation
            operations.append({"instance_id": instance["instance_id"], **deepcopy(operation)})

        for resource_id, amount in staged_outputs.items():
            capacity = self.resource_definitions[resource_id].get("capacity")
            total = available[resource_id] + amount
            self.inventory[resource_id] = min(total, capacity) if capacity is not None else total

        self.tick_count += 1
        self.current_time += timedelta(hours=1)
        return {
            "processed_at": processed_at.isoformat(),
            "operations": operations,
            "state": self.state(),
        }

    @staticmethod
    def _production_multiplier(definition, hour):
        window = definition.get("production_window")
        if window is None:
            return 1.0
        start, peak, end = window["start_hour"], window["peak_hour"], window["end_hour"]
        if hour < start or hour >= end:
            return 0.0
        if hour <= peak:
            return (hour - start) / (peak - start)
        return (end - hour) / (end - peak)


app.extensions["simulation"] = Simulation()


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
            payload.get("facility_id"),
            payload.get("column"),
            payload.get("row"),
            payload.get("rotated", False),
        )
    except (TypeError, ValueError) as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify(instance), 201


@app.post("/api/tick")
def advance_simulation():
    return jsonify(app.extensions["simulation"].advance_hour())


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
