import pytest

from app import Simulation, app, calculate_system_preview


@pytest.fixture
def simulation():
    simulation = Simulation()
    app.extensions["simulation"] = simulation
    return simulation


def test_calculate_system_preview_returns_expected_capacity_metrics():
    summary = calculate_system_preview(
        daily_load_kwh=10,
        solar_kw=2.0,
        battery_kwh=15,
        autonomy_days=2,
    )

    assert summary["daily_generation_kwh"] == pytest.approx(8.0)
    assert summary["solar_coverage_pct"] == pytest.approx(80.0)
    assert summary["estimated_autonomy_days"] == pytest.approx(1.2)
    assert summary["system_status"] == "Needs more capacity"


def test_tick_consumes_inputs_and_produces_facility_outputs(simulation):
    simulation.place_facility("chicken-coop", 0, 0)

    result = simulation.advance_hour()

    assert result["processed_at"] == "2026-04-01T08:00:00"
    assert result["state"]["current_time"] == "2026-04-01T09:00:00"
    assert result["state"]["tick_count"] == 1
    assert result["state"]["resources"]["feed"]["amount"] == pytest.approx(19.75)
    assert result["state"]["resources"]["water"]["amount"] == pytest.approx(498)
    assert result["state"]["resources"]["eggs"]["amount"] == pytest.approx(0.25)
    assert result["state"]["resources"]["organic_waste"]["amount"] == pytest.approx(10.1)
    assert result["operations"][0]["labor_used"] == pytest.approx(0.15)


def test_tick_stops_facility_when_an_input_is_unavailable(simulation):
    simulation.inventory["feed"] = 0
    simulation.place_facility("chicken-coop", 0, 0)

    result = simulation.advance_hour()

    assert result["operations"][0]["status"] == "idle"
    assert result["operations"][0]["reason"] == "not enough feed"
    assert result["state"]["resources"]["eggs"]["amount"] == 0


def test_tick_scales_facility_output_to_available_labor(simulation):
    simulation.resource_config["labor_hours_per_tick"] = 0.075
    simulation.place_facility("chicken-coop", 0, 0)

    result = simulation.advance_hour()

    assert result["operations"][0]["reason"] == "not enough labor"
    assert result["operations"][0]["labor_used"] == pytest.approx(0.075)
    assert result["state"]["resources"]["eggs"]["amount"] == pytest.approx(0.125)


def test_placement_and_tick_api_share_simulation_state(simulation):
    client = app.test_client()
    placement = client.post(
        "/api/facilities",
        json={"facility_id": "solar-array", "column": 0, "row": 0},
    )

    assert placement.status_code == 201
    assert client.post(
        "/api/facilities",
        json={"facility_id": "garden-plot", "column": 0, "row": 0},
    ).status_code == 400
    tick = client.post("/api/tick").get_json()

    assert tick["state"]["current_time"] == "2026-04-01T09:00:00"
    assert tick["state"]["instances"][0]["last_operation"]["produced"]["electricity"] > 0
