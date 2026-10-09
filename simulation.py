import json
from copy import deepcopy
from datetime import datetime, timedelta
from pathlib import Path


HOURS_PER_DAY = 24
HOURS_PER_YEAR = 365 * HOURS_PER_DAY


class Simulation:
    """
    Core simulation engine.

    Static rules come from facilities.json, resources.json, and
    HouseholdProfile.json. Dynamic world state comes from GameState.json.
    One call to advance_hour() processes one one-hour simulation tick.
    """

    def __init__(
        self,
        facilities_file,
        resources_file,
        household_profile_file,
        game_state_file,
    ):
        self.facilities_file = Path(facilities_file)
        self.resources_file = Path(resources_file)
        self.household_profile_file = Path(household_profile_file)
        self.game_state_file = Path(game_state_file)

        self.facility_config = {}
        self.facility_definitions = {}
        self.resource_config = {}
        self.resource_definitions = {}
        self.household_profile = {}
        self.game_state = {}

        self.load_definitions()
        self.load_game_state()

    # ------------------------------------------------------------------
    # Loading / saving
    # ------------------------------------------------------------------

    def load_definitions(self):
        with self.facilities_file.open(encoding="utf-8") as file:
            self.facility_config = json.load(file)

        definitions = self.facility_config.get("facilities", [])
        self.facility_definitions = {
            definition["id"]: definition
            for definition in definitions
        }

        # resources.json is optional to the core engine for now.  If present,
        # its metadata can be returned to the UI and used for validation later.
        if self.resources_file.exists():
            with self.resources_file.open(encoding="utf-8") as file:
                self.resource_config = json.load(file)
            self.resource_definitions = self.resource_config.get("resources", {})
        else:
            self.resource_config = {}
            self.resource_definitions = {}

        if not self.household_profile_file.exists():
            raise FileNotFoundError(
                f"Household profile not found: {self.household_profile_file}"
            )

        with self.household_profile_file.open(encoding="utf-8") as file:
            self.household_profile = json.load(file)

    def load_game_state(self):
        with self.game_state_file.open(encoding="utf-8") as file:
            self.game_state = json.load(file)

        self._normalize_game_state()

    def save(self):
        self.game_state_file.write_text(
            json.dumps(self.game_state, indent=2),
            encoding="utf-8",
        )

    def _normalize_game_state(self):
        """
        Supply harmless defaults so older or hand-edited GameState files are
        easier to load while the project schema is still evolving.
        """
        self.game_state.setdefault("schema_version", "0.1")
        self.game_state.setdefault("time", {"day": 1, "hour": 0})
        self.game_state.setdefault("household", {})
        self.game_state.setdefault(
            "household_profile_id",
            self.household_profile.get("profile_id", "default-household"),
        )
        self.game_state.setdefault("house_upgrades", {})
        self.game_state.setdefault("inventories", {})
        self.game_state.setdefault("current_flows", {})
        self.game_state.setdefault("map", {})
        self.game_state.setdefault("tile_states", [])
        self.game_state.setdefault("facilities", [])

        self.game_state["time"].setdefault("day", 1)
        self.game_state["time"].setdefault("hour", 0)

        map_state = self.game_state["map"]
        map_state.setdefault("tile_size_ft", self.facility_config.get("tile_size_ft", 5))
        map_state.setdefault("width_tiles", 42)
        map_state.setdefault("height_tiles", 42)
        map_state.setdefault("default_tile", "grass-tile")

        for instance in self.game_state["facilities"]:
            self._normalize_instance(instance)

    def _normalize_instance(self, instance):
        """
        Bring facility instances to a common runtime shape.

        Both x/y and column/row are accepted so the first GameState file and
        the existing browser API can coexist during migration.
        """
        if "facility_id" not in instance and "type" in instance:
            instance["facility_id"] = instance["type"]
        if "type" not in instance and "facility_id" in instance:
            instance["type"] = instance["facility_id"]

        if "column" not in instance and "x" in instance:
            instance["column"] = instance["x"]
        if "row" not in instance and "y" in instance:
            instance["row"] = instance["y"]
        if "x" not in instance and "column" in instance:
            instance["x"] = instance["column"]
        if "y" not in instance and "row" in instance:
            instance["y"] = instance["row"]

        facility_id = instance.get("facility_id")
        definition = self.facility_definitions.get(facility_id)

        if definition is not None:
            instance.setdefault("width", definition.get("width", 1))
            instance.setdefault("height", definition.get("height", 1))

        instance.setdefault("rotated", False)
        instance.setdefault("condition", 1.0)
        instance.setdefault("accrued_labor_requirement", 0.0)
        instance.setdefault("last_operation", None)

    # ------------------------------------------------------------------
    # Household profile helpers
    # ------------------------------------------------------------------

    def household_daily_baseline(self):
        """
        Return the static daily household baseline from HouseholdProfile.json.

        These values are intentionally annual-average daily equivalents. House
        upgrades can modify them later without changing the source profile.
        """
        daily_flows = deepcopy(self.household_profile.get("daily_flows", {}))
        electricity = deepcopy(
            self.household_profile.get("electricity_kwh_per_day", {})
        )

        return {
            "daily_flows": daily_flows,
            "electricity_kwh_per_day": electricity,
        }

    def household_hourly_baseline(self):
        """
        Convert the daily profile into one-hour simulation quantities.
        """
        baseline = self.household_daily_baseline()

        hourly_flows = {
            key: round(float(value) / HOURS_PER_DAY, 6)
            for key, value in baseline["daily_flows"].items()
            if isinstance(value, (int, float))
        }

        hourly_electricity = {
            key: round(float(value) / HOURS_PER_DAY, 6)
            for key, value in baseline["electricity_kwh_per_day"].items()
            if isinstance(value, (int, float))
        }

        return {
            "hourly_flows": hourly_flows,
            "electricity_kwh_per_hour": hourly_electricity,
        }

    # ------------------------------------------------------------------
    # Public state
    # ------------------------------------------------------------------

    def state(self):
        """
        Return the current simulation state.

        During the frontend migration this deliberately exposes both:
        1. the new GameState-oriented schema, and
        2. compatibility fields expected by the original JavaScript UI.
        """
        day = int(self.game_state["time"].get("day", 1))
        hour = int(self.game_state["time"].get("hour", 0))

        # Temporary compatibility timestamp for the existing frontend.
        # Day 1 maps to the original prototype start date.
        start_text = self.resource_config.get(
            "starting_at",
            "2026-04-01T00:00:00",
        )
        try:
            start_time = datetime.fromisoformat(start_text)
        except (TypeError, ValueError):
            start_time = datetime(2026, 4, 1, 0, 0)

        current_time = (
            start_time.replace(hour=0, minute=0, second=0, microsecond=0)
            + timedelta(days=day - 1, hours=hour)
        )

        # Compatibility resource structure expected by the original UI.
        # GameState inventories remain authoritative.
        resources = {}
        for resource_id, definition in self.resource_definitions.items():
            resources[resource_id] = {
                **deepcopy(definition),
                "amount": round(
                    float(
                        self.game_state["inventories"].get(
                            resource_id,
                            definition.get("initial_stock", 0.0),
                        )
                    ),
                    4,
                ),
            }

        return {
            # Compatibility fields for the existing frontend
            "current_time": current_time.isoformat(),
            "tick_count": max(0, ((day - 1) * HOURS_PER_DAY) + hour),
            "labor_hours_per_tick": self.resource_config.get(
                "labor_hours_per_tick",
                0.0,
            ),
            "resources": resources,

            # New state model
            "schema_version": self.game_state.get("schema_version"),
            "time": deepcopy(self.game_state["time"]),
            "household": deepcopy(self.game_state["household"]),
            "household_profile_id": self.game_state.get("household_profile_id"),
            "household_profile": deepcopy(self.household_profile),
            "house_upgrades": deepcopy(self.game_state["house_upgrades"]),
            "household_baseline_daily": self.household_daily_baseline(),
            "household_baseline_hourly": self.household_hourly_baseline(),
            "inventories": deepcopy(self.game_state["inventories"]),
            "current_flows": deepcopy(self.game_state["current_flows"]),
            "map": deepcopy(self.game_state["map"]),
            "tile_states": deepcopy(self.game_state["tile_states"]),
            "facility_definitions": deepcopy(
                list(self.facility_definitions.values())
            ),
            "resource_definitions": deepcopy(self.resource_definitions),
            "instances": deepcopy(self.game_state["facilities"]),
        }

    # ------------------------------------------------------------------
    # Facility placement
    # ------------------------------------------------------------------

    def place_facility(self, facility_id, column, row, rotated=False):
        definition = self.facility_definitions.get(facility_id)
        if definition is None:
            raise ValueError("Unknown facility type.")

        if type(column) is not int or type(row) is not int:
            raise ValueError("Map coordinates must be integers.")
        if type(rotated) is not bool:
            raise ValueError("Rotation must be a boolean.")

        width = int(definition.get("width", 1))
        height = int(definition.get("height", 1))
        if rotated:
            width, height = height, width

        map_state = self.game_state["map"]
        map_width = int(map_state["width_tiles"])
        map_height = int(map_state["height_tiles"])

        if (
            column < 0
            or row < 0
            or column + width > map_width
            or row + height > map_height
        ):
            raise ValueError("Facility footprint is outside the map.")

        for placed in self.game_state["facilities"]:
            self._normalize_instance(placed)
            if not (
                column + width <= placed["column"]
                or placed["column"] + placed["width"] <= column
                or row + height <= placed["row"]
                or placed["row"] + placed["height"] <= row
            ):
                raise ValueError("Facility footprint overlaps another structure.")

        instance = self._create_instance(
            definition=definition,
            column=column,
            row=row,
            width=width,
            height=height,
            rotated=rotated,
        )

        self.game_state["facilities"].append(instance)
        self.save()
        return deepcopy(instance)

    def _create_instance(self, definition, column, row, width, height, rotated):
        facility_id = definition["id"]

        instance = {
            "instance_id": self._next_instance_id(facility_id),
            "facility_id": facility_id,
            "type": facility_id,
            "column": column,
            "row": row,
            "x": column,
            "y": row,
            "width": width,
            "height": height,
            "rotated": rotated,
            "condition": 1.0,
            "accrued_labor_requirement": 0.0,
            "last_operation": None,
        }

        container = definition.get("container")
        if container:
            # current_fill means the current occupancy/content of the primary
            # container when a single generic value is sufficient.
            instance["current_fill"] = 0.0

        process = definition.get("process", {})
        for state_name in process.get("process_states", []):
            instance.setdefault(state_name, 0.0)

        if facility_id == "compost-pile":
            instance.setdefault("raw_material_mass", 0.0)

        return instance

    def _next_instance_id(self, facility_id):
        prefix = facility_id.replace("-", "_")
        existing_ids = {
            instance.get("instance_id")
            for instance in self.game_state["facilities"]
        }

        number = 1
        while f"{prefix}-{number:03d}" in existing_ids:
            number += 1

        return f"{prefix}-{number:03d}"

    # ------------------------------------------------------------------
    # Tick processing
    # ------------------------------------------------------------------

    def advance_hour(self):
        processed_day = self.game_state["time"]["day"]
        processed_hour = self.game_state["time"]["hour"]

        self._reset_tick_flows()
        household_operation = self._process_household_baseline()

        operations = [household_operation]

        # The default lawn covers all unoccupied map tiles.  It is processed
        # as an aggregate instead of creating ~1,700 grass facility objects.
        default_tile_operation = self._process_default_tile()
        if default_tile_operation is not None:
            operations.append(default_tile_operation)

        for instance in self.game_state["facilities"]:
            self._normalize_instance(instance)

            definition = self.facility_definitions.get(instance["facility_id"])
            if definition is None:
                instance["last_operation"] = {
                    "status": "error",
                    "reason": "facility definition not found",
                }
                operations.append({
                    "instance_id": instance.get("instance_id"),
                    **deepcopy(instance["last_operation"]),
                })
                continue

            operation = self._process_facility(instance, definition)
            instance["last_operation"] = operation
            operations.append({
                "instance_id": instance["instance_id"],
                **deepcopy(operation),
            })

        self._finalize_external_utility_flows()

        self._advance_clock()
        self.save()

        return {
            "processed_at": {
                "day": processed_day,
                "hour": processed_hour,
            },
            "operations": operations,
            "state": self.state(),
        }

    def _process_facility(self, instance, definition):
        facility_id = definition["id"]

        self._accrue_labor(instance, definition)
        self._apply_degradation(instance, definition)

        if facility_id == "chicken-coop":
            return self._process_chicken_coop(instance, definition)
        if facility_id == "rain-barrel":
            return self._process_rain_barrel(instance, definition)
        if facility_id == "solar-array":
            return self._process_solar_array(instance, definition)
        if facility_id == "compost-pile":
            return self._process_compost_pile(instance, definition)
        if facility_id == "bsfl-reactor":
            return self._process_bsfl_reactor(instance, definition)

        return self._process_generic_passive_facility(instance, definition)

    # ------------------------------------------------------------------
    # Generic helpers
    # ------------------------------------------------------------------

    def _inventory_amount(self, resource_id):
        return float(self.game_state["inventories"].get(resource_id, 0.0))

    def _add_inventory(self, resource_id, amount):
        if amount <= 0:
            return
        inventories = self.game_state["inventories"]
        inventories[resource_id] = float(inventories.get(resource_id, 0.0)) + amount

    def _consume_inventory(self, resource_id, requested):
        if requested <= 0:
            return 0.0

        inventories = self.game_state["inventories"]
        available = float(inventories.get(resource_id, 0.0))
        used = min(available, requested)
        inventories[resource_id] = available - used
        return used

    def _accrue_labor(self, instance, definition):
        labor = definition.get("labor") or {}

        daily_rate = labor.get("accrual_rate_per_day")
        if daily_rate is not None:
            instance["accrued_labor_requirement"] += float(daily_rate) / HOURS_PER_DAY

        base_rate = labor.get("base_accrual_rate_per_day")
        if base_rate is not None:
            instance["accrued_labor_requirement"] += float(base_rate) / HOURS_PER_DAY

        per_unit_rate = labor.get("accrual_rate_per_container_unit_per_day")
        if per_unit_rate is not None:
            fill = float(instance.get("current_fill", 0.0))
            instance["accrued_labor_requirement"] += (
                float(per_unit_rate) * fill / HOURS_PER_DAY
            )

    def _apply_degradation(self, instance, definition):
        annual_rate = definition.get("degradation_rate_per_year")
        if annual_rate in (None, 0):
            return

        condition = float(instance.get("condition", 1.0))
        condition -= float(annual_rate) / HOURS_PER_YEAR
        instance["condition"] = max(0.0, condition)

    def _reset_tick_flows(self):
        flows = self.game_state["current_flows"]

        # Preserve any future keys but reset all numeric tick counters.
        for key, value in list(flows.items()):
            if isinstance(value, (int, float)):
                flows[key] = 0.0

        flows.setdefault("electricity_generated_this_tick_kwh", 0.0)
        flows.setdefault("electricity_consumed_this_tick_kwh", 0.0)
        flows.setdefault("grid_electricity_this_tick_kwh", 0.0)
        flows.setdefault("municipal_water_this_tick_gal", 0.0)

        flows.setdefault("groceries_this_tick_usd", 0.0)
        flows.setdefault("tap_water_demand_this_tick_gal", 0.0)
        flows.setdefault("greywater_generated_this_tick_gal", 0.0)
        flows.setdefault("blackwater_generated_this_tick_gal", 0.0)
        flows.setdefault("other_water_use_this_tick_gal", 0.0)
        flows.setdefault("kitchen_waste_generated_this_tick_lb", 0.0)
        flows.setdefault("recyclable_paper_generated_this_tick_lb", 0.0)
        flows.setdefault("recyclable_plastic_generated_this_tick_lb", 0.0)
        flows.setdefault("recyclable_glass_generated_this_tick_lb", 0.0)
        flows.setdefault("recyclable_metal_generated_this_tick_lb", 0.0)
        flows.setdefault("residual_nonfood_waste_generated_this_tick_lb", 0.0)

    def _process_household_baseline(self):
        """
        Apply one hour of baseline household demand and waste generation.

        For this iteration, household needs are not yet modified by upgrades.
        Utility demand and waste generation are recorded as flows rather than
        automatically routed into storage or disposal systems.
        """
        hourly = self.household_hourly_baseline()
        flows = self.game_state["current_flows"]
        household_flows = hourly["hourly_flows"]
        electricity = hourly["electricity_kwh_per_hour"]

        groceries = household_flows.get("groceries_usd", 0.0)
        tap_water = household_flows.get("tap_water_gal", 0.0)
        greywater = household_flows.get("greywater_gal", 0.0)
        blackwater = household_flows.get("blackwater_gal", 0.0)
        other_water = household_flows.get("other_water_use_gal", 0.0)

        flows["groceries_this_tick_usd"] = groceries
        flows["tap_water_demand_this_tick_gal"] = tap_water
        flows["greywater_generated_this_tick_gal"] = greywater
        flows["blackwater_generated_this_tick_gal"] = blackwater
        flows["other_water_use_this_tick_gal"] = other_water

        # Until household water-supply systems are implemented, all tap-water
        # demand is supplied externally by the municipal/tap-water source.
        flows["municipal_water_this_tick_gal"] = tap_water

        waste_key_map = {
            "kitchen_waste_lb": "kitchen_waste_generated_this_tick_lb",
            "recyclable_paper_lb": "recyclable_paper_generated_this_tick_lb",
            "recyclable_plastic_lb": "recyclable_plastic_generated_this_tick_lb",
            "recyclable_glass_lb": "recyclable_glass_generated_this_tick_lb",
            "recyclable_metal_lb": "recyclable_metal_generated_this_tick_lb",
            "residual_nonfood_waste_lb": (
                "residual_nonfood_waste_generated_this_tick_lb"
            ),
        }

        for profile_key, flow_key in waste_key_map.items():
            flows[flow_key] = household_flows.get(profile_key, 0.0)

        total_electricity = electricity.get("total", 0.0)
        flows["electricity_consumed_this_tick_kwh"] = total_electricity

        end_use_electricity = {
            key: value
            for key, value in electricity.items()
            if key != "total"
        }

        return {
            "instance_id": "__household__",
            "facility_id": "household",
            "status": "operating",
            "consumed": {
                "groceries_usd": round(groceries, 6),
                "tap_water_gal": round(tap_water, 6),
                "electricity_kwh": round(total_electricity, 6),
            },
            "produced": {
                "greywater_gal": round(greywater, 6),
                "blackwater_gal": round(blackwater, 6),
                "kitchen_waste_lb": round(
                    household_flows.get("kitchen_waste_lb", 0.0), 6
                ),
                "recyclable_paper_lb": round(
                    household_flows.get("recyclable_paper_lb", 0.0), 6
                ),
                "recyclable_plastic_lb": round(
                    household_flows.get("recyclable_plastic_lb", 0.0), 6
                ),
                "recyclable_glass_lb": round(
                    household_flows.get("recyclable_glass_lb", 0.0), 6
                ),
                "recyclable_metal_lb": round(
                    household_flows.get("recyclable_metal_lb", 0.0), 6
                ),
                "residual_nonfood_waste_lb": round(
                    household_flows.get("residual_nonfood_waste_lb", 0.0), 6
                ),
            },
            "electricity_end_use_kwh": end_use_electricity,
            "note": (
                "Household flows currently use the unmodified static baseline; "
                "house-upgrade effects will be applied in a later iteration."
            ),
        }

    def _finalize_external_utility_flows(self):
        """
        Calculate residual externally supplied electricity after on-site
        generation. Storage/export logic can replace this simple netting later.
        """
        flows = self.game_state["current_flows"]

        demand = float(
            flows.get("electricity_consumed_this_tick_kwh", 0.0)
        )
        generated = float(
            flows.get("electricity_generated_this_tick_kwh", 0.0)
        )

        flows["grid_electricity_this_tick_kwh"] = max(
            0.0,
            demand - generated,
        )

    def _advance_clock(self):
        time_state = self.game_state["time"]
        time_state["hour"] += 1

        if time_state["hour"] >= HOURS_PER_DAY:
            time_state["hour"] = 0
            time_state["day"] += 1

    # ------------------------------------------------------------------
    # Facility-specific processors
    # ------------------------------------------------------------------

    def _process_chicken_coop(self, instance, definition):
        bird_count = max(0.0, float(instance.get("current_fill", 0.0)))
        capacity = float((definition.get("container") or {}).get("capacity", 0.0))
        if capacity > 0:
            bird_count = min(bird_count, capacity)
            instance["current_fill"] = bird_count

        if bird_count <= 0:
            return {
                "status": "idle",
                "reason": "no chickens",
                "occupancy": 0,
                "consumed": {},
                "produced": {},
            }

        requested = {}
        for resource_id, rule in definition.get("inputs", {}).items():
            per_unit_daily = rule.get("rate_per_container_unit_per_day")
            if per_unit_daily is not None:
                requested[resource_id] = (
                    float(per_unit_daily) * bird_count / HOURS_PER_DAY
                )

        # All required inputs share one utilization factor.  If feed is at
        # 50% of requirement, for example, all biological outputs run at 50%.
        utilization = 1.0
        for resource_id, amount in requested.items():
            if amount > 0:
                utilization = min(
                    utilization,
                    self._inventory_amount(resource_id) / amount,
                )

        utilization = max(0.0, min(1.0, utilization))

        consumed = {}
        for resource_id, amount in requested.items():
            used = self._consume_inventory(resource_id, amount * utilization)
            if used > 0:
                consumed[resource_id] = round(used, 6)

        produced = {}
        for resource_id, rule in definition.get("outputs", {}).items():
            per_unit_daily = rule.get("rate_per_container_unit_per_day")
            if per_unit_daily is None:
                continue

            amount = (
                float(per_unit_daily)
                * bird_count
                / HOURS_PER_DAY
                * utilization
            )
            self._add_inventory(resource_id, amount)
            if amount > 0:
                produced[resource_id] = round(amount, 6)

        reason = None
        if utilization < 1.0:
            limiting = [
                resource_id
                for resource_id, amount in requested.items()
                if amount > 0 and self._inventory_amount(resource_id) <= 1e-12
            ]
            reason = (
                f"limited by {', '.join(limiting)}"
                if limiting
                else "limited by inputs"
            )

        return {
            "status": "operating" if utilization > 0 else "idle",
            "occupancy": bird_count,
            "capacity": capacity,
            "utilization_pct": round(utilization * 100, 1),
            "consumed": consumed,
            "produced": produced,
            "reason": reason,
            "accrued_labor_requirement": round(
                instance["accrued_labor_requirement"], 6
            ),
        }

    def _process_rain_barrel(self, instance, definition):
        container = definition.get("container") or {}
        capacity = float(container.get("capacity", 0.0))
        current = max(0.0, float(instance.get("current_fill", 0.0)))

        daily_inflow = 0.0
        rain_rule = definition.get("inputs", {}).get("rainwater", {})
        if rain_rule.get("average_rate_per_day") is not None:
            daily_inflow = float(rain_rule["average_rate_per_day"])

        inflow = daily_inflow / HOURS_PER_DAY
        room = max(0.0, capacity - current)
        collected = min(room, inflow)

        instance["current_fill"] = current + collected

        return {
            "status": "collecting" if collected > 0 else "full",
            "collected_non_potable_water_gal": round(collected, 6),
            "current_fill": round(instance["current_fill"], 6),
            "capacity": capacity,
        }

    def _process_solar_array(self, instance, definition):
        output_rule = definition.get("outputs", {}).get("electricity", {})
        daily_average = float(output_rule.get("average_rate_per_day", 0.0))

        # v0.1 intentionally spreads annual-average production evenly over
        # all 24 hours.  A later weather/daylight model can replace this.
        generated = daily_average / HOURS_PER_DAY

        # Treat condition as a simple output multiplier for now.
        generated *= max(0.0, float(instance.get("condition", 1.0)))

        flows = self.game_state["current_flows"]
        flows["electricity_generated_this_tick_kwh"] += generated

        return {
            "status": "operating",
            "produced": {
                "electricity_kwh": round(generated, 6),
            },
            "condition": round(float(instance.get("condition", 1.0)), 6),
            "accrued_labor_requirement": round(
                instance["accrued_labor_requirement"], 6
            ),
        }

    def _process_compost_pile(self, instance, definition):
        process = definition.get("process") or {}
        outputs = definition.get("outputs") or {}

        raw_mass = max(0.0, float(instance.get("raw_material_mass", 0.0)))

        if raw_mass <= 0:
            return {
                "status": "idle",
                "reason": "no composting material",
                "raw_material_mass": 0.0,
                "produced": {},
                "accrued_labor_requirement": round(
                    instance["accrued_labor_requirement"], 6
                ),
            }

        processing_days = process.get("nominal_processing_time_days")
        if not processing_days:
            return {
                "status": "idle",
                "reason": "processing rate not configured",
                "raw_material_mass": raw_mass,
                "produced": {},
            }

        # First-order processing: each hour a fraction of the current active
        # mass equal to 1/(processing_days * 24) is transformed.
        processed = raw_mass / (float(processing_days) * HOURS_PER_DAY)

        full_load_rate = process.get("full_load_processing_rate_per_day")
        if full_load_rate is not None:
            processed = min(processed, float(full_load_rate) / HOURS_PER_DAY)

        processed = min(processed, raw_mass)
        instance["raw_material_mass"] = raw_mass - processed

        compost_rule = outputs.get("compost", {})
        yield_fraction = float(compost_rule.get("mass_yield_fraction", 0.0))
        compost = processed * yield_fraction
        self._add_inventory("compost", compost)

        forage_rule = outputs.get("insect_forage", {})
        full_load_forage_daily = float(
            forage_rule.get("rate_per_day_at_full_load", 0.0)
        )

        container_capacity = float(
            (definition.get("container") or {}).get("capacity", 0.0)
        )
        fill_fraction = (
            min(1.0, raw_mass / container_capacity)
            if container_capacity > 0
            else 0.0
        )
        insect_forage = (
            full_load_forage_daily / HOURS_PER_DAY * fill_fraction
        )
        self._add_inventory("insect_forage", insect_forage)

        produced = {}
        if compost > 0:
            produced["compost"] = round(compost, 6)
        if insect_forage > 0:
            produced["insect_forage"] = round(insect_forage, 6)

        return {
            "status": "operating",
            "processed_raw_material": round(processed, 6),
            "raw_material_mass": round(instance["raw_material_mass"], 6),
            "produced": produced,
            "accrued_labor_requirement": round(
                instance["accrued_labor_requirement"], 6
            ),
        }

    def _process_bsfl_reactor(self, instance, definition):
        """
        The BSFL lifecycle is intentionally scaffolded but not invented.

        The current facilities.json leaves feeding rate, yields, maturation
        time, carrying capacity, and max throughput as null.  Until those
        values are researched, the reactor retains its state without silently
        manufacturing outputs.
        """
        process = definition.get("process") or {}
        required = (
            "feeding_rate_lb_feed_per_lb_larvae_per_day",
            "larval_yield_fraction",
            "residue_yield_fraction",
            "average_maturation_time_days",
            "maximum_larval_biomass_lb",
            "maximum_processing_rate_lb_per_day",
        )

        if any(process.get(key) is None for key in required):
            return {
                "status": "idle",
                "reason": "BSFL process constants not yet configured",
                "feedstock_mass": round(
                    float(instance.get("feedstock_mass", 0.0)), 6
                ),
                "growing_larval_biomass": round(
                    float(instance.get("growing_larval_biomass", 0.0)), 6
                ),
                "mature_larval_biomass": round(
                    float(instance.get("mature_larval_biomass", 0.0)), 6
                ),
                "residue_mass": round(
                    float(instance.get("residue_mass", 0.0)), 6
                ),
            }

        return self._run_bsfl_process(instance, definition)

    def _run_bsfl_process(self, instance, definition):
        process = definition["process"]

        feedstock = max(0.0, float(instance.get("feedstock_mass", 0.0)))
        growing = max(
            0.0,
            float(instance.get("growing_larval_biomass", 0.0)),
        )
        mature = max(
            0.0,
            float(instance.get("mature_larval_biomass", 0.0)),
        )

        feeding_rate = float(
            process["feeding_rate_lb_feed_per_lb_larvae_per_day"]
        )
        max_processing = float(
            process["maximum_processing_rate_lb_per_day"]
        )
        larval_yield = float(process["larval_yield_fraction"])
        residue_yield = float(process["residue_yield_fraction"])
        maturation_days = float(process["average_maturation_time_days"])
        max_biomass = float(process["maximum_larval_biomass_lb"])

        potential_feed = growing * feeding_rate / HOURS_PER_DAY
        processed = min(
            feedstock,
            potential_feed,
            max_processing / HOURS_PER_DAY,
        )

        new_larval_biomass = processed * larval_yield
        new_residue = processed * residue_yield

        available_growth_room = max(
            0.0,
            max_biomass - growing - mature,
        )
        retained_growth = min(new_larval_biomass, available_growth_room)

        # Excess potential larval growth is not created if the reactor has
        # reached its configured carrying capacity.
        growing += retained_growth
        feedstock -= processed

        maturing = (
            growing / (maturation_days * HOURS_PER_DAY)
            if maturation_days > 0
            else 0.0
        )
        maturing = min(maturing, growing)

        growing -= maturing
        mature += maturing

        # The reactor design assumes mature/prepupal larvae self-harvest.
        harvested = mature
        mature = 0.0

        instance["feedstock_mass"] = feedstock
        instance["growing_larval_biomass"] = growing
        instance["mature_larval_biomass"] = mature
        instance["residue_mass"] = (
            float(instance.get("residue_mass", 0.0)) + new_residue
        )
        instance["harvested_insect_forage"] = (
            float(instance.get("harvested_insect_forage", 0.0)) + harvested
        )

        self._add_inventory("insect_forage", harvested)

        return {
            "status": "operating" if processed > 0 else "idle",
            "processed_feedstock": round(processed, 6),
            "new_larval_biomass": round(retained_growth, 6),
            "new_residue": round(new_residue, 6),
            "harvested_insect_forage": round(harvested, 6),
        }

    def _process_generic_passive_facility(self, instance, definition):
        produced = {}

        for resource_id, rule in definition.get("outputs", {}).items():
            if not isinstance(rule, dict):
                continue

            daily_rate = rule.get("rate_per_day")
            if daily_rate is None:
                continue

            amount = float(daily_rate) / HOURS_PER_DAY
            self._add_inventory(resource_id, amount)
            produced[resource_id] = round(amount, 6)

        return {
            "status": "operating" if produced else "idle",
            "produced": produced,
            "accrued_labor_requirement": round(
                instance["accrued_labor_requirement"], 6
            ),
        }

    # ------------------------------------------------------------------
    # Default map tile processing
    # ------------------------------------------------------------------

    def _process_default_tile(self):
        map_state = self.game_state["map"]
        default_tile_id = map_state.get("default_tile")
        definition = self.facility_definitions.get(default_tile_id)

        if definition is None:
            return None

        total_tiles = (
            int(map_state["width_tiles"])
            * int(map_state["height_tiles"])
        )

        occupied_tiles = 0
        for instance in self.game_state["facilities"]:
            self._normalize_instance(instance)
            occupied_tiles += int(instance["width"]) * int(instance["height"])

        # Explicit tile states are considered non-default tiles unless they
        # explicitly declare the same type as the map default.
        overridden_default_tiles = 0
        for tile in self.game_state.get("tile_states", []):
            if tile.get("type") != default_tile_id:
                overridden_default_tiles += 1

        active_tiles = max(
            0,
            total_tiles - occupied_tiles - overridden_default_tiles,
        )

        produced = {}
        for resource_id, rule in definition.get("outputs", {}).items():
            if not isinstance(rule, dict):
                continue
            daily_rate = rule.get("rate_per_day")
            if daily_rate is None:
                continue

            amount = (
                float(daily_rate)
                * active_tiles
                / HOURS_PER_DAY
            )
            self._add_inventory(resource_id, amount)
            produced[resource_id] = round(amount, 6)

        # Scat assimilation is deliberately not auto-routed yet.  We need a
        # spatial rule for where animal waste is deposited before consuming
        # household/global scat against lawn capacity.
        assimilation_rule = (
            definition.get("inputs", {})
            .get("scat", {})
        )
        scat_capacity = 0.0
        if assimilation_rule.get("capacity_per_day") is not None:
            scat_capacity = (
                float(assimilation_rule["capacity_per_day"])
                * active_tiles
                / HOURS_PER_DAY
            )

        return {
            "instance_id": "__default_tiles__",
            "facility_id": default_tile_id,
            "status": "operating",
            "active_tiles": active_tiles,
            "produced": produced,
            "potential_scat_assimilation_lb": round(scat_capacity, 6),
            "note": "Scat assimilation is reported but not auto-routed until spatial animal-waste logic exists.",
        }
