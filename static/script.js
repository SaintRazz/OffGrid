"use strict";

const landGrid = document.getElementById("land-grid");

if (landGrid) {
  const gridSize = 42;
  const placements = [];
  const definitionsById = new Map();

  const buildList = document.getElementById("build-list");
  const cancelButton = document.getElementById("cancel-building");
  const tickButton = document.getElementById("advance-tick");
  const status = document.getElementById("placement-status");
  const currentGameName = document.getElementById("current-game-name");

  const infoTabs = document.querySelectorAll(".info-tab");
  const infoPanels = document.querySelectorAll(".info-panel");

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

  const mapViewport = document.getElementById("map-viewport");
  const zoomInButton = document.getElementById("zoom-in");
  const zoomOutButton = document.getElementById("zoom-out");
  const zoomResetButton = document.getElementById("zoom-reset");
  const zoomLevel = document.getElementById("zoom-level");

  let selectedId = null;
  let hoverPosition = null;
  let preview = null;
  let simulationState = null;

  const MIN_ZOOM = 1;
  const MAX_ZOOM = 4;
  const ZOOM_STEP = 0.25;
  const DRAG_THRESHOLD_PX = 5;

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

  // ============================================================
  // Map grid
  // ============================================================

  for (let row = 0; row < gridSize; row += 1) {
    for (let column = 0; column < gridSize; column += 1) {
      const cell = document.createElement("div");
      cell.className = "grid-cell";
      cell.setAttribute("role", "gridcell");
      cell.setAttribute(
        "aria-label",
        `Grass tile, row ${row + 1}, column ${column + 1}`
      );
      cell.dataset.row = row;
      cell.dataset.column = column;
      cell.style.gridRow = String(row + 1);
      cell.style.gridColumn = String(column + 1);
      landGrid.appendChild(cell);
    }
  }

  // ============================================================
  // Formatting helpers
  // ============================================================

  function formatAmount(amount) {
    return new Intl.NumberFormat(undefined, {
      maximumFractionDigits: 4,
    }).format(amount ?? 0);
  }

  function prettyName(value) {
    return String(value)
      .replaceAll("_", " ")
      .replaceAll("-", " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function formatInspectorValue(value) {
    if (value === null || value === undefined) {
      return "—";
    }

    if (typeof value === "number") {
      return formatAmount(value);
    }

    if (typeof value === "boolean") {
      return value ? "Yes" : "No";
    }

    return String(value);
  }

  function flattenObject(object, prefix = "", result = []) {
    if (!object || typeof object !== "object") {
      return result;
    }

    Object.entries(object).forEach(([key, value]) => {
      const label = prefix
        ? `${prefix} · ${prettyName(key)}`
        : prettyName(key);

      if (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
      ) {
        flattenObject(value, label, result);
        return;
      }

      if (Array.isArray(value)) {
        result.push([
          label,
          value.length ? value.join(", ") : "None",
        ]);
        return;
      }

      result.push([label, formatInspectorValue(value)]);
    });

    return result;
  }

  function isRateField(key) {
    const name = key.toLowerCase();

    return (
      name.includes("rate") ||
      name.includes("yield") ||
      name.includes("processing") ||
      name.includes("degradation") ||
      name.includes("per_day") ||
      name.includes("per_year") ||
      name.includes("per_hour")
    );
  }

  function extractRates(definition) {
    const rates = [];

    function walk(object, prefix = "") {
      if (!object || typeof object !== "object") {
        return;
      }

      Object.entries(object).forEach(([key, value]) => {
        const label = prefix
          ? `${prefix} · ${prettyName(key)}`
          : prettyName(key);

        if (
          value !== null &&
          typeof value === "object" &&
          !Array.isArray(value)
        ) {
          walk(value, label);
          return;
        }

        if (isRateField(key)) {
          rates.push([label, formatInspectorValue(value)]);
        }
      });
    }

    walk(definition);
    return rates;
  }

  function genericDefinitionRows(definition) {
    return flattenObject(definition).filter(([label]) => {
      const lower = label.toLowerCase();

      return (
        lower !== "id" &&
        lower !== "name" &&
        lower !== "image" &&
        !lower.includes("rate") &&
        !lower.includes("yield") &&
        !lower.includes("processing") &&
        !lower.includes("degradation") &&
        !lower.includes("per day") &&
        !lower.includes("per year") &&
        !lower.includes("per hour")
      );
    });
  }

  // ============================================================
  // Map navigation
  // ============================================================

  function clamp(value, minimum, maximum) {
    return Math.min(
      maximum,
      Math.max(minimum, value)
    );
  }

  function clampMapPan(
    panX = mapPanX,
    panY = mapPanY,
    zoom = mapZoom
  ) {
    const viewportWidth =
      mapViewport.clientWidth;

    const viewportHeight =
      mapViewport.clientHeight;

    const contentWidth =
      landGrid.offsetWidth * zoom;

    const contentHeight =
      landGrid.offsetHeight * zoom;

    const minimumX =
      Math.min(
        0,
        viewportWidth - contentWidth
      );

    const minimumY =
      Math.min(
        0,
        viewportHeight - contentHeight
      );

    return {
      x: clamp(
        panX,
        minimumX,
        0
      ),

      y: clamp(
        panY,
        minimumY,
        0
      ),
    };
  }

  function renderMapTransform() {
    const clamped =
      clampMapPan();

    mapPanX = clamped.x;
    mapPanY = clamped.y;

    landGrid.style.transform =
      `translate(${mapPanX}px, ${mapPanY}px) ` +
      `scale(${mapZoom})`;

    zoomLevel.textContent =
      `${Math.round(mapZoom * 100)}%`;

    mapViewport.classList.toggle(
      "is-zoomed",
      mapZoom > 1
    );

    zoomOutButton.disabled =
      mapZoom <= MIN_ZOOM;

    zoomInButton.disabled =
      mapZoom >= MAX_ZOOM;
  }

  function setMapZoom(
    requestedZoom,
    focalClientX = null,
    focalClientY = null
  ) {
    const newZoom =
      clamp(
        requestedZoom,
        MIN_ZOOM,
        MAX_ZOOM
      );

    if (newZoom === mapZoom) {
      return;
    }

    const viewportRect =
      mapViewport.getBoundingClientRect();

    const focalX =
      focalClientX == null
        ? viewportRect.width / 2
        : focalClientX -
          viewportRect.left;

    const focalY =
      focalClientY == null
        ? viewportRect.height / 2
        : focalClientY -
          viewportRect.top;

    /*
     * Find the map-space point currently under the cursor, then
     * calculate the new pan so that same point stays under it.
     */
    const mapX =
      (focalX - mapPanX) /
      mapZoom;

    const mapY =
      (focalY - mapPanY) /
      mapZoom;

    mapPanX =
      focalX -
      mapX * newZoom;

    mapPanY =
      focalY -
      mapY * newZoom;

    mapZoom = newZoom;

    renderMapTransform();
  }

  function resetMapView() {
    mapZoom = 1;
    mapPanX = 0;
    mapPanY = 0;
    renderMapTransform();
  }

  function zoomMapBy(
    delta,
    focalClientX = null,
    focalClientY = null
  ) {
    setMapZoom(
      mapZoom + delta,
      focalClientX,
      focalClientY
    );
  }

  mapViewport.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();

      const direction =
        event.deltaY < 0
          ? ZOOM_STEP
          : -ZOOM_STEP;

      zoomMapBy(
        direction,
        event.clientX,
        event.clientY
      );
    },
    {
      passive: false,
    }
  );

  zoomInButton.addEventListener(
    "click",
    () => {
      zoomMapBy(ZOOM_STEP);
    }
  );

  zoomOutButton.addEventListener(
    "click",
    () => {
      zoomMapBy(-ZOOM_STEP);
    }
  );

  zoomResetButton.addEventListener(
    "click",
    resetMapView
  );

  /*
   * Important:
   * We do NOT capture the pointer here.
   *
   * A normal mouse-down / mouse-up should remain a normal click
   * so the underlying tile or facility can still be selected.
   *
   * Pointer capture begins only after movement exceeds the drag
   * threshold in the pointermove handler below.
   */
  mapViewport.addEventListener(
    "pointerdown",
    (event) => {
      if (
        event.button !== 0 ||
        selectedId ||
        mapZoom <= 1
      ) {
        return;
      }

      mapPointerDown = true;
      mapPointerId = event.pointerId;
      mapDragStarted = false;

      dragStartX = event.clientX;
      dragStartY = event.clientY;
      dragStartPanX = mapPanX;
      dragStartPanY = mapPanY;
    }
  );

  mapViewport.addEventListener(
    "pointermove",
    (event) => {
      if (
        !mapPointerDown ||
        event.pointerId !==
          mapPointerId
      ) {
        return;
      }

      const deltaX =
        event.clientX -
        dragStartX;

      const deltaY =
        event.clientY -
        dragStartY;

      if (!mapDragStarted) {
        const distance =
          Math.hypot(
            deltaX,
            deltaY
          );

        if (
          distance <
          DRAG_THRESHOLD_PX
        ) {
          return;
        }

        mapDragStarted = true;

        /*
         * Only capture after we've established that this gesture
         * is actually a drag rather than an ordinary click.
         */
        mapViewport.setPointerCapture(
          event.pointerId
        );

        mapViewport.classList.add(
          "is-dragging"
        );

        clearMapSelection();
      }

      event.preventDefault();

      const clamped =
        clampMapPan(
          dragStartPanX +
            deltaX,
          dragStartPanY +
            deltaY
        );

      mapPanX = clamped.x;
      mapPanY = clamped.y;

      renderMapTransform();
    }
  );

  function finishMapDrag(event) {
    if (
      !mapPointerDown ||
      event.pointerId !==
        mapPointerId
    ) {
      return;
    }

    if (mapDragStarted) {
      suppressNextMapClick = true;
    }

    mapPointerDown = false;
    mapPointerId = null;
    mapDragStarted = false;

    mapViewport.classList.remove(
      "is-dragging"
    );

    if (
      mapViewport.hasPointerCapture(
        event.pointerId
      )
    ) {
      mapViewport.releasePointerCapture(
        event.pointerId
      );
    }
  }

  mapViewport.addEventListener(
    "pointerup",
    finishMapDrag
  );

  mapViewport.addEventListener(
    "pointercancel",
    finishMapDrag
  );

  window.addEventListener(
    "resize",
    renderMapTransform
  );

  // ============================================================
  // Placement helpers
  // ============================================================

  function footprint() {
    return definitionsById.get(selectedId) ?? null;
  }

  function canPlace(column, row, width, height) {
    if (
      column + width > gridSize ||
      row + height > gridSize
    ) {
      return false;
    }

    return placements.every(
      (placed) =>
        column + width <= placed.column ||
        placed.column + placed.width <= column ||
        row + height <= placed.row ||
        placed.row + placed.height <= row
    );
  }

  function removePreview() {
    preview?.remove();
    preview = null;
  }

  function showPreview(column, row) {
    hoverPosition = { column, row };
    removePreview();

    const building = footprint();

    if (!building) {
      return;
    }

    preview = document.createElement("img");
    preview.className = "building-sprite building-preview";
    preview.src = `/static/assets/sprites/${building.image}`;
    preview.alt = "";
    preview.style.gridColumn =
      `${column + 1} / span ${building.width}`;
    preview.style.gridRow =
      `${row + 1} / span ${building.height}`;

    preview.classList.add(
      canPlace(
        column,
        row,
        building.width,
        building.height
      )
        ? "is-valid"
        : "is-invalid"
    );

    landGrid.appendChild(preview);
  }

  // ============================================================
  // Clock
  // ============================================================

  function setDateAndClock(value) {
    const dateElement =
      document.getElementById("simulation-date");

    const clockElement =
      document.getElementById("simulation-clock");

    if (!value) {
      dateElement.textContent = "Not started";
      clockElement.textContent = "--:--";
      return;
    }

    const date = new Date(value);

    dateElement.textContent =
      new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      }).format(date);

    clockElement.textContent =
      new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
      }).format(date);
  }

  // ============================================================
  // Household displays
  // ============================================================

  function addListItem(list, label, value) {
    const item = document.createElement("li");
    item.textContent = `${label}: ${value}`;
    list.appendChild(item);
  }

  function dailyHouseholdBaseline() {
    const stateBaseline =
      simulationState?.household_baseline_daily ?? {};

    const profile =
      simulationState?.household_profile ?? {};

    return {
      dailyFlows:
        stateBaseline.daily_flows ??
        profile.daily_flows ??
        {},

      electricity:
        stateBaseline.electricity_kwh_per_day ??
        profile.electricity_kwh_per_day ??
        {},
    };
  }

  function renderHouseholdSummary() {
    const list =
      document.getElementById("household-summary-list");

    if (!list) {
      return;
    }

    list.replaceChildren();

    const profile =
      simulationState?.household_profile;

    if (!profile) {
      addListItem(
        list,
        "Household profile",
        "Unavailable"
      );
      return;
    }

    addListItem(
      list,
      "Profile",
      profile.name ??
        profile.profile_id ??
        "Default household"
    );

    addListItem(
      list,
      "Occupants",
      formatAmount(profile.occupants ?? 0)
    );

    addListItem(
      list,
      "House size",
      `${formatAmount(profile.house_sq_ft ?? 0)} sq ft`
    );

    addListItem(
      list,
      "Electrical system",
      profile.all_electric
        ? "All-electric"
        : "Mixed"
    );

    addListItem(
      list,
      "Seasonal model",
      profile.seasonal_modeling
        ? "Enabled"
        : "Annual-average daily values"
    );
  }

  function renderConsumption() {
    const consumptionList =
      document.getElementById("consumption-list");

    const electricityList =
      document.getElementById(
        "electricity-breakdown-list"
      );

    if (
      !consumptionList ||
      !electricityList
    ) {
      return;
    }

    consumptionList.replaceChildren();
    electricityList.replaceChildren();

    const baseline =
      dailyHouseholdBaseline();

    const flows =
      baseline.dailyFlows;

    const electricity =
      baseline.electricity;

    addListItem(
      consumptionList,
      "Groceries",
      `$${formatAmount(
        flows.groceries_usd ?? 0
      )} / day`
    );

    addListItem(
      consumptionList,
      "Tap water",
      `${formatAmount(
        flows.tap_water_gal ?? 0
      )} gal / day`
    );

    addListItem(
      consumptionList,
      "Electricity",
      `${formatAmount(
        electricity.total ?? 0
      )} kWh / day`
    );

    const endUses = [
      [
        "HVAC cooling",
        "hvac_cooling",
      ],
      [
        "HVAC heating",
        "hvac_heating",
      ],
      [
        "Water heating",
        "water_heating",
      ],
      [
        "Refrigeration / freezer",
        "refrigeration_freezer",
      ],
      [
        "Cooking",
        "cooking",
      ],
      [
        "Lighting",
        "lighting",
      ],
      [
        "Laundry",
        "laundry",
      ],
      [
        "Electronics / personal plug loads",
        "electronics_personal_plug_loads",
      ],
      [
        "Other household electrical loads",
        "other_household_electrical_loads",
      ],
    ];

    endUses.forEach(
      ([label, key]) => {
        if (
          electricity[key] == null
        ) {
          return;
        }

        addListItem(
          electricityList,
          label,
          `${formatAmount(
            electricity[key]
          )} kWh / day`
        );
      }
    );
  }

  function renderWasteWater() {
    const list =
      document.getElementById(
        "waste-water-list"
      );

    if (!list) {
      return;
    }

    list.replaceChildren();

    const {
      dailyFlows: flows,
    } =
      dailyHouseholdBaseline();

    const rows = [
      [
        "Greywater",
        "greywater_gal",
        "gal / day",
      ],
      [
        "Blackwater",
        "blackwater_gal",
        "gal / day",
      ],
      [
        "Other water use",
        "other_water_use_gal",
        "gal / day",
      ],
      [
        "Kitchen waste",
        "kitchen_waste_lb",
        "lb / day",
      ],
      [
        "Recyclable paper / cardboard",
        "recyclable_paper_lb",
        "lb / day",
      ],
      [
        "Recyclable plastic",
        "recyclable_plastic_lb",
        "lb / day",
      ],
      [
        "Recyclable glass",
        "recyclable_glass_lb",
        "lb / day",
      ],
      [
        "Recyclable metal",
        "recyclable_metal_lb",
        "lb / day",
      ],
      [
        "Residual non-food waste",
        "residual_nonfood_waste_lb",
        "lb / day",
      ],
    ];

    rows.forEach(
      ([label, key, unit]) => {
        addListItem(
          list,
          label,
          `${formatAmount(
            flows[key] ?? 0
          )} ${unit}`
        );
      }
    );

    const greywater =
      Number(
        flows.greywater_gal ?? 0
      );

    const blackwater =
      Number(
        flows.blackwater_gal ?? 0
      );

    addListItem(
      list,
      "Total wastewater",
      `${formatAmount(
        greywater + blackwater
      )} gal / day`
    );
  }

  // ============================================================
  // Map object inspector
  // ============================================================

  function clearMapSelection() {
    landGrid
      .querySelectorAll(
        ".is-map-selected"
      )
      .forEach((element) => {
        element.classList.remove(
          "is-map-selected"
        );
      });
  }

  function markSelectedTile(
    column,
    row
  ) {
    clearMapSelection();

    const cell =
      landGrid.querySelector(
        `.grid-cell[data-column="${column}"][data-row="${row}"]`
      );

    cell?.classList.add(
      "is-map-selected"
    );
  }

  function markSelectedInstance(
    instanceId
  ) {
    clearMapSelection();

    const sprite =
      landGrid.querySelector(
        `.placed-building[data-instance-id="${instanceId}"]`
      );

    sprite?.classList.add(
      "is-map-selected"
    );
  }

  function makeInspectorSection(
    title,
    rows
  ) {
    if (!rows.length) {
      return null;
    }

    const section =
      document.createElement(
        "section"
      );

    section.className =
      "object-inspector-section";

    const heading =
      document.createElement("h3");

    heading.textContent =
      title;

    section.appendChild(
      heading
    );

    const list =
      document.createElement("dl");

    list.className =
      "object-inspector-stats";

    rows.forEach(
      ([label, value]) => {
        const term =
          document.createElement(
            "dt"
          );

        const detail =
          document.createElement(
            "dd"
          );

        term.textContent =
          label;

        detail.textContent =
          String(
            value ?? "—"
          );

        list.append(
          term,
          detail
        );
      }
    );

    section.appendChild(
      list
    );

    return section;
  }

  function openInspector({
    title,
    subtitle,
    genericRows = [],
    rateRows = [],
    stateRows = [],
    operationRows = [],
  }) {
    inspectorTitle.textContent =
      title;

    inspectorSubtitle.textContent =
      subtitle;

    inspectorContent.replaceChildren();

    [
      [
        "General",
        genericRows,
      ],
      [
        "Rates",
        rateRows,
      ],
      [
        "Current status",
        stateRows,
      ],
      [
        "Current operation",
        operationRows,
      ],
    ].forEach(
      ([sectionTitle, rows]) => {
        const section =
          makeInspectorSection(
            sectionTitle,
            rows
          );

        if (section) {
          inspectorContent.appendChild(
            section
          );
        }
      }
    );

    inspectorOverlay.hidden =
      false;

    inspectorCloseButton.focus();
  }

  function closeInspector() {
    inspectorOverlay.hidden =
      true;

    clearMapSelection();
  }

  function inspectFacility(
    instanceId
  ) {
    const instance =
      simulationState
        ?.instances
        ?.find(
          (candidate) =>
            candidate.instance_id ===
            instanceId
        );

    if (!instance) {
      return;
    }

    const definition =
      definitionsById.get(
        instance.facility_id
      );

    if (!definition) {
      return;
    }

    markSelectedInstance(
      instance.instance_id
    );

    const condition =
      Number(
        instance.condition ?? 1
      );

    const stateRows = [
      [
        "Instance",
        instance.instance_id,
      ],
      [
        "Location",
        `row ${instance.row + 1}, column ${instance.column + 1}`,
      ],
      [
        "Condition",
        `${formatAmount(
          condition * 100
        )}%`,
      ],
      [
        "Deterioration",
        `${formatAmount(
          (1 - condition) * 100
        )}%`,
      ],
      [
        "Accrued labor",
        `${formatAmount(
          instance.accrued_labor_requirement ?? 0
        )} h`,
      ],
    ];

    const container =
      definition.container ??
      null;

    if (container) {
      const capacity =
        container.capacity;

      const unit =
        container.unit ??
        container.capacity_unit ??
        "";

      if (
        capacity != null
      ) {
        stateRows.push([
          "Capacity",
          `${formatAmount(
            capacity
          )}${unit ? ` ${unit}` : ""}`,
        ]);
      }

      if (
        instance.current_fill != null
      ) {
        stateRows.push([
          "Current fill",
          `${formatAmount(
            instance.current_fill
          )}${unit ? ` ${unit}` : ""}`,
        ]);
      }
    }

    const processStates =
      definition
        .process
        ?.process_states ??
      [];

    processStates.forEach(
      (stateName) => {
        if (
          instance[stateName] !=
          null
        ) {
          stateRows.push([
            prettyName(
              stateName
            ),
            formatInspectorValue(
              instance[stateName]
            ),
          ]);
        }
      }
    );

    const operationRows =
      instance.last_operation
        ? flattenObject(
            instance.last_operation
          )
        : [
            [
              "Status",
              "Awaiting first tick",
            ],
          ];

    openInspector({
      title:
        definition.name,

      subtitle:
        `${instance.width * 5} × ` +
        `${instance.height * 5} ft facility`,

      genericRows:
        genericDefinitionRows(
          definition
        ),

      rateRows:
        extractRates(
          definition
        ),

      stateRows,
      operationRows,
    });
  }

  function inspectDefaultTile(
    column,
    row
  ) {
    const defaultTileId =
      simulationState
        ?.map
        ?.default_tile ??
      "grass-tile";

    const definition =
      definitionsById.get(
        defaultTileId
      );

    if (!definition) {
      return;
    }

    markSelectedTile(
      column,
      row
    );

    const tileState =
      simulationState
        ?.tile_states
        ?.find(
          (tile) => {
            const tileColumn =
              tile.column ??
              tile.x;

            const tileRow =
              tile.row ??
              tile.y;

            return (
              tileColumn ===
                column &&
              tileRow ===
                row
            );
          }
        );

    const stateRows = [
      [
        "Location",
        `row ${row + 1}, column ${column + 1}`,
      ],
      [
        "Land state",
        tileState
          ? "Explicit tile state"
          : "Unimproved grass",
      ],
      [
        "Condition",
        "Not individually tracked",
      ],
    ];

    if (tileState) {
      flattenObject(
        tileState
      )
        .filter(
          ([label]) =>
            ![
              "Column",
              "Row",
              "X",
              "Y",
              "Type",
            ].includes(
              label
            )
        )
        .forEach(
          (rowValue) => {
            stateRows.push(
              rowValue
            );
          }
        );
    }

    openInspector({
      title:
        definition.name ??
        prettyName(
          defaultTileId
        ),

      subtitle:
        `5 × 5 ft tile · row ${row + 1}, column ${column + 1}`,

      genericRows:
        genericDefinitionRows(
          definition
        ),

      rateRows:
        extractRates(
          definition
        ),

      stateRows,

      operationRows: [
        [
          "Status",
          "Active default land tile",
        ],
      ],
    });
  }

  inspectorCloseButton
    .addEventListener(
      "click",
      closeInspector
    );

  inspectorOverlay
    .addEventListener(
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

  // ============================================================
  // Resource display
  // ============================================================

  function renderResources() {
    const resourceList =
      document.getElementById(
        "resource-list"
      );

    resourceList.replaceChildren();

    Object.entries(
      simulationState
        ?.resources ??
      {}
    ).forEach(
      ([
        resourceId,
        resource,
      ]) => {
        const item =
          document.createElement(
            "li"
          );

        item.textContent =
          `${resource.name}: ` +
          `${formatAmount(
            resource.amount
          )} ${resource.unit}`;

        resourceList.appendChild(
          item
        );
      }
    );
  }

  function formatFlows(
    flows = {}
  ) {
    return Object.entries(
      flows ?? {}
    )
      .map(
        ([
          resourceId,
          amount,
        ]) => {
          const resource =
            simulationState
              ?.resources
              ?.[resourceId];

          if (!resource) {
            return (
              `${formatAmount(
                amount
              )} ${resourceId}`
            );
          }

          return (
            `${formatAmount(
              amount
            )} ` +
            `${resource.unit} ` +
            `${resource.name.toLowerCase()}`
          );
        }
      )
      .join(", ");
  }

  // ============================================================
  // Facility operations
  // ============================================================

  function renderOperations() {
    const list =
      document.getElementById(
        "facility-status-list"
      );

    list.replaceChildren();

    if (
      !simulationState
        ?.instances
        ?.length
    ) {
      const item =
        document.createElement(
          "li"
        );

      item.textContent =
        "No facilities placed.";

      list.appendChild(
        item
      );

      return;
    }

    simulationState.instances
      .forEach(
        (instance) => {
          const definition =
            definitionsById.get(
              instance.facility_id
            );

          const item =
            document.createElement(
              "li"
            );

          const heading =
            document.createElement(
              "strong"
            );

          heading.textContent =
            `${definition?.name ??
              instance.facility_id} · ` +
            `${instance.instance_id}`;

          item.appendChild(
            heading
          );

          const detail =
            document.createElement(
              "span"
            );

          const operation =
            instance.last_operation;

          if (!operation) {
            detail.textContent =
              `Tile ${instance.row + 1}, ` +
              `${instance.column + 1} · ` +
              "awaiting first tick";
          } else {
            const consumed =
              operation.consumed ??
              {};

            const produced =
              operation.produced ??
              {};

            const flows = [];

            if (
              Object.keys(
                consumed
              ).length
            ) {
              flows.push(
                `used ${formatFlows(
                  consumed
                )}`
              );
            }

            if (
              Object.keys(
                produced
              ).length
            ) {
              flows.push(
                `made ${formatFlows(
                  produced
                )}`
              );
            }

            let statusText;

            if (
              operation.status ===
              "operating"
            ) {
              statusText =
                operation
                  .utilization_pct !=
                null
                  ? `Operating ${operation.utilization_pct}%`
                  : "Operating";
            } else if (
              operation.status ===
              "collecting"
            ) {
              statusText =
                "Collecting";
            } else if (
              operation.status ===
              "full"
            ) {
              statusText =
                "Full";
            } else if (
              operation.status ===
              "error"
            ) {
              statusText =
                `Error: ${
                  operation.reason ??
                  "unknown error"
                }`;
            } else {
              statusText =
                `Idle${
                  operation.reason
                    ? `: ${operation.reason}`
                    : ""
                }`;
            }

            let laborText =
              "";

            if (
              operation
                .labor_used !=
              null
            ) {
              laborText =
                ` · ${formatAmount(
                  operation.labor_used
                )} labor h`;
            } else if (
              operation
                .accrued_labor_requirement !=
              null
            ) {
              laborText =
                ` · ${formatAmount(
                  operation
                    .accrued_labor_requirement
                )} labor h accrued`;
            }

            detail.textContent =
              `Tile ${instance.row + 1}, ` +
              `${instance.column + 1} · ` +
              `${statusText}` +
              laborText +
              (
                flows.length
                  ? ` · ${flows.join("; ")}`
                  : ""
              );
          }

          item.appendChild(
            detail
          );

          list.appendChild(
            item
          );
        }
      );
  }

  // ============================================================
  // Render placed facility
  // ============================================================

  function renderInstance(
    instance
  ) {
    const definition =
      definitionsById.get(
        instance.facility_id
      );

    if (!definition) {
      return;
    }

    const sprite =
      document.createElement(
        "img"
      );

    sprite.className =
      "building-sprite placed-building";

    sprite.dataset.instanceId =
      instance.instance_id;

    sprite.src =
      `/static/assets/sprites/${definition.image}`;

    sprite.alt =
      `${definition.name}, ` +
      `${instance.width * 5} by ` +
      `${instance.height * 5} feet`;

    sprite.draggable =
      false;

    sprite.style.gridColumn =
      `${instance.column + 1} / ` +
      `span ${instance.width}`;

    sprite.style.gridRow =
      `${instance.row + 1} / ` +
      `span ${instance.height}`;

    landGrid.appendChild(
      sprite
    );

    placements.push(
      instance
    );
  }

  // ============================================================
  // Main state render
  // ============================================================

  function renderState() {
    if (!simulationState) {
      return;
    }

    setDateAndClock(
      simulationState
        .current_time
    );

    renderHouseholdSummary();
    renderConsumption();
    renderWasteWater();
    renderResources();
    renderOperations();
  }

  // ============================================================
  // API helper
  // ============================================================

  async function requestJson(
    url,
    options = {}
  ) {
    const response =
      await fetch(
        url,
        options
      );

    let result;

    try {
      result =
        await response.json();
    } catch {
      throw new Error(
        `Server returned an invalid response (${response.status}).`
      );
    }

    if (!response.ok) {
      throw new Error(
        result.error ||
        "Simulation request failed."
      );
    }

    return result;
  }

  // ============================================================
  // Build menu
  // ============================================================

  function createBuildOptions(
    definitions
  ) {
    buildList.replaceChildren();
    definitionsById.clear();

    definitions.forEach(
      (definition) => {
        definitionsById.set(
          definition.id,
          definition
        );

        const button =
          document.createElement(
            "button"
          );

        button.className =
          "build-option";

        button.type =
          "button";

        button.dataset.building =
          definition.id;

        button.setAttribute(
          "aria-pressed",
          "false"
        );

        const image =
          document.createElement(
            "img"
          );

        image.src =
          `/static/assets/sprites/${definition.image}`;

        image.alt =
          "";

        const label =
          document.createElement(
            "span"
          );

        const name =
          document.createElement(
            "strong"
          );

        name.textContent =
          definition.name;

        const size =
          document.createElement(
            "small"
          );

        size.textContent =
          `${definition.width * 5} × ` +
          `${definition.height * 5} ft`;

        label.append(
          name,
          size
        );

        button.append(
          image,
          label
        );

        buildList.appendChild(
          button
        );
      }
    );

    buildList
      .querySelectorAll(
        ".build-option"
      )
      .forEach(
        (button) => {
          button.addEventListener(
            "click",
            () => {
              selectedId =
                button
                  .dataset
                  .building;

              closeInspector();

              buildList
                .querySelectorAll(
                  ".build-option"
                )
                .forEach(
                  (option) => {
                    option.setAttribute(
                      "aria-pressed",
                      String(
                        option ===
                        button
                      )
                    );
                  }
                );

              cancelButton.disabled =
                false;

              const building =
                footprint();

              if (!building) {
                return;
              }

              status.textContent =
                `${building.name} selected ` +
                `(${building.width * 5} × ` +
                `${building.height * 5} ft). ` +
                "Click an open tile to place.";

              if (
                hoverPosition
              ) {
                showPreview(
                  hoverPosition.column,
                  hoverPosition.row
                );
              }
            }
          );
        }
      );
  }

  // ============================================================
  // Clear/reset game rendering
  // ============================================================

  function clearRenderedGame() {
    selectedId = null;
    hoverPosition = null;

    removePreview();
    closeInspector();

    placements.length = 0;

    landGrid
      .querySelectorAll(
        ".placed-building"
      )
      .forEach(
        (sprite) => {
          sprite.remove();
        }
      );

    buildList.replaceChildren();
    definitionsById.clear();

    cancelButton.disabled =
      true;

    tickButton.disabled =
      true;
  }

  // ============================================================
  // Initialize selected game
  // ============================================================

  function initializeSimulation(
    state,
    gameName = "Current Game"
  ) {
    clearRenderedGame();
    resetMapView();

    simulationState =
      state;

    currentGameName.textContent =
      gameName;

    createBuildOptions(
      simulationState
        .facility_definitions ??
        []
    );

    (
      simulationState
        .instances ??
      []
    ).forEach(
      renderInstance
    );

    renderState();

    tickButton.disabled =
      false;

    startupOverlay.hidden =
      true;

    status.textContent =
      "Click a map tile or facility to inspect it, or select a structure to build.";
  }

  // ============================================================
  // Startup controls
  // ============================================================

  function setStartupBusy(
    isBusy
  ) {
    newGameButton.disabled =
      isBusy;

    loadGameButton.disabled =
      isBusy;

    backToStartButton.disabled =
      isBusy;

    saveGameList
      .querySelectorAll(
        "button"
      )
      .forEach(
        (button) => {
          button.disabled =
            isBusy;
        }
      );
  }

  function showStartupMain() {
    loadGamePanel.hidden =
      true;

    startupMainActions.hidden =
      false;

    startupStatus.textContent =
      "";
  }

  async function startNewGame() {
    setStartupBusy(
      true
    );

    startupStatus.textContent =
      "Starting a new game...";

    try {
      const result =
        await requestJson(
          "/api/new-game",
          {
            method: "POST",
          }
        );

      initializeSimulation(
        result.state,
        result.game_name ??
          "New Game"
      );
    } catch (error) {
      startupStatus.textContent =
        error.message;
    } finally {
      setStartupBusy(
        false
      );
    }
  }

  function makeSaveButton(
    save
  ) {
    const button =
      document.createElement(
        "button"
      );

    button.type =
      "button";

    button.className =
      "save-game-option";

    const title =
      document.createElement(
        "strong"
      );

    title.textContent =
      save.label ||
      save.filename;

    const path =
      document.createElement(
        "small"
      );

    path.textContent =
      save.path ||
      save.filename;

    button.append(
      title,
      path
    );

    button.addEventListener(
      "click",
      async () => {
        setStartupBusy(
          true
        );

        startupStatus.textContent =
          `Loading ${save.filename}...`;

        try {
          const result =
            await requestJson(
              "/api/load-game",
              {
                method:
                  "POST",

                headers: {
                  "Content-Type":
                    "application/json",
                },

                body:
                  JSON.stringify({
                    save_id:
                      save.id,
                  }),
              }
            );

          initializeSimulation(
            result.state,
            result.game_name ??
              save.label ??
              save.filename
          );
        } catch (error) {
          startupStatus.textContent =
            error.message;
        } finally {
          setStartupBusy(
            false
          );
        }
      }
    );

    return button;
  }

  async function showLoadGamePanel() {
    setStartupBusy(
      true
    );

    startupStatus.textContent =
      "Looking for saved games...";

    try {
      const result =
        await requestJson(
          "/api/saves"
        );

      const saves =
        result.saves ??
        [];

      saveGameList.replaceChildren();

      if (!saves.length) {
        const empty =
          document.createElement(
            "p"
          );

        empty.className =
          "no-saves-message";

        empty.textContent =
          "No saved games were found.";

        saveGameList.appendChild(
          empty
        );
      } else {
        saves.forEach(
          (save) => {
            saveGameList.appendChild(
              makeSaveButton(
                save
              )
            );
          }
        );
      }

      startupMainActions.hidden =
        true;

      loadGamePanel.hidden =
        false;

      startupStatus.textContent =
        "";
    } catch (error) {
      startupStatus.textContent =
        error.message;
    } finally {
      setStartupBusy(
        false
      );
    }
  }

  newGameButton
    .addEventListener(
      "click",
      startNewGame
    );

  loadGameButton
    .addEventListener(
      "click",
      showLoadGamePanel
    );

  backToStartButton
    .addEventListener(
      "click",
      showStartupMain
    );

  // ============================================================
  // Left-side tabs
  // ============================================================

  function activateInfoPanel(
    panelId
  ) {
    infoTabs.forEach(
      (tab) => {
        const active =
          tab.dataset.panel ===
          panelId;

        tab.classList.toggle(
          "is-active",
          active
        );

        tab.setAttribute(
          "aria-selected",
          String(
            active
          )
        );
      }
    );

    infoPanels.forEach(
      (panel) => {
        const active =
          panel.id ===
          panelId;

        panel.classList.toggle(
          "is-active",
          active
        );

        panel.hidden =
          !active;
      }
    );
  }

  infoTabs.forEach(
    (tab) => {
      tab.addEventListener(
        "click",
        () => {
          activateInfoPanel(
            tab.dataset.panel
          );
        }
      );
    }
  );

  // ============================================================
  // Map hover: building placement preview only
  // ============================================================

  landGrid.addEventListener(
    "pointerover",
    (event) => {
      if (!selectedId) {
        return;
      }

      const cell =
        event.target.closest(
          ".grid-cell"
        );

      if (!cell) {
        return;
      }

      showPreview(
        Number(
          cell.dataset.column
        ),
        Number(
          cell.dataset.row
        )
      );
    }
  );

  // ============================================================
  // Map click: inspect or place
  // ============================================================

  landGrid.addEventListener(
    "click",
    async (event) => {
      if (!simulationState) {
        return;
      }

      /*
       * A drag is followed by a synthetic click in most browsers.
       * Ignore exactly one click after a genuine map pan.
       */
      if (
        suppressNextMapClick
      ) {
        suppressNextMapClick =
          false;

        return;
      }

      const placedSprite =
        event.target.closest(
          ".placed-building"
        );

      /*
       * No build tool selected:
       * inspect the object occupying the clicked location.
       */
      if (!selectedId) {
        if (placedSprite) {
          inspectFacility(
            placedSprite
              .dataset
              .instanceId
          );

          return;
        }

        const cell =
          event.target.closest(
            ".grid-cell"
          );

        if (!cell) {
          return;
        }

        inspectDefaultTile(
          Number(
            cell.dataset.column
          ),
          Number(
            cell.dataset.row
          )
        );

        return;
      }

      /*
       * Build tool selected:
       * left-click retains placement behavior.
       */
      if (placedSprite) {
        status.textContent =
          "That area is already occupied.";

        return;
      }

      const cell =
        event.target.closest(
          ".grid-cell"
        );

      const building =
        footprint();

      if (
        !cell ||
        !building
      ) {
        return;
      }

      const column =
        Number(
          cell.dataset.column
        );

      const row =
        Number(
          cell.dataset.row
        );

      if (
        !canPlace(
          column,
          row,
          building.width,
          building.height
        )
      ) {
        status.textContent =
          "That footprint is out of bounds or overlaps another structure.";

        return;
      }

      try {
        const instance =
          await requestJson(
            "/api/facilities",
            {
              method:
                "POST",

              headers: {
                "Content-Type":
                  "application/json",
              },

              body:
                JSON.stringify({
                  facility_id:
                    selectedId,
                  column,
                  row,
                }),
            }
          );

        if (
          !simulationState
            .instances
        ) {
          simulationState.instances =
            [];
        }

        simulationState.instances.push(
          instance
        );

        renderInstance(
          instance
        );

        renderOperations();

        status.textContent =
          `${building.name} placed at ` +
          `tile ${row + 1}, ` +
          `${column + 1}.`;

        showPreview(
          column,
          row
        );
      } catch (error) {
        status.textContent =
          error.message;
      }
    }
  );

  // ============================================================
  // Advance one hour
  // ============================================================

  tickButton.addEventListener(
    "click",
    async () => {
      if (!simulationState) {
        return;
      }

      tickButton.disabled =
        true;

      try {
        const result =
          await requestJson(
            "/api/tick",
            {
              method:
                "POST",
            }
          );

        simulationState =
          result.state;

        renderState();

        const operations =
          result.operations ??
          [];

        const operating =
          operations.filter(
            (operation) =>
              operation.status ===
              "operating"
          ).length;

        const processedLabel =
          result.state
            ?.current_time
            ? new Date(
                result
                  .state
                  .current_time
              ).toLocaleString()
            : (
                `day ${
                  result
                    .processed_at
                    ?.day ??
                  "?"
                }, hour ${
                  result
                    .processed_at
                    ?.hour ??
                  "?"
                }`
              );

        status.textContent =
          `Hour processed: ` +
          `${processedLabel}. ` +
          `${operating} of ` +
          `${operations.length} ` +
          "operations active.";
      } catch (error) {
        status.textContent =
          error.message;
      } finally {
        tickButton.disabled =
          false;
      }
    }
  );

  // ============================================================
  // Cancel placement
  // ============================================================

  function cancelPlacement() {
    selectedId =
      null;

    removePreview();

    buildList
      .querySelectorAll(
        ".build-option"
      )
      .forEach(
        (button) => {
          button.setAttribute(
            "aria-pressed",
            "false"
          );
        }
      );

    cancelButton.disabled =
      true;

    status.textContent =
      simulationState
        ? "Click a map tile or facility to inspect it, or select a structure to build."
        : "Choose New Game or Load Game to begin.";
  }

  cancelButton.addEventListener(
    "click",
    cancelPlacement
  );

  // ============================================================
  // Keyboard
  // ============================================================

  document.addEventListener(
    "keydown",
    (event) => {
      if (
        event.key === "+" ||
        event.key === "="
      ) {
        zoomMapBy(
          ZOOM_STEP
        );

        return;
      }

      if (
        event.key === "-" ||
        event.key === "_"
      ) {
        zoomMapBy(
          -ZOOM_STEP
        );

        return;
      }

      if (
        event.key === "0"
      ) {
        resetMapView();

        return;
      }

      if (
        event.key !==
        "Escape"
      ) {
        return;
      }

      if (
        inspectorOverlay &&
        !inspectorOverlay.hidden
      ) {
        closeInspector();
      } else {
        cancelPlacement();
      }
    }
  );

  // ============================================================
  // Initial application state
  // ============================================================

  clearRenderedGame();
  resetMapView();

  currentGameName.textContent =
    "No game loaded";

  startupOverlay.hidden =
    false;

  showStartupMain();
}