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
  let inspectorMode = "summary";

  for (let row = 0; row < GRID_SIZE; row += 1) {
    for (let column = 0; column < GRID_SIZE; column += 1) {
      const cell = document.createElement("div");

      cell.className = "grid-cell";
      cell.dataset.row = String(row);
      cell.dataset.column = String(column);
      cell.style.gridRow = String(row + 1);
      cell.style.gridColumn = String(column + 1);

      cell.setAttribute("role", "gridcell");
      cell.setAttribute(
        "aria-label",
        `Grass tile, row ${row + 1}, column ${column + 1}`
      );

      landGrid.appendChild(cell);
    }
  }

  function formatAmount(value, digits = 4) {
    return new Intl.NumberFormat(
      undefined,
      {
        maximumFractionDigits: digits,
      }
    ).format(Number(value ?? 0));
  }

  function prettyName(value) {
    return String(value ?? "")
      .replaceAll("_", " ")
      .replaceAll("-", " ")
      .replace(
        /\b\w/g,
        (letter) => letter.toUpperCase()
      );
  }

  function resourceDefinition(resourceId) {
    return (
      simulationState
        ?.resource_definitions
        ?.[resourceId] ??
      null
    );
  }

  function resourceLabel(resourceId) {
    return (
      resourceDefinition(resourceId)
        ?.name ??
      prettyName(resourceId)
    );
  }

  function resourceUnit(resourceId) {
    return (
      resourceDefinition(resourceId)
        ?.unit ??
      (
        resourceId === "chicken"
          ? "bird"
          : "lb"
      )
    );
  }

  function addListItem(list, label, value) {
    const item =
      document.createElement("li");

    item.textContent =
      `${label}: ${value}`;

    list.appendChild(item);
  }

  async function api(url, options = {}) {
    const response =
      await fetch(
        url,
        {
          headers: {
            "Content-Type":
              "application/json",

            ...(options.headers ?? {}),
          },

          ...options,
        }
      );

    const data =
      await response
        .json()
        .catch(
          () => ({})
        );

    if (!response.ok) {
      throw new Error(
        data.error ||
        `${response.status} ${response.statusText}`
      );
    }

    return data;
  }

  // ============================================================
  // Runtime
  // ============================================================

  function currentSpeedMinutes() {
    const value =
      Number(
        gameSpeedSelect
          ?.value ??
        1
      );

    return (
      Number.isFinite(value) &&
      value > 0
        ? Math.floor(value)
        : 1
    );
  }

  function speedLabel(minutes) {
    if (minutes === 1) {
      return "1 sim min / real sec";
    }

    if (minutes === 30) {
      return "30 sim min / real sec";
    }

    if (minutes === 60) {
      return "1 sim hour / real sec";
    }

    if (minutes === 1440) {
      return "1 sim day / real sec";
    }

    return (
      `${minutes} sim min / real sec`
    );
  }

  function setRuntimeRunning(
    running,
    label = null
  ) {
    runtimeStatus
      ?.classList
      .toggle(
        "is-running",
        running
      );

    if (runtimeLabel) {
      runtimeLabel.textContent =
        label ??
        (
          running
            ? "Running"
            : "Paused"
        );
    }
  }

  function startRuntime() {
    if (
      runtimeTimer !== null ||
      interactionOpen ||
      !gameLoaded
    ) {
      return;
    }

    setRuntimeRunning(
      true,
      `Running · ${speedLabel(
        currentSpeedMinutes()
      )}`
    );

    runtimeTimer =
      window.setInterval(
        runGamePulse,
        GAME_PULSE_MS
      );
  }

  function stopRuntime(
    label = "Paused"
  ) {
    if (runtimeTimer !== null) {
      window.clearInterval(
        runtimeTimer
      );

      runtimeTimer = null;
    }

    setRuntimeRunning(
      false,
      label
    );
  }

  async function advanceSimulation(
    minutes,
    statusMessage = null
  ) {
    if (
      !gameLoaded ||
      advanceInFlight ||
      interactionOpen
    ) {
      return null;
    }

    advanceInFlight = true;

    if (nextDayButton) {
      nextDayButton.disabled = true;
    }

    try {
      const result =
        await api(
          "/api/advance",
          {
            method: "POST",

            body:
              JSON.stringify(
                {
                  minutes,
                }
              ),
          }
        );

      renderState(
        result.state,
        result.activity ??
          result.movement ??
          null
      );

      if (statusMessage) {
        statusLine.textContent =
          statusMessage;
      }

      return result;
    } catch (error) {
      stopRuntime("Stopped");

      statusLine.textContent =
        `Automatic time stopped: ${error.message}`;

      return null;
    } finally {
      advanceInFlight = false;

      if (nextDayButton) {
        nextDayButton.disabled =
          false;
      }
    }
  }

  async function runGamePulse() {
    await advanceSimulation(
      currentSpeedMinutes()
    );
  }

  function setDateAndClock(state) {
    const dateElement =
      document.getElementById(
        "simulation-date"
      );

    const clockElement =
      document.getElementById(
        "simulation-clock"
      );

    if (!state?.current_time) {
      dateElement.textContent =
        "Not started";

      clockElement.textContent =
        "--:--";

      return;
    }

    const date =
      new Date(
        state.current_time
      );

    dateElement.textContent =
      new Intl.DateTimeFormat(
        undefined,
        {
          year: "numeric",
          month: "short",
          day: "numeric",
        }
      ).format(date);

    clockElement.textContent =
      new Intl.DateTimeFormat(
        undefined,
        {
          hour: "numeric",
          minute: "2-digit",
        }
      ).format(date);
  }

  // ============================================================
  // Map zoom and pan
  // ============================================================

  function clamp(
    value,
    minimum,
    maximum
  ) {
    return Math.min(
      maximum,
      Math.max(
        minimum,
        value
      )
    );
  }

  function clampMapPan(
    panX = mapPanX,
    panY = mapPanY,
    zoom = mapZoom
  ) {
    const minimumX =
      Math.min(
        0,
        mapViewport.clientWidth -
          landGrid.offsetWidth *
          zoom
      );

    const minimumY =
      Math.min(
        0,
        mapViewport.clientHeight -
          landGrid.offsetHeight *
          zoom
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

    mapPanX =
      clamped.x;

    mapPanY =
      clamped.y;

    landGrid.style.transform =
      `translate(${mapPanX}px, ${mapPanY}px) scale(${mapZoom})`;

    zoomLevel.textContent =
      `${Math.round(
        mapZoom * 100
      )}%`;

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
    clientX = null,
    clientY = null
  ) {
    const newZoom =
      clamp(
        requestedZoom,
        MIN_ZOOM,
        MAX_ZOOM
      );

    if (
      newZoom === mapZoom
    ) {
      return;
    }

    const rect =
      mapViewport
        .getBoundingClientRect();

    const focalX =
      clientX == null
        ? rect.width / 2
        : clientX -
          rect.left;

    const focalY =
      clientY == null
        ? rect.height / 2
        : clientY -
          rect.top;

    const mapX =
      (
        focalX -
        mapPanX
      ) /
      mapZoom;

    const mapY =
      (
        focalY -
        mapPanY
      ) /
      mapZoom;

    mapPanX =
      focalX -
      mapX *
      newZoom;

    mapPanY =
      focalY -
      mapY *
      newZoom;

    mapZoom =
      newZoom;

    renderMapTransform();
  }

  function resetMapView() {
    mapZoom = 1;
    mapPanX = 0;
    mapPanY = 0;

    renderMapTransform();
  }

  zoomInButton.addEventListener(
    "click",
    () => {
      setMapZoom(
        mapZoom +
        ZOOM_STEP
      );
    }
  );

  zoomOutButton.addEventListener(
    "click",
    () => {
      setMapZoom(
        mapZoom -
        ZOOM_STEP
      );
    }
  );

  zoomResetButton.addEventListener(
    "click",
    resetMapView
  );

  window.addEventListener(
    "resize",
    renderMapTransform
  );

  mapViewport.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();

      setMapZoom(
        mapZoom +
        (
          event.deltaY < 0
            ? ZOOM_STEP
            : -ZOOM_STEP
        ),
        event.clientX,
        event.clientY
      );
    },
    {
      passive: false,
    }
  );

  mapViewport.addEventListener(
    "pointerdown",
    (event) => {
      if (
        event.button !== 0 ||
        selectedBuildId ||
        mapZoom <= 1
      ) {
        return;
      }

      mapPointerDown = true;

      mapPointerId =
        event.pointerId;

      mapDragStarted = false;

      dragStartX =
        event.clientX;

      dragStartY =
        event.clientY;

      dragStartPanX =
        mapPanX;

      dragStartPanY =
        mapPanY;
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
        if (
          Math.hypot(
            deltaX,
            deltaY
          ) <
          DRAG_THRESHOLD_PX
        ) {
          return;
        }

        mapDragStarted = true;

        mapViewport.setPointerCapture(
          event.pointerId
        );

        mapViewport.classList.add(
          "is-dragging"
        );

        clearMapSelection();

        closeInspector();
      }

      event.preventDefault();

      const clamped =
        clampMapPan(
          dragStartPanX +
          deltaX,
          dragStartPanY +
          deltaY
        );

      mapPanX =
        clamped.x;

      mapPanY =
        clamped.y;

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
      suppressNextMapClick =
        true;
    }

    mapPointerDown = false;
    mapPointerId = null;

    mapViewport.classList.remove(
      "is-dragging"
    );

    if (
      mapDragStarted &&
      mapViewport.hasPointerCapture(
        event.pointerId
      )
    ) {
      mapViewport.releasePointerCapture(
        event.pointerId
      );
    }

    mapDragStarted = false;
  }

  mapViewport.addEventListener(
    "pointerup",
    finishMapDrag
  );

  mapViewport.addEventListener(
    "pointercancel",
    finishMapDrag
  );

  function mapCoordinatesFromClient(
    clientX,
    clientY
  ) {
    const rect =
      landGrid.getBoundingClientRect();

    return {
      column:
        clamp(
          Math.floor(
            (
              clientX -
              rect.left
            ) /
            (
              rect.width /
              GRID_SIZE
            )
          ),
          0,
          GRID_SIZE - 1
        ),

      row:
        clamp(
          Math.floor(
            (
              clientY -
              rect.top
            ) /
            (
              rect.height /
              GRID_SIZE
            )
          ),
          0,
          GRID_SIZE - 1
        ),
    };
  }

  // ============================================================
  // Placement
  // ============================================================

  function reservedHouseZones() {
    const house =
      simulationState
        ?.house ??
      {};

    const zones = [];

    for (
      const point
      of Object.values(
        house.pickup_points ??
        {}
      )
    ) {
      zones.push(
        {
          column:
            Math.floor(
              Number(
                point.column
              )
            ),

          row:
            Math.floor(
              Number(
                point.row
              )
            ),

          width: 2,
          height: 2,
        }
      );
    }

    if (
      house.storage_point
    ) {
      zones.push(
        {
          column:
            Math.floor(
              Number(
                house
                  .storage_point
                  .column
              )
            ),

          row:
            Math.floor(
              Number(
                house
                  .storage_point
                  .row
              )
            ),

          width: 3,
          height: 2,
        }
      );
    }

    return zones;
  }

  function rectanglesOverlap(
    a,
    b
  ) {
    return !(
      a.column +
        a.width <=
        b.column ||
      b.column +
        b.width <=
        a.column ||
      a.row +
        a.height <=
        b.row ||
      b.row +
        b.height <=
        a.row
    );
  }

  function canPlace(
    column,
    row,
    width,
    height
  ) {
    const candidate = {
      column,
      row,
      width,
      height,
    };

    if (
      column < 0 ||
      row < 0 ||
      column + width >
        GRID_SIZE ||
      row + height >
        GRID_SIZE
    ) {
      return false;
    }

    if (
      reservedHouseZones()
        .some(
          (zone) =>
            rectanglesOverlap(
              candidate,
              zone
            )
        )
    ) {
      return false;
    }

    return placements.every(
      (placed) =>
        !rectanglesOverlap(
          candidate,
          placed
        )
    );
  }

  function removePreview() {
    preview?.remove();
    preview = null;
  }

  function showPreview(
    column,
    row
  ) {
    removePreview();

    const definition =
      definitionsById.get(
        selectedBuildId
      );

    if (!definition) {
      return;
    }

    preview =
      document.createElement(
        "img"
      );

    preview.className =
      "building-sprite building-preview";

    preview.src =
      `/static/assets/sprites/${definition.image}`;

    preview.alt = "";

    preview.style.gridColumn =
      `${column + 1} / span ${definition.width}`;

    preview.style.gridRow =
      `${row + 1} / span ${definition.height}`;

    preview.classList.add(
      canPlace(
        column,
        row,
        definition.width,
        definition.height
      )
        ? "is-valid"
        : "is-invalid"
    );

    landGrid.appendChild(
      preview
    );
  }

  function syncPlacementUi() {
    const active =
      Boolean(
        selectedBuildId
      );

    cancelButton.disabled =
      !active;

    buildList
      .querySelectorAll(
        ".build-option"
      )
      .forEach(
        (button) => {
          button.setAttribute(
            "aria-pressed",
            active &&
            button.dataset
              .facilityId ===
              selectedBuildId
              ? "true"
              : "false"
          );
        }
      );
  }

  function selectBuild(
    facilityId
  ) {
    selectedBuildId =
      facilityId;

    closeInspector();

    clearMapSelection();

    syncPlacementUi();

    statusLine.textContent =
      `Place ${
        definitionsById
          .get(facilityId)
          ?.name ??
        facilityId
      } on the map.`;
  }

  function cancelPlacement(
    {
      silent = false,
    } = {}
  ) {
    selectedBuildId = null;

    removePreview();

    syncPlacementUi();

    if (
      !silent &&
      gameLoaded
    ) {
      statusLine.textContent =
        "Select a tile or facility to interact.";
    }
  }

  cancelButton.addEventListener(
    "click",
    () => {
      cancelPlacement();
    }
  );

  async function placeSelectedFacility(
    column,
    row
  ) {
    const definition =
      definitionsById.get(
        selectedBuildId
      );

    if (
      !definition ||
      !canPlace(
        column,
        row,
        definition.width,
        definition.height
      )
    ) {
      statusLine.textContent =
        "That structure cannot be placed there.";

      return;
    }

    try {
      const result =
        await api(
          "/api/facilities",
          {
            method: "POST",

            body:
              JSON.stringify(
                {
                  facility_id:
                    selectedBuildId,

                  column,
                  row,
                }
              ),
          }
        );

      renderState(
        result.state
      );

      cancelPlacement();

      statusLine.textContent =
        `${definition.name} placed.`;
    } catch (error) {
      statusLine.textContent =
        error.message;
    }
  }

  function renderBuildList() {
    buildList.replaceChildren();

    const defaultTile =
      simulationState
        ?.map
        ?.default_tile;

    for (
      const definition
      of simulationState
        ?.facility_definitions ??
      []
    ) {
      definitionsById.set(
        definition.id,
        definition
      );

      if (
        definition.id ===
        defaultTile
      ) {
        continue;
      }

      const button =
        document.createElement(
          "button"
        );

      button.type = "button";

      button.className =
        "build-option";

      button.dataset.facilityId =
        definition.id;

      button.setAttribute(
        "aria-pressed",
        definition.id ===
          selectedBuildId
          ? "true"
          : "false"
      );

      const image =
        document.createElement(
          "img"
        );

      image.src =
        `/static/assets/sprites/${definition.image}`;

      image.alt = "";

      const text =
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
        `${definition.width} × ${definition.height} tiles`;

      text.append(
        name,
        size
      );

      button.append(
        image,
        text
      );

      buildList.appendChild(
        button
      );
    }

    syncPlacementUi();
  }

  buildList.addEventListener(
    "click",
    (event) => {
      const button =
        event.target.closest(
          ".build-option"
        );

      if (
        button &&
        buildList.contains(
          button
        )
      ) {
        selectBuild(
          button.dataset.facilityId
        );
      }
    }
  );

  // ============================================================
  // Selection
  // ============================================================

  function clearMapSelection() {
    landGrid
      .querySelectorAll(
        ".is-map-selected"
      )
      .forEach(
        (element) => {
          element.classList.remove(
            "is-map-selected"
          );
        }
      );
  }

  function facilityAt(
    column,
    row
  ) {
    return (
      placements.find(
        (instance) =>
          column >=
            instance.column &&
          column <
            instance.column +
            instance.width &&
          row >=
            instance.row &&
          row <
            instance.row +
            instance.height
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
            CSS.escape(
              instance.instance_id
            )
          }"]`
        )
        ?.classList
        .add(
          "is-map-selected"
        );
    } else {
      landGrid
        .querySelector(
          `.grid-cell[data-column="${column}"][data-row="${row}"]`
        )
        ?.classList
        .add(
          "is-map-selected"
        );
    }
  }

  function beginInteractionPause() {
    interactionOpen = true;

    inspectorPausedRuntime =
      runtimeTimer !== null;

    if (
      inspectorPausedRuntime
    ) {
      stopRuntime(
        "Paused for interaction"
      );
    }
  }

  function closeInspector(
    {
      resume = true,
    } = {}
  ) {
    const shouldResume =
      resume &&
      inspectorPausedRuntime &&
      gameLoaded;

    inspectorOverlay.hidden = true;

    selectedMapObject = null;
    inspectorMode = "summary";

    inspectorPausedRuntime = false;
    interactionOpen = false;

    if (shouldResume) {
      startRuntime();
    }
  }

  function renderSelectionSummary(
    selection
  ) {
    inspectorContent.replaceChildren();

    const dl =
      document.createElement(
        "dl"
      );

    dl.className =
      "selection-summary";

    let rows = [];

    if (
      selection?.kind ===
      "house"
    ) {
      const house =
        simulationState
          ?.house ??
        {};

      rows = [
        [
          "Type",
          "Household waste pickup",
        ],

        [
          "Kitchen waste ready",
          `${formatAmount(
            house.outputs
              ?.kitchen_waste ??
            0
          )} lb`,
        ],

        [
          "Paper waste ready",
          `${formatAmount(
            house.outputs
              ?.paper_waste ??
            0
          )} lb`,
        ],
      ];
    } else if (
      selection?.kind ===
      "house_storage"
    ) {
      const storage =
        simulationState
          ?.house
          ?.storage ??
        {};

      rows = [
        [
          "Type",
          "House delivery / storage point",
        ],

        [
          "Stored resource types",
          String(
            Object.values(
              storage
            ).filter(
              (value) =>
                Number(value) >
                1e-9
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

      if (
        selection.instance
      ) {
        rows.push(
          [
            "Condition",
            `${formatAmount(
              (
                selection.instance
                  .condition ??
                1
              ) * 100,
              1
            )}%`,
          ]
        );

        rows.push(
          [
            "Accrued labor",
            `${formatAmount(
              selection.instance
                .accrued_labor_requirement ??
              0,
              3
            )} h`,
          ]
        );

        if (
          selection.instance
            .current_fill !=
          null
        ) {
          rows.push(
            [
              "Current fill",
              formatAmount(
                selection.instance
                  .current_fill
              ),
            ]
          );
        }

        if (
          selection.instance
            .feed_mass !=
          null
        ) {
          rows.push(
            [
              "Chicken feed",
              `${formatAmount(
                selection.instance
                  .feed_mass
              )} lb`,
            ]
          );
        }

        if (
          selection.instance
            .feedstock_mass !=
          null
        ) {
          rows.push(
            [
              "Feedstock",
              `${formatAmount(
                selection.instance
                  .feedstock_mass
              )} lb`,
            ]
          );
        }

        if (
          selection.instance
            .larval_biomass !=
          null
        ) {
          rows.push(
            [
              "Larval biomass",
              `${formatAmount(
                selection.instance
                  .larval_biomass
              )} lb`,
            ]
          );
        }

        if (
          selection.instance
            .raw_material_mass !=
          null
        ) {
          rows.push(
            [
              "Raw material",
              `${formatAmount(
                selection.instance
                  .raw_material_mass
              )} lb`,
            ]
          );
        }
      }
    }

    for (
      const [label, value]
      of rows
    ) {
      const dt =
        document.createElement(
          "dt"
        );

      const dd =
        document.createElement(
          "dd"
        );

      dt.textContent = label;
      dd.textContent = value;

      dl.append(
        dt,
        dd
      );
    }

    inspectorContent.appendChild(
      dl
    );
  }

  function openSelection(
    column,
    row
  ) {
    beginInteractionPause();

    inspectorMode =
      "summary";

    const instance =
      facilityAt(
        column,
        row
      );

    const definition =
      instance
        ? definitionsById.get(
            instance.facility_id
          )
        : definitionsById.get(
            simulationState
              ?.map
              ?.default_tile
          );

    selectedMapObject = {
      kind: "map",
      column,
      row,
      instance,
      definition,
    };

    markMapSelection(
      column,
      row,
      instance
    );

    inspectorTitle.textContent =
      definition?.name ??
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
        instance
          ?.accrued_labor_requirement ??
        0
      ) <=
      1e-9;

    inspectorOverlay.hidden =
      false;
  }

  function openHouseSelection(
    focusResourceId = null
  ) {
    const house =
      simulationState?.house;

    if (!house) {
      return;
    }

    beginInteractionPause();

    const entrance =
      house.entrance ??
      {
        column: 14.5,
        row: 40,
      };

    selectedMapObject = {
      kind: "house",

      column:
        Number(
          entrance.column
        ),

      row:
        Number(
          entrance.row
        ),

      house,
      focusResourceId,
    };

    clearMapSelection();

    inspectorTitle.textContent =
      "House";

    inspectorSubtitle.textContent =
      "Household waste pickup";

    inspectorMode =
      focusResourceId
        ? "contents"
        : "summary";

    if (
      inspectorMode ===
      "contents"
    ) {
      renderHouseContentsManager(
        selectedMapObject,
        focusResourceId
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

    if (!house) {
      return;
    }

    beginInteractionPause();

    const point =
      house.storage_point ??
      {
        column: 20,
        row: 40,
      };

    selectedMapObject = {
      kind: "house_storage",

      column:
        Number(
          point.column
        ),

      row:
        Number(
          point.row
        ),

      house,
    };

    clearMapSelection();

    inspectorTitle.textContent =
      mode === "order"
        ? "Order Supplies"
        : "House Storage";

    inspectorSubtitle.textContent =
      mode === "order"
        ? "Instant delivery to House Storage"
        : "Household delivery and drop-off point";

    inspectorMode = mode;

    if (
      mode === "order"
    ) {
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

  inspectorCloseButton.addEventListener(
    "click",
    () => {
      closeInspector();
    }
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
      if (!selectedMapObject) {
        return;
      }

      try {
        const {
          column,
          row,
        } =
          selectedMapObject;

        const result =
          await api(
            "/api/player/walk",
            {
              method: "POST",

              body:
                JSON.stringify(
                  {
                    column,
                    row,
                  }
                ),
            }
          );

        renderState(
          result.state
        );

        closeInspector();

        clearMapSelection();

        statusLine.textContent =
          `Walk task queued for tile ${Math.floor(column) + 1}, ${Math.floor(row) + 1}.`;
      } catch (error) {
        statusLine.textContent =
          error.message;
      }
    }
  );

  serviceFacilityButton.addEventListener(
    "click",
    async () => {
      const instance =
        selectedMapObject
          ?.instance;

      if (!instance) {
        return;
      }

      const facilityName =
        selectedMapObject
          ?.definition
          ?.name ??
        instance.facility_id;

      try {
        const result =
          await api(
            `/api/facilities/${
              encodeURIComponent(
                instance.instance_id
              )
            }/service`,
            {
              method: "POST",
              body: "{}",
            }
          );

        renderState(
          result.state
        );

        closeInspector();

        clearMapSelection();

        statusLine.textContent =
          `Service task queued for ${facilityName}.`;
      } catch (error) {
        statusLine.textContent =
          error.message;
      }
    }
  );

  manageContentsButton.addEventListener(
    "click",
    () => {
      if (!selectedMapObject) {
        return;
      }

      if (
        selectedMapObject.kind ===
        "house_storage"
      ) {
        inspectorMode =
          "storage";

        renderHouseStorageManager();
      } else {
        inspectorMode =
          "contents";

        renderContentsManager(
          selectedMapObject
        );
      }
    }
  );

  // ============================================================
  // Contents interfaces
  // ============================================================

  function queuedFillAmount(
    instanceId,
    field
  ) {
    return (
      simulationState
        ?.player
        ?.task_queue ??
      []
    )
      .filter(
        (task) =>
          task.type ===
            "facility_fill" &&
          task.target_instance_id ===
            instanceId &&
          task.target_field ===
            field
      )
      .reduce(
        (sum, task) =>
          sum +
          Number(
            task.amount ??
            0
          ),
        0
      );
  }

  function managedContentOptions(
    selection
  ) {
    const instance =
      selection?.instance;

    const definition =
      selection?.definition;

    if (
      !instance ||
      !definition
    ) {
      return [];
    }

    const container =
      definition.container ??
      {};

    const process =
      definition.process ??
      {};

    if (
      definition.id ===
      "chicken-coop"
    ) {
      return [
        {
          resourceId:
            "chicken",

          label:
            "Laying hen",

          unit:
            "bird",

          step:
            1,

          integerOnly:
            true,

          currentField:
            "current_fill",

          capacity:
            Number(
              container.capacity ??
              0
            ),
        },

        {
          resourceId:
            "feed",

          label:
            "Chicken feed",

          unit:
            "lb",

          step:
            0.1,

          integerOnly:
            false,

          currentField:
            "feed_mass",

          capacity:
            null,
        },
      ];
    }

    if (
      definition.id ===
      "bsfl-reactor"
    ) {
      return [
        {
          resourceId:
            "bsfl_biomass",

          label:
            "BSFL larval biomass",

          unit:
            "lb",

          step:
            0.1,

          integerOnly:
            false,

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

          unit:
            "lb",

          step:
            0.1,

          integerOnly:
            false,

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

    if (
      definition.id ===
      "compost-pile"
    ) {
      return Object.entries(
        definition.inputs ??
        {}
      )
        .filter(
          ([, rule]) =>
            rule?.mode ===
            "shared_feedstock"
        )
        .map(
          ([resourceId]) => ({
            resourceId,

            label:
              prettyName(
                resourceId
              ),

            unit:
              "lb",

            step:
              0.1,

            integerOnly:
              false,

            currentField:
              "raw_material_mass",

            capacity:
              Number(
                container.capacity ??
                0
              ),
          })
        );
    }

    return [];
  }

  function renderContentsManager(
    selection
  ) {
    if (
      selection?.kind ===
      "house"
    ) {
      renderHouseContentsManager(
        selection,
        selection.focusResourceId ??
          null
      );

      return;
    }

    if (
      selection?.kind ===
      "house_storage"
    ) {
      renderHouseStorageManager();

      return;
    }

    inspectorContent.replaceChildren();

    const options =
      managedContentOptions(
        selection
      );

    if (
      !selection?.instance ||
      !options.length
    ) {
      const message =
        document.createElement(
          "p"
        );

      message.className =
        "contents-message";

      message.textContent =
        "This facility has no manually managed contents yet.";

      inspectorContent.appendChild(
        message
      );

      return;
    }

    const intro =
      document.createElement(
        "p"
      );

    intro.className =
      "contents-message";

    intro.textContent =
      "Submitting a transfer reserves the carried material immediately and adds a delivery task to the Homesteader's activity queue. The facility receives it only when she reaches the facility and completes the handling task.";

    inspectorContent.appendChild(
      intro
    );

    for (
      const option
      of options
    ) {
      const current =
        Number(
          selection.instance
            ?.[option.currentField] ??
          0
        );

      const queued =
        queuedFillAmount(
          selection.instance
            .instance_id,
          option.currentField
        );

      const carried =
        Number(
          simulationState
            ?.player
            ?.inventory
            ?.[option.resourceId] ??
          0
        );

      const remaining =
        option.capacity == null
          ? carried
          : Math.max(
              0,
              option.capacity -
              current -
              queued
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
        document.createElement(
          "section"
        );

      card.className =
        "contents-row";

      const heading =
        document.createElement(
          "h3"
        );

      heading.textContent =
        option.label;

      const stats =
        document.createElement(
          "p"
        );

      stats.className =
        "contents-stats";

      stats.textContent =
        `Current: ${formatAmount(current)} ${option.unit} · ` +
        `Queued: ${formatAmount(queued)} ${option.unit} · ` +
        `${
          option.capacity == null
            ? "Capacity: not modeled"
            : `Capacity: ${formatAmount(option.capacity)} ${option.unit}`
        } · ` +
        `Carried: ${formatAmount(carried)} ${option.unit}`;

      const form =
        document.createElement(
          "form"
        );

      form.className =
        "contents-form";

      const label =
        document.createElement(
          "label"
        );

      label.textContent =
        `Amount to deliver (${option.unit})`;

      const input =
        document.createElement(
          "input"
        );

      input.type = "number";
      input.min = "0";
      input.step =
        String(
          option.step
        );

      input.max =
        String(
          maximum
        );

      input.value =
        maximum > 0
          ? String(
              option.integerOnly
                ? Math.max(
                    1,
                    Math.floor(
                      maximum
                    )
                  )
                : Math.min(
                    maximum,
                    option.step
                  )
            )
          : "0";

      input.disabled =
        maximum <= 0;

      label.appendChild(
        input
      );

      const button =
        document.createElement(
          "button"
        );

      button.type =
        "submit";

      button.className =
        "interaction-button primary";

      button.textContent =
        "Queue Delivery";

      button.disabled =
        maximum <= 0;

      form.append(
        label,
        button
      );

      form.addEventListener(
        "submit",
        async (event) => {
          event.preventDefault();

          const amount =
            Number(
              input.value
            );

          if (
            !Number.isFinite(
              amount
            ) ||
            amount <= 0
          ) {
            return;
          }

          try {
            const result =
              await api(
                `/api/facilities/${
                  encodeURIComponent(
                    selection
                      .instance
                      .instance_id
                  )
                }/fill`,
                {
                  method:
                    "POST",

                  body:
                    JSON.stringify(
                      {
                        resource_id:
                          option.resourceId,

                        amount,
                      }
                    ),
                }
              );

            renderState(
              result.state
            );

            selectedMapObject.instance =
              facilityAt(
                selectedMapObject
                  .column,
                selectedMapObject
                  .row
              );

            selectedMapObject.definition =
              definitionsById.get(
                selectedMapObject
                  .instance
                  ?.facility_id
              );

            inspectorMode =
              "contents";

            renderContentsManager(
              selectedMapObject
            );

            statusLine.textContent =
              `${option.label} delivery queued.`;
          } catch (error) {
            statusLine.textContent =
              error.message;
          }
        }
      );

      card.append(
        heading,
        stats,
        form
      );

      inspectorContent.appendChild(
        card
      );
    }
  }

  function renderHouseContentsManager(
    selection,
    focusResourceId = null
  ) {
    inspectorContent.replaceChildren();

    const house =
      simulationState?.house;

    if (!house) {
      return;
    }

    const intro =
      document.createElement(
        "p"
      );

    intro.className =
      "contents-message";

    intro.textContent =
      "Submitting a pickup reserves that household waste stream and adds a physical pickup task to the Homesteader's queue.";

    inspectorContent.appendChild(
      intro
    );

    const streams = [
      {
        resourceId:
          "kitchen_waste",

        label:
          "Kitchen waste",

        unit:
          "lb",
      },

      {
        resourceId:
          "paper_waste",

        label:
          "Paper waste",

        unit:
          "lb",
      },
    ];

    for (
      const stream
      of streams
    ) {
      const available =
        Number(
          house.outputs
            ?.[stream.resourceId] ??
          0
        );

      const carried =
        Number(
          simulationState
            ?.player
            ?.inventory
            ?.[stream.resourceId] ??
          0
        );

      const card =
        document.createElement(
          "section"
        );

      card.className =
        "contents-row";

      if (
        focusResourceId ===
        stream.resourceId
      ) {
        card.classList.add(
          "is-focused"
        );
      }

      const heading =
        document.createElement(
          "h3"
        );

      heading.textContent =
        stream.label;

      const stats =
        document.createElement(
          "p"
        );

      stats.className =
        "contents-stats";

      stats.textContent =
        `Available: ${formatAmount(available)} ${stream.unit} · ` +
        `Carried: ${formatAmount(carried)} ${stream.unit}`;

      const form =
        document.createElement(
          "form"
        );

      form.className =
        "contents-form";

      const label =
        document.createElement(
          "label"
        );

      label.textContent =
        `Amount to pick up (${stream.unit})`;

      const input =
        document.createElement(
          "input"
        );

      input.type = "number";
      input.min = "0";
      input.step = "0.1";

      input.max =
        String(
          available
        );

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

      label.appendChild(
        input
      );

      const button =
        document.createElement(
          "button"
        );

      button.type =
        "submit";

      button.className =
        "interaction-button primary";

      button.textContent =
        "Queue Pickup";

      button.disabled =
        available <= 0;

      form.append(
        label,
        button
      );

      form.addEventListener(
        "submit",
        async (event) => {
          event.preventDefault();

          const amount =
            Number(
              input.value
            );

          try {
            const result =
              await api(
                "/api/house/pickup",
                {
                  method:
                    "POST",

                  body:
                    JSON.stringify(
                      {
                        resource_id:
                          stream.resourceId,

                        amount,
                      }
                    ),
                }
              );

            renderState(
              result.state
            );

            inspectorMode =
              "contents";

            renderHouseContentsManager(
              selectedMapObject,
              stream.resourceId
            );

            statusLine.textContent =
              `${stream.label} pickup queued.`;
          } catch (error) {
            statusLine.textContent =
              error.message;
          }
        }
      );

      card.append(
        heading,
        stats,
        form
      );

      inspectorContent.appendChild(
        card
      );
    }
  }

  function storageResourceIds() {
    return [
      ...new Set(
        [
          ...Object.keys(
            simulationState
              ?.house
              ?.storage ??
            {}
          ),

          ...Object.keys(
            simulationState
              ?.player
              ?.inventory ??
            {}
          ),
        ]
      ),
    ]
      .filter(
        (resourceId) =>
          Number(
            simulationState
              ?.house
              ?.storage
              ?.[resourceId] ??
            0
          ) >
            1e-9 ||
          Number(
            simulationState
              ?.player
              ?.inventory
              ?.[resourceId] ??
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
      document.createElement(
        "p"
      );

    intro.className =
      "contents-message";

    intro.textContent =
      "Pickup and drop-off instructions are queued. Material is reserved immediately, but the transfer completes only after the Homesteader reaches House Storage and spends one simulated minute handling it.";

    inspectorContent.appendChild(
      intro
    );

    const resourceIds =
      storageResourceIds();

    if (
      !resourceIds.length
    ) {
      const message =
        document.createElement(
          "p"
        );

      message.className =
        "contents-message";

      message.textContent =
        "House Storage is empty. Use Order to request supplies.";

      inspectorContent.appendChild(
        message
      );
    }

    for (
      const resourceId
      of resourceIds
    ) {
      const stored =
        Number(
          simulationState
            ?.house
            ?.storage
            ?.[resourceId] ??
          0
        );

      const carried =
        Number(
          simulationState
            ?.player
            ?.inventory
            ?.[resourceId] ??
          0
        );

      const unit =
        resourceUnit(
          resourceId
        );

      const integerOnly =
        resourceId ===
        "chicken";

      const card =
        document.createElement(
          "section"
        );

      card.className =
        "contents-row";

      const heading =
        document.createElement(
          "h3"
        );

      heading.textContent =
        resourceLabel(
          resourceId
        );

      const stats =
        document.createElement(
          "p"
        );

      stats.className =
        "contents-stats";

      stats.textContent =
        `House Storage: ${formatAmount(stored)} ${unit} · ` +
        `Carried: ${formatAmount(carried)} ${unit}`;

      const controls =
        document.createElement(
          "div"
        );

      controls.className =
        "storage-transfer-controls";

      const input =
        document.createElement(
          "input"
        );

      input.type = "number";
      input.min = "0";

      input.step =
        integerOnly
          ? "1"
          : "0.1";

      input.value =
        integerOnly
          ? "1"
          : "0.1";

      const pickupButton =
        document.createElement(
          "button"
        );

      pickupButton.type =
        "button";

      pickupButton.className =
        "interaction-button primary";

      pickupButton.textContent =
        "Queue Pickup";

      pickupButton.disabled =
        stored <= 0;

      const dropButton =
        document.createElement(
          "button"
        );

      dropButton.type =
        "button";

      dropButton.className =
        "interaction-button";

      dropButton.textContent =
        "Queue Drop Off";

      dropButton.disabled =
        carried <= 0;

      async function queueTransfer(
        direction
      ) {
        const amount =
          Number(
            input.value
          );

        try {
          const result =
            await api(
              "/api/house/storage/transfer",
              {
                method:
                  "POST",

                body:
                  JSON.stringify(
                    {
                      resource_id:
                        resourceId,

                      amount,

                      direction,
                    }
                  ),
              }
            );

          renderState(
            result.state
          );

          inspectorMode =
            "storage";

          renderHouseStorageManager();

          statusLine.textContent =
            `${resourceLabel(resourceId)} transfer queued.`;
        } catch (error) {
          statusLine.textContent =
            error.message;
        }
      }

      pickupButton.addEventListener(
        "click",
        () => {
          queueTransfer(
            "to_player"
          );
        }
      );

      dropButton.addEventListener(
        "click",
        () => {
          queueTransfer(
            "to_house"
          );
        }
      );

      controls.append(
        input,
        pickupButton,
        dropButton
      );

      card.append(
        heading,
        stats,
        controls
      );

      inspectorContent.appendChild(
        card
      );
    }

    const orderShortcut =
      document.createElement(
        "button"
      );

    orderShortcut.type =
      "button";

    orderShortcut.className =
      "interaction-button order-shortcut";

    orderShortcut.textContent =
      "Order Supplies";

    orderShortcut.addEventListener(
      "click",
      () => {
        inspectorMode =
          "order";

        inspectorTitle.textContent =
          "Order Supplies";

        renderOrderInterface();
      }
    );

    inspectorContent.appendChild(
      orderShortcut
    );
  }

  function renderOrderInterface() {
    inspectorContent.replaceChildren();

    const intro =
      document.createElement(
        "p"
      );

    intro.className =
      "contents-message";

    intro.textContent =
      "Orders are currently free and delivered instantly to House Storage. Delivery by outside vendors is abstracted.";

    inspectorContent.appendChild(
      intro
    );

    for (
      const [
        resourceId,
        spec,
      ]
      of Object.entries(
        simulationState
          ?.order_catalog ??
        {}
      )
    ) {
      const card =
        document.createElement(
          "section"
        );

      card.className =
        "contents-row order-row";

      const heading =
        document.createElement(
          "h3"
        );

      heading.textContent =
        spec.name ??
        resourceLabel(
          resourceId
        );

      const stats =
        document.createElement(
          "p"
        );

      stats.className =
        "contents-stats";

      stats.textContent =
        `House Storage: ${formatAmount(
          simulationState
            ?.house
            ?.storage
            ?.[resourceId] ??
          0
        )} ${
          spec.unit ??
          resourceUnit(
            resourceId
          )
        }`;

      const form =
        document.createElement(
          "form"
        );

      form.className =
        "contents-form";

      const label =
        document.createElement(
          "label"
        );

      label.textContent =
        `Quantity (${
          spec.unit ??
          resourceUnit(
            resourceId
          )
        })`;

      const input =
        document.createElement(
          "input"
        );

      input.type = "number";
      input.min = "0";

      input.step =
        spec.integer_only
          ? "1"
          : "0.1";

      input.value =
        spec.integer_only
          ? "1"
          : "1";

      label.appendChild(
        input
      );

      const button =
        document.createElement(
          "button"
        );

      button.type =
        "submit";

      button.className =
        "interaction-button primary";

      button.textContent =
        "Order";

      form.append(
        label,
        button
      );

      form.addEventListener(
        "submit",
        async (event) => {
          event.preventDefault();

          const amount =
            Number(
              input.value
            );

          try {
            const result =
              await api(
                "/api/orders",
                {
                  method:
                    "POST",

                  body:
                    JSON.stringify(
                      {
                        resource_id:
                          resourceId,

                        amount,
                      }
                    ),
                }
              );

            renderState(
              result.state
            );

            inspectorMode =
              "order";

            renderOrderInterface();

            statusLine.textContent =
              `${
                spec.name ??
                resourceLabel(
                  resourceId
                )
              } delivered to House Storage.`;
          } catch (error) {
            statusLine.textContent =
              error.message;
          }
        }
      );

      card.append(
        heading,
        stats,
        form
      );

      inspectorContent.appendChild(
        card
      );
    }
  }

  // ============================================================
  // Activity queue
  // ============================================================

  function taskPhaseLabel(task) {
    if (!task) {
      return "Idle";
    }

    if (
      task.phase ===
      "travel"
    ) {
      return "Traveling";
    }

    if (
      task.phase ===
      "working"
    ) {
      return "Working";
    }

    if (
      task.phase ===
      "queued"
    ) {
      return "Queued";
    }

    return prettyName(
      task.phase ??
      task.status ??
      "Queued"
    );
  }

  function taskTravelMinutes(task) {
    const target =
      task?.target;

    const position =
      simulationState
        ?.player
        ?.position;

    if (
      !target ||
      !position ||
      task.phase !==
        "travel"
    ) {
      return null;
    }

    const dx =
      Number(
        target.column
      ) -
      Number(
        position.column
      );

    const dy =
      Number(
        target.row
      ) -
      Number(
        position.row
      );

    return Math.max(
      1,
      Math.ceil(
        Math.hypot(
          dx,
          dy
        ) /
        WALKING_SPEED_TILES_PER_MINUTE
      )
    );
  }

  function taskDetail(task) {
    if (!task) {
      return "No queued tasks";
    }

    const pieces = [
      taskPhaseLabel(
        task
      ),
    ];

    const travel =
      taskTravelMinutes(
        task
      );

    if (
      travel != null
    ) {
      pieces.push(
        `~${travel} min travel`
      );
    }

    if (
      task.phase ===
      "working"
    ) {
      pieces.push(
        `${Number(
          task.work_minutes_remaining ??
          0
        )} min work remaining`
      );
    } else if (
      Number(
        task.work_minutes_remaining ??
        0
      ) >
      0
    ) {
      pieces.push(
        `${Number(
          task.work_minutes_remaining
        )} min work after arrival`
      );
    }

    return pieces.join(
      " · "
    );
  }

  async function cancelQueuedTask(
    taskId
  ) {
    try {
      const result =
        await api(
          `/api/tasks/${
            encodeURIComponent(
              taskId
            )
          }/cancel`,
          {
            method: "POST",
            body: "{}",
          }
        );

      renderState(
        result.state
      );

      statusLine.textContent =
        "Task cancelled; any reserved material was returned to its source.";
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
      simulationState
        ?.player
        ?.task_queue ??
      [];

    const current =
      queue[0] ??
      null;

    currentTaskCard.replaceChildren();

    if (!current) {
      currentTaskCard.textContent =
        "Idle · no current task.";
    } else {
      const strong =
        document.createElement(
          "strong"
        );

      strong.textContent =
        current.description ??
        prettyName(
          current.type
        );

      const detail =
        document.createElement(
          "span"
        );

      detail.textContent =
        taskDetail(
          current
        );

      currentTaskCard.append(
        strong,
        detail
      );
    }

    taskQueueList.replaceChildren();

    if (
      queue.length <= 1
    ) {
      const empty =
        document.createElement(
          "p"
        );

      empty.className =
        "panel-note";

      empty.textContent =
        "No waiting tasks.";

      taskQueueList.appendChild(
        empty
      );

      return;
    }

    queue
      .slice(1)
      .forEach(
        (task, index) => {
          const row =
            document.createElement(
              "div"
            );

          row.className =
            "task-queue-item";

          const text =
            document.createElement(
              "div"
            );

          const strong =
            document.createElement(
              "strong"
            );

          strong.textContent =
            `${index + 1}. ${
              task.description ??
              prettyName(
                task.type
              )
            }`;

          const detail =
            document.createElement(
              "span"
            );

          detail.textContent =
            taskDetail(
              task
            );

          text.append(
            strong,
            detail
          );

          const cancel =
            document.createElement(
              "button"
            );

          cancel.type =
            "button";

          cancel.className =
            "task-cancel-button";

          cancel.textContent =
            "Cancel";

          cancel.addEventListener(
            "click",
            () => {
              cancelQueuedTask(
                task.task_id
              );
            }
          );

          row.append(
            text,
            cancel
          );

          taskQueueList.appendChild(
            row
          );
        }
      );
  }

  // ============================================================
  // Avatar
  // ============================================================

  function ensureAvatar() {
    if (avatar) {
      return avatar;
    }

    avatar =
      document.createElement(
        "img"
      );

    avatar.id =
      "player-avatar";

    avatar.className =
      "player-avatar";

    avatar.alt =
      "Homesteader";

    avatar.src =
      "/static/assets/sprites/HomesteaderIdle.png";

    avatarTooltip =
      document.createElement(
        "div"
      );

    avatarTooltip.className =
      "player-task-tooltip";

    avatarTooltip.hidden =
      true;

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

  function avatarAsset(
    task,
    activity
  ) {
    const phase =
      activity?.phase ??
      task?.phase ??
      "idle";

    const direction =
      activity?.direction ??
      task?.direction ??
      simulationState
        ?.player
        ?.last_direction ??
      "down";

    if (
      phase ===
      "working"
    ) {
      return "/static/assets/sprites/HomesteaderCrouch.png";
    }

    if (
      phase !==
      "travel"
    ) {
      return "/static/assets/sprites/HomesteaderIdle.png";
    }

    if (
      direction ===
      "up"
    ) {
      return "/static/assets/sprites/HomesteaderWalkAway.png";
    }

    if (
      direction ===
      "down"
    ) {
      return "/static/assets/sprites/HomesteaderWalkToward.png";
    }

    return "/static/assets/sprites/HomesteaderWalkSide.png";
  }

  function updateAvatarTooltip() {
    if (!avatarTooltip) {
      return;
    }

    const queue =
      simulationState
        ?.player
        ?.task_queue ??
      [];

    const current =
      queue[0] ??
      null;

    if (!current) {
      avatarTooltip.innerHTML =
        "<strong>Homesteader</strong><span>Idle</span><span>No queued tasks</span>";

      return;
    }

    avatarTooltip.replaceChildren();

    const title =
      document.createElement(
        "strong"
      );

    title.textContent =
      "Homesteader";

    const description =
      document.createElement(
        "span"
      );

    description.textContent =
      current.description ??
      prettyName(
        current.type
      );

    const detail =
      document.createElement(
        "span"
      );

    detail.textContent =
      taskDetail(
        current
      );

    const waiting =
      document.createElement(
        "span"
      );

    waiting.textContent =
      `${Math.max(
        0,
        queue.length - 1
      )} task${
        queue.length - 1 === 1
          ? ""
          : "s"
      } waiting`;

    avatarTooltip.append(
      title,
      description,
      detail,
      waiting
    );
  }

  function renderAvatar(
    activity = null
  ) {
    const player =
      simulationState?.player;

    if (!player) {
      avatar?.remove();
      avatarTooltip?.remove();

      avatar = null;
      avatarTooltip = null;

      return;
    }

    const element =
      ensureAvatar();

    const column =
      Number(
        player.position
          ?.column ??
        0
      );

    const row =
      Number(
        player.position
          ?.row ??
        GRID_SIZE - 1
      );

    element.style.left =
      `${
        (
          (
            column +
            0.5
          ) /
          GRID_SIZE
        ) *
        100
      }%`;

    element.style.top =
      `${
        (
          (
            row +
            1
          ) /
          GRID_SIZE
        ) *
        100
      }%`;

    const task =
      player
        .task_queue
        ?.[0] ??
      player.current_task ??
      null;

    const direction =
      activity?.direction ??
      task?.direction ??
      player.last_direction ??
      "down";

    element.src =
      avatarAsset(
        task,
        activity
      );

    element.classList.toggle(
      "walk-left",
      (
        activity?.phase ??
        task?.phase
      ) ===
        "travel" &&
      direction ===
        "left"
    );

    element.title =
      task
        ? `${
            task.description
          }\n${
            taskDetail(
              task
            )
          }`
        : "Homesteader — Idle";

    if (avatarTooltip) {
      avatarTooltip.style.left =
        element.style.left;

      avatarTooltip.style.top =
        element.style.top;

      updateAvatarTooltip();
    }
  }

  // ============================================================
  // House and facility rendering
  // ============================================================

  function renderHouse() {
    landGrid
      .querySelectorAll(
        ".house-eaves, .house-pickup, .house-storage"
      )
      .forEach(
        (element) => {
          element.remove();
        }
      );

    const house =
      simulationState?.house;

    if (!house) {
      return;
    }

    const eaves =
      house.eaves ??
      {
        column: 11,
        width: 20,
      };

    const eavesElement =
      document.createElement(
        "div"
      );

    eavesElement.className =
      "house-eaves";

    eavesElement.style.gridColumn =
      `${Number(eaves.column) + 1} / span ${Number(eaves.width)}`;

    eavesElement.style.gridRow =
      `${GRID_SIZE} / span 1`;

    landGrid.appendChild(
      eavesElement
    );

    const pickupSpecs = [
      [
        "kitchen_waste",
        "Kitchen waste",
        "kitchen-pickup",
      ],

      [
        "paper_waste",
        "Paper waste",
        "paper-pickup",
      ],
    ];

    for (
      const [
        resourceId,
        text,
        extraClass,
      ]
      of pickupSpecs
    ) {
      const point =
        house
          .pickup_points
          ?.[resourceId];

      if (!point) {
        continue;
      }

      const button =
        document.createElement(
          "button"
        );

      button.type =
        "button";

      button.className =
        `house-pickup ${extraClass}`;

      button.dataset.resourceId =
        resourceId;

      button.style.gridColumn =
        `${
          Math.floor(
            Number(
              point.column
            )
          ) +
          1
        } / span 2`;

      button.style.gridRow =
        `${
          Math.floor(
            Number(
              point.row
            )
          ) +
          1
        } / span 2`;

      const amount =
        Number(
          house.outputs
            ?.[resourceId] ??
          0
        );

      button.innerHTML =
        `<span class="pickup-icon">${
          resourceId ===
            "kitchen_waste"
            ? "♻"
            : "▤"
        }</span>` +
        `<span>${text}</span>` +
        `<strong>${formatAmount(
          amount,
          2
        )} lb</strong>`;

      landGrid.appendChild(
        button
      );
    }

    const point =
      house.storage_point ??
      {
        column: 20,
        row: 40,
      };

    const storage =
      document.createElement(
        "button"
      );

    storage.type =
      "button";

    storage.className =
      "house-storage";

    storage.style.gridColumn =
      `${
        Math.floor(
          Number(
            point.column
          )
        ) +
        1
      } / span 3`;

    storage.style.gridRow =
      `${
        Math.floor(
          Number(
            point.row
          )
        ) +
        1
      } / span 2`;

    const storedTypes =
      Object.values(
        house.storage ??
        {}
      )
        .filter(
          (amount) =>
            Number(amount) >
            1e-9
        )
        .length;

    storage.innerHTML =
      `<span class="pickup-icon">▣</span>` +
      `<span>House Storage</span>` +
      `<strong>${storedTypes} type${
        storedTypes === 1
          ? ""
          : "s"
      }</strong>`;

    landGrid.appendChild(
      storage
    );
  }

  function renderPlacements() {
    landGrid
      .querySelectorAll(
        ".placed-building"
      )
      .forEach(
        (element) => {
          element.remove();
        }
      );

    placements =
      (
        simulationState
          ?.instances ??
        []
      )
        .map(
          (instance) => ({
            ...instance,
          })
        );

    for (
      const instance
      of placements
    ) {
      const definition =
        definitionsById.get(
          instance.facility_id
        );

      if (!definition) {
        continue;
      }

      const image =
        document.createElement(
          "img"
        );

      image.className =
        "building-sprite placed-building";

      image.src =
        `/static/assets/sprites/${definition.image}`;

      image.alt =
        definition.name;

      image.dataset.instanceId =
        instance.instance_id;

      image.style.gridColumn =
        `${instance.column + 1} / span ${instance.width}`;

      image.style.gridRow =
        `${instance.row + 1} / span ${instance.height}`;

      landGrid.appendChild(
        image
      );
    }

    renderHouse();

    if (avatar) {
      landGrid.appendChild(
        avatar
      );
    }

    if (avatarTooltip) {
      landGrid.appendChild(
        avatarTooltip
      );
    }
  }

  // ============================================================
  // Side panels
  // ============================================================

  function dailyBaseline() {
    const baseline =
      simulationState
        ?.household_baseline_daily ??
      {};

    const profile =
      simulationState
        ?.household_profile ??
      {};

    return {
      flows:
        baseline.daily_flows ??
        profile.daily_flows ??
        {},

      electricity:
        baseline
          .electricity_kwh_per_day ??
        profile
          .electricity_kwh_per_day ??
        {},
    };
  }

  function renderPlayerInventory() {
    if (!playerInventoryList) {
      return;
    }

    playerInventoryList.replaceChildren();

    const entries =
      Object.entries(
        simulationState
          ?.player
          ?.inventory ??
        {}
      )
        .filter(
          ([, amount]) =>
            Number(amount) >
            1e-9
        )
        .sort(
          ([a], [b]) =>
            resourceLabel(a)
              .localeCompare(
                resourceLabel(b)
              )
        );

    if (!entries.length) {
      const item =
        document.createElement(
          "li"
        );

      item.textContent =
        "Nothing carried.";

      playerInventoryList.appendChild(
        item
      );

      return;
    }

    for (
      const [
        resourceId,
        amount,
      ]
      of entries
    ) {
      addListItem(
        playerInventoryList,
        resourceLabel(
          resourceId
        ),
        `${formatAmount(amount)} ${resourceUnit(resourceId)}`
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
        simulationState
          ?.household
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
          player.position
            ?.column,
          2
        )}, ${formatAmount(
          player.position
            ?.row,
          2
        )}`
      );

      const task =
        player
          .task_queue
          ?.[0] ??
        null;

      addListItem(
        playerList,
        "Activity",
        task
          ? `${
              task.description
            } — ${
              taskPhaseLabel(
                task
              )
            }`
          : "Idle"
      );

      addListItem(
        playerList,
        "Tasks",
        String(
          player
            .task_queue
            ?.length ??
          0
        )
      );
    }

    renderPlayerInventory();

    renderTaskQueue();

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
      "Groceries",
      `$${formatAmount(
        flows.groceries_usd,
        2
      )} / day`
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
      const [
        key,
        value,
      ]
      of Object.entries(
        electricity
      )
    ) {
      if (
        key !==
        "total"
      ) {
        addListItem(
          electricityList,
          prettyName(
            key
          ),
          `${formatAmount(value)} kWh / day`
        );
      }
    }

    const wasteList =
      document.getElementById(
        "waste-water-list"
      );

    wasteList.replaceChildren();

    for (
      const [
        key,
        value,
      ]
      of Object.entries(
        flows
      )
    ) {
      if (
        key ===
          "groceries_usd" ||
        key ===
          "tap_water_gal"
      ) {
        continue;
      }

      const unit =
        key.endsWith(
          "_gal"
        )
          ? "gal / day"
          : key.endsWith(
              "_lb"
            )
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
        `${formatAmount(value)} ${unit}`
      );
    }

    const resourceList =
      document.getElementById(
        "resource-list"
      );

    resourceList.replaceChildren();

    for (
      const [
        resourceId,
        resource,
      ]
      of Object.entries(
        simulationState
          ?.resources ??
        {}
      )
    ) {
      addListItem(
        resourceList,
        resource.name ??
        prettyName(
          resourceId
        ),
        `${
          formatAmount(
            resource.amount
          )
        } ${
          resource.unit ??
          ""
        }`.trim()
      );
    }

    const operationsList =
      document.getElementById(
        "facility-status-list"
      );

    operationsList.replaceChildren();

    if (!placements.length) {
      const item =
        document.createElement(
          "li"
        );

      item.textContent =
        "No placed facilities.";

      operationsList.appendChild(
        item
      );
    } else {
      for (
        const instance
        of placements
      ) {
        const definition =
          definitionsById.get(
            instance.facility_id
          );

        addListItem(
          operationsList,
          definition?.name ??
          instance.facility_id,
          instance
            .last_operation
            ?.status ??
          "Awaiting first hourly tick"
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
          selectedMapObject,
          selectedMapObject
            .focusResourceId ??
            null
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

    const refreshedInstance =
      facilityAt(
        selectedMapObject
          .column,
        selectedMapObject
          .row
      );

    selectedMapObject.instance =
      refreshedInstance;

    selectedMapObject.definition =
      refreshedInstance
        ? definitionsById.get(
            refreshedInstance
              .facility_id
          )
        : definitionsById.get(
            simulationState
              ?.map
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
      !refreshedInstance ||
      Number(
        refreshedInstance
          .accrued_labor_requirement ??
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
      const definition
      of state
        ?.facility_definitions ??
      []
    ) {
      definitionsById.set(
        definition.id,
        definition
      );
    }

    setDateAndClock(
      state
    );

    renderBuildList();

    renderPlacements();

    refreshOpenInspector();

    renderAvatar(
      activity
    );

    renderHouseholdPanels();
  }

  // ============================================================
  // Map pointer behavior
  // ============================================================

  landGrid.addEventListener(
    "pointermove",
    (event) => {
      if (
        !selectedBuildId ||
        mapDragStarted
      ) {
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

      showPreview(
        column,
        row
      );
    }
  );

  landGrid.addEventListener(
    "pointerleave",
    () => {
      if (
        selectedBuildId
      ) {
        removePreview();
      }
    }
  );

  landGrid.addEventListener(
    "click",
    async (event) => {
      if (!gameLoaded) {
        return;
      }

      if (
        suppressNextMapClick
      ) {
        suppressNextMapClick =
          false;

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

      const clickedPickup =
        event.target.closest
          ?.(".house-pickup") ??
        null;

      const clickedStorage =
        event.target.closest
          ?.(".house-storage") ??
        null;

      const clickedEaves =
        event.target.closest
          ?.(".house-eaves") ??
        null;

      const clickedFacility =
        event.target.closest
          ?.(".placed-building") ??
        null;

      if (clickedStorage) {
        if (
          selectedBuildId
        ) {
          cancelPlacement(
            {
              silent: true,
            }
          );
        }

        openHouseStorage(
          "storage"
        );

        return;
      }

      if (clickedPickup) {
        if (
          selectedBuildId
        ) {
          cancelPlacement(
            {
              silent: true,
            }
          );
        }

        openHouseSelection(
          clickedPickup
            .dataset
            .resourceId ??
            null
        );

        return;
      }

      if (clickedEaves) {
        if (
          selectedBuildId
        ) {
          cancelPlacement(
            {
              silent: true,
            }
          );
        }

        openHouseSelection();

        return;
      }

      if (clickedFacility) {
        if (
          selectedBuildId
        ) {
          cancelPlacement(
            {
              silent: true,
            }
          );
        }

        openSelection(
          column,
          row
        );

        return;
      }

      if (
        selectedBuildId
      ) {
        await placeSelectedFacility(
          column,
          row
        );

        return;
      }

      openSelection(
        column,
        row
      );
    }
  );

  // ============================================================
  // Top controls
  // ============================================================

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

  // ============================================================
  // Tabs
  // ============================================================

  infoTabs.forEach(
    (tab) => {
      tab.addEventListener(
        "click",
        () => {
          infoTabs.forEach(
            (candidate) => {
              const active =
                candidate ===
                tab;

              candidate.classList.toggle(
                "is-active",
                active
              );

              candidate.setAttribute(
                "aria-selected",
                active
                  ? "true"
                  : "false"
              );
            }
          );

          infoPanels.forEach(
            (panel) => {
              const active =
                panel.id ===
                tab.dataset.panel;

              panel.hidden =
                !active;

              panel.classList.toggle(
                "is-active",
                active
              );
            }
          );
        }
      );
    }
  );

  document.addEventListener(
    "keydown",
    (event) => {
      if (
        event.key ===
        "Escape"
      ) {
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
          mapZoom +
          ZOOM_STEP
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
          mapZoom -
          ZOOM_STEP
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

  // ============================================================
  // Startup
  // ============================================================

  function setGameLoaded(
    name,
    state
  ) {
    gameLoaded = true;

    currentGameName.textContent =
      name ||
      "Current Game";

    startupOverlay.hidden =
      true;

    startupStatus.textContent =
      "";

    renderState(
      state
    );

    statusLine.textContent =
      "Select a tile or facility to interact.";

    startRuntime();
  }

  async function beginNewGame() {
    startupStatus.textContent =
      "Creating new game…";

    newGameButton.disabled =
      true;

    loadGameButton.disabled =
      true;

    try {
      const result =
        await api(
          "/api/new-game",
          {
            method: "POST",
            body: "{}",
          }
        );

      setGameLoaded(
        result.game_name,
        result.state
      );
    } catch (error) {
      startupStatus.textContent =
        error.message;
    } finally {
      newGameButton.disabled =
        false;

      loadGameButton.disabled =
        false;
    }
  }

  async function showSavedGames() {
    startupMainActions.hidden =
      true;

    loadGamePanel.hidden =
      false;

    startupStatus.textContent =
      "Loading saved games…";

    saveGameList.replaceChildren();

    try {
      const result =
        await api(
          "/api/saves"
        );

      if (
        !result.saves
          ?.length
      ) {
        const message =
          document.createElement(
            "p"
          );

        message.className =
          "no-saves-message";

        message.textContent =
          "No saved games found.";

        saveGameList.appendChild(
          message
        );
      } else {
        for (
          const save
          of result.saves
        ) {
          const button =
            document.createElement(
              "button"
            );

          button.type =
            "button";

          button.className =
            "save-game-option";

          const strong =
            document.createElement(
              "strong"
            );

          strong.textContent =
            save.label;

          const small =
            document.createElement(
              "small"
            );

          small.textContent =
            save.path;

          button.append(
            strong,
            small
          );

          button.addEventListener(
            "click",
            () => {
              loadSavedGame(
                save.id
              );
            }
          );

          saveGameList.appendChild(
            button
          );
        }
      }

      startupStatus.textContent =
        "";
    } catch (error) {
      startupStatus.textContent =
        error.message;
    }
  }

  async function loadSavedGame(
    saveId
  ) {
    startupStatus.textContent =
      "Loading game…";

    try {
      const result =
        await api(
          "/api/load-game",
          {
            method: "POST",

            body:
              JSON.stringify(
                {
                  save_id:
                    saveId,
                }
              ),
          }
        );

      setGameLoaded(
        result.game_name,
        result.state
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
      loadGamePanel.hidden =
        true;

      startupMainActions.hidden =
        false;

      startupStatus.textContent =
        "";
    }
  );

  async function initialize() {
    renderMapTransform();

    setRuntimeRunning(
      false
    );

    try {
      const session =
        await api(
          "/api/session"
        );

      if (
        session.game_loaded
      ) {
        const state =
          await api(
            "/api/simulation"
          );

        setGameLoaded(
          session.game_name,
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