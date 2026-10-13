import json
from copy import deepcopy
from datetime import datetime, timedelta
from pathlib import Path


HOURS_PER_DAY = 24
MINUTES_PER_HOUR = 60
HOURS_PER_YEAR = 365 * HOURS_PER_DAY
WALKING_SPEED_FT_PER_MINUTE = 264.0


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
        paper_pickup = pickup_points.setdefault("paper_waste", {})
        paper_pickup.setdefault("column", 16.0)
        paper_pickup.setdefault("row", 40.0)
        entrance = house.setdefault("entrance", {})
        entrance.setdefault("column", 14.5)
        entrance.setdefault("row", 40.0)
        outputs = house.setdefault("outputs", {})
        outputs.setdefault("kitchen_waste", 0.0)
        outputs.setdefault("paper_waste", 0.0)

        player = self.game_state.setdefault("player", {})
        player.setdefault("name", "Homesteader")
        position = player.setdefault("position", {})
        position.setdefault("column", 0.0)
        position.setdefault("row", float(max(0, int(map_state["height_tiles"]) - 1)))
        player.setdefault("current_task", None)
        player.setdefault("last_direction", "down")
        player.setdefault("inventory", {})

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

        # BSFL state migration: older saves tracked growing and mature larvae
        # separately.  The current model treats the colony as one aggregate
        # standing larval biomass and self-harvests a continuous fraction.
        if facility_id == "bsfl-reactor":
            if "larval_biomass" not in instance:
                old_growing = float(instance.get("growing_larval_biomass", 0.0))
                old_mature = float(instance.get("mature_larval_biomass", 0.0))
                instance["larval_biomass"] = max(0.0, old_growing + old_mature)

            instance.setdefault("feedstock_mass", 0.0)
            instance.setdefault("residue_mass", 0.0)

            # These are obsolete process states.  harvested_insect_forage was
            # already exported to inventory by the old processor, so it is
            # deliberately discarded rather than exported a second time.
            instance.pop("growing_larval_biomass", None)
            instance.pop("mature_larval_biomass", None)
            instance.pop("harvested_insect_forage", None)

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
            "house": deepcopy(self.game_state["house"]),
            "player": deepcopy(self.game_state["player"]),
            "pending_events": deepcopy(self.game_state["pending_events"]),
            "last_full_tick_events": deepcopy(self.game_state["last_full_tick_events"]),
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
    # Facility content transfers
    # ------------------------------------------------------------------

    def _find_facility_instance(self, instance_id):
        for instance in self.game_state["facilities"]:
            if instance.get("instance_id") == instance_id:
                self._normalize_instance(instance)
                return instance
        raise ValueError("Facility instance not found.")

    def _fill_spec(self, instance, resource_id):
        """Return the supported destination field/capacity for a fill action."""
        facility_id = instance.get("facility_id")
        definition = self.facility_definitions.get(facility_id) or {}
        container = definition.get("container") or {}
        process = definition.get("process") or {}

        if facility_id == "chicken-coop" and resource_id == "chicken":
            return {
                "field": "current_fill",
                "capacity": float(container.get("capacity", 0.0)),
                "unit": "bird",
                "integer_only": True,
            }

        if facility_id == "bsfl-reactor":
            if resource_id == "bsfl_biomass":
                return {
                    "field": "larval_biomass",
                    "capacity": float(process.get("maximum_larval_biomass_lb", 0.0)),
                    "unit": "lb",
                    "integer_only": False,
                }
            if resource_id == "kitchen_waste":
                return {
                    "field": "feedstock_mass",
                    "capacity": float(container.get("usable_capacity_lb", 0.0)),
                    "unit": "lb",
                    "integer_only": False,
                }

        if facility_id == "compost-pile":
            rule = (definition.get("inputs") or {}).get(resource_id) or {}
            if rule.get("mode") == "shared_feedstock":
                return {
                    "field": "raw_material_mass",
                    "capacity": float(container.get("capacity", 0.0)),
                    "unit": "lb",
                    "integer_only": False,
                }

        raise ValueError("That material cannot be added to this facility.")

    def _pending_fill_for_field(self, instance_id, field):
        total = 0.0
        for event in self.game_state.get("pending_events", []):
            if (
                event.get("type") == "facility_fill"
                and event.get("instance_id") == instance_id
                and event.get("target_field") == field
            ):
                total += float(event.get("amount", 0.0))
        return total

    def fill_facility(self, instance_id, resource_id, amount):
        """Stage material/organisms for addition at the next full tick.

        Inventory is reserved immediately, while the actual facility state change
        is journaled in pending_events and applied after the current hour's full
        processing pass. This prevents a sub-tick addition from being treated as
        though it had been present for the entire preceding hour.
        """
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
            raise ValueError("Chickens must be added in whole birds.")

        available = self._player_inventory_amount(resource_id)
        if amount > available + 1e-9:
            raise ValueError(
                f"The Homesteader is not carrying enough "
                f"{resource_id.replace('_', ' ')}. Available: {available:g}."
            )

        current = max(0.0, float(instance.get(spec["field"], 0.0)))
        pending = self._pending_fill_for_field(instance_id, spec["field"])
        capacity = max(0.0, float(spec["capacity"]))
        remaining = max(0.0, capacity - current - pending)

        if amount > remaining + 1e-9:
            raise ValueError(
                f"That exceeds the remaining capacity ({remaining:g} {spec['unit']})."
            )

        used = self._consume_player_inventory(resource_id, amount)
        if used + 1e-9 < amount:
            raise ValueError("Carried inventory changed before the transfer could be reserved.")

        event = self._append_pending_event({
            "type": "facility_fill",
            "instance_id": instance_id,
            "facility_id": instance.get("facility_id"),
            "resource_id": resource_id,
            "amount": amount,
            "target_field": spec["field"],
            "unit": spec["unit"],
            "effective": "next_full_tick",
        })
        self.save()
        return deepcopy(event)

    def _apply_pending_facility_fills(self, events):
        applied = []
        for event in events:
            if event.get("type") != "facility_fill":
                continue

            instance = self._find_facility_instance(event.get("instance_id"))
            field = event.get("target_field")
            amount = max(0.0, float(event.get("amount", 0.0)))
            if not field or amount <= 0:
                continue

            instance[field] = max(0.0, float(instance.get(field, 0.0))) + amount
            applied.append(deepcopy(event))

        return applied

    # ------------------------------------------------------------------
    # Player inventory transfers
    # ------------------------------------------------------------------

    def _player_inventory_amount(self, resource_id):
        player = self.game_state["player"]
        inventory = player.setdefault("inventory", {})
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
        inventory[resource_id] = available - used
        return used

    def transfer_player_inventory(self, resource_id, amount, direction):
        """Move a resource between household stores and the Homesteader.

        This is an immediate inventory transfer. It does not run facility
        processing and therefore does not require the hourly event journal.
        Carry-capacity rules can be layered onto this method later without
        changing the browser/API contract.
        """
        if not isinstance(resource_id, str) or not resource_id:
            raise ValueError("A resource must be selected.")

        try:
            amount = float(amount)
        except (TypeError, ValueError) as exc:
            raise ValueError("Transfer amount must be numeric.") from exc

        if amount <= 0:
            raise ValueError("Transfer amount must be greater than zero.")

        if resource_id == "chicken" and not amount.is_integer():
            raise ValueError("Chickens must be transferred in whole birds.")

        if direction == "to_player":
            available = self._inventory_amount(resource_id)
            if amount > available + 1e-9:
                raise ValueError(
                    f"Not enough {resource_id.replace('_', ' ')} in household inventory. "
                    f"Available: {available:g}."
                )
            used = self._consume_inventory(resource_id, amount)
            self._add_player_inventory(resource_id, used)

        elif direction == "to_household":
            available = self._player_inventory_amount(resource_id)
            if amount > available + 1e-9:
                raise ValueError(
                    f"The Homesteader is not carrying enough "
                    f"{resource_id.replace('_', ' ')}. Available: {available:g}."
                )
            used = self._consume_player_inventory(resource_id, amount)
            self._add_inventory(resource_id, used)

        else:
            raise ValueError("Transfer direction must be to_player or to_household.")

        event = self._append_pending_event({
            "type": "inventory_transfer",
            "resource_id": resource_id,
            "amount": amount,
            "direction": direction,
            "effective": "immediate",
        })
        self.save()
        return deepcopy(event)

    def pickup_house_output(self, resource_id, amount):
        """Move a recoverable household waste stream into player inventory."""
        if resource_id not in {"kitchen_waste", "paper_waste"}:
            raise ValueError("That resource is not available from a house pickup point.")

        try:
            amount = float(amount)
        except (TypeError, ValueError) as exc:
            raise ValueError("Pickup amount must be numeric.") from exc

        if amount <= 0:
            raise ValueError("Pickup amount must be greater than zero.")

        outputs = self.game_state.setdefault("house", {}).setdefault("outputs", {})
        available = float(outputs.get(resource_id, 0.0))
        if amount > available + 1e-9:
            raise ValueError(
                f"Not enough {resource_id.replace('_', ' ')} at the house pickup point. "
                f"Available: {available:g}."
            )

        outputs[resource_id] = max(0.0, available - amount)
        self._add_player_inventory(resource_id, amount)
        event = self._append_pending_event({
            "type": "house_pickup",
            "resource_id": resource_id,
            "amount": amount,
            "effective": "immediate",
        })
        self.save()
        return deepcopy(event)

    # ------------------------------------------------------------------
    # Player movement and sub-ticks
    # ------------------------------------------------------------------

    def start_walk(self, column, row):
        if not isinstance(column, (int, float)) or not isinstance(row, (int, float)):
            raise ValueError("Walk destination must use numeric map coordinates.")

        map_state = self.game_state["map"]
        max_column = int(map_state["width_tiles"]) - 1
        max_row = int(map_state["height_tiles"]) - 1
        target_column = float(column)
        target_row = float(row)

        if not (0 <= target_column <= max_column and 0 <= target_row <= max_row):
            raise ValueError("Walk destination is outside the map.")

        player = self.game_state["player"]
        position = player["position"]
        dx = target_column - float(position.get("column", 0.0))
        dy = target_row - float(position.get("row", 0.0))

        if abs(dx) < 1e-9 and abs(dy) < 1e-9:
            player["current_task"] = None
            self.save()
            return deepcopy(player)

        direction = self._movement_direction(dx, dy)
        player["current_task"] = {
            "type": "walk",
            "status": "active",
            "target": {"column": target_column, "row": target_row},
            "direction": direction,
            "started_at": deepcopy(self.game_state["time"]),
        }
        player["last_direction"] = direction
        self.save()
        return deepcopy(player)

    @staticmethod
    def _movement_direction(dx, dy):
        if abs(dx) >= abs(dy):
            return "right" if dx >= 0 else "left"
        return "down" if dy >= 0 else "up"

    def _advance_player_one_minute(self):
        player = self.game_state["player"]
        task = player.get("current_task")
        if not task or task.get("type") != "walk":
            return {"status": "idle", "completed": False}

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
        tiles_per_minute = (
            WALKING_SPEED_FT_PER_MINUTE / tile_size_ft
            if tile_size_ft > 0
            else distance_tiles
        )

        direction = self._movement_direction(dx, dy) if distance_tiles > 0 else player.get("last_direction", "down")
        task["direction"] = direction
        player["last_direction"] = direction

        if distance_tiles <= tiles_per_minute or distance_tiles <= 1e-9:
            position["column"] = target_column
            position["row"] = target_row
            player["current_task"] = None
            return {
                "status": "completed",
                "completed": True,
                "type": "walk",
                "target": deepcopy(target),
                "direction": direction,
            }

        fraction = tiles_per_minute / distance_tiles
        position["column"] = current_column + dx * fraction
        position["row"] = current_row + dy * fraction
        return {
            "status": "walking",
            "completed": False,
            "type": "walk",
            "target": deepcopy(target),
            "direction": direction,
        }

    def _append_pending_event(self, event):
        stamped = {
            **deepcopy(event),
            "time": deepcopy(self.game_state["time"]),
        }
        self.game_state["pending_events"].append(stamped)
        return stamped

    def advance_subtick(self):
        """Advance one simulated minute.

        Player/task state is updated every sub-tick. Facility and household
        processing remains hourly and runs only when the minute counter wraps
        from 59 to 00.
        """
        started_at = deepcopy(self.game_state["time"])
        movement = self._advance_player_one_minute()

        time_state = self.game_state["time"]
        time_state["minute"] = int(time_state.get("minute", 0)) + 1
        full_tick_due = time_state["minute"] >= MINUTES_PER_HOUR

        if movement.get("completed"):
            self._append_pending_event({
                "type": "walk_completed",
                "target": deepcopy(movement.get("target", {})),
            })

        full_tick_result = None
        if full_tick_due:
            time_state["minute"] = 0
            full_tick_result = self.advance_hour()
        elif movement.get("completed"):
            # Important player events are persisted immediately even though
            # the expensive world simulation waits for the hour boundary.
            self.save()

        return {
            "subtick_started_at": started_at,
            "movement": movement,
            "full_tick": full_tick_result is not None,
            "full_tick_result": full_tick_result,
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

        # Sub-tick facility fills become effective only after the just-finished
        # hour has been processed. This prevents retroactive full-hour output.
        applied_fills = self._apply_pending_facility_fills(pending_events)
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
        flows.setdefault("tap_water_demand_this_tick_gal", 0.0)
        flows.setdefault("greywater_generated_this_tick_gal", 0.0)
        flows.setdefault("blackwater_generated_this_tick_gal", 0.0)
        flows.setdefault("other_water_use_this_tick_gal", 0.0)
        flows.setdefault("kitchen_waste_generated_this_tick_lb", 0.0)
        flows.setdefault("paper_waste_generated_this_tick_lb", 0.0)
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

        # Recoverable household waste appears physically at the house pickup
        # points. Separation/collection is abstracted; the Homesteader must
        # carry it from the house to a processor. Recalcitrant waste has no
        # productive use and is abstracted as curbside garbage.
        kitchen_waste = max(
            0.0,
            float(household_flows.get("kitchen_waste_lb", 0.0)),
        )
        paper_waste = max(
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
        house_outputs["paper_waste"] = (
            float(house_outputs.get("paper_waste", 0.0)) + paper_waste
        )
        flows["paper_waste_generated_this_tick_lb"] = paper_waste
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
                "paper_waste_lb": round(paper_waste, 6),
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

        # Self-harvested larvae leave the reactor immediately as the ordinary
        # insect_forage resource.  Residue remains inside until a later
        # collection/emptying action is implemented.
        self._add_inventory("insect_forage", harvested)

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
            "new_residue": round(new_residue, 6),
            "untracked_loss": round(untracked_loss, 6),
            "nominal_untracked_loss": round(nominal_untracked_loss, 6),
            "self_harvested_insect_forage": round(self_harvest, 6),
            "capacity_overflow_harvest": round(overflow_harvest, 6),
            "harvested_insect_forage": round(harvested, 6),
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
