"use strict";

const landGrid = document.getElementById("land-grid");

if (landGrid) {
  const gridSize = 42;
  const buildings = {
    "chicken-coop": { name: "Chicken coop", image: "ChickenCoop.png", width: 4, height: 3 },
    "solar-array": { name: "Solar array", image: "ElectroSolar.png", width: 4, height: 3 },
    "garden-plot": { name: "Garden plot", image: "InGroundPlot.png", width: 4, height: 2 },
    "bsfl-reactor": { name: "BSFL reactor", image: "BSFLReactor.png", width: 2, height: 2 },
    "compost-pile": { name: "Compost pile", image: "CompostPile.png", width: 2, height: 2 },
    "rain-barrel": { name: "Rain barrel", image: "RainBarrel.png", width: 1, height: 1 },
  };
  const placements = [];
  const buildOptions = document.querySelectorAll(".build-option");
  const rotateButton = document.getElementById("rotate-building");
  const cancelButton = document.getElementById("cancel-building");
  const status = document.getElementById("placement-status");
  let selectedId = null;
  let rotated = false;
  let hoverPosition = null;
  let preview = null;

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
    const building = buildings[selectedId];
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

  buildOptions.forEach((button) => {
    button.addEventListener("click", () => {
      selectedId = button.dataset.building;
      rotated = false;
      buildOptions.forEach((option) => option.setAttribute("aria-pressed", String(option === button)));
      rotateButton.disabled = false;
      cancelButton.disabled = false;
      const building = footprint();
      status.textContent = `${building.name} selected (${building.width * 5} × ${building.height * 5} ft). Click an open tile to place.`;
      if (hoverPosition) showPreview(hoverPosition.column, hoverPosition.row);
    });
  });

  landGrid.addEventListener("pointerover", (event) => {
    const cell = event.target.closest(".grid-cell");
    if (cell) showPreview(Number(cell.dataset.column), Number(cell.dataset.row));
  });

  landGrid.addEventListener("click", (event) => {
    const cell = event.target.closest(".grid-cell");
    const building = footprint();
    if (!cell || !building) return;

    const column = Number(cell.dataset.column);
    const row = Number(cell.dataset.row);
    if (!canPlace(column, row, building.width, building.height)) {
      status.textContent = "That footprint is out of bounds or overlaps another structure.";
      return;
    }

    const sprite = document.createElement("img");
    sprite.className = "building-sprite placed-building";
    sprite.src = `/static/assets/sprites/${building.image}`;
    sprite.alt = `${building.name}, ${building.width * 5} by ${building.height * 5} feet`;
    sprite.title = `${building.name} · ${building.width * 5} × ${building.height * 5} ft`;
    sprite.style.gridColumn = `${column + 1} / span ${building.width}`;
    sprite.style.gridRow = `${row + 1} / span ${building.height}`;
    landGrid.appendChild(sprite);
    placements.push({ column, row, width: building.width, height: building.height });
    status.textContent = `${building.name} placed at tile ${row + 1}, ${column + 1}.`;
    showPreview(column, row);
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
    buildOptions.forEach((button) => button.setAttribute("aria-pressed", "false"));
    rotateButton.disabled = true;
    cancelButton.disabled = true;
    status.textContent = "Select a structure, then click an open tile to place it.";
  }

  cancelButton.addEventListener("click", cancelPlacement);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") cancelPlacement();
    if (event.key.toLowerCase() === "r" && selectedId) rotateButton.click();
  });
}

