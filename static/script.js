"use strict";

const landGrid = document.getElementById("land-grid");

if (landGrid) {
  const gridSize = 42;
  const placements = [];
  const buildList = document.getElementById("build-list");
  const rotateButton = document.getElementById("rotate-building");
  const cancelButton = document.getElementById("cancel-building");
  const tickButton = document.getElementById("advance-tick");
  const status = document.getElementById("placement-status");
  const definitionsById = new Map();
  let selectedId = null;
  let rotated = false;
  let hoverPosition = null;
  let preview = null;
  let simulationState = null;

  for (let row = 0; row < gridSize; row += 1) {
    for (let column = 0; column < gridSize; column += 1) {
      const cell = document.createElement("div");
      cell.className = "grid-cell";
      cell.setAttribute("role", "gridcell");
      cell.setAttribute("aria-label", `Grass tile, row ${row + 1}, column ${column + 1}`);
      cell.dataset.row = row;
      cell.dataset.column = column;
      cell.style.gridRow = String(row + 1);
      cell.style.gridColumn = String(column + 1);
      landGrid.appendChild(cell);
    }
  }

  function footprint() {
    const building = definitionsById.get(selectedId);
    if (!building) return null;
    return rotated
      ? { ...building, width: building.height, height: building.width }
      : building;
  }

  function canPlace(column, row, width, height) {
    if (column + width > gridSize || row + height > gridSize) return false;
    return placements.every((placed) =>
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
    if (!building) return;

    preview = document.createElement("img");
    preview.className = "building-sprite building-preview";
    preview.src = `/static/assets/sprites/${building.image}`;
    preview.alt = "";
    preview.style.gridColumn = `${column + 1} / span ${building.width}`;
    preview.style.gridRow = `${row + 1} / span ${building.height}`;
    preview.classList.add(canPlace(column, row, building.width, building.height) ? "is-valid" : "is-invalid");
    landGrid.appendChild(preview);
  }

  function formatAmount(amount) {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(amount);
  }

  function setDateAndClock(value) {
    const date = new Date(value);
    document.getElementById("simulation-date").textContent = new Intl.DateTimeFormat(undefined, {
      year: "numeric", month: "short", day: "numeric",
    }).format(date);
    document.getElementById("simulation-clock").textContent = new Intl.DateTimeFormat(undefined, {
      hour: "numeric", minute: "2-digit",
    }).format(date);
  }

  function renderResources() {
    const resourceList = document.getElementById("resource-list");
    resourceList.replaceChildren();
    Object.entries(simulationState.resources).forEach(([resourceId, resource]) => {
      const item = document.createElement("li");
      item.textContent = `${resource.name}: ${formatAmount(resource.amount)} ${resource.unit}`;
      resourceList.appendChild(item);
    });

    ["electricity", "water", "produce"].forEach((resourceId) => {
      const resource = simulationState.resources[resourceId];
      document.getElementById(`stat-${resourceId}`).textContent =
        `${formatAmount(resource.amount)} ${resource.unit}`;
    });
  }

  function formatFlows(flows) {
    return Object.entries(flows).map(([resourceId, amount]) => {
      const resource = simulationState.resources[resourceId];
      return `${formatAmount(amount)} ${resource.unit} ${resource.name.toLowerCase()}`;
    }).join(", ");
  }

  function renderOperations() {
    const list = document.getElementById("facility-status-list");
    list.replaceChildren();
    if (simulationState.instances.length === 0) {
      const item = document.createElement("li");
      item.textContent = "No facilities placed.";
      list.appendChild(item);
      return;
    }

    simulationState.instances.forEach((instance) => {
      const definition = definitionsById.get(instance.facility_id);
      const item = document.createElement("li");
      const operation = instance.last_operation;
      const heading = document.createElement("strong");
      heading.textContent = `${definition.name} · ${instance.instance_id}`;
      item.appendChild(heading);

      const detail = document.createElement("span");
      if (!operation) {
        detail.textContent = `Tile ${instance.row + 1}, ${instance.column + 1} · awaiting first tick`;
      } else {
        const flows = [];
        if (Object.keys(operation.consumed).length) flows.push(`used ${formatFlows(operation.consumed)}`);
        if (Object.keys(operation.produced).length) flows.push(`made ${formatFlows(operation.produced)}`);
        const statusText = operation.status === "operating"
          ? `Operating ${operation.utilization_pct}%`
          : `Idle: ${operation.reason}`;
        detail.textContent = `Tile ${instance.row + 1}, ${instance.column + 1} · ${statusText} · ${formatAmount(operation.labor_used)} labor h${flows.length ? ` · ${flows.join("; ")}` : ""}`;
      }
      item.appendChild(detail);
      list.appendChild(item);
    });
  }

  function renderInstance(instance) {
    const definition = definitionsById.get(instance.facility_id);
    const sprite = document.createElement("img");
    sprite.className = "building-sprite placed-building";
    sprite.src = `/static/assets/sprites/${definition.image}`;
    sprite.alt = `${definition.name}, ${instance.width * 5} by ${instance.height * 5} feet`;
    sprite.title = `${definition.name} · ${instance.width * 5} × ${instance.height * 5} ft`;
    sprite.style.gridColumn = `${instance.column + 1} / span ${instance.width}`;
    sprite.style.gridRow = `${instance.row + 1} / span ${instance.height}`;
    landGrid.appendChild(sprite);
    placements.push(instance);
  }

  function renderState() {
    setDateAndClock(simulationState.current_time);
    renderResources();
    renderOperations();
  }

  async function requestJson(url, options = {}) {
    const response = await fetch(url, options);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Simulation request failed.");
    return result;
  }

  function createBuildOptions(definitions) {
    definitions.forEach((definition) => {
      definitionsById.set(definition.id, definition);
      const button = document.createElement("button");
      button.className = "build-option";
      button.type = "button";
      button.dataset.building = definition.id;
      button.setAttribute("aria-pressed", "false");

      const image = document.createElement("img");
      image.src = `/static/assets/sprites/${definition.image}`;
      image.alt = "";
      const label = document.createElement("span");
      const name = document.createElement("strong");
      name.textContent = definition.name;
      const size = document.createElement("small");
      size.textContent = `${definition.width * 5} × ${definition.height * 5} ft`;
      label.append(name, size);
      button.append(image, label);
      buildList.appendChild(button);
    });

    buildList.querySelectorAll(".build-option").forEach((button) => {
    button.addEventListener("click", () => {
      selectedId = button.dataset.building;
      rotated = false;
      buildList.querySelectorAll(".build-option").forEach((option) => {
        option.setAttribute("aria-pressed", String(option === button));
      });
      rotateButton.disabled = false;
      cancelButton.disabled = false;
      const building = footprint();
      status.textContent = `${building.name} selected (${building.width * 5} × ${building.height * 5} ft). Click an open tile to place.`;
      if (hoverPosition) showPreview(hoverPosition.column, hoverPosition.row);
    });
  });
  }

  async function loadSimulation() {
    try {
      simulationState = await requestJson("/api/simulation");
      createBuildOptions(simulationState.facility_definitions);
      simulationState.instances.forEach(renderInstance);
      renderState();
    } catch (error) {
      status.textContent = error.message;
      tickButton.disabled = true;
    }
  }

  landGrid.addEventListener("pointerover", (event) => {
    const cell = event.target.closest(".grid-cell");
    if (cell) showPreview(Number(cell.dataset.column), Number(cell.dataset.row));
  });

  landGrid.addEventListener("click", async (event) => {
    const cell = event.target.closest(".grid-cell");
    const building = footprint();
    if (!cell || !building) return;

    const column = Number(cell.dataset.column);
    const row = Number(cell.dataset.row);
    if (!canPlace(column, row, building.width, building.height)) {
      status.textContent = "That footprint is out of bounds or overlaps another structure.";
      return;
    }

    try {
      const instance = await requestJson("/api/facilities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ facility_id: selectedId, column, row, rotated }),
      });
      simulationState.instances.push(instance);
      renderInstance(instance);
      renderOperations();
      status.textContent = `${building.name} placed at tile ${row + 1}, ${column + 1}.`;
      showPreview(column, row);
    } catch (error) {
      status.textContent = error.message;
    }
  });

  tickButton.addEventListener("click", async () => {
    tickButton.disabled = true;
    try {
      const result = await requestJson("/api/tick", { method: "POST" });
      simulationState = result.state;
      renderState();
      const operating = result.operations.filter((operation) => operation.status === "operating").length;
      status.textContent = `Hour processed: ${new Date(result.processed_at).toLocaleString()}. ${operating} of ${result.operations.length} facilities operating.`;
    } catch (error) {
      status.textContent = error.message;
    } finally {
      tickButton.disabled = false;
    }
  });

  rotateButton.addEventListener("click", () => {
    if (!selectedId) return;
    rotated = !rotated;
    const building = footprint();
    status.textContent = `${building.name} rotated (${building.width * 5} × ${building.height * 5} ft).`;
    if (hoverPosition) showPreview(hoverPosition.column, hoverPosition.row);
  });

  function cancelPlacement() {
    selectedId = null;
    rotated = false;
    removePreview();
    buildList.querySelectorAll(".build-option").forEach((button) => button.setAttribute("aria-pressed", "false"));
    rotateButton.disabled = true;
    cancelButton.disabled = true;
    status.textContent = "Select a structure, then click an open tile to place it.";
  }

  cancelButton.addEventListener("click", cancelPlacement);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") cancelPlacement();
    if (event.key.toLowerCase() === "r" && selectedId) rotateButton.click();
  });

  loadSimulation();
}

