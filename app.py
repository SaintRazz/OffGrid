from flask import Flask, jsonify, render_template, request

app = Flask(__name__)


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


@app.get("/")
def index():
    return render_template("index.html")


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
