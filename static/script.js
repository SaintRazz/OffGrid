"use strict";

const landGrid = document.getElementById("land-grid");

if (landGrid) {
  const GRID_SIZE = 42;
  const MIN_ZOOM = 1;
  const MAX_ZOOM = 4;
  const ZOOM_STEP = 0.25;
  const DRAG_THRESHOLD_PX = 5;
  const SUBTICK_REAL_MS = 1000;

  const buildList = document.getElementById("build-list");
  const cancelButton = document.getElementById("cancel-building");
  const statusLine = document.getElementById("placement-status");
  const currentGameName = document.getElementById("current-game-name");
  const runtimeStatus = document.querySelector(".runtime-status");
  const runtimeLabel = document.getElementById("runtime-label");

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

  const playerInventoryList = document.getElementById("player-inventory-list");
  const playerInventoryResource = document.getElementById("player-inventory-resource");
  const playerInventoryAmount = document.getElementById("player-inventory-amount");
  const loadPlayerInventoryButton = document.getElementById("load-player-inventory");
  const unloadPlayerInventoryButton = document.getElementById("unload-player-inventory");

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
  let subTickInFlight = false;
  let gameLoaded = false;
  let inspectorPausedRuntime = false;
  let inspectorMode = "summary";
  let interactionOpen = false;
  let deferredSubTickState = null;
  let deferredSubTickMovement = null;

  // ============================================================
  // Grid
  // ============================================================

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

  function formatAmount(value, maximumFractionDigits = 4) {
    return new Intl.NumberFormat(undefined, {
      maximumFractionDigits,
    }).format(Number(value ?? 0));
  }

  function prettyName(value) {
    return String(value ?? "")
      .replaceAll("_", " ")
      .replaceAll("-", " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function resourceDefinition(resourceId) {
    return simulationState?.resource_definitions?.[resourceId] ?? null;
  }

  function resourceLabel(resourceId) {
    return resourceDefinition(resourceId)?.name ?? prettyName(resourceId);
  }

  function resourceUnit(resourceId) {
    return (
      resourceDefinition(resourceId)?.unit ??
      (resourceId === "chicken" ? "bird" : "lb")
    );
  }

  function addListItem(list, label, value) {
    const item = document.createElement("li");
    item.textContent = `${label}: ${value}`;
    list.appendChild(item);
  }

  async function api(url, options = {}) {
    const response = await fetch(url, {
      headers: {
        "Content-Type": "application/json",
        ...(options.headers ?? {}),
      },
      ...options,
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(
        data.error ||
        `${response.status} ${response.statusText}`
      );
    }

    return data;
  }

  // ============================================================
  // Runtime clock
  // ============================================================

  function setRuntimeRunning(running, label = null) {
    runtimeStatus?.classList.toggle("is-running", running);

    if (runtimeLabel) {
      runtimeLabel.textContent =
        label ??
        (running ? "Running" : "Paused");
    }
  }

  function startRuntime() {
    if (runtimeTimer !== null) {
      return;
    }

    if (interactionOpen) {
      setRuntimeRunning(
        false,
        "Paused for interaction"
      );

      return;
    }

    setRuntimeRunning(true);

    runtimeTimer = window.setInterval(
      runSubTick,
      SUBTICK_REAL_MS
    );
  }

  function stopRuntime(label = "Paused") {
    if (runtimeTimer !== null) {
      window.clearInterval(runtimeTimer);
      runtimeTimer = null;
    }

    setRuntimeRunning(false, label);
  }

  async function runSubTick() {
    if (
      !gameLoaded ||
      subTickInFlight ||
      interactionOpen
    ) {
      return;
    }

    subTickInFlight = true;

    try {
      const result = await api(
        "/api/subtick",
        {
          method: "POST",
          body: "{}",
        }
      );

      if (interactionOpen) {
        deferredSubTickState =
          result.state;

        deferredSubTickMovement =
          result.movement ?? null;

        return;
      }

      renderState(
        result.state,
        result.movement ?? null
      );

      if (result.full_tick) {
        statusLine.textContent =
          "Hourly simulation processed and saved.";
      }
    } catch (error) {
      stopRuntime("Stopped");

      statusLine.textContent =
        `Automatic time stopped: ${error.message}`;
    } finally {
      subTickInFlight = false;
    }
  }

  function setDateAndClock(state) {
    const dateElement =
      document.getElementById("simulation-date");

    const clockElement =
      document.getElementById("simulation-clock");

    if (!state?.current_time) {
      dateElement.textContent =
        "Not started";

      clockElement.textContent =
        "--:--";

      return;
    }

    const date =
      new Date(state.current_time);

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
      Math.max(minimum, value)
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

    if (newZoom === mapZoom) {
      return;
    }

    const rect =
      mapViewport.getBoundingClientRect();

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
        mapZoom + ZOOM_STEP
      );
    }
  );

  zoomOutButton.addEventListener(
    "click",
    () => {
      setMapZoom(
        mapZoom - ZOOM_STEP
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

    mapPointerDown =
      false;

    mapPointerId =
      null;

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

    mapDragStarted =
      false;
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

    const column =
      clamp(
        Math.floor(
          (clientX - rect.left) /
          (
            rect.width /
            GRID_SIZE
          )
        ),
        0,
        GRID_SIZE - 1
      );

    const row =
      clamp(
        Math.floor(
          (clientY - rect.top) /
          (
            rect.height /
            GRID_SIZE
          )
        ),
        0,
        GRID_SIZE - 1
      );

    return {
      column,
      row,
    };
  }

  // ============================================================
  // Building placement
  // ============================================================

  function canPlace(
    column,
    row,
    width,
    height
  ) {
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

    return placements.every(
      (placed) =>
        column + width <=
          placed.column ||
        placed.column +
          placed.width <=
          column ||
        row + height <=
          placed.row ||
        placed.row +
          placed.height <=
          row
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

    preview.alt =
      "";

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
    const placementActive =
      Boolean(
        selectedBuildId
      );

    cancelButton.disabled =
      !placementActive;

    buildList
      .querySelectorAll(
        ".build-option"
      )
      .forEach(
        (button) => {
          button.setAttribute(
            "aria-pressed",
            placementActive &&
              button.dataset.facilityId ===
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
        definitionsById.get(
          facilityId
        )?.name ??
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
            body: JSON.stringify({
              facility_id:
                selectedBuildId,
              column,
              row,
            }),
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
      simulationState?.map
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

      button.type =
        "button";

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

      image.alt =
        "";

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
        !button ||
        !buildList.contains(
          button
        )
      ) {
        return;
      }

      selectBuild(
        button.dataset.facilityId
      );
    }
  );

  // ============================================================
  // Selection / interaction popup
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
        ?.classList.add(
          "is-map-selected"
        );
    } else {
      landGrid
        .querySelector(
          `.grid-cell[data-column="${column}"][data-row="${row}"]`
        )
        ?.classList.add(
          "is-map-selected"
        );
    }
  }

  // ============================================================
  // Manage contents
  // ============================================================

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
            "Chicken",
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
              process.maximum_larval_biomass_lb ??
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
              container.usable_capacity_lb ??
              0
            ),
        },
      ];
    }

    if (
      definition.id ===
      "compost-pile"
    ) {
      const capacity =
        Number(
          container.capacity ??
          0
        );

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
            capacity,
          })
        );
    }

    return [];
  }

  function pendingAmount(
    instanceId,
    field
  ) {
    return (
      simulationState
        ?.pending_events ??
      []
    )
      .filter(
        (event) =>
          event.type ===
            "facility_fill" &&
          event.instance_id ===
            instanceId &&
          event.target_field ===
            field
      )
      .reduce(
        (sum, event) =>
          sum +
          Number(
            event.amount ??
            0
          ),
        0
      );
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
      "Kitchen and paper waste are separated abstractly inside the household and appear at these pickup points. Picked-up material moves into the Homesteader's carried inventory.";

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

      card.appendChild(
        heading
      );

      const stats =
        document.createElement(
          "p"
        );

      stats.className =
        "contents-stats";

      stats.textContent =
        `At pickup point: ${formatAmount(available)} ${stream.unit} · ` +
        `Carried by Homesteader: ${formatAmount(carried)} ${stream.unit}`;

      card.appendChild(
        stats
      );

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

      input.type =
        "number";

      input.min =
        "0";

      input.step =
        "0.1";

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
        "Pick up";

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

          if (
            !Number.isFinite(
              amount
            ) ||
            amount <= 0
          ) {
            statusLine.textContent =
              "Enter an amount greater than zero.";

            return;
          }

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
              `${formatAmount(amount)} ${stream.unit} ${stream.label.toLowerCase()} picked up.`;
          } catch (error) {
            statusLine.textContent =
              error.message;
          }
        }
      );

      card.appendChild(
        form
      );

      inspectorContent.appendChild(
        card
      );
    }

    const trash =
      document.createElement(
        "p"
      );

    trash.className =
      "contents-message house-trash-note";

    trash.textContent =
      "Recalcitrant household waste is abstracted as curbside garbage and has no pickup inventory in this version.";

    inspectorContent.appendChild(
      trash
    );
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
        "This selection has no manually fillable contents.";

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
      "Transfers reserve inventory immediately. Additions become active at the next hourly full tick, so material added mid-hour is not processed retroactively.";

    inspectorContent.appendChild(
      intro
    );

    for (
      const option
      of options
    ) {
      const current =
        Number(
          selection.instance[
            option.currentField
          ] ??
          0
        );

      const pending =
        pendingAmount(
          selection.instance
            .instance_id,
          option.currentField
        );

      const available =
        Number(
          simulationState
            ?.player
            ?.inventory
            ?.[option.resourceId] ??
          0
        );

      const remaining =
        Math.max(
          0,
          option.capacity -
            current -
            pending
        );

      const maximum =
        Math.max(
          0,
          Math.min(
            available,
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

      card.appendChild(
        heading
      );

      const stats =
        document.createElement(
          "p"
        );

      stats.className =
        "contents-stats";

      stats.textContent =
        `Current: ${formatAmount(current)} ${option.unit} · ` +
        `Pending: ${formatAmount(pending)} ${option.unit} · ` +
        `Capacity: ${formatAmount(option.capacity)} ${option.unit} · ` +
        `Carried by Homesteader: ${formatAmount(available)} ${option.unit}`;

      card.appendChild(
        stats
      );

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
        `Amount to add (${option.unit})`;

      const input =
        document.createElement(
          "input"
        );

      input.type =
        "number";

      input.min =
        "0";

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
                ? Math.floor(
                    maximum
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

      const addButton =
        document.createElement(
          "button"
        );

      addButton.type =
        "submit";

      addButton.className =
        "interaction-button primary";

      addButton.textContent =
        "Add";

      addButton.disabled =
        maximum <= 0;

      form.append(
        label,
        addButton
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
            statusLine.textContent =
              "Enter an amount greater than zero.";

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

            if (
              selectedMapObject
            ) {
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

              renderContentsManager(
                selectedMapObject
              );
            }

            statusLine.textContent =
              `${formatAmount(amount)} ${option.unit} ${option.label.toLowerCase()} staged for the next full tick.`;
          } catch (error) {
            statusLine.textContent =
              error.message;
          }
        }
      );

      card.appendChild(
        form
      );

      inspectorContent.appendChild(
        card
      );
    }
  }

  // ============================================================
  // Selection summaries
  // ============================================================

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

    if (
      selection?.kind ===
      "house"
    ) {
      const house =
        simulationState
          ?.house ??
        {};

      const rows = [
        [
          "Type",
          "House edge / pickup area",
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

        dt.textContent =
          label;

        dd.textContent =
          value;

        dl.append(
          dt,
          dd
        );
      }

      inspectorContent.appendChild(
        dl
      );

      return;
    }

    const rows = [
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
      rows.push([
        "Condition",
        `${formatAmount(
          (
            selection.instance
              .condition ??
            1
          ) * 100,
          1
        )}%`,
      ]);

      rows.push([
        "Accrued labor",
        `${formatAmount(
          selection.instance
            .accrued_labor_requirement ??
          0,
          3
        )} h`,
      ]);

      if (
        selection.instance
          .current_fill != null
      ) {
        rows.push([
          "Current fill",
          formatAmount(
            selection.instance
              .current_fill
          ),
        ]);
      }

      if (
        selection.instance
          .feedstock_mass != null
      ) {
        rows.push([
          "Feedstock",
          `${formatAmount(
            selection.instance
              .feedstock_mass
          )} lb`,
        ]);
      }

      if (
        selection.instance
          .larval_biomass != null
      ) {
        rows.push([
          "Larval biomass",
          `${formatAmount(
            selection.instance
              .larval_biomass
          )} lb`,
        ]);
      }

      if (
        selection.instance
          .raw_material_mass != null
      ) {
        rows.push([
          "Raw material",
          `${formatAmount(
            selection.instance
              .raw_material_mass
          )} lb`,
        ]);
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

      dt.textContent =
        label;

      dd.textContent =
        value;

      dl.append(
        dt,
        dd
      );
    }

    inspectorContent.appendChild(
      dl
    );
  }

  function beginInteractionPause() {
    interactionOpen =
      true;

    if (runtimeTimer !== null) {
      inspectorPausedRuntime =
        true;

      stopRuntime(
        "Paused for interaction"
      );
    } else {
      inspectorPausedRuntime =
        false;
    }
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
      kind:
        "map",
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
      false;

    manageContentsButton.title =
      selectedMapObject.instance
        ? "Manage facility contents"
        : "View contents available for this tile";

    inspectorOverlay.hidden =
      false;

    walkHereButton.focus();
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
        row: 40.0,
      };

    selectedMapObject = {
      kind:
        "house",
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

    manageContentsButton.title =
      "Manage household waste pickup";

    inspectorOverlay.hidden =
      false;

    walkHereButton.focus();
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

    inspectorOverlay.hidden =
      true;

    selectedMapObject =
      null;

    inspectorMode =
      "summary";

    inspectorPausedRuntime =
      false;

    interactionOpen =
      false;

    if (deferredSubTickState) {
      const state =
        deferredSubTickState;

      const movement =
        deferredSubTickMovement;

      deferredSubTickState =
        null;

      deferredSubTickMovement =
        null;

      renderState(
        state,
        movement
      );
    }

    if (shouldResume) {
      startRuntime();
    }
  }

  inspectorCloseButton.addEventListener(
    "click",
    closeInspector
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
              method:
                "POST",

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
          result.status ===
            "already_there"
            ? "Homesteader is already at that location."
            : `Walking to tile ${column + 1}, ${row + 1}.`;
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

      inspectorMode =
        "contents";

      renderContentsManager(
        selectedMapObject
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

    landGrid.appendChild(
      avatar
    );

    return avatar;
  }

  function avatarAsset(
    direction,
    walking
  ) {
    if (!walking) {
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

  function renderAvatar(
    movement = null
  ) {
    const player =
      simulationState?.player;

    if (!player) {
      avatar?.remove();
      avatar = null;

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

    const activeTask =
      player.current_task;

    const direction =
      movement?.direction ??
      activeTask?.direction ??
      player.last_direction ??
      "down";

    const walking =
      Boolean(
        activeTask?.type ===
          "walk" ||
        movement?.type ===
          "walk"
      );

    element.style.left =
      `${
        (
          (column + 0.5) /
          GRID_SIZE
        ) * 100
      }%`;

    element.style.top =
      `${
        (
          (row + 1) /
          GRID_SIZE
        ) * 100
      }%`;

    element.src =
      avatarAsset(
        direction,
        walking
      );

    element.classList.toggle(
      "walk-left",
      walking &&
        direction ===
          "left"
    );

    if (
      movement?.completed &&
      !activeTask
    ) {
      window.setTimeout(
        () => {
          if (
            simulationState
              ?.player
              ?.current_task ==
              null &&
            avatar
          ) {
            avatar.src =
              "/static/assets/sprites/HomesteaderIdle.png";

            avatar.classList.remove(
              "walk-left"
            );
          }
        },
        850
      );
    }
  }

  // ============================================================
  // Homesteader inventory
  // ============================================================

  function inventoryResourceIds() {
    const ids =
      new Set([
        ...Object.keys(
          simulationState
            ?.inventories ??
          {}
        ),

        ...Object.keys(
          simulationState
            ?.player
            ?.inventory ??
          {}
        ),

        ...Object.keys(
          simulationState
            ?.resource_definitions ??
          {}
        ),
      ]);

    return [...ids].sort(
      (a, b) =>
        resourceLabel(a)
          .localeCompare(
            resourceLabel(b)
          )
    );
  }

  function renderPlayerInventoryControls() {
    if (
      !playerInventoryList ||
      !playerInventoryResource
    ) {
      return;
    }

    playerInventoryList.replaceChildren();

    const carried =
      simulationState
        ?.player
        ?.inventory ??
      {};

    const carriedEntries =
      Object.entries(
        carried
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

    if (
      !carriedEntries.length
    ) {
      const item =
        document.createElement(
          "li"
        );

      item.textContent =
        "Nothing carried.";

      playerInventoryList.appendChild(
        item
      );
    } else {
      for (
        const [
          resourceId,
          amount,
        ]
        of carriedEntries
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

    const previousSelection =
      playerInventoryResource.value;

    playerInventoryResource.replaceChildren();

    for (
      const resourceId
      of inventoryResourceIds()
    ) {
      const householdAmount =
        Number(
          simulationState
            ?.inventories
            ?.[resourceId] ??
          0
        );

      const carriedAmount =
        Number(
          carried
            ?.[resourceId] ??
          0
        );

      if (
        householdAmount <=
          1e-9 &&
        carriedAmount <=
          1e-9
      ) {
        continue;
      }

      const option =
        document.createElement(
          "option"
        );

      option.value =
        resourceId;

      option.textContent =
        `${resourceLabel(resourceId)} — ` +
        `household ${formatAmount(householdAmount)} ${resourceUnit(resourceId)}, ` +
        `carried ${formatAmount(carriedAmount)} ${resourceUnit(resourceId)}`;

      playerInventoryResource.appendChild(
        option
      );
    }

    if (
      !playerInventoryResource
        .options
        .length
    ) {
      const option =
        document.createElement(
          "option"
        );

      option.value =
        "";

      option.textContent =
        "No transferable resources";

      playerInventoryResource.appendChild(
        option
      );

      playerInventoryResource.disabled =
        true;

      playerInventoryAmount.disabled =
        true;

      loadPlayerInventoryButton.disabled =
        true;

      unloadPlayerInventoryButton.disabled =
        true;

      return;
    }

    playerInventoryResource.disabled =
      false;

    playerInventoryAmount.disabled =
      false;

    loadPlayerInventoryButton.disabled =
      false;

    unloadPlayerInventoryButton.disabled =
      false;

    if (
      [
        ...playerInventoryResource.options,
      ].some(
        (option) =>
          option.value ===
          previousSelection
      )
    ) {
      playerInventoryResource.value =
        previousSelection;
    }

    syncInventoryAmountStep();
  }

  function syncInventoryAmountStep() {
    const resourceId =
      playerInventoryResource
        ?.value;

    if (
      !resourceId ||
      !playerInventoryAmount
    ) {
      return;
    }

    const integerOnly =
      resourceId ===
      "chicken";

    playerInventoryAmount.step =
      integerOnly
        ? "1"
        : "0.1";

    if (integerOnly) {
      playerInventoryAmount.value =
        String(
          Math.max(
            1,
            Math.floor(
              Number(
                playerInventoryAmount
                  .value
              ) ||
              1
            )
          )
        );
    }
  }

  async function transferPlayerInventory(
    direction
  ) {
    const resourceId =
      playerInventoryResource
        ?.value;

    const amount =
      Number(
        playerInventoryAmount
          ?.value
      );

    if (!resourceId) {
      statusLine.textContent =
        "Select a resource to transfer.";

      return;
    }

    if (
      !Number.isFinite(
        amount
      ) ||
      amount <= 0
    ) {
      statusLine.textContent =
        "Enter an amount greater than zero.";

      return;
    }

    try {
      const result =
        await api(
          "/api/player/inventory/transfer",
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

      statusLine.textContent =
        direction ===
          "to_player"
          ? `${formatAmount(amount)} ${resourceUnit(resourceId)} ${resourceLabel(resourceId)} loaded onto the Homesteader.`
          : `${formatAmount(amount)} ${resourceUnit(resourceId)} ${resourceLabel(resourceId)} returned to household stores.`;
    } catch (error) {
      statusLine.textContent =
        error.message;
    }
  }

  playerInventoryResource
    ?.addEventListener(
      "change",
      syncInventoryAmountStep
    );

  loadPlayerInventoryButton
    ?.addEventListener(
      "click",
      () =>
        transferPlayerInventory(
          "to_player"
        )
    );

  unloadPlayerInventoryButton
    ?.addEventListener(
      "click",
      () =>
        transferPlayerInventory(
          "to_household"
        )
    );

  // ============================================================
  // State rendering
  // ============================================================

  function renderHouse() {
    landGrid
      .querySelectorAll(
        ".house-eaves, .house-pickup"
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

    eavesElement.dataset.houseId =
      house.id ??
      "main-house";

    eavesElement.style.gridColumn =
      `${Number(eaves.column) + 1} / span ${Number(eaves.width)}`;

    eavesElement.style.gridRow =
      `${GRID_SIZE} / span 1`;

    eavesElement.setAttribute(
      "aria-label",
      "House eaves at south edge of property"
    );

    landGrid.appendChild(
      eavesElement
    );

    const pickupPoints =
      house.pickup_points ??
      {};

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
        pickupPoints[
          resourceId
        ];

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
        `${Math.floor(Number(point.column)) + 1} / span 2`;

      button.style.gridRow =
        `${Math.floor(Number(point.row)) + 1} / span 2`;

      const amount =
        Number(
          house.outputs
            ?.[resourceId] ??
          0
        );

      const icon =
        resourceId ===
          "kitchen_waste"
          ? "♻"
          : "▤";

      button.innerHTML =
        `<span class="pickup-icon" aria-hidden="true">${icon}</span>` +
        `<span>${text}</span>` +
        `<strong>${formatAmount(amount, 2)} lb</strong>`;

      button.title =
        `${text} pickup: ${formatAmount(amount)} lb available`;

      button.setAttribute(
        "aria-label",
        `${text} pickup, ${formatAmount(amount)} pounds available`
      );

      landGrid.appendChild(
        button
      );
    }
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
      ).map(
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
  }

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
        player.current_task;

      addListItem(
        playerList,
        "Activity",
        task?.type ===
          "walk"
          ? `Walking ${task.direction}`
          : "Idle"
      );

      if (
        task?.target
      ) {
        addListItem(
          playerList,
          "Destination",
          `${formatAmount(
            task.target
              .column,
            0
          )}, ${formatAmount(
            task.target
              .row,
            0
          )}`
        );
      }
    }

    renderPlayerInventoryControls();

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
      const [key, value]
      of Object.entries(
        electricity
      )
    ) {
      if (
        key ===
        "total"
      ) {
        continue;
      }

      addListItem(
        electricityList,
        prettyName(key),
        `${formatAmount(
          value
        )} kWh / day`
      );
    }

    const wasteList =
      document.getElementById(
        "waste-water-list"
      );

    wasteList.replaceChildren();

    for (
      const [key, value]
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
        `${formatAmount(
          value
        )} ${unit}`
      );
    }

    const resourceList =
      document.getElementById(
        "resource-list"
      );

    resourceList.replaceChildren();

    for (
      const [
        id,
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
          prettyName(id),
        `${formatAmount(
          resource.amount
        )} ${resource.unit ?? ""}`.trim()
      );
    }

    const operationsList =
      document.getElementById(
        "facility-status-list"
      );

    operationsList.replaceChildren();

    if (!placements.length) {
      const li =
        document.createElement(
          "li"
        );

      li.textContent =
        "No placed facilities.";

      operationsList.appendChild(
        li
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

        const op =
          instance.last_operation;

        addListItem(
          operationsList,
          definition?.name ??
            instance.facility_id,
          op?.status ??
            "Awaiting first hourly tick"
        );
      }
    }
  }

  function renderState(
    state,
    movement = null
  ) {
    simulationState =
      state;

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

    if (
      selectedMapObject
    ) {
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

        manageContentsButton.disabled =
          false;

        manageContentsButton.title =
          "Manage household waste pickup";
      } else {
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

        markMapSelection(
          selectedMapObject
            .column,
          selectedMapObject
            .row,
          refreshedInstance
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

        manageContentsButton.disabled =
          false;

        manageContentsButton.title =
          selectedMapObject.instance
            ? "Manage facility contents"
            : "View contents available for this tile";
      }
    }

    renderAvatar(
      movement
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
        event.target.closest?.(
          ".house-pickup"
        ) ??
        null;

      const clickedEaves =
        event.target.closest?.(
          ".house-eaves"
        ) ??
        null;

      const clickedFacilityElement =
        event.target.closest?.(
          ".placed-building"
        ) ??
        null;

      if (clickedPickup) {
        if (
          selectedBuildId
        ) {
          cancelPlacement({
            silent: true,
          });
        }

        openHouseSelection(
          clickedPickup.dataset
            .resourceId ??
            null
        );

        return;
      }

      if (clickedEaves) {
        if (
          selectedBuildId
        ) {
          cancelPlacement({
            silent: true,
          });
        }

        openHouseSelection();

        return;
      }

      if (
        clickedFacilityElement
      ) {
        if (
          selectedBuildId
        ) {
          cancelPlacement({
            silent: true,
          });
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

  // ============================================================
  // Startup / load
  // ============================================================

  function setGameLoaded(
    name,
    state
  ) {
    gameLoaded =
      true;

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
            method:
              "POST",
            body:
              "{}",
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

          button.innerHTML =
            `<strong></strong><small></small>`;

          button
            .querySelector(
              "strong"
            )
            .textContent =
              save.label;

          button
            .querySelector(
              "small"
            )
            .textContent =
              save.path;

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
            method:
              "POST",

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
    setRuntimeRunning(false);

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