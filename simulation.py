import json
import math
from copy import deepcopy
from datetime import datetime, timedelta
from pathlib import Path


HOURS_PER_DAY = 24
MINUTES_PER_HOUR = 60
HOURS_PER_YEAR = 365 * HOURS_PER_DAY
WALKING_SPEED_FT_PER_MINUTE = 264.0
YARD_FORAGE_CAP_DAYS = 3.0
EGG_GROCERY_VALUE_USD = 0.20

ORDER_CATALOG = {
    "feed": {
        "resource_id": "feed",
        "name": "Chicken feed",
        "unit": "lb",
        "integer_only": False,
    },
    "chicken": {
        "resource_id": "chicken",
        "name": "Laying hen",
        "unit": "bird",
        "integer_only": True,
    },
    "bsfl_biomass": {
        "resource_id": "bsfl_biomass",
        "name": "Live black soldier fly larvae",
        "unit": "lb",
        "integer_only": False,
    },
    "straw": {
        "resource_id": "carbonaceous_plant_waste",
        "name": "Straw",
        "unit": "lb",
        "integer_only": False,
    },
}


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
        self.game_state.setdefault("time", {"day": 1, "hour": 0, "minute": 0})
        household_state = self.game_state.setdefault("household", {})
        household_state.setdefault("grocery_credit_usd", 0.0)
        household_state.setdefault("cumulative_grocery_savings_usd", 0.0)
        self.game_state.setdefault(
            "household_profile_id",
            self.household_profile.get("profile_id", "default-household"),
        )
        self.game_state.setdefault("house_upgrades", {})
        self.game_state.setdefault("inventories", {})
        yard_resources = self.game_state.setdefault("yard_resources", {})
        yard_resources.setdefault("insect_forage", 0.0)
        yard_resources.setdefault("green_forage", 0.0)
        self.game_state.setdefault("current_flows", {})
        self.game_state.setdefault("map", {})
        self.game_state.setdefault("tile_states", [])
        self.game_state.setdefault("facilities", [])
        self.game_state.setdefault("pending_events", [])
        self.game_state.setdefault("last_full_tick_events", [])

        self.game_state["time"].setdefault("day", 1)
        self.game_state["time"].setdefault("hour", 0)
        self.game_state["time"].setdefault("minute", 0)

        map_state = self.game_state["map"]
        map_state.setdefault("tile_size_ft", self.facility_config.get("tile_size_ft", 5))
        map_state.setdefault("width_tiles", 42)
        map_state.setdefault("height_tiles", 42)
        map_state.setdefault("default_tile", "grass-tile")

        # The house interior remains abstract.  Only the lower eaves and two
        # household-waste pickup points are represented on the yard map.
        house = self.game_state.setdefault("house", {})
        house.setdefault("id", "main-house")
        house.setdefault("name", "House")
        eaves = house.setdefault("eaves", {})
        eaves.setdefault("column", 11)
        eaves.setdefault("width", 20)
        pickup_points = house.setdefault("pickup_points", {})
        kitchen_pickup = pickup_points.setdefault("kitchen_waste", {})
        kitchen_pickup.setdefault("column", 13.0)
        kitchen_pickup.setdefault("row", 40.0)
        kitchen_pickup.setdefault("width", 1)
        kitchen_pickup.setdefault("height", 1)
        legacy_paper_pickup = pickup_points.pop("paper_waste", None)
        carbon_pickup = pickup_points.setdefault(
            "carbonaceous_plant_waste",
            legacy_paper_pickup if isinstance(legacy_paper_pickup, dict) else {},
        )
        carbon_pickup.setdefault("column", 16.0)
        carbon_pickup.setdefault("row", 40.0)
        carbon_pickup.setdefault("width", 1)
        carbon_pickup.setdefault("height", 1)
        entrance = house.setdefault("entrance", {})
        entrance.setdefault("column", 14.5)
        entrance.setdefault("row", 40.0)
        outputs = house.setdefault("outputs", {})
        outputs.setdefault("kitchen_waste", 0.0)
        legacy_paper_output = max(0.0, float(outputs.pop("paper_waste", 0.0)))
        outputs["carbonaceous_plant_waste"] = (
            max(0.0, float(outputs.get("carbonaceous_plant_waste", 0.0)))
            + legacy_paper_output
        )
        storage_point = house.setdefault("storage_point", {})
        storage_point.setdefault("column", 20.0)
        storage_point.setdefault("row", 40.0)
        storage_point.setdefault("width", 2)
        storage_point.setdefault("height", 2)
        house.setdefault("storage", {})

        # Resource-id migrations from earlier saves.  Paper waste and dry
        # plant litter now share one carbonaceous-browns resource; BSFL
        # organic residue is now the same transferable material as active
        # compost/pre-compost.
        alias_map = {
            "paper_waste": "carbonaceous_plant_waste",
            "plant_litter": "carbonaceous_plant_waste",
            "organic_residue": "active_compost",
        }
        for mapping in (
            self.game_state.setdefault("inventories", {}),
            house.setdefault("storage", {}),
        ):
            for old_id, new_id in alias_map.items():
                old_amount = max(0.0, float(mapping.pop(old_id, 0.0)))
                if old_amount > 0:
                    mapping[new_id] = max(0.0, float(mapping.get(new_id, 0.0))) + old_amount

        # Before yard_resources existed, unimproved grass accumulated insect
        # forage in the compatibility/global inventory. Move that legacy pool
        # into the environmental yard pool. Facility-produced/collected BSFL
        # never uses this global inventory path and remains physical stock.
        legacy_yard_insects = max(0.0, float(self.game_state["inventories"].pop("insect_forage", 0.0)))
        if legacy_yard_insects > 0:
            yard_resources["insect_forage"] = max(0.0, float(yard_resources.get("insect_forage", 0.0))) + legacy_yard_insects

        player = self.game_state.setdefault("player", {})
        player.setdefault("name", "Homesteader")
        position = player.setdefault("position", {})
        position.setdefault("column", 0.0)
        position.setdefault("row", float(max(0, int(map_state["height_tiles"]) - 1)))
        player.setdefault("last_direction", "down")
        player.setdefault("inventory", {})
        for old_id, new_id in alias_map.items():
            old_amount = max(0.0, float(player["inventory"].pop(old_id, 0.0)))
            if old_amount > 0:
                player["inventory"][new_id] = max(0.0, float(player["inventory"].get(new_id, 0.0))) + old_amount
        queue = player.setdefault("task_queue", [])
        for task in queue:
            if task.get("resource_id") in alias_map:
                task["resource_id"] = alias_map[task["resource_id"]]
            cargo = task.get("reserved_cargo")
            if isinstance(cargo, dict) and cargo.get("resource_id") in alias_map:
                cargo["resource_id"] = alias_map[cargo["resource_id"]]
        player.setdefault("next_task_id", 1)

        # Migrate the old single walking task into the new persistent queue.
        old_task = player.pop("current_task", None)
        if old_task and not queue:
            old_task = deepcopy(old_task)
            old_task.setdefault("task_id", self._next_task_id())
            old_task.setdefault("description", "Walk to selected tile")
            old_task.setdefault("phase", "travel")
            old_task.setdefault("work_minutes_total", 0)
            old_task.setdefault("work_minutes_remaining", 0)
            queue.append(old_task)

        for instance in self.game_state["facilities"]:
            self._normalize_instance(instance)

        # Older builds abstracted coop egg production into the global
        # inventory, sometimes as fractional eggs. Put those eggs back at the
        # first coop so whole eggs are collectible and the fractional part can
        # continue through the normal production remainder.
        legacy_eggs = max(0.0, float(self.game_state["inventories"].pop("eggs", 0.0)))
        if legacy_eggs > 0:
            coop = next((i for i in self.game_state["facilities"] if i.get("facility_id") == "chicken-coop"), None)
            if coop is not None:
                whole = math.floor(legacy_eggs + 1e-9)
                fraction = max(0.0, legacy_eggs - whole)
                outputs = coop.setdefault("stored_outputs", {})
                outputs["eggs"] = max(0.0, float(outputs.get("eggs", 0.0))) + whole
                remainders = coop.setdefault("production_remainders", {})
                remainders["eggs"] = max(0.0, float(remainders.get("eggs", 0.0))) + fraction
            else:
                self.game_state["inventories"]["eggs"] = legacy_eggs

    def _normalize_instance(self, instance):
        """Bring facility instances to a common runtime shape."""
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
        instance.setdefault("stored_outputs", {})
        instance.setdefault("production_remainders", {})

        if facility_id == "chicken-coop":
            instance.setdefault("feed_mass", 0.0)

        if facility_id == "bsfl-reactor":
            if "larval_biomass" not in instance:
                old_growing = float(instance.get("growing_larval_biomass", 0.0))
                old_mature = float(instance.get("mature_larval_biomass", 0.0))
                instance["larval_biomass"] = max(0.0, old_growing + old_mature)
            instance.setdefault("feedstock_mass", 0.0)
            instance.setdefault("residue_mass", 0.0)
            instance.pop("growing_larval_biomass", None)
            instance.pop("mature_larval_biomass", None)
            old_harvest = max(0.0, float(instance.pop("harvested_insect_forage", 0.0)))
            if old_harvest > 0:
                outputs = instance.setdefault("stored_outputs", {})
                outputs["insect_forage"] = float(outputs.get("insect_forage", 0.0)) + old_harvest
            outputs = instance.setdefault("stored_outputs", {})
            legacy_residue_output = max(0.0, float(outputs.pop("organic_residue", 0.0)))
            if legacy_residue_output > 0:
                instance["residue_mass"] = max(0.0, float(instance.get("residue_mass", 0.0))) + legacy_residue_output

        if facility_id == "compost-pile":
            # Migrate the earlier one-pool compost model into fresh feedstock.
            old_raw = max(0.0, float(instance.pop("raw_material_mass", 0.0)))
            instance.setdefault("unbalanced_kitchen_waste", 0.0)
            instance.setdefault("unbalanced_scat", 0.0)
            instance.setdefault("available_carbon_material", 0.0)
            instance.setdefault("feedstock_mass", old_raw)
            instance.setdefault("active_compost_mass", 0.0)
            instance.setdefault("mature_compost_mass", 0.0)

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

    def _public_player_state(self):
        player = deepcopy(self.game_state["player"])
        queue = player.get("task_queue", [])
        player["current_task"] = deepcopy(queue[0]) if queue else None
        player["queued_task_count"] = max(0, len(queue) - 1)
        return player

    def state(self):
        """
        Return the current simulation state.

        During the frontend migration this deliberately exposes both:
        1. the new GameState-oriented schema, and
        2. compatibility fields expected by the original JavaScript UI.
        """
        day = int(self.game_state["time"].get("day", 1))
        hour = int(self.game_state["time"].get("hour", 0))
        minute = int(self.game_state["time"].get("minute", 0))

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
            + timedelta(days=day - 1, hours=hour, minutes=minute)
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

        # Aggregate physical stock by resource for the Resource overview.  The
        # authoritative locations remain House Storage, Homesteader inventory,
        # house pickup points, and facility-local process/output state.
        stock_totals = {resource_id: 0.0 for resource_id in self.resource_definitions}
        for resource_id, amount in self.game_state.get("inventories", {}).items():
            stock_totals[resource_id] = stock_totals.get(resource_id, 0.0) + max(0.0, float(amount))
        for mapping in (
            self.game_state.get("house", {}).get("storage", {}),
            self.game_state.get("house", {}).get("outputs", {}),
            self.game_state.get("player", {}).get("inventory", {}),
        ):
            for resource_id, amount in mapping.items():
                stock_totals[resource_id] = stock_totals.get(resource_id, 0.0) + max(0.0, float(amount))
        for instance in self.game_state.get("facilities", []):
            self._normalize_instance(instance)
            for resource_id, amount in (instance.get("stored_outputs") or {}).items():
                stock_totals[resource_id] = stock_totals.get(resource_id, 0.0) + max(0.0, float(amount))
            if instance.get("facility_id") == "chicken-coop":
                stock_totals["chicken"] = stock_totals.get("chicken", 0.0) + max(0.0, float(instance.get("current_fill", 0.0)))
                stock_totals["feed"] = stock_totals.get("feed", 0.0) + max(0.0, float(instance.get("feed_mass", 0.0)))
            elif instance.get("facility_id") == "bsfl-reactor":
                stock_totals["bsfl_biomass"] = stock_totals.get("bsfl_biomass", 0.0) + max(0.0, float(instance.get("larval_biomass", 0.0)))
                stock_totals["kitchen_waste"] = stock_totals.get("kitchen_waste", 0.0) + max(0.0, float(instance.get("feedstock_mass", 0.0)))
                stock_totals["active_compost"] = stock_totals.get("active_compost", 0.0) + max(0.0, float(instance.get("residue_mass", 0.0)))
            elif instance.get("facility_id") == "compost-pile":
                stock_totals["kitchen_waste"] = stock_totals.get("kitchen_waste", 0.0) + max(0.0, float(instance.get("unbalanced_kitchen_waste", 0.0)))
                stock_totals["scat"] = stock_totals.get("scat", 0.0) + max(0.0, float(instance.get("unbalanced_scat", 0.0)))
                stock_totals["carbonaceous_plant_waste"] = stock_totals.get("carbonaceous_plant_waste", 0.0) + max(0.0, float(instance.get("available_carbon_material", 0.0)))
                stock_totals["active_compost"] = stock_totals.get("active_compost", 0.0) + max(0.0, float(instance.get("active_compost_mass", 0.0)))
                stock_totals["compost"] = stock_totals.get("compost", 0.0) + max(0.0, float(instance.get("mature_compost_mass", 0.0)))

        resource_overview = {"biological_materials": {}, "yard_forage": {}, "utilities": {}}
        for resource_id, definition in self.resource_definitions.items():
            category = definition.get("category", "biological_materials")
            behavior = definition.get("behavior", "stock")
            if behavior == "stock":
                resource_overview.setdefault(category, {})[resource_id] = {
                    **deepcopy(definition),
                    "amount": round(stock_totals.get(resource_id, 0.0), 4),
                }

        active_default_tiles = self._active_default_tile_count()
        default_definition = self.facility_definitions.get(self.game_state["map"].get("default_tile"), {})
        default_outputs = default_definition.get("outputs", {})
        for resource_id in ("insect_forage", "green_forage"):
            definition = self.resource_definitions.get(resource_id, {})
            daily_rate_per_tile = float((default_outputs.get(resource_id) or {}).get("rate_per_day", 0.0))
            daily_generation = daily_rate_per_tile * active_default_tiles
            capacity = daily_generation * YARD_FORAGE_CAP_DAYS
            resource_overview["yard_forage"][resource_id] = {
                **deepcopy(definition),
                "name": f"Yard {definition.get('name', resource_id).lower()}",
                "amount": round(max(0.0, float(self.game_state.get("yard_resources", {}).get(resource_id, 0.0))), 4),
                "daily_generation": round(daily_generation, 4),
                "capacity": round(capacity, 4),
                "behavior": "environmental_pool",
            }

        resource_overview["utilities"]["electricity_balance"] = {
            "name": "Electricity",
            "behavior": "flow",
            "unit": "kWh/hour",
            "demand": round(float(self.game_state["current_flows"].get("electricity_consumed_this_tick_kwh", 0.0)), 4),
            "onsite_generation": round(float(self.game_state["current_flows"].get("electricity_generated_this_tick_kwh", 0.0)), 4),
            "grid_requirement": round(float(self.game_state["current_flows"].get("grid_electricity_this_tick_kwh", 0.0)), 4),
        }
        resource_overview["utilities"]["municipal_water"] = {
            "name": "Municipal potable water",
            "behavior": "flow",
            "unit": "gal/hour",
            "amount": round(float(self.game_state["current_flows"].get("municipal_water_this_tick_gal", 0.0)), 4),
        }

        return {
            # Compatibility fields for the existing frontend
            "current_time": current_time.isoformat(),
            "tick_count": max(0, ((day - 1) * HOURS_PER_DAY) + hour),
            "sub_tick_count": max(0, (((day - 1) * HOURS_PER_DAY + hour) * MINUTES_PER_HOUR) + minute),
            "labor_hours_per_tick": self.resource_config.get(
                "labor_hours_per_tick",
                0.0,
            ),
            "resources": resources,
            "resource_overview": resource_overview,

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
            "yard_resources": deepcopy(self.game_state["yard_resources"]),
            "current_flows": deepcopy(self.game_state["current_flows"]),
            "map": deepcopy(self.game_state["map"]),
            "house": deepcopy(self.game_state["house"]),
            "player": self._public_player_state(),
            "pending_events": deepcopy(self.game_state["pending_events"]),
            "last_full_tick_events": deepcopy(self.game_state["last_full_tick_events"]),
            "tile_states": deepcopy(self.game_state["tile_states"]),
            "facility_definitions": deepcopy(
                list(self.facility_definitions.values())
            ),
            "resource_definitions": deepcopy(self.resource_definitions),
            "order_catalog": deepcopy(ORDER_CATALOG),
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

        house = self.game_state.get("house") or {}
        reserved_house_zones = []
        for point in (house.get("pickup_points") or {}).values():
            reserved_house_zones.append((
                int(float(point.get("column", -1000))),
                int(float(point.get("row", -1000))),
                max(1, int(point.get("width", 1))),
                max(1, int(point.get("height", 1))),
            ))
        storage_point = house.get("storage_point") or {}
        if storage_point:
            reserved_house_zones.append((
                int(float(storage_point.get("column", -1000))),
                int(float(storage_point.get("row", -1000))),
                max(1, int(storage_point.get("width", 2))),
                max(1, int(storage_point.get("height", 2))),
            ))

        for zone_column, zone_row, zone_width, zone_height in reserved_house_zones:
            if not (
                column + width <= zone_column
                or zone_column + zone_width <= column
                or row + height <= zone_row
                or zone_row + zone_height <= row
            ):
                raise ValueError("Facility footprint overlaps a household pickup or storage point.")

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
            "stored_outputs": {},
            "production_remainders": {},
        }

        container = definition.get("container")
        if container:
            instance["current_fill"] = 0.0

        process = definition.get("process", {})
        for state_name in process.get("process_states", []):
            instance.setdefault(state_name, 0.0)

        if facility_id == "compost-pile":
            instance.setdefault("unbalanced_kitchen_waste", 0.0)
            instance.setdefault("unbalanced_scat", 0.0)
            instance.setdefault("available_carbon_material", 0.0)
            instance.setdefault("feedstock_mass", 0.0)
            instance.setdefault("active_compost_mass", 0.0)
            instance.setdefault("mature_compost_mass", 0.0)

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
    # Activity queue, physical transfers, and player movement
    # ------------------------------------------------------------------

    def _find_facility_instance(self, instance_id):
        for instance in self.game_state["facilities"]:
            if instance.get("instance_id") == instance_id:
                self._normalize_instance(instance)
                return instance
        raise ValueError("Facility instance not found.")

    def _fill_spec(self, instance, resource_id):
        """Return destination state/capacity for a physical facility delivery."""
        facility_id = instance.get("facility_id")
        definition = self.facility_definitions.get(facility_id) or {}
        container = definition.get("container") or {}
        process = definition.get("process") or {}

        if facility_id == "chicken-coop":
            if resource_id == "chicken":
                return {"field": "current_fill", "capacity": float(container.get("capacity", 0.0)), "unit": "bird", "integer_only": True}
            if resource_id == "feed":
                return {"field": "feed_mass", "capacity": None, "unit": "lb", "integer_only": False}

        if facility_id == "bsfl-reactor":
            if resource_id == "bsfl_biomass":
                return {"field": "larval_biomass", "capacity": float(process.get("maximum_larval_biomass_lb", 0.0)), "unit": "lb", "integer_only": False}
            if resource_id == "kitchen_waste":
                return {"field": "feedstock_mass", "capacity": float(container.get("usable_capacity_lb", 0.0)), "unit": "lb", "integer_only": False}

        if facility_id == "compost-pile":
            rule = (definition.get("inputs") or {}).get(resource_id) or {}
            mode = rule.get("mode")
            field_by_resource = {
                "kitchen_waste": "unbalanced_kitchen_waste",
                "scat": "unbalanced_scat",
                "carbonaceous_plant_waste": "available_carbon_material",
                "active_compost": "active_compost_mass",
            }
            field = field_by_resource.get(resource_id)
            if field and mode in {"nitrogen_rich", "carbon_rich", "active_compost"}:
                return {
                    "field": field,
                    "capacity": float(container.get("capacity", 0.0)),
                    "capacity_mode": "shared_total_mass",
                    "unit": "lb",
                    "integer_only": False,
                }

        raise ValueError("That material cannot be added to this facility.")

    def _compost_total_mass(self, instance):
        fields = (
            "unbalanced_kitchen_waste",
            "unbalanced_scat",
            "available_carbon_material",
            "feedstock_mass",
            "active_compost_mass",
            "mature_compost_mass",
        )
        return sum(max(0.0, float(instance.get(field, 0.0))) for field in fields)

    def _compost_carbon_demand(self, instance, definition=None):
        definition = definition or self.facility_definitions.get("compost-pile") or {}
        inputs = definition.get("inputs") or {}
        kitchen_factor = float((inputs.get("kitchen_waste") or {}).get("carbon_demand_lb_per_lb", 0.5))
        scat_factor = float((inputs.get("scat") or {}).get("carbon_demand_lb_per_lb", 1.5))
        demand = (
            max(0.0, float(instance.get("unbalanced_kitchen_waste", 0.0))) * kitchen_factor
            + max(0.0, float(instance.get("unbalanced_scat", 0.0))) * scat_factor
        )
        available = max(0.0, float(instance.get("available_carbon_material", 0.0)))
        return max(0.0, demand - available), demand, available

    def _compost_description(self, instance):
        feedstock = max(0.0, float(instance.get("feedstock_mass", 0.0)))
        active = max(0.0, float(instance.get("active_compost_mass", 0.0)))
        mature = max(0.0, float(instance.get("mature_compost_mass", 0.0)))
        total = feedstock + active + mature
        if total <= 1e-9:
            pending = (
                max(0.0, float(instance.get("unbalanced_kitchen_waste", 0.0)))
                + max(0.0, float(instance.get("unbalanced_scat", 0.0)))
                + max(0.0, float(instance.get("available_carbon_material", 0.0)))
            )
            return "Fresh compost inputs awaiting balancing and mixing" if pending > 1e-9 else "Empty compost pile"
        if mature / total >= 0.70 and feedstock / total <= 0.10:
            return "Composted material ready for use as soil amendment"
        if feedstock >= active:
            return "Organic waste rapidly decomposing"
        return "Active composting and curing"

    def _mix_compost_inputs(self, instance):
        definition = self.facility_definitions.get("compost-pile") or {}
        inputs = definition.get("inputs") or {}
        kitchen = max(0.0, float(instance.get("unbalanced_kitchen_waste", 0.0)))
        scat = max(0.0, float(instance.get("unbalanced_scat", 0.0)))
        carbon = max(0.0, float(instance.get("available_carbon_material", 0.0)))
        kitchen_factor = float((inputs.get("kitchen_waste") or {}).get("carbon_demand_lb_per_lb", 0.5))
        scat_factor = float((inputs.get("scat") or {}).get("carbon_demand_lb_per_lb", 1.5))
        demand = kitchen * kitchen_factor + scat * scat_factor
        if demand <= 1e-12 or carbon <= 1e-12:
            return {"mixed_feedstock_lb": 0.0, "carbon_used_lb": 0.0}

        fraction = min(1.0, carbon / demand)
        kitchen_used = kitchen * fraction
        scat_used = scat * fraction
        carbon_used = demand * fraction
        mixed = kitchen_used + scat_used + carbon_used

        instance["unbalanced_kitchen_waste"] = max(0.0, kitchen - kitchen_used)
        instance["unbalanced_scat"] = max(0.0, scat - scat_used)
        instance["available_carbon_material"] = max(0.0, carbon - carbon_used)
        instance["feedstock_mass"] = max(0.0, float(instance.get("feedstock_mass", 0.0))) + mixed
        return {
            "mixed_feedstock_lb": mixed,
            "kitchen_waste_used_lb": kitchen_used,
            "scat_used_lb": scat_used,
            "carbon_used_lb": carbon_used,
        }

    def _facility_output_amount(self, instance, resource_id, source_field=None):
        if source_field:
            return max(0.0, float(instance.get(source_field, 0.0)))
        return max(0.0, float((instance.get("stored_outputs") or {}).get(resource_id, 0.0)))

    def _player_inventory_amount(self, resource_id):
        inventory = self.game_state["player"].setdefault("inventory", {})
        return float(inventory.get(resource_id, 0.0))

    def _add_player_inventory(self, resource_id, amount):
        if amount <= 0:
            return
        inventory = self.game_state["player"].setdefault("inventory", {})
        inventory[resource_id] = float(inventory.get(resource_id, 0.0)) + amount

    def _consume_player_inventory(self, resource_id, requested):
        if requested <= 0:
            return 0.0
        inventory = self.game_state["player"].setdefault("inventory", {})
        available = float(inventory.get(resource_id, 0.0))
        used = min(available, requested)
        inventory[resource_id] = max(0.0, available - used)
        return used

    def _house_storage_amount(self, resource_id):
        storage = self.game_state["house"].setdefault("storage", {})
        return float(storage.get(resource_id, 0.0))

    def _add_house_storage(self, resource_id, amount):
        if amount <= 0:
            return
        storage = self.game_state["house"].setdefault("storage", {})
        storage[resource_id] = float(storage.get(resource_id, 0.0)) + amount

    def _consume_house_storage(self, resource_id, requested):
        if requested <= 0:
            return 0.0
        storage = self.game_state["house"].setdefault("storage", {})
        available = float(storage.get(resource_id, 0.0))
        used = min(available, requested)
        storage[resource_id] = max(0.0, available - used)
        return used

    def order_house_material(self, resource_id, amount):
        """Instantly deliver a zero-cost catalog item to House Storage."""
        spec = ORDER_CATALOG.get(resource_id)
        if spec is None:
            raise ValueError("That item is not available to order.")
        try:
            amount = float(amount)
        except (TypeError, ValueError) as exc:
            raise ValueError("Order amount must be numeric.") from exc
        if amount <= 0:
            raise ValueError("Order amount must be greater than zero.")
        if spec.get("integer_only") and not amount.is_integer():
            raise ValueError(f"{spec['name']} must be ordered in whole units.")

        delivered_resource_id = spec.get("resource_id", resource_id)
        self._add_house_storage(delivered_resource_id, amount)
        event = self._append_pending_event({
            "type": "house_delivery",
            "catalog_item_id": resource_id,
            "resource_id": delivered_resource_id,
            "amount": amount,
            "unit": spec.get("unit"),
            "effective": "immediate",
        })
        self.save()
        return deepcopy(event)

    def _next_task_id(self):
        player = self.game_state.setdefault("player", {})
        number = int(player.get("next_task_id", 1))
        player["next_task_id"] = number + 1
        return f"task-{number:04d}"

    def _queue_task(self, task):
        player = self.game_state["player"]
        queue = player.setdefault("task_queue", [])
        queued = {
            "task_id": self._next_task_id(),
            "status": "queued",
            "phase": "queued",
            "queued_at": deepcopy(self.game_state["time"]),
            "work_minutes_total": 0,
            "work_minutes_remaining": 0,
            **deepcopy(task),
        }
        queue.append(queued)
        self.save()
        return deepcopy(queued)

    @staticmethod
    def _movement_direction(dx, dy):
        if abs(dx) >= abs(dy):
            return "right" if dx >= 0 else "left"
        return "down" if dy >= 0 else "up"

    def _point_blocked(self, column, row, ignore_instance_id=None):
        map_state = self.game_state["map"]
        if not (0 <= column < int(map_state["width_tiles"]) and 0 <= row < int(map_state["height_tiles"])):
            return True

        for instance in self.game_state["facilities"]:
            if instance.get("instance_id") == ignore_instance_id:
                continue
            self._normalize_instance(instance)
            if (
                instance["column"] <= column < instance["column"] + instance["width"]
                and instance["row"] <= row < instance["row"] + instance["height"]
            ):
                return True

        house = self.game_state.get("house") or {}
        for point in (house.get("pickup_points") or {}).values():
            pc = int(float(point.get("column", -1000)))
            pr = int(float(point.get("row", -1000)))
            pw = max(1, int(point.get("width", 1)))
            ph = max(1, int(point.get("height", 1)))
            if pc <= column < pc + pw and pr <= row < pr + ph:
                return True
        point = house.get("storage_point") or {}
        pc = int(float(point.get("column", -1000)))
        pr = int(float(point.get("row", -1000)))
        pw = max(1, int(point.get("width", 2)))
        ph = max(1, int(point.get("height", 2)))
        if pc <= column < pc + pw and pr <= row < pr + ph:
            return True
        return False

    def _nearest_adjacent_tile(self, instance):
        self._normalize_instance(instance)
        c0 = int(instance["column"])
        r0 = int(instance["row"])
        w = int(instance["width"])
        h = int(instance["height"])
        candidates = []
        for column in range(c0, c0 + w):
            candidates.extend([(column, r0 - 1), (column, r0 + h)])
        for row in range(r0, r0 + h):
            candidates.extend([(c0 - 1, row), (c0 + w, row)])

        candidates = [
            (column, row)
            for column, row in candidates
            if not self._point_blocked(column, row, instance.get("instance_id"))
        ]
        if not candidates:
            raise ValueError("No accessible adjacent tile is available for this facility.")

        position = self.game_state["player"]["position"]
        pc = float(position.get("column", 0.0))
        pr = float(position.get("row", 0.0))
        column, row = min(candidates, key=lambda p: (p[0] - pc) ** 2 + (p[1] - pr) ** 2)
        return {"column": float(column), "row": float(row)}

    def _validate_map_target(self, column, row):
        if not isinstance(column, (int, float)) or not isinstance(row, (int, float)):
            raise ValueError("Destination must use numeric map coordinates.")
        map_state = self.game_state["map"]
        max_column = int(map_state["width_tiles"]) - 1
        max_row = int(map_state["height_tiles"]) - 1
        column = float(column)
        row = float(row)
        if not (0 <= column <= max_column and 0 <= row <= max_row):
            raise ValueError("Destination is outside the map.")
        return column, row

    def queue_walk(self, column, row):
        column, row = self._validate_map_target(column, row)
        return self._queue_task({
            "type": "walk",
            "description": f"Walk to tile {int(column) + 1}, {int(row) + 1}",
            "target": {"column": column, "row": row},
        })

    # Compatibility alias for older callers.
    def start_walk(self, column, row):
        self.queue_walk(column, row)
        return deepcopy(self.game_state["player"])

    def queue_house_pickup(self, resource_id, amount):
        if resource_id not in {"kitchen_waste", "carbonaceous_plant_waste"}:
            raise ValueError("That resource is not available from a house pickup point.")
        try:
            amount = float(amount)
        except (TypeError, ValueError) as exc:
            raise ValueError("Pickup amount must be numeric.") from exc
        if amount <= 0:
            raise ValueError("Pickup amount must be greater than zero.")

        outputs = self.game_state["house"].setdefault("outputs", {})
        available = float(outputs.get(resource_id, 0.0))
        if amount > available + 1e-9:
            raise ValueError(f"Only {available:g} is available at that pickup point.")
        outputs[resource_id] = max(0.0, available - amount)
        point = self.game_state["house"]["pickup_points"][resource_id]
        return self._queue_task({
            "type": "house_pickup",
            "description": f"Pick up {amount:g} {resource_id.replace('_', ' ')}",
            "resource_id": resource_id,
            "amount": amount,
            "reserved_cargo": {"resource_id": resource_id, "amount": amount, "source": "house_output"},
            "target": {"column": float(point["column"]), "row": float(point["row"])},
            "work_minutes_total": 1,
            "work_minutes_remaining": 1,
        })

    def pickup_house_output(self, resource_id, amount):
        return self.queue_house_pickup(resource_id, amount)

    def queue_house_storage_transfer(self, resource_id, amount, direction):
        if not isinstance(resource_id, str) or not resource_id:
            raise ValueError("A resource must be selected.")
        try:
            amount = float(amount)
        except (TypeError, ValueError) as exc:
            raise ValueError("Transfer amount must be numeric.") from exc
        if amount <= 0:
            raise ValueError("Transfer amount must be greater than zero.")
        if resource_id == "chicken" and not amount.is_integer():
            raise ValueError("Laying hens must be transferred in whole birds.")

        if direction == "to_player":
            available = self._house_storage_amount(resource_id)
            if amount > available + 1e-9:
                raise ValueError(f"Only {available:g} is available in House Storage.")
            self._consume_house_storage(resource_id, amount)
            source = "house_storage"
            description = f"Pick up {amount:g} {resource_id.replace('_', ' ')} from House Storage"
        elif direction == "to_house":
            available = self._player_inventory_amount(resource_id)
            if amount > available + 1e-9:
                raise ValueError(f"The Homesteader is carrying only {available:g}.")
            self._consume_player_inventory(resource_id, amount)
            source = "player"
            description = f"Drop off {amount:g} {resource_id.replace('_', ' ')} at House Storage"
        else:
            raise ValueError("Transfer direction must be to_player or to_house.")

        point = self.game_state["house"]["storage_point"]
        return self._queue_task({
            "type": "house_storage_transfer",
            "description": description,
            "resource_id": resource_id,
            "amount": amount,
            "transfer_direction": direction,
            "reserved_cargo": {"resource_id": resource_id, "amount": amount, "source": source},
            "target": {"column": float(point["column"]), "row": float(point["row"])},
            "work_minutes_total": 1,
            "work_minutes_remaining": 1,
        })

    def transfer_house_storage(self, resource_id, amount, direction):
        return self.queue_house_storage_transfer(resource_id, amount, direction)

    def transfer_player_inventory(self, resource_id, amount, direction):
        """Compatibility route: household transfers now use physical House Storage."""
        mapped = "to_house" if direction == "to_household" else direction
        return self.queue_house_storage_transfer(resource_id, amount, mapped)

    def queue_facility_fill(self, instance_id, resource_id, amount):
        if not isinstance(instance_id, str) or not instance_id:
            raise ValueError("A facility instance must be selected.")
        if not isinstance(resource_id, str) or not resource_id:
            raise ValueError("A material must be selected.")
        try:
            amount = float(amount)
        except (TypeError, ValueError) as exc:
            raise ValueError("Fill amount must be numeric.") from exc
        if amount <= 0:
            raise ValueError("Fill amount must be greater than zero.")

        instance = self._find_facility_instance(instance_id)
        spec = self._fill_spec(instance, resource_id)
        if spec["integer_only"] and not amount.is_integer():
            raise ValueError("Laying hens must be added in whole birds.")

        available = self._player_inventory_amount(resource_id)
        if amount > available + 1e-9:
            raise ValueError(f"The Homesteader is carrying only {available:g}.")

        reserved = 0.0
        for task in self.game_state["player"].get("task_queue", []):
            if task.get("type") == "facility_fill" and task.get("target_instance_id") == instance_id:
                if spec.get("capacity_mode") == "shared_total_mass" or task.get("target_field") == spec["field"]:
                    reserved += float(task.get("amount", 0.0))

        if spec["capacity"] is not None:
            current = (
                self._compost_total_mass(instance)
                if spec.get("capacity_mode") == "shared_total_mass"
                else max(0.0, float(instance.get(spec["field"], 0.0)))
            )
            remaining = max(0.0, float(spec["capacity"]) - current - reserved)
            if amount > remaining + 1e-9:
                raise ValueError(f"That exceeds remaining capacity ({remaining:g} {spec['unit']}).")

        self._consume_player_inventory(resource_id, amount)
        definition = self.facility_definitions.get(instance["facility_id"]) or {}
        return self._queue_task({
            "type": "facility_fill",
            "description": f"Deliver {amount:g} {resource_id.replace('_', ' ')} to {definition.get('name', instance['facility_id'])}",
            "target_instance_id": instance_id,
            "resource_id": resource_id,
            "amount": amount,
            "target_field": spec["field"],
            "unit": spec["unit"],
            "reserved_cargo": {"resource_id": resource_id, "amount": amount, "source": "player"},
            "work_minutes_total": 1,
            "work_minutes_remaining": 1,
        })

    def fill_facility(self, instance_id, resource_id, amount):
        return self.queue_facility_fill(instance_id, resource_id, amount)

    def queue_facility_collection(self, instance_id, resource_id, amount, source_field=None):
        instance = self._find_facility_instance(instance_id)
        if not isinstance(resource_id, str) or not resource_id:
            raise ValueError("A resource must be selected.")
        try:
            amount = float(amount)
        except (TypeError, ValueError) as exc:
            raise ValueError("Collection amount must be numeric.") from exc
        if amount <= 0:
            raise ValueError("Collection amount must be greater than zero.")

        allowed_sources = {
            "chicken-coop": {("eggs", None)},
            "compost-pile": {("compost", "mature_compost_mass")},
            "bsfl-reactor": {("insect_forage", None), ("active_compost", "residue_mass")},
        }
        facility_id = instance.get("facility_id")
        if (resource_id, source_field) not in allowed_sources.get(facility_id, set()):
            raise ValueError("That output is not available for collection from this facility.")

        resource_def = self.resource_definitions.get(resource_id) or {}
        if resource_def.get("quantity_mode") == "discrete" and not amount.is_integer():
            raise ValueError(f"{resource_def.get('name', resource_id)} must be collected in whole units.")

        available = self._facility_output_amount(instance, resource_id, source_field)
        reserved = sum(
            max(0.0, float(task.get("amount", 0.0)))
            for task in self.game_state["player"].get("task_queue", [])
            if task.get("type") == "facility_collect"
            and task.get("target_instance_id") == instance_id
            and task.get("resource_id") == resource_id
            and task.get("source_field") == source_field
        )
        free = max(0.0, available - reserved)
        if amount > free + 1e-9:
            raise ValueError(f"Only {free:g} is available to collect.")

        definition = self.facility_definitions.get(instance["facility_id"]) or {}
        return self._queue_task({
            "type": "facility_collect",
            "description": f"Collect {amount:g} {resource_def.get('name', resource_id)} from {definition.get('name', instance['facility_id'])}",
            "target_instance_id": instance_id,
            "resource_id": resource_id,
            "amount": amount,
            "source_field": source_field,
            "work_minutes_total": 1,
            "work_minutes_remaining": 1,
        })

    def queue_service_facility(self, instance_id):
        instance = self._find_facility_instance(instance_id)
        accrued = max(0.0, float(instance.get("accrued_labor_requirement", 0.0)))
        already_reserved = sum(
            max(0.0, float(task.get("service_hours_remaining", 0.0)))
            for task in self.game_state["player"].get("task_queue", [])
            if task.get("type") == "service_facility"
            and task.get("target_instance_id") == instance_id
        )
        labor_hours = max(0.0, accrued - already_reserved)
        if labor_hours <= 1e-9:
            raise ValueError("This facility has no unassigned service labor requirement.")
        minutes = max(1, int(math.ceil(labor_hours * MINUTES_PER_HOUR - 1e-12)))
        definition = self.facility_definitions.get(instance["facility_id"]) or {}
        return self._queue_task({
            "type": "service_facility",
            "description": f"Service {definition.get('name', instance['facility_id'])}",
            "target_instance_id": instance_id,
            "service_hours_reserved": labor_hours,
            "service_hours_remaining": labor_hours,
            "work_minutes_total": minutes,
            "work_minutes_remaining": minutes,
        })

    def _refund_task_reservation(self, task):
        cargo = task.get("reserved_cargo") or {}
        resource_id = cargo.get("resource_id")
        amount = max(0.0, float(cargo.get("amount", 0.0)))
        source = cargo.get("source")
        if not resource_id or amount <= 0:
            return
        if source == "house_output":
            outputs = self.game_state["house"].setdefault("outputs", {})
            outputs[resource_id] = float(outputs.get(resource_id, 0.0)) + amount
        elif source == "house_storage":
            self._add_house_storage(resource_id, amount)
        elif source == "player":
            self._add_player_inventory(resource_id, amount)

    def cancel_task(self, task_id):
        queue = self.game_state["player"].setdefault("task_queue", [])
        for index, task in enumerate(queue):
            if task.get("task_id") == task_id:
                removed = queue.pop(index)
                self._refund_task_reservation(removed)
                self._append_pending_event({
                    "type": "task_cancelled",
                    "task_id": task_id,
                    "task_type": removed.get("type"),
                })
                self.save()
                return deepcopy(removed)
        raise ValueError("Task not found.")

    def _initialize_task(self, task):
        if task.get("phase") != "queued":
            return
        if task.get("target_instance_id"):
            instance = self._find_facility_instance(task["target_instance_id"])
            task["target"] = self._nearest_adjacent_tile(instance)
        target = task.get("target")
        if target is None:
            task["phase"] = "working"
            task["status"] = "active"
            return
        position = self.game_state["player"]["position"]
        dx = float(target["column"]) - float(position.get("column", 0.0))
        dy = float(target["row"]) - float(position.get("row", 0.0))
        if (dx * dx + dy * dy) ** 0.5 <= 1e-9:
            if task.get("type") == "walk" or int(task.get("work_minutes_remaining", 0)) <= 0:
                task["phase"] = "complete"
            else:
                task["phase"] = "working"
        else:
            task["phase"] = "travel"
        task["status"] = "active"
        task["started_at"] = deepcopy(self.game_state["time"])

    def _complete_task_effect(self, task):
        task_type = task.get("type")
        if task_type == "house_pickup":
            self._add_player_inventory(task["resource_id"], float(task["amount"]))
        elif task_type == "house_storage_transfer":
            if task.get("transfer_direction") == "to_player":
                self._add_player_inventory(task["resource_id"], float(task["amount"]))
            else:
                resource_id = task["resource_id"]
                amount = float(task["amount"])
                if resource_id == "eggs":
                    credit = amount * EGG_GROCERY_VALUE_USD
                    household = self.game_state.setdefault("household", {})
                    household["grocery_credit_usd"] = max(0.0, float(household.get("grocery_credit_usd", 0.0))) + credit
                    task["grocery_credit_added_usd"] = round(credit, 6)
                else:
                    self._add_house_storage(resource_id, amount)
        elif task_type == "facility_fill":
            instance = self._find_facility_instance(task["target_instance_id"])
            field = task["target_field"]
            instance[field] = max(0.0, float(instance.get(field, 0.0))) + float(task["amount"])
        elif task_type == "facility_collect":
            instance = self._find_facility_instance(task["target_instance_id"])
            amount = float(task["amount"])
            source_field = task.get("source_field")
            resource_id = task["resource_id"]
            if source_field:
                available = max(0.0, float(instance.get(source_field, 0.0)))
                instance[source_field] = max(0.0, available - amount)
            else:
                outputs = instance.setdefault("stored_outputs", {})
                available = max(0.0, float(outputs.get(resource_id, 0.0)))
                outputs[resource_id] = max(0.0, available - amount)
            self._add_player_inventory(resource_id, amount)
        elif task_type == "service_facility":
            instance = self._find_facility_instance(task["target_instance_id"])
            if instance.get("facility_id") == "compost-pile":
                mixed = self._mix_compost_inputs(instance)
                task["compost_mix_result"] = {key: round(value, 6) for key, value in mixed.items()}

        self._append_pending_event({
            "type": "task_completed",
            "task_id": task.get("task_id"),
            "task_type": task_type,
            "description": task.get("description"),
        })

    def _advance_task_one_minute(self):
        player = self.game_state["player"]
        queue = player.setdefault("task_queue", [])
        if not queue:
            return {"status": "idle", "completed": False, "phase": "idle"}

        task = queue[0]
        self._initialize_task(task)

        if task.get("phase") == "complete":
            self._complete_task_effect(task)
            finished = queue.pop(0)
            return {"status": "completed", "completed": True, "phase": "complete", "task": deepcopy(finished)}

        if task.get("phase") == "travel":
            position = player["position"]
            target = task.get("target") or {}
            current_column = float(position.get("column", 0.0))
            current_row = float(position.get("row", 0.0))
            target_column = float(target.get("column", current_column))
            target_row = float(target.get("row", current_row))
            dx = target_column - current_column
            dy = target_row - current_row
            distance_tiles = (dx * dx + dy * dy) ** 0.5
            tile_size_ft = float(self.game_state["map"].get("tile_size_ft", 5))
            tiles_per_minute = WALKING_SPEED_FT_PER_MINUTE / tile_size_ft if tile_size_ft > 0 else distance_tiles
            direction = self._movement_direction(dx, dy) if distance_tiles > 0 else player.get("last_direction", "down")
            task["direction"] = direction
            player["last_direction"] = direction

            if distance_tiles <= tiles_per_minute or distance_tiles <= 1e-9:
                position["column"] = target_column
                position["row"] = target_row
                if task.get("type") == "walk" or int(task.get("work_minutes_remaining", 0)) <= 0:
                    self._complete_task_effect(task)
                    finished = queue.pop(0)
                    return {
                        "status": "completed", "completed": True, "phase": "complete",
                        "type": task.get("type"), "target": deepcopy(target), "direction": direction,
                        "task": deepcopy(finished),
                    }
                task["phase"] = "working"
                return {
                    "status": "arrived", "completed": False, "phase": "working",
                    "type": task.get("type"), "target": deepcopy(target), "direction": direction,
                    "task": deepcopy(task),
                }

            fraction = tiles_per_minute / distance_tiles
            position["column"] = current_column + dx * fraction
            position["row"] = current_row + dy * fraction
            return {
                "status": "walking", "completed": False, "phase": "travel",
                "type": task.get("type"), "target": deepcopy(target), "direction": direction,
                "task": deepcopy(task),
            }

        if task.get("phase") == "working":
            remaining = max(0, int(task.get("work_minutes_remaining", 0)))
            if remaining > 0:
                if task.get("type") == "service_facility":
                    instance = self._find_facility_instance(task["target_instance_id"])
                    service_remaining = max(0.0, float(task.get("service_hours_remaining", 0.0)))
                    worked_hours = min(1.0 / MINUTES_PER_HOUR, service_remaining)
                    instance["accrued_labor_requirement"] = max(
                        0.0,
                        float(instance.get("accrued_labor_requirement", 0.0)) - worked_hours,
                    )
                    task["service_hours_remaining"] = max(0.0, service_remaining - worked_hours)
                task["work_minutes_remaining"] = remaining - 1

            if int(task.get("work_minutes_remaining", 0)) <= 0:
                self._complete_task_effect(task)
                finished = queue.pop(0)
                return {
                    "status": "completed", "completed": True, "phase": "complete",
                    "type": task.get("type"), "task": deepcopy(finished),
                }

            return {
                "status": "working", "completed": False, "phase": "working",
                "type": task.get("type"), "task": deepcopy(task),
            }

        return {"status": "idle", "completed": False, "phase": task.get("phase", "queued"), "task": deepcopy(task)}

    def _append_pending_event(self, event):
        stamped = {
            **deepcopy(event),
            "time": deepcopy(self.game_state["time"]),
        }
        self.game_state["pending_events"].append(stamped)
        return stamped

    def _advance_one_minute(self):
        """Advance one simulated minute; one queued Homesteader task may progress."""
        started_at = deepcopy(self.game_state["time"])
        activity = self._advance_task_one_minute()

        time_state = self.game_state["time"]
        time_state["minute"] = int(time_state.get("minute", 0)) + 1
        full_tick_due = time_state["minute"] >= MINUTES_PER_HOUR

        full_tick_result = None
        if full_tick_due:
            time_state["minute"] = 0
            full_tick_result = self.advance_hour()
        else:
            self.save()

        return {
            "subtick_started_at": started_at,
            "movement": activity,
            "activity": activity,
            "full_tick": full_tick_result is not None,
            "full_tick_result": full_tick_result,
        }

    def advance_subtick(self):
        result = self._advance_one_minute()
        return {**result, "state": self.state()}

    def advance_minutes(self, minutes):
        if isinstance(minutes, bool):
            raise ValueError("Minutes must be a positive integer.")
        try:
            minutes = int(minutes)
        except (TypeError, ValueError) as exc:
            raise ValueError("Minutes must be a positive integer.") from exc
        if minutes <= 0:
            raise ValueError("Minutes must be greater than zero.")
        if minutes > 10080:
            raise ValueError("A single advance is limited to seven simulated days.")

        first_started_at = deepcopy(self.game_state["time"])
        last_activity = {"status": "idle", "completed": False, "phase": "idle"}
        full_ticks = 0
        last_full_tick_result = None
        for _ in range(minutes):
            result = self._advance_one_minute()
            last_activity = result["activity"]
            if result["full_tick"]:
                full_ticks += 1
                last_full_tick_result = result["full_tick_result"]

        return {
            "advance_started_at": first_started_at,
            "minutes_advanced": minutes,
            "movement": last_activity,
            "activity": last_activity,
            "full_tick": full_ticks > 0,
            "full_ticks": full_ticks,
            "full_tick_result": last_full_tick_result,
            "state": self.state(),
        }

    # ------------------------------------------------------------------
    # Tick processing
    # ------------------------------------------------------------------

    def advance_hour(self):
        processed_day = self.game_state["time"]["day"]
        processed_hour = self.game_state["time"]["hour"]
        pending_events = deepcopy(self.game_state.get("pending_events", []))

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

        # Pending events are now an audit journal. Physical transfers are
        # executed by the Homesteader activity queue at minute resolution.
        applied_fills = []
        self.game_state["last_full_tick_events"] = pending_events
        self.game_state["pending_events"] = []

        self._advance_clock()
        self.save()

        return {
            "processed_at": {
                "day": processed_day,
                "hour": processed_hour,
            },
            "operations": operations,
            "applied_pending_fills": applied_fills,
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
        flows.setdefault("groceries_baseline_this_tick_usd", 0.0)
        flows.setdefault("grocery_credit_applied_this_tick_usd", 0.0)
        flows.setdefault("groceries_net_this_tick_usd", 0.0)
        flows.setdefault("tap_water_demand_this_tick_gal", 0.0)
        flows.setdefault("greywater_generated_this_tick_gal", 0.0)
        flows.setdefault("blackwater_generated_this_tick_gal", 0.0)
        flows.setdefault("other_water_use_this_tick_gal", 0.0)
        flows.setdefault("kitchen_waste_generated_this_tick_lb", 0.0)
        flows.setdefault("carbonaceous_plant_waste_generated_this_tick_lb", 0.0)
        flows.setdefault("recalcitrant_waste_generated_this_tick_lb", 0.0)
        flows.setdefault("garbage_to_curb_this_tick_lb", 0.0)
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

        groceries_baseline = max(0.0, float(household_flows.get("groceries_usd", 0.0)))
        household_state = self.game_state.setdefault("household", {})
        grocery_credit_available = max(0.0, float(household_state.get("grocery_credit_usd", 0.0)))
        grocery_credit_applied = min(groceries_baseline, grocery_credit_available)
        groceries = max(0.0, groceries_baseline - grocery_credit_applied)
        household_state["grocery_credit_usd"] = grocery_credit_available - grocery_credit_applied
        household_state["cumulative_grocery_savings_usd"] = (
            max(0.0, float(household_state.get("cumulative_grocery_savings_usd", 0.0)))
            + grocery_credit_applied
        )
        tap_water = household_flows.get("tap_water_gal", 0.0)
        greywater = household_flows.get("greywater_gal", 0.0)
        blackwater = household_flows.get("blackwater_gal", 0.0)
        other_water = household_flows.get("other_water_use_gal", 0.0)

        flows["groceries_baseline_this_tick_usd"] = groceries_baseline
        flows["grocery_credit_applied_this_tick_usd"] = grocery_credit_applied
        flows["groceries_net_this_tick_usd"] = groceries
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

        # Recoverable household waste appears physically at the house pickup
        # points. Separation/collection is abstracted; the Homesteader must
        # carry it from the house to a processor. Recalcitrant waste has no
        # productive use and is abstracted as curbside garbage.
        kitchen_waste = max(
            0.0,
            float(household_flows.get("kitchen_waste_lb", 0.0)),
        )
        carbonaceous_plant_waste = max(
            0.0,
            float(household_flows.get("recyclable_paper_lb", 0.0)),
        )
        recalcitrant_waste = max(
            0.0,
            float(household_flows.get("recyclable_plastic_lb", 0.0))
            + float(household_flows.get("recyclable_glass_lb", 0.0))
            + float(household_flows.get("recyclable_metal_lb", 0.0))
            + float(household_flows.get("residual_nonfood_waste_lb", 0.0)),
        )

        house_outputs = self.game_state["house"].setdefault("outputs", {})
        house_outputs["kitchen_waste"] = (
            float(house_outputs.get("kitchen_waste", 0.0)) + kitchen_waste
        )
        house_outputs["carbonaceous_plant_waste"] = (
            float(house_outputs.get("carbonaceous_plant_waste", 0.0))
            + carbonaceous_plant_waste
        )
        flows["carbonaceous_plant_waste_generated_this_tick_lb"] = carbonaceous_plant_waste
        flows["recalcitrant_waste_generated_this_tick_lb"] = recalcitrant_waste
        flows["garbage_to_curb_this_tick_lb"] = recalcitrant_waste

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
                "kitchen_waste_lb": round(kitchen_waste, 6),
                "carbonaceous_plant_waste_lb": round(carbonaceous_plant_waste, 6),
                "recalcitrant_waste_lb": round(recalcitrant_waste, 6),
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
        time_state["minute"] = 0
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
        instance.setdefault("feed_mass", 0.0)
        outputs = instance.setdefault("stored_outputs", {})
        remainders = instance.setdefault("production_remainders", {})

        if bird_count <= 0:
            return {
                "status": "idle", "reason": "no chickens", "occupancy": 0,
                "feed_mass": round(float(instance.get("feed_mass", 0.0)), 6),
                "stored_eggs": int(max(0.0, float(outputs.get("eggs", 0.0)))),
                "consumed": {}, "produced": {},
            }

        inputs = definition.get("inputs", {})
        feed_daily = float((inputs.get("feed") or {}).get("rate_per_container_unit_per_day", 0.0))
        water_daily = float((inputs.get("water") or {}).get("rate_per_container_unit_per_day", 0.0))
        total_nutrition_required = feed_daily * bird_count / HOURS_PER_DAY
        requested_water = water_daily * bird_count / HOURS_PER_DAY

        yard = self.game_state.setdefault("yard_resources", {})
        nutrition_from_forage = 0.0
        consumed = {}
        forage_detail = {}

        for resource_id in ("insect_forage", "green_forage"):
            rule = inputs.get(resource_id) or {}
            max_fraction = max(0.0, min(1.0, float(rule.get("max_nutrition_fraction", 0.0))))
            equivalent = max(0.0, float(rule.get("feed_equivalent_per_lb", 0.0)))
            contribution_cap = total_nutrition_required * max_fraction
            available = max(0.0, float(yard.get(resource_id, 0.0)))
            physical_requested = contribution_cap / equivalent if equivalent > 0 else 0.0
            used = min(available, physical_requested)
            contribution = used * equivalent
            yard[resource_id] = max(0.0, available - used)
            nutrition_from_forage += contribution
            if used > 0:
                consumed[resource_id] = round(used, 6)
            forage_detail[resource_id] = {
                "used_lb": round(used, 6),
                "feed_equivalent_lb": round(contribution, 6),
                "nutrition_cap_lb_feed_equivalent": round(contribution_cap, 6),
            }

        commercial_feed_needed = max(0.0, total_nutrition_required - nutrition_from_forage)
        available_feed = max(0.0, float(instance.get("feed_mass", 0.0)))
        used_feed = min(available_feed, commercial_feed_needed)
        instance["feed_mass"] = max(0.0, available_feed - used_feed)
        if used_feed > 0:
            consumed["feed"] = round(used_feed, 6)

        nutrition_received = nutrition_from_forage + used_feed
        utilization = (
            1.0
            if total_nutrition_required <= 0
            else max(0.0, min(1.0, nutrition_received / total_nutrition_required))
        )

        used_water = requested_water * utilization
        self.game_state["current_flows"]["municipal_water_this_tick_gal"] = (
            float(self.game_state["current_flows"].get("municipal_water_this_tick_gal", 0.0))
            + used_water
        )
        if used_water > 0:
            consumed["water"] = round(used_water, 6)

        produced = {}
        for resource_id, rule in definition.get("outputs", {}).items():
            per_unit_daily = rule.get("rate_per_container_unit_per_day")
            if per_unit_daily is None:
                continue
            expected_amount = float(per_unit_daily) * bird_count / HOURS_PER_DAY * utilization
            if resource_id == "eggs":
                total_with_remainder = max(0.0, float(remainders.get("eggs", 0.0))) + expected_amount
                whole_eggs = math.floor(total_with_remainder + 1e-9)
                remainders["eggs"] = max(0.0, total_with_remainder - whole_eggs)
                if whole_eggs > 0:
                    outputs["eggs"] = max(0.0, float(outputs.get("eggs", 0.0))) + whole_eggs
                    produced["eggs"] = whole_eggs
            else:
                self._add_inventory(resource_id, expected_amount)
                if expected_amount > 0:
                    produced[resource_id] = round(expected_amount, 6)

        reason = None if utilization >= 1.0 - 1e-9 else "limited by available nutrition"
        return {
            "status": "operating" if utilization > 0 else "idle",
            "occupancy": bird_count,
            "capacity": capacity,
            "feed_mass": round(float(instance.get("feed_mass", 0.0)), 6),
            "stored_eggs": int(max(0.0, float(outputs.get("eggs", 0.0)))),
            "egg_production_remainder": round(float(remainders.get("eggs", 0.0)), 6),
            "nutrition_required_lb_feed_equivalent": round(total_nutrition_required, 6),
            "nutrition_received_lb_feed_equivalent": round(nutrition_received, 6),
            "commercial_feed_needed_after_forage_lb": round(commercial_feed_needed, 6),
            "forage": forage_detail,
            "utilization_pct": round(utilization * 100, 1),
            "consumed": consumed,
            "produced": produced,
            "reason": reason,
            "accrued_labor_requirement": round(instance["accrued_labor_requirement"], 6),
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
        """Run one hour of the three-pool compost model.

        Balanced feedstock converts into active compost; active compost converts
        into mature soil amendment. Mature material remains at the pile until
        physically collected by the Homesteader.
        """
        process = definition.get("process") or {}
        feedstock = max(0.0, float(instance.get("feedstock_mass", 0.0)))
        active = max(0.0, float(instance.get("active_compost_mass", 0.0)))
        mature = max(0.0, float(instance.get("mature_compost_mass", 0.0)))

        feed_daily = max(0.0, min(1.0, float(process.get("feedstock_conversion_rate_per_day", 0.10))))
        mature_daily = max(0.0, min(1.0, float(process.get("active_maturation_rate_per_day", 0.04))))
        feed_retention = max(0.0, min(1.0, float(process.get("feedstock_to_active_retention_fraction", 0.70))))
        mature_retention = max(0.0, min(1.0, float(process.get("active_to_mature_retention_fraction", 0.65))))

        feed_hourly = 1.0 - (1.0 - feed_daily) ** (1.0 / HOURS_PER_DAY) if feed_daily < 1.0 else 1.0
        mature_hourly = 1.0 - (1.0 - mature_daily) ** (1.0 / HOURS_PER_DAY) if mature_daily < 1.0 else 1.0

        # Mature the material that existed at the beginning of the hour first,
        # then process fresh feedstock so newly created active compost is not
        # allowed to traverse two stages in the same tick.
        active_processed = min(active, active * mature_hourly)
        mature_created = active_processed * mature_retention
        maturation_loss = active_processed - mature_created
        active -= active_processed
        mature += mature_created

        feedstock_processed = min(feedstock, feedstock * feed_hourly)
        active_created = feedstock_processed * feed_retention
        decomposition_loss = feedstock_processed - active_created
        feedstock -= feedstock_processed
        active += active_created

        for key, value in (("feedstock_mass", feedstock), ("active_compost_mass", active), ("mature_compost_mass", mature)):
            instance[key] = 0.0 if value < 1e-8 else value

        carbon_needed, total_carbon_demand, available_carbon = self._compost_carbon_demand(instance, definition)
        total_mass = self._compost_total_mass(instance)
        capacity = max(0.0, float((definition.get("container") or {}).get("capacity", 0.0)))

        return {
            "status": "operating" if (feedstock_processed > 0 or active_processed > 0) else "idle",
            "description": self._compost_description(instance),
            "capacity_lb": round(capacity, 6),
            "total_mass_lb": round(total_mass, 6),
            "feedstock_mass": round(instance["feedstock_mass"], 6),
            "active_compost_mass": round(instance["active_compost_mass"], 6),
            "mature_compost_mass": round(instance["mature_compost_mass"], 6),
            "unbalanced_kitchen_waste": round(float(instance.get("unbalanced_kitchen_waste", 0.0)), 6),
            "unbalanced_scat": round(float(instance.get("unbalanced_scat", 0.0)), 6),
            "available_carbon_material": round(available_carbon, 6),
            "carbon_demand_total_lb": round(total_carbon_demand, 6),
            "additional_carbon_needed_lb": round(carbon_needed, 6),
            "processed_feedstock_lb": round(feedstock_processed, 6),
            "active_compost_created_lb": round(active_created, 6),
            "rapid_decomposition_loss_lb": round(decomposition_loss, 6),
            "active_compost_matured_lb": round(active_processed, 6),
            "mature_amendment_created_lb": round(mature_created, 6),
            "curing_loss_lb": round(maturation_loss, 6),
            "accrued_labor_requirement": round(instance["accrued_labor_requirement"], 6),
        }

    def _process_bsfl_reactor(self, instance, definition):
        """Process one hour of an aggregate black soldier fly larva colony.

        facilities.json supplies the biological and physical constants.  The
        GameState instance stores only the current feedstock, standing larval
        biomass, and accumulated residue.
        """
        process = definition.get("process") or {}
        container = definition.get("container") or {}

        required = (
            "feeding_rate_lb_feed_per_lb_larvae_per_day",
            "maximum_growth_rate_per_day",
            "larval_yield_fraction",
            "residue_yield_fraction",
            "untracked_loss_fraction",
            "self_harvest_rate_per_day",
            "maximum_larval_biomass_lb",
        )

        if any(process.get(key) is None for key in required):
            return {
                "status": "idle",
                "reason": "BSFL process constants not fully configured",
                "feedstock_mass": round(float(instance.get("feedstock_mass", 0.0)), 6),
                "larval_biomass": round(float(instance.get("larval_biomass", 0.0)), 6),
                "residue_mass": round(float(instance.get("residue_mass", 0.0)), 6),
            }

        if container.get("usable_capacity_lb") is None:
            return {
                "status": "idle",
                "reason": "BSFL feedstock capacity not configured",
                "feedstock_mass": round(float(instance.get("feedstock_mass", 0.0)), 6),
                "larval_biomass": round(float(instance.get("larval_biomass", 0.0)), 6),
                "residue_mass": round(float(instance.get("residue_mass", 0.0)), 6),
            }

        return self._run_bsfl_process(instance, definition)

    def _run_bsfl_process(self, instance, definition):
        process = definition["process"]
        container = definition.get("container") or {}

        feedstock = max(0.0, float(instance.get("feedstock_mass", 0.0)))
        larval_biomass = max(0.0, float(instance.get("larval_biomass", 0.0)))
        residue_mass = max(0.0, float(instance.get("residue_mass", 0.0)))

        feed_capacity = max(0.0, float(container.get("usable_capacity_lb", 0.0)))
        feeding_rate = max(
            0.0,
            float(process["feeding_rate_lb_feed_per_lb_larvae_per_day"]),
        )
        maximum_growth_rate = max(
            0.0,
            float(process["maximum_growth_rate_per_day"]),
        )
        larval_yield = max(0.0, float(process["larval_yield_fraction"]))
        residue_yield = max(0.0, float(process["residue_yield_fraction"]))
        nominal_loss_fraction = max(
            0.0,
            float(process["untracked_loss_fraction"]),
        )
        self_harvest_rate = max(
            0.0,
            float(process["self_harvest_rate_per_day"]),
        )
        max_biomass = max(
            0.0,
            float(process["maximum_larval_biomass_lb"]),
        )

        configured_max_processing = process.get("maximum_processing_rate_lb_per_day")
        if configured_max_processing is None:
            maximum_processing_per_hour = max_biomass * feeding_rate / HOURS_PER_DAY
        else:
            maximum_processing_per_hour = max(
                0.0,
                float(configured_max_processing) / HOURS_PER_DAY,
            )

        # Existing saves are allowed to be above the nominal feed capacity;
        # capacity constrains loading, while the processor simply works the
        # excess down instead of deleting stored material.
        potential_feed = larval_biomass * feeding_rate / HOURS_PER_DAY
        processed = min(feedstock, potential_feed, maximum_processing_per_hour)

        feeding_fraction = (
            processed / potential_feed
            if potential_feed > 0
            else 0.0
        )
        feeding_fraction = max(0.0, min(1.0, feeding_fraction))

        # Feed-derived growth is limited both by conversion yield and by the
        # colony's researched maximum relative growth rate.
        yield_limited_growth = processed * larval_yield
        biology_limited_growth = (
            larval_biomass
            * maximum_growth_rate
            / HOURS_PER_DAY
            * feeding_fraction
        )
        gross_growth = min(yield_limited_growth, biology_limited_growth)

        new_residue = processed * residue_yield

        # The nominal 35/35/30 split is exact when the growth ceiling does not
        # bind.  If the independently rounded 0.45/day growth ceiling binds,
        # the tiny difference is treated as additional untracked loss so mass
        # is still conserved.
        untracked_loss = max(0.0, processed - gross_growth - new_residue)
        nominal_untracked_loss = processed * nominal_loss_fraction

        # Continuous self-harvest represents an established mixed-age colony.
        # It is activity-scaled so an unfed/torpid colony neither grows nor
        # drains away through modeled maturation.
        self_harvest = (
            larval_biomass
            * self_harvest_rate
            / HOURS_PER_DAY
            * feeding_fraction
        )
        self_harvest = min(self_harvest, larval_biomass + gross_growth)

        larval_biomass = larval_biomass + gross_growth - self_harvest

        # Carrying-capacity overflow becomes additional harvest rather than
        # disappearing from the mass balance.
        overflow_harvest = 0.0
        if max_biomass > 0 and larval_biomass > max_biomass:
            overflow_harvest = larval_biomass - max_biomass
            larval_biomass = max_biomass

        harvested = self_harvest + overflow_harvest
        feedstock -= processed
        residue_mass += new_residue

        instance["feedstock_mass"] = max(0.0, feedstock)
        instance["larval_biomass"] = max(0.0, larval_biomass)
        instance["residue_mass"] = max(0.0, residue_mass)

        # Self-harvested larvae leave the active matrix but remain physically
        # in the reactor catchment until the Homesteader collects them.
        outputs = instance.setdefault("stored_outputs", {})
        outputs["insect_forage"] = max(0.0, float(outputs.get("insect_forage", 0.0))) + harvested

        if larval_biomass <= 0:
            status = "idle"
            reason = "no larval biomass"
        elif feedstock <= 0 and processed <= 0:
            status = "idle"
            reason = "no feedstock"
        elif processed > 0:
            status = "operating"
            reason = None
        else:
            status = "idle"
            reason = "unable to process feedstock"

        result = {
            "status": status,
            "feedstock_capacity_lb": round(feed_capacity, 6),
            "feedstock_mass": round(instance["feedstock_mass"], 6),
            "larval_biomass": round(instance["larval_biomass"], 6),
            "maximum_larval_biomass_lb": round(max_biomass, 6),
            "residue_mass": round(instance["residue_mass"], 6),
            "feeding_fraction": round(feeding_fraction, 6),
            "processed_feedstock": round(processed, 6),
            "gross_larval_growth": round(gross_growth, 6),
            "new_active_compost_precompost": round(new_residue, 6),
            "untracked_loss": round(untracked_loss, 6),
            "nominal_untracked_loss": round(nominal_untracked_loss, 6),
            "self_harvested_insect_forage": round(self_harvest, 6),
            "capacity_overflow_harvest": round(overflow_harvest, 6),
            "harvested_insect_forage": round(harvested, 6),
            "catchment_insect_forage": round(float(instance.get("stored_outputs", {}).get("insect_forage", 0.0)), 6),
            "accrued_labor_requirement": round(
                instance["accrued_labor_requirement"], 6
            ),
        }
        if reason is not None:
            result["reason"] = reason
        return result

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

    def _active_default_tile_count(self):
        map_state = self.game_state["map"]
        default_tile_id = map_state.get("default_tile")
        total_tiles = int(map_state["width_tiles"]) * int(map_state["height_tiles"])
        occupied_tiles = 0
        for instance in self.game_state["facilities"]:
            self._normalize_instance(instance)
            occupied_tiles += int(instance["width"]) * int(instance["height"])
        overridden_default_tiles = sum(
            1
            for tile in self.game_state.get("tile_states", [])
            if tile.get("type") != default_tile_id
        )
        return max(0, total_tiles - occupied_tiles - overridden_default_tiles)

    def _process_default_tile(self):
        map_state = self.game_state["map"]
        default_tile_id = map_state.get("default_tile")
        definition = self.facility_definitions.get(default_tile_id)

        if definition is None:
            return None

        active_tiles = self._active_default_tile_count()
        produced = {}
        forage_capacity = {}
        yard = self.game_state.setdefault("yard_resources", {})

        for resource_id, rule in definition.get("outputs", {}).items():
            if not isinstance(rule, dict):
                continue
            daily_rate = rule.get("rate_per_day")
            if daily_rate is None:
                continue

            daily_generation = float(daily_rate) * active_tiles
            amount = daily_generation / HOURS_PER_DAY

            if resource_id in {"insect_forage", "green_forage"}:
                capacity = daily_generation * YARD_FORAGE_CAP_DAYS
                current = max(0.0, float(yard.get(resource_id, 0.0)))
                # Dynamic carrying capacity follows the amount of unimproved
                # grass. If grass area shrinks, excess environmental forage is
                # clamped rather than becoming transferable stored inventory.
                current = min(current, capacity)
                new_amount = min(capacity, current + amount)
                generated = max(0.0, new_amount - current)
                yard[resource_id] = new_amount
                produced[resource_id] = round(generated, 6)
                forage_capacity[resource_id] = {
                    "amount": round(new_amount, 6),
                    "daily_generation": round(daily_generation, 6),
                    "capacity": round(capacity, 6),
                }
            else:
                self._add_inventory(resource_id, amount)
                produced[resource_id] = round(amount, 6)

        assimilation_rule = (definition.get("inputs", {}).get("scat", {}))
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
            "yard_forage": forage_capacity,
            "potential_scat_assimilation_lb": round(scat_capacity, 6),
            "note": "Yard forage is an environmental pool capped at three days of current grass-tile generation; scat assimilation remains reported but not auto-routed.",
        }

