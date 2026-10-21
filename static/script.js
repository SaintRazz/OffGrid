"use strict";

const landGrid = document.getElementById("land-grid");

if (landGrid) {
  const GRID_SIZE = 42;
  const GAME_PULSE_MS = 1000;
  const WALKING_SPEED_TILES_PER_MINUTE = 264 / 5;
  const MIN_ZOOM = 1;
  const MAX_ZOOM = 4;
  const ZOOM_STEP = 0.25;
  const DRAG_THRESHOLD_PX = 5;

  const buildList = document.getElementById("build-list");
  const cancelButton = document.getElementById("cancel-building");
  const statusLine = document.getElementById("placement-status");
  const currentGameName = document.getElementById("current-game-name");
  const runtimeStatus = document.querySelector(".runtime-status");
  const runtimeLabel = document.getElementById("runtime-label");
  const gameSpeedSelect = document.getElementById("game-speed-select");
  const nextDayButton = document.getElementById("next-day-button");
  const orderButton = document.getElementById("order-button");

  const startupOverlay = document.getElementById("startup-overlay");
  const startupMainActions = document.getElementById("startup-main-actions");
  const newGameButton = document.getElementById("new-game-button");
  const loadGameButton = document.getElementById("load-game-button");
  const loadGamePanel = document.getElementById("load-game-panel");
  const saveGameList = document.getElementById("save-game-list");
  const backToStartButton = document.getElementById("back-to-start-button");
  const startupStatus = document.getElementById("startup-status");

  const inspectorOverlay = document.getElementById("object-inspector-overlay");
  const inspectorTitle = document.getElementById("object-inspector-title");
  const inspectorSubtitle = document.getElementById("object-inspector-subtitle");
  const inspectorContent = document.getElementById("object-inspector-content");
  const inspectorCloseButton = document.getElementById("object-inspector-close");
  const walkHereButton = document.getElementById("walk-here-button");
  const manageContentsButton = document.getElementById("manage-contents-button");
  const serviceFacilityButton = document.getElementById("service-facility-button");

  const playerInventoryList = document.getElementById("player-inventory-list");
  const currentTaskCard = document.getElementById("current-task-card");
  const taskQueueList = document.getElementById("task-queue-list");
  const biologicalResourceList = document.getElementById("biological-resource-list");
  const yardResourceList = document.getElementById("yard-resource-list");
  const utilityResourceList = document.getElementById("utility-resource-list");

  const mapViewport = document.getElementById("map-viewport");
  const zoomInButton = document.getElementById("zoom-in");
  const zoomOutButton = document.getElementById("zoom-out");
  const zoomResetButton = document.getElementById("zoom-reset");
  const zoomLevel = document.getElementById("zoom-level");
  const infoTabs = document.querySelectorAll(".info-tab");
  const infoPanels = document.querySelectorAll(".info-panel");

  const definitionsById = new Map();
  let placements = [];
  let simulationState = null;
  let selectedBuildId = null;
  let selectedMapObject = null;
  let inspectorMode = "summary";
  let preview = null;
  let avatar = null;
  let avatarTooltip = null;
  let mapZoom = 1;
  let mapPanX = 0;
  let mapPanY = 0;
  let mapPointerDown = false;
  let mapPointerId = null;
  let mapDragStarted = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragStartPanX = 0;
  let dragStartPanY = 0;
  let suppressNextMapClick = false;
  let runtimeTimer = null;
  let advanceInFlight = false;
  let gameLoaded = false;
  let interactionOpen = false;
  let inspectorPausedRuntime = false;

  for (let row = 0; row < GRID_SIZE; row += 1) {
    for (let column = 0; column < GRID_SIZE; column += 1) {
      const cell = document.createElement("div");
      cell.className = "grid-cell";
      cell.dataset.row = String(row);
      cell.dataset.column = String(column);
      cell.style.gridRow = String(row + 1);
      cell.style.gridColumn = String(column + 1);
      cell.setAttribute("role", "gridcell");
      cell.setAttribute("aria-label", `Grass tile, row ${row + 1}, column ${column + 1}`);
      landGrid.appendChild(cell);
    }
  }

  function formatAmount(value, digits = 4) {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }).format(Number(value ?? 0));
  }

  function prettyName(value) {
    return String(value ?? "").replaceAll("_", " ").replaceAll("-", " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function resourceDefinition(id) { return simulationState?.resource_definitions?.[id] ?? null; }
  function resourceLabel(id) { return resourceDefinition(id)?.name ?? prettyName(id); }
  function resourceUnit(id) { return resourceDefinition(id)?.unit ?? (id === "chicken" ? "bird" : "lb"); }
  function isDiscrete(id) { return resourceDefinition(id)?.quantity_mode === "discrete"; }

  function addListItem(list, label, value) {
    const item = document.createElement("li");
    item.textContent = `${label}: ${value}`;
    list.appendChild(item);
  }

  async function api(url, options = {}) {
    const response = await fetch(url, {
      headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
      ...options,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `${response.status} ${response.statusText}`);
    return data;
  }

  function currentSpeedMinutes() {
    const value = Number(gameSpeedSelect?.value ?? 1);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
  }

  function speedLabel(minutes) {
    if (minutes === 1) return "1 sim min / real sec";
    if (minutes === 30) return "30 sim min / real sec";
    if (minutes === 60) return "1 sim hour / real sec";
    if (minutes === 1440) return "1 sim day / real sec";
    return `${minutes} sim min / real sec`;
  }

  function setRuntimeRunning(running, label = null) {
    runtimeStatus?.classList.toggle("is-running", running);
    if (runtimeLabel) runtimeLabel.textContent = label ?? (running ? "Running" : "Paused");
  }

  function startRuntime() {
    if (runtimeTimer !== null || interactionOpen || !gameLoaded) return;
    setRuntimeRunning(true, `Running · ${speedLabel(currentSpeedMinutes())}`);
    runtimeTimer = window.setInterval(runGamePulse, GAME_PULSE_MS);
  }

  function stopRuntime(label = "Paused") {
    if (runtimeTimer !== null) {
      clearInterval(runtimeTimer);
      runtimeTimer = null;
    }
    setRuntimeRunning(false, label);
  }

  async function advanceSimulation(minutes, message = null) {
    if (!gameLoaded || advanceInFlight || interactionOpen) return null;
    advanceInFlight = true;
    if (nextDayButton) nextDayButton.disabled = true;
    try {
      const result = await api("/api/advance", { method: "POST", body: JSON.stringify({ minutes }) });
      renderState(result.state, result.activity ?? result.movement ?? null);
      if (message) statusLine.textContent = message;
      return result;
    } catch (error) {
      stopRuntime("Stopped");
      statusLine.textContent = `Automatic time stopped: ${error.message}`;
      return null;
    } finally {
      advanceInFlight = false;
      if (nextDayButton) nextDayButton.disabled = false;
    }
  }

  async function runGamePulse() { await advanceSimulation(currentSpeedMinutes()); }

  function setDateAndClock(state) {
    const dateElement = document.getElementById("simulation-date");
    const clockElement = document.getElementById("simulation-clock");
    if (!state?.current_time) {
      dateElement.textContent = "Not started";
      clockElement.textContent = "--:--";
      return;
    }
    const date = new Date(state.current_time);
    dateElement.textContent = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" }).format(date);
    clockElement.textContent = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
  }

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function clampMapPan(x = mapPanX, y = mapPanY, zoom = mapZoom) {
    return {
      x: clamp(x, Math.min(0, mapViewport.clientWidth - landGrid.offsetWidth * zoom), 0),
      y: clamp(y, Math.min(0, mapViewport.clientHeight - landGrid.offsetHeight * zoom), 0),
    };
  }

  function renderMapTransform() {
    const p = clampMapPan();
    mapPanX = p.x;
    mapPanY = p.y;

    const isDefaultView =
      mapZoom === 1 &&
      mapPanX === 0 &&
      mapPanY === 0;

    if (isDefaultView) {
      landGrid.style.transform = "none";
    } else {
      landGrid.style.transform =
        `translate(${mapPanX}px, ${mapPanY}px) scale(${mapZoom})`;
    }

    zoomLevel.textContent = `${Math.round(mapZoom * 100)}%`;
    mapViewport.classList.toggle("is-zoomed", mapZoom > 1);
    zoomOutButton.disabled = mapZoom <= MIN_ZOOM;
    zoomInButton.disabled = mapZoom >= MAX_ZOOM;
  }

  function setMapZoom(requested, clientX = null, clientY = null) {
    const next = clamp(requested, MIN_ZOOM, MAX_ZOOM);
    if (next === mapZoom) return;

    const rect = mapViewport.getBoundingClientRect();
    const fx = clientX == null ? rect.width / 2 : clientX - rect.left;
    const fy = clientY == null ? rect.height / 2 : clientY - rect.top;
    const mx = (fx - mapPanX) / mapZoom;
    const my = (fy - mapPanY) / mapZoom;

    mapPanX = fx - mx * next;
    mapPanY = fy - my * next;
    mapZoom = next;
    renderMapTransform();
  }

  function resetMapView() {
    mapZoom = 1;
    mapPanX = 0;
    mapPanY = 0;
    renderMapTransform();
  }

  zoomInButton.addEventListener("click", () => setMapZoom(mapZoom + ZOOM_STEP));
  zoomOutButton.addEventListener("click", () => setMapZoom(mapZoom - ZOOM_STEP));
  zoomResetButton.addEventListener("click", resetMapView);
  window.addEventListener("resize", renderMapTransform);

  mapViewport.addEventListener("wheel", (event) => {
    event.preventDefault();
    setMapZoom(
      mapZoom + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP),
      event.clientX,
      event.clientY
    );
  }, { passive: false });

  mapViewport.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || selectedBuildId || mapZoom <= 1) return;

    mapPointerDown = true;
    mapPointerId = event.pointerId;
    mapDragStarted = false;
    dragStartX = event.clientX;
    dragStartY = event.clientY;
    dragStartPanX = mapPanX;
    dragStartPanY = mapPanY;
  });

  mapViewport.addEventListener("pointermove", (event) => {
    if (!mapPointerDown || event.pointerId !== mapPointerId) return;

    const dx = event.clientX - dragStartX;
    const dy = event.clientY - dragStartY;

    if (!mapDragStarted) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;

      mapDragStarted = true;
      mapViewport.setPointerCapture(event.pointerId);
      mapViewport.classList.add("is-dragging");

      clearMapSelection();
      closeInspector();
    }

    event.preventDefault();

    const p = clampMapPan(
      dragStartPanX + dx,
      dragStartPanY + dy
    );

    mapPanX = p.x;
    mapPanY = p.y;
    renderMapTransform();
  });

  function finishMapDrag(event) {
    if (!mapPointerDown || event.pointerId !== mapPointerId) return;

    if (mapDragStarted) suppressNextMapClick = true;

    mapPointerDown = false;
    mapPointerId = null;
    mapViewport.classList.remove("is-dragging");

    if (
      mapDragStarted &&
      mapViewport.hasPointerCapture(event.pointerId)
    ) {
      mapViewport.releasePointerCapture(event.pointerId);
    }

    mapDragStarted = false;
  }

  mapViewport.addEventListener("pointerup", finishMapDrag);
  mapViewport.addEventListener("pointercancel", finishMapDrag);

  function mapCoordinatesFromClient(clientX, clientY) {
    const rect = landGrid.getBoundingClientRect();

    return {
      column: clamp(
        Math.floor(
          (clientX - rect.left) /
          (rect.width / GRID_SIZE)
        ),
        0,
        GRID_SIZE - 1
      ),
      row: clamp(
        Math.floor(
          (clientY - rect.top) /
          (rect.height / GRID_SIZE)
        ),
        0,
        GRID_SIZE - 1
      ),
    };
  }

  function reservedHouseZones() {
    const house = simulationState?.house ?? {};
    const zones = [];

    for (const point of Object.values(house.pickup_points ?? {})) {
      zones.push({
        column: Math.floor(Number(point.column)),
        row: Math.floor(Number(point.row)),
        width: Math.max(1, Number(point.width ?? 1)),
        height: Math.max(1, Number(point.height ?? 1)),
      });
    }

    if (house.storage_point) {
      zones.push({
        column: Math.floor(Number(house.storage_point.column)),
        row: Math.floor(Number(house.storage_point.row)),
        width: Math.max(1, Number(house.storage_point.width ?? 2)),
        height: Math.max(1, Number(house.storage_point.height ?? 2)),
      });
    }

    return zones;
  }

  function rectanglesOverlap(a, b) {
    return !(
      a.column + a.width <= b.column ||
      b.column + b.width <= a.column ||
      a.row + a.height <= b.row ||
      b.row + b.height <= a.row
    );
  }

  function canPlace(column, row, width, height) {
    const candidate = { column, row, width, height };

    if (
      column < 0 ||
      row < 0 ||
      column + width > GRID_SIZE ||
      row + height > GRID_SIZE
    ) {
      return false;
    }

    if (
      reservedHouseZones().some(
        (z) => rectanglesOverlap(candidate, z)
      )
    ) {
      return false;
    }

    return placements.every(
      (p) => !rectanglesOverlap(candidate, p)
    );
  }

  function removePreview() {
    preview?.remove();
    preview = null;
  }

  function showPreview(column, row) {
    removePreview();

    const def = definitionsById.get(selectedBuildId);
    if (!def) return;

    preview = document.createElement("img");
    preview.className = "building-sprite building-preview";
    preview.src = `/static/assets/sprites/${def.image}`;
    preview.alt = "";
    preview.style.gridColumn = `${column + 1} / span ${def.width}`;
    preview.style.gridRow = `${row + 1} / span ${def.height}`;

    preview.classList.add(
      canPlace(column, row, def.width, def.height)
        ? "is-valid"
        : "is-invalid"
    );

    landGrid.appendChild(preview);
  }

  function syncPlacementUi() {
    cancelButton.disabled = !selectedBuildId;

    buildList
      .querySelectorAll(".build-option")
      .forEach((b) =>
        b.setAttribute(
          "aria-pressed",
          b.dataset.facilityId === selectedBuildId
            ? "true"
            : "false"
        )
      );
  }

  function selectBuild(id) {
    selectedBuildId = id;
    closeInspector();
    clearMapSelection();
    syncPlacementUi();

    statusLine.textContent =
      `Place ${definitionsById.get(id)?.name ?? id} on the map.`;
  }

  function cancelPlacement({ silent = false } = {}) {
    selectedBuildId = null;
    removePreview();
    syncPlacementUi();

    if (!silent && gameLoaded) {
      statusLine.textContent =
        "Select a tile or facility to interact.";
    }
  }

  cancelButton.addEventListener(
    "click",
    () => cancelPlacement()
  );

  async function placeSelectedFacility(column, row) {
    const def = definitionsById.get(selectedBuildId);

    if (
      !def ||
      !canPlace(
        column,
        row,
        def.width,
        def.height
      )
    ) {
      statusLine.textContent =
        "That structure cannot be placed there.";
      return;
    }

    try {
      const result = await api(
        "/api/facilities",
        {
          method: "POST",
          body: JSON.stringify({
            facility_id: selectedBuildId,
            column,
            row,
          }),
        }
      );

      renderState(result.state);
      cancelPlacement();
      statusLine.textContent =
        `${def.name} placed.`;
    } catch (error) {
      statusLine.textContent = error.message;
    }
  }

  function renderBuildList() {
    buildList.replaceChildren();

    const defaultTile =
      simulationState?.map?.default_tile;

    for (
      const def
      of simulationState?.facility_definitions ?? []
    ) {
      definitionsById.set(def.id, def);

      if (def.id === defaultTile) {
        continue;
      }

      const button =
        document.createElement("button");

      button.type = "button";
      button.className = "build-option";
      button.dataset.facilityId = def.id;

      const image =
        document.createElement("img");

      image.src =
        `/static/assets/sprites/${def.image}`;
      image.alt = "";

      const text =
        document.createElement("span");

      const name =
        document.createElement("strong");

      name.textContent = def.name;

      const size =
        document.createElement("small");

      size.textContent =
        `${def.width} × ${def.height} tiles`;

      text.append(name, size);
      button.append(image, text);

      button.addEventListener(
        "click",
        () => selectBuild(def.id)
      );

      buildList.appendChild(button);
    }

    syncPlacementUi();
  }

  function clearMapSelection() {
    landGrid
      .querySelectorAll(".is-map-selected")
      .forEach((e) =>
        e.classList.remove("is-map-selected")
      );
  }

  function facilityAt(column, row) {
    return (
      placements.find(
        (i) =>
          column >= i.column &&
          column < i.column + i.width &&
          row >= i.row &&
          row < i.row + i.height
      ) ??
      null
    );
  }

  function markMapSelection(
    column,
    row,
    instance
  ) {
    clearMapSelection();

    if (instance) {
      landGrid
        .querySelector(
          `[data-instance-id="${
            CSS.escape(instance.instance_id)
          }"]`
        )
        ?.classList.add("is-map-selected");
    } else {
      landGrid
        .querySelector(
          `.grid-cell[data-column="${column}"][data-row="${row}"]`
        )
        ?.classList.add("is-map-selected");
    }
  }

  function beginInteractionPause() {
    interactionOpen = true;
    inspectorPausedRuntime =
      runtimeTimer !== null;

    if (inspectorPausedRuntime) {
      stopRuntime(
        "Paused for interaction"
      );
    }
  }

  function closeInspector({ resume = true } = {}) {
    const shouldResume =
      resume &&
      inspectorPausedRuntime &&
      gameLoaded;

    inspectorOverlay.hidden = true;
    selectedMapObject = null;
    inspectorMode = "summary";
    interactionOpen = false;
    inspectorPausedRuntime = false;

    if (shouldResume) {
      startRuntime();
    }
  }

  function compostStatus(instance) {
    const f =
      Number(instance.feedstock_mass ?? 0);

    const a =
      Number(instance.active_compost_mass ?? 0);

    const m =
      Number(instance.mature_compost_mass ?? 0);

    const total = f + a + m;

    const pending =
      Number(
        instance.unbalanced_kitchen_waste ?? 0
      ) +
      Number(
        instance.unbalanced_scat ?? 0
      ) +
      Number(
        instance.available_carbon_material ?? 0
      );

    if (total <= 1e-9) {
      return pending > 1e-9
        ? "Fresh compost inputs awaiting balancing and mixing"
        : "Empty compost pile";
    }

    if (
      m / total >= 0.70 &&
      f / total <= 0.10
    ) {
      return "Composted material ready for use as soil amendment";
    }

    if (f >= a) {
      return "Organic waste rapidly decomposing";
    }

    return "Active composting and curing";
  }

  function compostCarbonNeed(
    instance,
    definition
  ) {
    const inputs =
      definition?.inputs ?? {};

    const demand =
      Number(
        instance.unbalanced_kitchen_waste ?? 0
      ) *
        Number(
          inputs.kitchen_waste
            ?.carbon_demand_lb_per_lb ??
          0.5
        ) +
      Number(
        instance.unbalanced_scat ?? 0
      ) *
        Number(
          inputs.scat
            ?.carbon_demand_lb_per_lb ??
          1.5
        );

    const carbon =
      Number(
        instance.available_carbon_material ?? 0
      );

    return {
      demand,
      carbon,
      needed:
        Math.max(0, demand - carbon),
    };
  }

  function compostTotalMass(instance) {
    return [
      "unbalanced_kitchen_waste",
      "unbalanced_scat",
      "available_carbon_material",
      "feedstock_mass",
      "active_compost_mass",
      "mature_compost_mass",
    ].reduce(
      (sum, key) =>
        sum +
        Number(instance[key] ?? 0),
      0
    );
  }

  function renderSelectionSummary(selection) {
    inspectorContent.replaceChildren();

    const dl =
      document.createElement("dl");

    dl.className = "selection-summary";

    let rows = [];

    if (selection.kind === "house") {
      const h =
        simulationState?.house ?? {};

      rows = [
        [
          "Type",
          "Household waste pickup",
        ],
        [
          "Kitchen waste ready",
          `${formatAmount(
            h.outputs?.kitchen_waste ?? 0
          )} lb`,
        ],
        [
          "Household paper browns ready",
          `${formatAmount(
            h.outputs
              ?.carbonaceous_plant_waste ??
            0
          )} lb`,
        ],
      ];
    } else if (
      selection.kind === "house_storage"
    ) {
      rows = [
        [
          "Type",
          "House delivery / storage point",
        ],
        [
          "Stored resource types",
          String(
            Object.values(
              simulationState?.house
                ?.storage ??
              {}
            ).filter(
              (v) => Number(v) > 1e-9
            ).length
          ),
        ],
      ];
    } else {
      rows = [
        [
          "Tile",
          `(${selection.column + 1}, ${selection.row + 1})`,
        ],
        [
          "Type",
          selection.instance
            ? "Facility"
            : "Grass tile",
        ],
      ];

      const i =
        selection.instance;

      if (i) {
        rows.push(
          [
            "Condition",
            `${formatAmount(
              (i.condition ?? 1) * 100,
              1
            )}%`,
          ],
          [
            "Accrued labor",
            `${formatAmount(
              i.accrued_labor_requirement ??
              0,
              3
            )} h`,
          ]
        );

        if (i.current_fill != null) {
          rows.push([
            "Current fill",
            formatAmount(i.current_fill),
          ]);
        }

        if (i.feed_mass != null) {
          rows.push([
            "Chicken feed",
            `${formatAmount(
              i.feed_mass
            )} lb`,
          ]);
        }

        if (
          i.facility_id ===
          "chicken-coop"
        ) {
          rows.push(
            [
              "Eggs in coop",
              `${formatAmount(
                i.stored_outputs?.eggs ??
                0,
                0
              )} eggs`,
            ],
            [
              "Egg production progress",
              `${formatAmount(
                i.production_remainders
                  ?.eggs ??
                0,
                3
              )} toward next egg`,
            ]
          );
        }

        if (
          i.facility_id ===
          "bsfl-reactor"
        ) {
          rows.push(
            [
              "Feedstock",
              `${formatAmount(
                i.feedstock_mass ?? 0
              )} lb`,
            ],
            [
              "Larval biomass",
              `${formatAmount(
                i.larval_biomass ?? 0
              )} lb`,
            ],
            [
              "BSFL pre-compost",
              `${formatAmount(
                i.residue_mass ?? 0
              )} lb`,
            ],
            [
              "Harvest catchment",
              `${formatAmount(
                i.stored_outputs
                  ?.insect_forage ??
                0
              )} lb`,
            ]
          );
        }

        if (
          i.facility_id ===
          "compost-pile"
        ) {
          const cap =
            Number(
              selection.definition
                ?.container
                ?.capacity ??
              0
            );

          const total =
            compostTotalMass(i);

          const c =
            compostCarbonNeed(
              i,
              selection.definition
            );

          rows.push(
            [
              "State",
              compostStatus(i),
            ],
            [
              "Pile mass",
              `${formatAmount(
                total
              )} / ${formatAmount(
                cap
              )} lb`,
            ],
            [
              "Fresh kitchen waste",
              `${formatAmount(
                i.unbalanced_kitchen_waste ??
                0
              )} lb`,
            ],
            [
              "Fresh scat",
              `${formatAmount(
                i.unbalanced_scat ??
                0
              )} lb`,
            ],
            [
              "Carbon-rich material",
              `${formatAmount(
                i.available_carbon_material ??
                0
              )} lb`,
            ],
            [
              "Feedstock",
              `${formatAmount(
                i.feedstock_mass ?? 0
              )} lb`,
            ],
            [
              "Active compost",
              `${formatAmount(
                i.active_compost_mass ??
                0
              )} lb`,
            ],
            [
              "Mature amendment",
              `${formatAmount(
                i.mature_compost_mass ??
                0
              )} lb`,
            ],
            [
              "Carbon balance",
              c.needed > 1e-6
                ? `Needs about ${formatAmount(
                    c.needed,
                    2
                  )} lb browns`
                : "Good",
            ]
          );
        }
      }
    }

    for (const [label, value] of rows) {
      const dt =
        document.createElement("dt");

      const dd =
        document.createElement("dd");

      dt.textContent = label;
      dd.textContent = value;

      dl.append(dt, dd);
    }

    inspectorContent.appendChild(dl);
  }

  function openSelection(column, row) {
    beginInteractionPause();
    inspectorMode = "summary";

    const instance =
      facilityAt(column, row);

    const def =
      instance
        ? definitionsById.get(
            instance.facility_id
          )
        : definitionsById.get(
            simulationState?.map
              ?.default_tile
          );

    selectedMapObject = {
      kind: "map",
      column,
      row,
      instance,
      definition: def,
    };

    markMapSelection(
      column,
      row,
      instance
    );

    inspectorTitle.textContent =
      def?.name ??
      (
        instance
          ? "Facility"
          : "Grass Tile"
      );

    inspectorSubtitle.textContent =
      instance
        ? `Facility instance ${instance.instance_id}`
        : `Map tile ${column + 1}, ${row + 1}`;

    renderSelectionSummary(
      selectedMapObject
    );

    manageContentsButton.disabled =
      !instance;

    serviceFacilityButton.disabled =
      !instance ||
      Number(
        instance.accrued_labor_requirement ??
        0
      ) <=
        1e-9;

    inspectorOverlay.hidden =
      false;
  }

  function openHouseSelection(
    resourceId = null
  ) {
    const house =
      simulationState?.house;

    if (!house) return;

    beginInteractionPause();

    const p =
      house.entrance ??
      {
        column: 14.5,
        row: 40,
      };

    selectedMapObject = {
      kind: "house",
      column: Number(p.column),
      row: Number(p.row),
      house,
      focusResourceId: resourceId,
    };

    inspectorTitle.textContent =
      "House";

    inspectorSubtitle.textContent =
      "Household waste pickup";

    inspectorMode =
      resourceId
        ? "contents"
        : "summary";

    if (
      inspectorMode ===
      "contents"
    ) {
      renderHouseContentsManager(
        resourceId
      );
    } else {
      renderSelectionSummary(
        selectedMapObject
      );
    }

    manageContentsButton.disabled =
      false;

    serviceFacilityButton.disabled =
      true;

    inspectorOverlay.hidden =
      false;
  }

  function openHouseStorage(
    mode = "storage"
  ) {
    const house =
      simulationState?.house;

    if (!house) return;

    beginInteractionPause();

    const p =
      house.storage_point ??
      {
        column: 20,
        row: 40,
      };

    selectedMapObject = {
      kind: "house_storage",
      column: Number(p.column),
      row: Number(p.row),
      house,
    };

    inspectorTitle.textContent =
      mode === "order"
        ? "Order Supplies"
        : "House Storage";

    inspectorSubtitle.textContent =
      mode === "order"
        ? "Instant delivery to House Storage"
        : "Household delivery and drop-off point";

    inspectorMode = mode;

    if (mode === "order") {
      renderOrderInterface();
    } else {
      renderHouseStorageManager();
    }

    manageContentsButton.disabled =
      false;

    serviceFacilityButton.disabled =
      true;

    inspectorOverlay.hidden =
      false;
  }

  function queuedFillAmount(
    instanceId,
    field
  ) {
    return (
      simulationState?.player
        ?.task_queue ??
      []
    )
      .filter(
        (t) =>
          t.type ===
            "facility_fill" &&
          t.target_instance_id ===
            instanceId &&
          t.target_field ===
            field
      )
      .reduce(
        (s, t) =>
          s +
          Number(t.amount ?? 0),
        0
      );
  }

  // HTML max validates on submit; clamp while editing as well.
  function capTransferInput(input, maximum, discrete = false) {
    const limit = Math.max(0, discrete ? Math.floor(maximum) : maximum);
    input.max = String(limit);
    input.step = discrete ? "1" : "any";
    input.disabled = limit <= 0;
    const clamp = () => {
      if (input.value === "") return;
      const value = Number(input.value);
      input.value = String(Number.isFinite(value)
        ? Math.min(limit, Math.max(0, discrete ? Math.floor(value) : value))
        : 0);
    };
    input.addEventListener("input", clamp);
    input.addEventListener("change", clamp);
    clamp();
    return limit;
  }

  function appendTransferAll(form, input, text) {
    const all = document.createElement("button");
    all.type = "button";
    all.className = "interaction-button";
    all.textContent = text;
    all.disabled = input.disabled;
    all.addEventListener("click", () => {
      input.value = input.max;
      form.requestSubmit();
    });
    form.appendChild(all);
  }

  function queuedCollectionAmount(
    instanceId,
    resourceId,
    sourceField = null
  ) {
    return (
      simulationState?.player
        ?.task_queue ??
      []
    )
      .filter(
        (t) =>
          t.type ===
            "facility_collect" &&
          t.target_instance_id ===
            instanceId &&
          t.resource_id ===
            resourceId &&
          (
            t.source_field ?? null
          ) === sourceField
      )
      .reduce(
        (s, t) =>
          s +
          Number(t.amount ?? 0),
        0
      );
  }

  function managedContentOptions(selection) {
    const i =
      selection?.instance;

    const d =
      selection?.definition;

    if (!i || !d) {
      return [];
    }

    const container =
      d.container ?? {};

    const process =
      d.process ?? {};

    if (d.id === "chicken-coop") {
      return [
        {
          resourceId: "chicken",
          label: "Laying hen",
          unit: "bird",
          currentField: "current_fill",
          capacity:
            Number(
              container.capacity ?? 0
            ),
        },
        {
          resourceId: "feed",
          label: "Chicken feed",
          unit: "lb",
          currentField: "feed_mass",
          capacity: null,
        },
      ];
    }

    if (d.id === "bsfl-reactor") {
      return [
        {
          resourceId:
            "bsfl_biomass",
          label:
            "BSFL larval biomass",
          unit: "lb",
          currentField:
            "larval_biomass",
          capacity:
            Number(
              process
                .maximum_larval_biomass_lb ??
              0
            ),
        },
        {
          resourceId:
            "kitchen_waste",
          label:
            "Kitchen waste",
          unit: "lb",
          currentField:
            "feedstock_mass",
          capacity:
            Number(
              container
                .usable_capacity_lb ??
              0
            ),
        },
      ];
    }

    if (d.id === "compost-pile") {
      return [
        {
          resourceId:
            "kitchen_waste",
          label:
            "Kitchen waste",
          unit: "lb",
          currentField:
            "unbalanced_kitchen_waste",
          sharedCapacity: true,
          capacity:
            Number(
              container.capacity ?? 0
            ),
        },
        {
          resourceId:
            "scat",
          label:
            "Avian scat",
          unit: "lb",
          currentField:
            "unbalanced_scat",
          sharedCapacity: true,
          capacity:
            Number(
              container.capacity ?? 0
            ),
        },
        {
          resourceId:
            "carbonaceous_plant_waste",
          label:
            "Carbonaceous plant waste",
          unit: "lb",
          currentField:
            "available_carbon_material",
          sharedCapacity: true,
          capacity:
            Number(
              container.capacity ?? 0
            ),
        },
        {
          resourceId:
            "active_compost",
          label:
            "Active compost / pre-compost",
          unit: "lb",
          currentField:
            "active_compost_mass",
          sharedCapacity: true,
          capacity:
            Number(
              container.capacity ?? 0
            ),
        },
      ];
    }

    return [];
  }

  function collectionOptions(selection) {
    const i =
      selection?.instance;

    if (!i) return [];

    if (
      i.facility_id ===
      "chicken-coop"
    ) {
      return [
        {
          resourceId: "eggs",
          label: "Eggs",
          unit: "egg",
          sourceField: null,
          available:
            Number(
              i.stored_outputs?.eggs ??
              0
            ),
        },
      ];
    }

    if (
      i.facility_id ===
      "compost-pile"
    ) {
      return [
        {
          resourceId: "compost",
          label: "Mature compost",
          unit: "lb",
          sourceField:
            "mature_compost_mass",
          available:
            Number(
              i.mature_compost_mass ??
              0
            ),
        },
      ];
    }

    if (
      i.facility_id ===
      "bsfl-reactor"
    ) {
      return [
        {
          resourceId:
            "insect_forage",
          label:
            "Self-harvested BSFL",
          unit: "lb",
          sourceField: null,
          available:
            Number(
              i.stored_outputs
                ?.insect_forage ??
              0
            ),
        },
        {
          resourceId:
            "active_compost",
          label:
            "BSFL pre-compost",
          unit: "lb",
          sourceField:
            "residue_mass",
          available:
            Number(
              i.residue_mass ?? 0
            ),
        },
      ];
    }

    return [];
  }

  function renderContentsManager(selection) {
    inspectorContent.replaceChildren();

    if (!selection?.instance) {
      inspectorContent.textContent =
        "This selection has no managed contents.";
      return;
    }

    if (
      selection.instance.facility_id ===
      "compost-pile"
    ) {
      const note =
        document.createElement("p");

      note.className =
        "compost-state-note";

      note.textContent =
        compostStatus(
          selection.instance
        );

      inspectorContent.appendChild(note);

      const c =
        compostCarbonNeed(
          selection.instance,
          selection.definition
        );

      const carbon =
        document.createElement("p");

      carbon.className =
        "carbon-balance-note";

      carbon.textContent =
        c.needed > 1e-6
          ? `This compost pile needs about ${formatAmount(
              c.needed,
              2
            )} lb of carbon-rich material to keep composting well.`
          : "Carbon balance is currently adequate. Fresh balanced inputs are mixed into generic feedstock when the pile is serviced.";

      inspectorContent.appendChild(
        carbon
      );
    }

    const intro =
      document.createElement("p");

    intro.className =
      "contents-message";

    intro.textContent =
      "Transfers reserve carried material immediately and queue a physical delivery. Collection is also queued and completes only after the Homesteader reaches the facility.";

    inspectorContent.appendChild(
      intro
    );

    const options =
      managedContentOptions(selection);

    for (const o of options) {
      const carried =
        Number(
          simulationState?.player
            ?.inventory
            ?.[o.resourceId] ??
          0
        );

      const queued =
        queuedFillAmount(
          selection.instance
            .instance_id,
          o.currentField
        );

      const current =
        Number(
          selection.instance
            [o.currentField] ??
          0
        );

      const used =
        o.sharedCapacity
          ? compostTotalMass(
              selection.instance
            )
          : current;

      const remaining =
        o.capacity == null
          ? carried
          : Math.max(
              0,
              o.capacity -
                used -
                (
                  o.sharedCapacity
                    ? (
                        simulationState
                          ?.player
                          ?.task_queue ??
                        []
                      )
                        .filter(
                          (t) =>
                            t.type ===
                              "facility_fill" &&
                            t.target_instance_id ===
                              selection.instance.instance_id
                        )
                        .reduce(
                          (s, t) =>
                            s +
                            Number(
                              t.amount ?? 0
                            ),
                          0
                        )
                    : queued
                )
            );

      const maximum =
        Math.max(
          0,
          Math.min(
            carried,
            remaining
          )
        );

      const card =
        document.createElement("section");

      card.className =
        "contents-row";

      const h =
        document.createElement("h3");

      h.textContent =
        o.label;

      const stats =
        document.createElement("p");

      stats.className =
        "contents-stats";

      stats.textContent =
        `At facility: ${formatAmount(
          current
        )} ${o.unit} · ` +
        `Queued: ${formatAmount(
          queued
        )} ${o.unit} · ` +
        `Carried: ${formatAmount(
          carried
        )} ${o.unit}` +
        (
          o.capacity == null
            ? ""
            : ` · Remaining pile/container capacity: ${formatAmount(
                remaining
              )} ${o.unit}`
        );

      const form =
        document.createElement("form");

      form.className =
        "contents-form";

      const label =
        document.createElement("label");

      label.textContent =
        `Amount to deliver (${o.unit})`;

      const input =
        document.createElement("input");

      input.type = "number";
      input.min = "0";

      input.step =
        isDiscrete(o.resourceId)
          ? "1"
          : "0.1";

      input.max =
        String(maximum);

      input.value =
        maximum > 0
          ? String(
              isDiscrete(o.resourceId)
                ? Math.max(
                    1,
                    Math.floor(
                      Math.min(
                        maximum,
                        1
                      )
                    )
                  )
                : Math.min(
                    maximum,
                    0.1
                  )
            )
          : "0";

      input.disabled =
        maximum <= 0;

      label.appendChild(input);

      const button =
        document.createElement("button");

      button.type = "submit";
      button.className =
        "interaction-button primary";
      button.textContent =
        "Queue Delivery";
      button.disabled =
        maximum <= 0;

      capTransferInput(input, Number(input.max), isDiscrete(o.resourceId));
      form.append(label, button);
      appendTransferAll(form, input, "Drop off all");

      form.addEventListener(
        "submit",
        async (event) => {
          event.preventDefault();

          const amount =
            Number(input.value);

          if (
            !Number.isFinite(amount) ||
            amount <= 0
          ) {
            return;
          }

          try {
            const result =
              await api(
                `/api/facilities/${
                  encodeURIComponent(
                    selection.instance
                      .instance_id
                  )
                }/fill`,
                {
                  method: "POST",
                  body:
                    JSON.stringify({
                      resource_id:
                        o.resourceId,
                      amount,
                    }),
                }
              );

            renderState(result.state);
            refreshOpenInspector();

            statusLine.textContent =
              `${o.label} delivery queued.`;
          } catch (error) {
            statusLine.textContent =
              error.message;
          }
        }
      );

      card.append(h, stats, form);
      inspectorContent.appendChild(card);
    }

    for (
      const o
      of collectionOptions(selection)
    ) {
      const reserved =
        queuedCollectionAmount(
          selection.instance
            .instance_id,
          o.resourceId,
          o.sourceField
        );

      const available =
        Math.max(
          0,
          o.available - reserved
        );

      const card =
        document.createElement("section");

      card.className =
        "contents-row output-collection-row";

      const h =
        document.createElement("h3");

      h.textContent = o.label;

      const stats =
        document.createElement("p");

      stats.className =
        "contents-stats";

      stats.textContent =
        `Available to collect: ${formatAmount(
          available
        )} ${o.unit}` +
        (
          reserved > 0
            ? ` · Reserved by queued tasks: ${formatAmount(
                reserved
              )} ${o.unit}`
            : ""
        );

      const form =
        document.createElement("form");

      form.className =
        "contents-form";

      const label =
        document.createElement("label");

      label.textContent =
        `Amount to collect (${o.unit})`;

      const input =
        document.createElement("input");

      input.type = "number";
      input.min = "0";

      input.step =
        isDiscrete(o.resourceId)
          ? "1"
          : "0.1";

      input.max =
        String(available);

      input.value =
        available > 0
          ? String(
              isDiscrete(o.resourceId)
                ? Math.max(
                    1,
                    Math.floor(
                      Math.min(
                        available,
                        1
                      )
                    )
                  )
                : Math.min(
                    available,
                    0.1
                  )
            )
          : "0";

      input.disabled =
        available <= 0;

      label.appendChild(input);

      const button =
        document.createElement("button");

      button.type = "submit";
      button.className =
        "interaction-button";
      button.textContent =
        "Queue Collection";
      button.disabled =
        available <= 0;

      capTransferInput(input, Number(input.max), isDiscrete(o.resourceId));
      form.append(label, button);
      appendTransferAll(form, input, "Pick up all");

      form.addEventListener(
        "submit",
        async (event) => {
          event.preventDefault();

          const amount =
            Number(input.value);

          if (
            !Number.isFinite(amount) ||
            amount <= 0
          ) {
            return;
          }

          try {
            const result =
              await api(
                `/api/facilities/${
                  encodeURIComponent(
                    selection.instance
                      .instance_id
                  )
                }/collect`,
                {
                  method: "POST",
                  body:
                    JSON.stringify({
                      resource_id:
                        o.resourceId,
                      amount,
                      source_field:
                        o.sourceField,
                    }),
                }
              );

            renderState(result.state);
            refreshOpenInspector();

            statusLine.textContent =
              `${o.label} collection queued.`;
          } catch (error) {
            statusLine.textContent =
              error.message;
          }
        }
      );

      card.append(h, stats, form);
      inspectorContent.appendChild(card);
    }
  }

  function renderHouseContentsManager(
    focus = null
  ) {
    inspectorContent.replaceChildren();

    const house =
      simulationState?.house;

    if (!house) return;

    const intro =
      document.createElement("p");

    intro.className =
      "contents-message";

    intro.textContent =
      "Submitting a pickup reserves the household waste immediately and queues a physical pickup task.";

    inspectorContent.appendChild(intro);

    for (
      const stream
      of [
        {
          id: "kitchen_waste",
          label: "Kitchen waste",
        },
        {
          id:
            "carbonaceous_plant_waste",
          label:
            "Household paper waste (browns)",
        },
      ]
    ) {
      const available =
        Number(
          house.outputs?.[stream.id] ??
          0
        );

      const carried =
        Number(
          simulationState?.player
            ?.inventory
            ?.[stream.id] ??
          0
        );

      const card =
        document.createElement("section");

      card.className =
        "contents-row";

      if (focus === stream.id) {
        card.classList.add(
          "is-focused"
        );
      }

      const h =
        document.createElement("h3");

      h.textContent = stream.label;

      const p =
        document.createElement("p");

      p.className =
        "contents-stats";

      p.textContent =
        `Available: ${formatAmount(
          available
        )} lb · ` +
        `Carried: ${formatAmount(
          carried
        )} lb`;

      const form =
        document.createElement("form");

      form.className =
        "contents-form";

      const label =
        document.createElement("label");

      label.textContent =
        "Amount to pick up (lb)";

      const input =
        document.createElement("input");

      input.type = "number";
      input.min = "0";
      input.step = "0.1";
      input.max = String(available);

      input.value =
        available > 0
          ? String(
              Math.min(
                available,
                0.1
              )
            )
          : "0";

      input.disabled =
        available <= 0;

      label.appendChild(input);

      const b =
        document.createElement("button");

      b.type = "submit";
      b.className =
        "interaction-button primary";
      b.textContent = "Queue Pickup";
      b.disabled =
        available <= 0;

      capTransferInput(input, available);
      form.append(label, b);
      appendTransferAll(form, input, "Pick up all");

      form.addEventListener(
        "submit",
        async (e) => {
          e.preventDefault();

          try {
            const result =
              await api(
                "/api/house/pickup",
                {
                  method: "POST",
                  body:
                    JSON.stringify({
                      resource_id:
                        stream.id,
                      amount:
                        Number(
                          input.value
                        ),
                    }),
                }
              );

            renderState(result.state);

            renderHouseContentsManager(
              stream.id
            );
          } catch (error) {
            statusLine.textContent =
              error.message;
          }
        }
      );

      card.append(h, p, form);
      inspectorContent.appendChild(card);
    }
  }

  function storageResourceIds() {
    return [
      ...new Set([
        ...Object.keys(
          simulationState?.house
            ?.storage ??
          {}
        ),
        ...Object.keys(
          simulationState?.player
            ?.inventory ??
          {}
        ),
      ]),
    ]
      .filter(
        (id) =>
          Number(
            simulationState?.house
              ?.storage
              ?.[id] ??
            0
          ) >
            1e-9 ||
          Number(
            simulationState?.player
              ?.inventory
              ?.[id] ??
            0
          ) >
            1e-9
      )
      .sort(
        (a, b) =>
          resourceLabel(a)
            .localeCompare(
              resourceLabel(b)
            )
      );
  }

  function renderHouseStorageManager() {
    inspectorContent.replaceChildren();

    const intro =
      document.createElement("p");

    intro.className =
      "contents-message";

    intro.textContent =
      "Pickup and drop-off instructions are queued and take one simulated minute of handling after travel. Eggs delivered here are immediately converted to grocery credit at $0.20 per egg.";

    inspectorContent.appendChild(intro);

    const groceryNote =
      document.createElement("p");

    groceryNote.className =
      "contents-stats";

    groceryNote.textContent =
      `Available grocery credit: $${formatAmount(
        simulationState?.household
          ?.grocery_credit_usd ??
        0,
        2
      )} · Cumulative savings: $${formatAmount(
        simulationState?.household
          ?.cumulative_grocery_savings_usd ??
        0,
        2
      )}`;

    inspectorContent.appendChild(
      groceryNote
    );

    const ids =
      storageResourceIds();

    if (!ids.length) {
      const p =
        document.createElement("p");

      p.className =
        "contents-message";

      p.textContent =
        "House Storage is empty.";

      inspectorContent.appendChild(p);
    }

    for (const id of ids) {
      const stored =
        Number(
          simulationState?.house
            ?.storage
            ?.[id] ??
          0
        );

      const carried =
        Number(
          simulationState?.player
            ?.inventory
            ?.[id] ??
          0
        );

      const unit =
        resourceUnit(id);

      const card =
        document.createElement("section");

      card.className =
        "contents-row";

      const h =
        document.createElement("h3");

      h.textContent =
        resourceLabel(id);

      const p =
        document.createElement("p");

      p.className =
        "contents-stats";

      p.textContent =
        `House Storage: ${formatAmount(
          stored
        )} ${unit} · ` +
        `Carried: ${formatAmount(
          carried
        )} ${unit}`;

      card.append(h, p);

      for (const [direction, available, action, allText] of [
        ["to_player", stored, "Queue Pickup", "Pick up all"],
        ["to_house", carried, "Queue Drop Off", "Drop off all"],
      ]) {
        const form = document.createElement("form");
        form.className = "contents-form";
        const label = document.createElement("label");
        label.textContent = `${direction === "to_player" ? "Amount to pick up" : "Amount to drop off"} (${unit})`;
        const input = document.createElement("input");
        input.type = "number";
        input.min = "0";
        input.value = String(Math.min(available, isDiscrete(id) ? 1 : 0.1));
        const maximum = capTransferInput(input, available, isDiscrete(id));
        label.appendChild(input);
        const button = document.createElement("button");
        button.type = "submit";
        button.className = "interaction-button";
        button.textContent = action;
        button.disabled = maximum <= 0;
        form.append(label, button);
        appendTransferAll(form, input, allText);

        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          const amount = Number(input.value);
          if (!Number.isFinite(amount) || amount <= 0 || amount > maximum) return;
          try {
            const result = await api("/api/house/storage/transfer", {
              method: "POST",
              body: JSON.stringify({ resource_id: id, amount, direction }),
            });
            renderState(result.state);
            renderHouseStorageManager();
          } catch (error) {
            statusLine.textContent = error.message;
          }
        });
        card.appendChild(form);
      }

      inspectorContent.appendChild(card);
    }

    const order =
      document.createElement("button");

    order.type = "button";
    order.className =
      "interaction-button order-shortcut";
    order.textContent =
      "Order Supplies";

    order.addEventListener(
      "click",
      () => {
        inspectorMode = "order";
        inspectorTitle.textContent =
          "Order Supplies";
        renderOrderInterface();
      }
    );

    inspectorContent.appendChild(order);
  }

  function renderOrderInterface() {
    inspectorContent.replaceChildren();

    const intro =
      document.createElement("p");

    intro.className =
      "contents-message";

    intro.textContent =
      "Orders are currently free and delivered instantly to House Storage.";

    inspectorContent.appendChild(intro);

    for (
      const [id, spec]
      of Object.entries(
        simulationState?.order_catalog ??
        {}
      )
    ) {
      const card =
        document.createElement("section");

      card.className =
        "contents-row order-row";

      const h =
        document.createElement("h3");

      h.textContent =
        spec.name ??
        resourceLabel(id);

      const p =
        document.createElement("p");

      p.className =
        "contents-stats";

      p.textContent =
        `House Storage: ${formatAmount(
          simulationState?.house
            ?.storage
            ?.[spec.resource_id ?? id] ??
          0
        )} ${
          spec.unit ??
          resourceUnit(id)
        }`;

      const form =
        document.createElement("form");

      form.className =
        "contents-form";

      const label =
        document.createElement("label");

      label.textContent =
        `Quantity (${
          spec.unit ??
          resourceUnit(id)
        })`;

      const input =
        document.createElement("input");

      input.type = "number";
      input.min = "0";
      input.step =
        spec.integer_only
          ? "1"
          : "0.1";
      input.value = "1";

      label.appendChild(input);

      const b =
        document.createElement("button");

      b.type = "submit";
      b.className =
        "interaction-button primary";
      b.textContent = "Order";

      form.append(label, b);

      form.addEventListener(
        "submit",
        async (e) => {
          e.preventDefault();

          try {
            const result =
              await api(
                "/api/orders",
                {
                  method: "POST",
                  body:
                    JSON.stringify({
                      resource_id: id,
                      amount:
                        Number(
                          input.value
                        ),
                    }),
                }
              );

            renderState(result.state);
            renderOrderInterface();
          } catch (error) {
            statusLine.textContent =
              error.message;
          }
        }
      );

      card.append(h, p, form);
      inspectorContent.appendChild(card);
    }
  }

  inspectorCloseButton.addEventListener(
    "click",
    () => closeInspector()
  );

  inspectorOverlay.addEventListener(
    "click",
    (event) => {
      if (
        event.target ===
        inspectorOverlay
      ) {
        closeInspector();
      }
    }
  );

  walkHereButton.addEventListener(
    "click",
    async () => {
      if (!selectedMapObject) return;

      try {
        const result =
          await api(
            "/api/player/walk",
            {
              method: "POST",
              body:
                JSON.stringify({
                  column:
                    selectedMapObject
                      .column,
                  row:
                    selectedMapObject
                      .row,
                }),
            }
          );

        renderState(result.state);
        closeInspector();
        clearMapSelection();

        statusLine.textContent =
          "Walk task queued.";
      } catch (error) {
        statusLine.textContent =
          error.message;
      }
    }
  );

  serviceFacilityButton.addEventListener(
    "click",
    async () => {
      const i =
        selectedMapObject?.instance;

      if (!i) return;

      try {
        const result =
          await api(
            `/api/facilities/${
              encodeURIComponent(
                i.instance_id
              )
            }/service`,
            {
              method: "POST",
              body: "{}",
            }
          );

        renderState(result.state);
        closeInspector();
        clearMapSelection();

        statusLine.textContent =
          "Service task queued.";
      } catch (error) {
        statusLine.textContent =
          error.message;
      }
    }
  );

  manageContentsButton.addEventListener(
    "click",
    () => {
      if (!selectedMapObject) return;

      if (
        selectedMapObject.kind ===
        "house_storage"
      ) {
        inspectorMode = "storage";
        renderHouseStorageManager();
      } else if (
        selectedMapObject.kind ===
        "house"
      ) {
        inspectorMode = "contents";

        renderHouseContentsManager(
          selectedMapObject.focusResourceId
        );
      } else {
        inspectorMode = "contents";
        renderContentsManager(
          selectedMapObject
        );
      }
    }
  );

  function taskPhaseLabel(t) {
    return t?.phase === "travel"
      ? "Traveling"
      : t?.phase === "working"
        ? "Working"
        : t?.phase === "queued"
          ? "Queued"
          : "Idle";
  }

  function taskTravelMinutes(t) {
    if (
      !t?.target ||
      t.phase !== "travel"
    ) {
      return null;
    }

    const p =
      simulationState?.player
        ?.position;

    if (!p) return null;

    return Math.max(
      1,
      Math.ceil(
        Math.hypot(
          Number(t.target.column) -
            Number(p.column),
          Number(t.target.row) -
            Number(p.row)
        ) /
          WALKING_SPEED_TILES_PER_MINUTE
      )
    );
  }

  function taskDetail(t) {
    if (!t) {
      return "No queued tasks";
    }

    const parts = [
      taskPhaseLabel(t),
    ];

    const travel =
      taskTravelMinutes(t);

    if (travel != null) {
      parts.push(
        `~${travel} min travel`
      );
    }

    if (
      t.phase === "working"
    ) {
      parts.push(
        `${Number(
          t.work_minutes_remaining ??
          0
        )} min work remaining`
      );
    } else if (
      Number(
        t.work_minutes_remaining ??
        0
      ) >
      0
    ) {
      parts.push(
        `${Number(
          t.work_minutes_remaining
        )} min work after arrival`
      );
    }

    return parts.join(" · ");
  }

  async function cancelQueuedTask(id) {
    try {
      const result =
        await api(
          `/api/tasks/${
            encodeURIComponent(id)
          }/cancel`,
          {
            method: "POST",
            body: "{}",
          }
        );

      renderState(result.state);
    } catch (error) {
      statusLine.textContent =
        error.message;
    }
  }

  function renderTaskQueue() {
    if (
      !currentTaskCard ||
      !taskQueueList
    ) {
      return;
    }

    const queue =
      simulationState?.player
        ?.task_queue ??
      [];

    const current =
      queue[0] ?? null;

    currentTaskCard.replaceChildren();

    if (!current) {
      currentTaskCard.textContent =
        "Idle · no current task.";
    } else {
      const s =
        document.createElement("strong");

      const d =
        document.createElement("span");

      s.textContent =
        current.description ??
        prettyName(current.type);

      d.textContent =
        taskDetail(current);

      currentTaskCard.append(s, d);
    }

    taskQueueList.replaceChildren();

    if (queue.length <= 1) {
      const p =
        document.createElement("p");

      p.className =
        "panel-note";

      p.textContent =
        "No waiting tasks.";

      taskQueueList.appendChild(p);
      return;
    }

    queue.slice(1).forEach(
      (t, index) => {
        const row =
          document.createElement("div");

        row.className =
          "task-queue-item";

        const text =
          document.createElement("div");

        const s =
          document.createElement("strong");

        const d =
          document.createElement("span");

        s.textContent =
          `${index + 1}. ${
            t.description ??
            prettyName(t.type)
          }`;

        d.textContent =
          taskDetail(t);

        text.append(s, d);

        const b =
          document.createElement("button");

        b.type = "button";
        b.className =
          "task-cancel-button";
        b.textContent = "Cancel";

        b.addEventListener(
          "click",
          () =>
            cancelQueuedTask(
              t.task_id
            )
        );

        row.append(text, b);
        taskQueueList.appendChild(row);
      }
    );
  }

  function ensureAvatar() {
    if (avatar) return avatar;

    avatar =
      document.createElement("img");

    avatar.id =
      "player-avatar";
    avatar.className =
      "player-avatar";
    avatar.alt =
      "Homesteader";
    avatar.src =
      "/static/assets/sprites/HomesteaderIdle.png";

    avatarTooltip =
      document.createElement("div");

    avatarTooltip.className =
      "player-task-tooltip";
    avatarTooltip.hidden = true;

    landGrid.append(
      avatar,
      avatarTooltip
    );

    avatar.addEventListener(
      "mouseenter",
      () => {
        updateAvatarTooltip();
        avatarTooltip.hidden =
          false;
      }
    );

    avatar.addEventListener(
      "mouseleave",
      () => {
        avatarTooltip.hidden =
          true;
      }
    );

    return avatar;
  }

  function avatarAsset(task, activity) {
    const phase =
      activity?.phase ??
      task?.phase ??
      "idle";

    const direction =
      activity?.direction ??
      task?.direction ??
      simulationState?.player
        ?.last_direction ??
      "down";

    if (phase === "working") {
      return "/static/assets/sprites/HomesteaderCrouch.png";
    }

    if (phase !== "travel") {
      return "/static/assets/sprites/HomesteaderIdle.png";
    }

    if (direction === "up") {
      return "/static/assets/sprites/HomesteaderWalkAway.png";
    }

    if (direction === "down") {
      return "/static/assets/sprites/HomesteaderWalkToward.png";
    }

    return "/static/assets/sprites/HomesteaderWalkSide.png";
  }

  function updateAvatarTooltip() {
    if (!avatarTooltip) return;

    const queue =
      simulationState?.player
        ?.task_queue ??
      [];

    const current =
      queue[0] ?? null;

    avatarTooltip.replaceChildren();

    const lines =
      current
        ? [
            "Homesteader",
            current.description ??
              prettyName(
                current.type
              ),
            taskDetail(current),
            `${Math.max(
              0,
              queue.length - 1
            )} task${
              queue.length - 1 === 1
                ? ""
                : "s"
            } waiting`,
          ]
        : [
            "Homesteader",
            "Idle",
            "No queued tasks",
          ];

    for (const text of lines) {
      const el =
        text === "Homesteader"
          ? document.createElement(
              "strong"
            )
          : document.createElement(
              "span"
            );

      el.textContent = text;
      avatarTooltip.appendChild(el);
    }
  }

  function renderAvatar(activity = null) {
    const player =
      simulationState?.player;

    if (!player) {
      avatar?.remove();
      avatarTooltip?.remove();

      avatar = null;
      avatarTooltip = null;
      return;
    }

    const el =
      ensureAvatar();

    const column =
      Number(
        player.position?.column ?? 0
      );

    const row =
      Number(
        player.position?.row ??
        GRID_SIZE - 1
      );

    const task =
      player.task_queue?.[0] ??
      player.current_task ??
      null;

    const direction =
      activity?.direction ??
      task?.direction ??
      player.last_direction ??
      "down";

    el.style.left =
      `${
        ((column + 0.5) / GRID_SIZE) *
        100
      }%`;

    el.style.top =
      `${
        ((row + 1) / GRID_SIZE) *
        100
      }%`;

    el.src =
      avatarAsset(task, activity);

    el.classList.toggle(
      "walk-left",
      (
        activity?.phase ??
        task?.phase
      ) ===
        "travel" &&
      direction === "left"
    );

    if (avatarTooltip) {
      avatarTooltip.style.left =
        el.style.left;

      avatarTooltip.style.top =
        el.style.top;

      updateAvatarTooltip();
    }
  }

  function renderHouse() {
    landGrid
      .querySelectorAll(
        ".house-eaves, .house-pickup, .house-storage"
      )
      .forEach((e) => e.remove());

    const house =
      simulationState?.house;

    if (!house) return;

    const e =
      house.eaves ??
      {
        column: 11,
        width: 20,
      };

    const eaves =
      document.createElement("div");

    eaves.className =
      "house-eaves";

    eaves.style.gridColumn =
      `${Number(e.column) + 1} / span ${Number(e.width)}`;

    eaves.style.gridRow =
      `${GRID_SIZE} / span 1`;

    eaves.setAttribute(
      "aria-label",
      "House"
    );

    landGrid.appendChild(eaves);

    const makeTooltip =
      (name, contentLines) => {
        const tooltip =
          document.createElement("span");

        tooltip.className =
          "map-storage-tooltip";

        tooltip.setAttribute(
          "role",
          "tooltip"
        );

        const heading =
          document.createElement("strong");

        heading.textContent =
          name;

        tooltip.appendChild(heading);

        const lines =
          Array.isArray(contentLines)
            ? contentLines
            : [contentLines];

        for (const line of lines) {
          const row =
            document.createElement("span");

          row.className =
            "tooltip-contents";

          row.textContent = line;
          tooltip.appendChild(row);
        }

        return tooltip;
      };

    for (
      const [id, label, klass]
      of [
        [
          "kitchen_waste",
          "Kitchen waste",
          "kitchen-pickup",
        ],
        [
          "carbonaceous_plant_waste",
          "Paper waste",
          "paper-pickup",
        ],
      ]
    ) {
      const point =
        house.pickup_points?.[id];

      if (!point) continue;

      const width =
        Math.max(
          1,
          Number(point.width ?? 1)
        );

      const height =
        Math.max(
          1,
          Number(point.height ?? 1)
        );

      const amount =
        Number(
          house.outputs?.[id] ?? 0
        );

      const button =
        document.createElement("button");

      button.type = "button";

      button.className =
        `house-pickup ${klass}`;

      button.dataset.resourceId =
        id;

      button.style.gridColumn =
        `${
          Math.floor(
            Number(point.column)
          ) +
          1
        } / span ${width}`;

      button.style.gridRow =
        `${
          Math.floor(
            Number(point.row)
          ) +
          1
        } / span ${height}`;

      button.setAttribute(
        "aria-label",
        `${label}: ${formatAmount(
          amount,
          2
        )} lb ready`
      );

      button.appendChild(
        makeTooltip(
          label,
          `${formatAmount(
            amount,
            2
          )} lb ready`
        )
      );

      landGrid.appendChild(button);
    }

    const point =
      house.storage_point ??
      {
        column: 20,
        row: 40,
        width: 2,
        height: 2,
      };

    const width =
      Math.max(
        1,
        Number(point.width ?? 2)
      );

    const height =
      Math.max(
        1,
        Number(point.height ?? 2)
      );

    const storage =
      house.storage ?? {};

    const storedEntries =
      Object.entries(storage)
        .filter(
          ([, amount]) =>
            Number(amount) > 1e-9
        )
        .sort(
          ([a], [b]) =>
            resourceLabel(a)
              .localeCompare(
                resourceLabel(b)
              )
        );

    const storageButton =
      document.createElement("button");

    storageButton.type =
      "button";

    storageButton.className =
      "house-storage";

    storageButton.style.gridColumn =
      `${
        Math.floor(
          Number(point.column)
        ) +
        1
      } / span ${width}`;

    storageButton.style.gridRow =
      `${
        Math.floor(
          Number(point.row)
        ) +
        1
      } / span ${height}`;

    const storageLines =
      storedEntries.length
        ? storedEntries.map(
            ([id, amount]) =>
              `${resourceLabel(
                id
              )}: ${formatAmount(
                amount,
                isDiscrete(id)
                  ? 0
                  : 2
              )} ${resourceUnit(id)}`
          )
        : ["Empty"];

    storageButton.setAttribute(
      "aria-label",
      storedEntries.length
        ? `House Storage. ${storageLines.join(
            "; "
          )}`
        : "House Storage. Empty."
    );

    storageButton.appendChild(
      makeTooltip(
        "House Storage",
        storageLines
      )
    );

    landGrid.appendChild(
      storageButton
    );
  }

  function renderPlacements() {
    landGrid
      .querySelectorAll(
        ".placed-building"
      )
      .forEach((e) => e.remove());

    placements =
      (
        simulationState?.instances ??
        []
      ).map((i) => ({ ...i }));

    for (const i of placements) {
      const d =
        definitionsById.get(
          i.facility_id
        );

      if (!d) continue;

      const image =
        document.createElement("img");

      image.className =
        "building-sprite placed-building";

      image.src =
        `/static/assets/sprites/${d.image}`;

      image.alt = d.name;

      image.dataset.instanceId =
        i.instance_id;

      image.style.gridColumn =
        `${i.column + 1} / span ${i.width}`;

      image.style.gridRow =
        `${i.row + 1} / span ${i.height}`;

      landGrid.appendChild(image);
    }

    renderHouse();

    if (avatar) {
      landGrid.appendChild(avatar);
    }

    if (avatarTooltip) {
      landGrid.appendChild(
        avatarTooltip
      );
    }
  }

  function dailyBaseline() {
    const b =
      simulationState
        ?.household_baseline_daily ??
      {};

    const p =
      simulationState
        ?.household_profile ??
      {};

    return {
      flows:
        b.daily_flows ??
        p.daily_flows ??
        {},
      electricity:
        b.electricity_kwh_per_day ??
        p.electricity_kwh_per_day ??
        {},
    };
  }

  function renderPlayerInventory() {
    playerInventoryList.replaceChildren();

    const entries =
      Object.entries(
        simulationState?.player
          ?.inventory ??
        {}
      )
        .filter(
          ([, v]) =>
            Number(v) > 1e-9
        )
        .sort(
          ([a], [b]) =>
            resourceLabel(a)
              .localeCompare(
                resourceLabel(b)
              )
        );

    if (!entries.length) {
      const li =
        document.createElement("li");

      li.textContent =
        "Nothing carried.";

      playerInventoryList.appendChild(li);
      return;
    }

    for (
      const [id, amount]
      of entries
    ) {
      addListItem(
        playerInventoryList,
        resourceLabel(id),
        `${formatAmount(
          amount,
          isDiscrete(id)
            ? 0
            : 4
        )} ${resourceUnit(id)}`
      );
    }
  }

  function renderResourceOverview() {
    biologicalResourceList
      ?.replaceChildren();

    yardResourceList
      ?.replaceChildren();

    utilityResourceList
      ?.replaceChildren();

    const overview =
      simulationState
        ?.resource_overview ??
      {};

    for (
      const [id, r]
      of Object.entries(
        overview.biological_materials ??
        {}
      ).sort(
        ([, a], [, b]) =>
          String(a.name)
            .localeCompare(
              String(b.name)
            )
      )
    ) {
      if (
        r.behavior !== "stock" ||
        Number(r.amount ?? 0) <=
          1e-9
      ) {
        continue;
      }

      addListItem(
        biologicalResourceList,
        r.name ??
          resourceLabel(id),
        `${formatAmount(
          r.amount,
          r.quantity_mode ===
            "discrete"
            ? 0
            : 4
        )} ${
          r.unit ?? ""
        }`.trim()
      );
    }

    if (
      biologicalResourceList &&
      !biologicalResourceList.children.length
    ) {
      const li =
        document.createElement("li");

      li.textContent =
        "No physical stocks yet.";

      biologicalResourceList.appendChild(li);
    }

    for (
      const [id, r]
      of Object.entries(
        overview.yard_forage ??
        {}
      ).sort(
        ([, a], [, b]) =>
          String(a.name)
            .localeCompare(
              String(b.name)
            )
      )
    ) {
      addListItem(
        yardResourceList,
        r.name ??
          resourceLabel(id),
        `${formatAmount(
          r.amount ?? 0,
          4
        )} / ${formatAmount(
          r.capacity ?? 0,
          4
        )} ${
          r.unit ?? "lb"
        } · ${formatAmount(
          r.daily_generation ?? 0,
          4
        )}/day`
      );
    }

    if (
      yardResourceList &&
      !yardResourceList.children.length
    ) {
      const li =
        document.createElement("li");

      li.textContent =
        "No yard forage available.";

      yardResourceList.appendChild(li);
    }

    const u =
      overview.utilities ?? {};

    const e =
      u.electricity_balance;

    if (e) {
      addListItem(
        utilityResourceList,
        "Electricity demand",
        `${formatAmount(
          e.demand
        )} kWh/h`
      );

      addListItem(
        utilityResourceList,
        "On-site generation",
        `${formatAmount(
          e.onsite_generation
        )} kWh/h`
      );

      addListItem(
        utilityResourceList,
        "Grid requirement",
        `${formatAmount(
          e.grid_requirement
        )} kWh/h`
      );
    }

    if (u.municipal_water) {
      addListItem(
        utilityResourceList,
        u.municipal_water.name ??
          "Municipal potable water",
        `${formatAmount(
          u.municipal_water.amount
        )} gal/h`
      );
    }

    const np =
      overview.utilities
        ?.non_potable_water;

    if (np) {
      addListItem(
        utilityResourceList,
        np.name,
        `${formatAmount(
          np.amount
        )} ${
          np.unit ?? ""
        }`.trim()
      );
    }
  }

  function renderHouseholdPanels() {
    const profile =
      simulationState
        ?.household_profile ??
      {};

    const householdList =
      document.getElementById(
        "household-summary-list"
      );

    householdList.replaceChildren();

    addListItem(
      householdList,
      "Profile",
      profile.name ??
        profile.profile_id ??
        "Default household"
    );

    addListItem(
      householdList,
      "Occupants",
      formatAmount(
        profile.occupants
      )
    );

    addListItem(
      householdList,
      "House size",
      `${formatAmount(
        profile.house_sq_ft
      )} sq ft`
    );

    addListItem(
      householdList,
      "Money",
      `$${formatAmount(
        simulationState?.household
          ?.money ??
        0,
        2
      )}`
    );

    const playerList =
      document.getElementById(
        "player-status-list"
      );

    playerList.replaceChildren();

    const player =
      simulationState?.player;

    if (player) {
      addListItem(
        playerList,
        "Position",
        `${formatAmount(
          player.position?.column,
          2
        )}, ${formatAmount(
          player.position?.row,
          2
        )}`
      );

      addListItem(
        playerList,
        "Activity",
        player.task_queue?.[0]
          ? `${
              player.task_queue[0]
                .description
            } — ${
              taskPhaseLabel(
                player.task_queue[0]
              )
            }`
          : "Idle"
      );

      addListItem(
        playerList,
        "Tasks",
        String(
          player.task_queue
            ?.length ??
          0
        )
      );
    }

    renderPlayerInventory();
    renderTaskQueue();
    renderResourceOverview();

    const {
      flows,
      electricity,
    } =
      dailyBaseline();

    const consumptionList =
      document.getElementById(
        "consumption-list"
      );

    consumptionList.replaceChildren();

    addListItem(
      consumptionList,
      "Baseline groceries",
      `$${formatAmount(
        flows.groceries_usd,
        2
      )} / day`
    );

    addListItem(
      consumptionList,
      "Egg grocery credit available",
      `$${formatAmount(
        simulationState?.household
          ?.grocery_credit_usd ??
        0,
        2
      )}`
    );

    addListItem(
      consumptionList,
      "Cumulative grocery savings",
      `$${formatAmount(
        simulationState?.household
          ?.cumulative_grocery_savings_usd ??
        0,
        2
      )}`
    );

    addListItem(
      consumptionList,
      "Tap water",
      `${formatAmount(
        flows.tap_water_gal
      )} gal / day`
    );

    addListItem(
      consumptionList,
      "Electricity",
      `${formatAmount(
        electricity.total
      )} kWh / day`
    );

    const electricityList =
      document.getElementById(
        "electricity-breakdown-list"
      );

    electricityList.replaceChildren();

    for (
      const [key, value]
      of Object.entries(electricity)
    ) {
      if (key !== "total") {
        addListItem(
          electricityList,
          prettyName(key),
          `${formatAmount(
            value
          )} kWh / day`
        );
      }
    }

    const wasteList =
      document.getElementById(
        "waste-water-list"
      );

    wasteList.replaceChildren();

    for (
      const [key, value]
      of Object.entries(flows)
    ) {
      if (
        [
          "groceries_usd",
          "tap_water_gal",
        ].includes(key)
      ) {
        continue;
      }

      const unit =
        key.endsWith("_gal")
          ? "gal / day"
          : key.endsWith("_lb")
            ? "lb / day"
            : "/ day";

      addListItem(
        wasteList,
        prettyName(
          key.replace(
            /_(gal|lb)$/,
            ""
          )
        ),
        `${formatAmount(
          value
        )} ${unit}`
      );
    }

    const operationsList =
      document.getElementById(
        "facility-status-list"
      );

    operationsList.replaceChildren();

    if (!placements.length) {
      const li =
        document.createElement("li");

      li.textContent =
        "No placed facilities.";

      operationsList.appendChild(li);
    } else {
      for (const i of placements) {
        const d =
          definitionsById.get(
            i.facility_id
          );

        const label =
          i.facility_id ===
            "compost-pile"
            ? compostStatus(i)
            : i.last_operation
                ?.status ??
              "Awaiting first hourly tick";

        addListItem(
          operationsList,
          d?.name ??
            i.facility_id,
          label
        );
      }
    }
  }

  function refreshOpenInspector() {
    if (
      !selectedMapObject ||
      inspectorOverlay.hidden
    ) {
      return;
    }

    if (
      selectedMapObject.kind ===
      "house"
    ) {
      selectedMapObject.house =
        simulationState?.house;

      if (
        inspectorMode ===
        "contents"
      ) {
        renderHouseContentsManager(
          selectedMapObject
            .focusResourceId
        );
      } else {
        renderSelectionSummary(
          selectedMapObject
        );
      }

      return;
    }

    if (
      selectedMapObject.kind ===
      "house_storage"
    ) {
      selectedMapObject.house =
        simulationState?.house;

      if (
        inspectorMode ===
        "order"
      ) {
        renderOrderInterface();
      } else {
        renderHouseStorageManager();
      }

      return;
    }

    const i =
      facilityAt(
        selectedMapObject.column,
        selectedMapObject.row
      );

    selectedMapObject.instance = i;

    selectedMapObject.definition =
      i
        ? definitionsById.get(
            i.facility_id
          )
        : definitionsById.get(
            simulationState?.map
              ?.default_tile
          );

    if (
      inspectorMode ===
      "contents"
    ) {
      renderContentsManager(
        selectedMapObject
      );
    } else {
      renderSelectionSummary(
        selectedMapObject
      );
    }

    serviceFacilityButton.disabled =
      !i ||
      Number(
        i.accrued_labor_requirement ??
        0
      ) <=
        1e-9;
  }

  function renderState(
    state,
    activity = null
  ) {
    simulationState = state;
    definitionsById.clear();

    for (
      const d
      of state?.facility_definitions ??
      []
    ) {
      definitionsById.set(
        d.id,
        d
      );
    }

    setDateAndClock(state);
    renderBuildList();
    renderPlacements();
    refreshOpenInspector();
    renderAvatar(activity);
    renderHouseholdPanels();
  }

  landGrid.addEventListener(
    "pointermove",
    (event) => {
      if (
        !selectedBuildId ||
        mapDragStarted
      ) {
        return;
      }

      const p =
        mapCoordinatesFromClient(
          event.clientX,
          event.clientY
        );

      showPreview(
        p.column,
        p.row
      );
    }
  );

  landGrid.addEventListener(
    "pointerleave",
    () => {
      if (selectedBuildId) {
        removePreview();
      }
    }
  );

  landGrid.addEventListener(
    "click",
    async (event) => {
      if (!gameLoaded) return;

      if (suppressNextMapClick) {
        suppressNextMapClick = false;
        return;
      }

      const {
        column,
        row,
      } =
        mapCoordinatesFromClient(
          event.clientX,
          event.clientY
        );

      const pickup =
        event.target.closest
          ?.(".house-pickup");

      const storage =
        event.target.closest
          ?.(".house-storage");

      const eaves =
        event.target.closest
          ?.(".house-eaves");

      const facility =
        event.target.closest
          ?.(".placed-building");

      if (storage) {
        if (selectedBuildId) {
          cancelPlacement({
            silent: true,
          });
        }

        openHouseStorage("storage");
        return;
      }

      if (pickup) {
        if (selectedBuildId) {
          cancelPlacement({
            silent: true,
          });
        }

        openHouseSelection(
          pickup.dataset.resourceId
        );

        return;
      }

      if (eaves) {
        if (selectedBuildId) {
          cancelPlacement({
            silent: true,
          });
        }

        openHouseSelection();
        return;
      }

      if (facility) {
        if (selectedBuildId) {
          cancelPlacement({
            silent: true,
          });
        }

        openSelection(column, row);
        return;
      }

      if (selectedBuildId) {
        await placeSelectedFacility(
          column,
          row
        );
        return;
      }

      openSelection(column, row);
    }
  );

  gameSpeedSelect
    ?.addEventListener(
      "change",
      () => {
        if (
          runtimeTimer !== null &&
          !interactionOpen
        ) {
          setRuntimeRunning(
            true,
            `Running · ${speedLabel(
              currentSpeedMinutes()
            )}`
          );
        }
      }
    );

  nextDayButton
    ?.addEventListener(
      "click",
      async () => {
        if (
          !gameLoaded ||
          interactionOpen ||
          advanceInFlight
        ) {
          return;
        }

        await advanceSimulation(
          1440,
          "Advanced exactly one simulated day."
        );
      }
    );

  orderButton
    ?.addEventListener(
      "click",
      () => {
        if (gameLoaded) {
          openHouseStorage(
            "order"
          );
        }
      }
    );

  infoTabs.forEach(
    (tab) =>
      tab.addEventListener(
        "click",
        () => {
          infoTabs.forEach(
            (t) => {
              const a =
                t === tab;

              t.classList.toggle(
                "is-active",
                a
              );

              t.setAttribute(
                "aria-selected",
                a
                  ? "true"
                  : "false"
              );
            }
          );

          infoPanels.forEach(
            (p) => {
              const a =
                p.id ===
                tab.dataset.panel;

              p.hidden = !a;

              p.classList.toggle(
                "is-active",
                a
              );
            }
          );
        }
      )
  );

  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape") {
        closeInspector();
        clearMapSelection();
        cancelPlacement();
      }

      if (
        (
          event.key === "+" ||
          event.key === "="
        ) &&
        !event.target.matches(
          "input, textarea, select"
        )
      ) {
        setMapZoom(
          mapZoom + ZOOM_STEP
        );
      }

      if (
        (
          event.key === "-" ||
          event.key === "_"
        ) &&
        !event.target.matches(
          "input, textarea, select"
        )
      ) {
        setMapZoom(
          mapZoom - ZOOM_STEP
        );
      }

      if (
        event.key === "0" &&
        !event.target.matches(
          "input, textarea, select"
        )
      ) {
        resetMapView();
      }
    }
  );

  function setGameLoaded(name, state) {
    gameLoaded = true;

    currentGameName.textContent =
      name || "Current Game";

    startupOverlay.hidden = true;
    startupStatus.textContent = "";

    renderState(state);

    statusLine.textContent =
      "Select a tile or facility to interact.";

    startRuntime();
  }

  async function beginNewGame() {
    startupStatus.textContent =
      "Creating new game…";

    newGameButton.disabled = true;
    loadGameButton.disabled = true;

    try {
      const r =
        await api(
          "/api/new-game",
          {
            method: "POST",
            body: "{}",
          }
        );

      setGameLoaded(
        r.game_name,
        r.state
      );
    } catch (error) {
      startupStatus.textContent =
        error.message;
    } finally {
      newGameButton.disabled = false;
      loadGameButton.disabled = false;
    }
  }

  async function showSavedGames() {
    startupMainActions.hidden = true;
    loadGamePanel.hidden = false;

    startupStatus.textContent =
      "Loading saved games…";

    saveGameList.replaceChildren();

    try {
      const r =
        await api("/api/saves");

      if (!r.saves?.length) {
        const p =
          document.createElement("p");

        p.className =
          "no-saves-message";

        p.textContent =
          "No saved games found.";

        saveGameList.appendChild(p);
      } else {
        for (const save of r.saves) {
          const b =
            document.createElement("button");

          b.type = "button";
          b.className =
            "save-game-option";

          const strong =
            document.createElement("strong");

          const small =
            document.createElement("small");

          strong.textContent =
            save.label;

          small.textContent =
            save.path;

          b.append(strong, small);

          b.addEventListener(
            "click",
            () =>
              loadSavedGame(save.id)
          );

          saveGameList.appendChild(b);
        }
      }

      startupStatus.textContent = "";
    } catch (error) {
      startupStatus.textContent =
        error.message;
    }
  }

  async function loadSavedGame(id) {
    startupStatus.textContent =
      "Loading game…";

    try {
      const r =
        await api(
          "/api/load-game",
          {
            method: "POST",
            body:
              JSON.stringify({
                save_id: id,
              }),
          }
        );

      setGameLoaded(
        r.game_name,
        r.state
      );
    } catch (error) {
      startupStatus.textContent =
        error.message;
    }
  }

  newGameButton.addEventListener(
    "click",
    beginNewGame
  );

  loadGameButton.addEventListener(
    "click",
    showSavedGames
  );

  backToStartButton.addEventListener(
    "click",
    () => {
      loadGamePanel.hidden = true;
      startupMainActions.hidden = false;
      startupStatus.textContent = "";
    }
  );

  async function initialize() {
    renderMapTransform();
    setRuntimeRunning(false);

    try {
      const s =
        await api("/api/session");

      if (s.game_loaded) {
        const state =
          await api(
            "/api/simulation"
          );

        setGameLoaded(
          s.game_name,
          state
        );
      }
    } catch (error) {
      startupStatus.textContent =
        error.message;
    }
  }

  initialize();
}