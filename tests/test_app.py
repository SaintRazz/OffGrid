import pytest

from app import calculate_system_preview


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
