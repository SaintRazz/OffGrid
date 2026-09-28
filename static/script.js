"use strict";

const landGrid = document.getElementById("land-grid");

if (landGrid) {
  const size = 42;

  for (let i = 0; i < size * size; i += 1) {
    const cell = document.createElement("div");
    cell.className = "grid-cell";

    const terrain = (i % 19 === 0 && i > 0) ? "water" : (i % 13 === 0 ? "green" : "soil");
    cell.classList.add(terrain);

    if (i >= 0 && i < 42) {
      cell.classList.add("road");
    }

    if (i % 42 === 0 || i % 42 === 41 || Math.floor(i / 42) === 0 || Math.floor(i / 42) === 41) {
      cell.classList.add("edge");
    }

    if (i === 210 || i === 211 || i === 252 || i === 253 || i === 294 || i === 295) {
      cell.classList.add("structure");
    }

    if (i >= 400 && i <= 450) {
      cell.classList.add("garden");
    }

    if (i >= 1260 && i <= 1305) {
      cell.classList.add("solar");
    }

    landGrid.appendChild(cell);
  }
}

