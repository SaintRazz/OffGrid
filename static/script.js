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

  // ------------------------------------------------------------
  // Tooltip setup
  // ------------------------------------------------------------

  const tooltip = document.createElement("div");

  tooltip.className = "map-tooltip";
  tooltip.hidden = true;

  document.body.appendChild(tooltip);

  // ------------------------------------------------------------
  // Build base land grid
  // ------------------------------------------------------------

  for (let row = 0; row < gridSize; row += 1) {
    for (let column = 0; column < gridSize; column += 1) {
      const cell = document.createElement("div");

      cell.className = "grid-cell";

      cell.setAttribute(
        "role",
        "gridcell"
      );

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

  // ------------------------------------------------------------
  // General helpers
  // ------------------------------------------------------------

  function formatAmount(amount) {
    return new Intl.NumberFormat(
      undefined,
      {
        maximumFractionDigits: 4,
      }
    ).format(amount ?? 0);
  }

  function prettyName(value) {
    return String(value)
      .replaceAll("_", " ")
      .replaceAll("-", " ")
      .replace(
        /\b\w/g,
        (letter) => letter.toUpperCase()
      );
  }

  function formatTooltipValue(value) {
    if (
      value === null ||
      value === undefined
    ) {
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

  function flattenObject(
    object,
    prefix = "",
    result = []
  ) {
    if (
      !object ||
      typeof object !== "object"
    ) {
      return result;
    }

    Object.entries(object).forEach(
      ([key, value]) => {
        const label = prefix
          ? `${prefix} · ${prettyName(key)}`
          : prettyName(key);

        if (
          value !== null &&
          typeof value === "object" &&
          !Array.isArray(value)
        ) {
          flattenObject(
            value,
            label,
            result
          );

          return;
        }

        if (Array.isArray(value)) {
          result.push([
            label,
            value.length
              ? value.join(", ")
              : "None",
          ]);

          return;
        }

        result.push([
          label,
          formatTooltipValue(value),
        ]);
      }
    );

    return result;
  }

  function extractRates(definition) {
    const rates = [];

    function walk(
      object,
      prefix = ""
    ) {
      if (
        !object ||
        typeof object !== "object"
      ) {
        return;
      }

      Object.entries(object).forEach(
        ([key, value]) => {
          const label = prefix
            ? `${prefix} · ${prettyName(key)}`
            : prettyName(key);

          if (
            value !== null &&
            typeof value === "object" &&
            !Array.isArray(value)
          ) {
            walk(
              value,
              label
            );

            return;
          }

          if (isRateField(key)) {
            rates.push([
              label,
              formatTooltipValue(value),
            ]);
          }
        }
      );
    }

    walk(definition);

    return rates;
  }

  function tooltipSection(
    title,
    rows
  ) {
    if (!rows.length) {
      return "";
    }

    const body = rows
      .map(
        ([label, value]) => `
          <div class="tooltip-row">
            <span>${label}</span>
            <strong>${value}</strong>
          </div>
        `
      )
      .join("");

    return `
      <section class="tooltip-section">
        <h4>${title}</h4>
        ${body}
      </section>
    `;
  }

  function positionTooltip(event) {
    const offset = 16;

    let left =
      event.clientX + offset;

    let top =
      event.clientY + offset;

    tooltip.style.left =
      `${left}px`;

    tooltip.style.top =
      `${top}px`;

    /*
     * Keep the tooltip on screen if it
     * would extend beyond the viewport.
     */
    const box =
      tooltip.getBoundingClientRect();

    if (
      box.right >
      window.innerWidth - 8
    ) {
      left =
        event.clientX -
        box.width -
        offset;
    }

    if (
      box.bottom >
      window.innerHeight - 8
    ) {
      top =
        window.innerHeight -
        box.height -
        8;
    }

    tooltip.style.left =
      `${Math.max(8, left)}px`;

    tooltip.style.top =
      `${Math.max(8, top)}px`;
  }

  function hideTooltip() {
    tooltip.hidden = true;
  }

  // ------------------------------------------------------------
  // Facility tooltip
  // ------------------------------------------------------------

  function showFacilityTooltip(
    instance,
    event
  ) {
    const definition =
      definitionsById.get(
        instance.facility_id
      );

    if (!definition) {
      return;
    }

    /*
     * Permanent characteristics of this
     * facility type.
     *
     * Rate values are pulled out into
     * their own section so they do not
     * appear twice.
     */
    const permanentRows =
      flattenObject(definition)
        .filter(
          ([label]) => {
            const lower =
              label.toLowerCase();

            return (
              lower !== "id" &&
              lower !== "name" &&
              lower !== "image" &&
              !lower.includes("rate") &&
              !lower.includes("yield") &&
              !lower.includes("processing rate") &&
              !lower.includes("degradation rate") &&
              !lower.includes("per day") &&
              !lower.includes("per year") &&
              !lower.includes("per hour")
            );
          }
        );

    const rateRows =
      extractRates(definition);

    /*
     * Current state belongs to this
     * particular facility instance.
     */
    const stateRows =
      flattenObject(instance)
        .filter(
          ([label]) =>
            ![
              "Facility Id",
              "Type",
              "Column",
              "Row",
              "X",
              "Y",
              "Width",
              "Height",
              "Rotated",
              "Last Operation",
            ].includes(label)
        );

    /*
     * The last-operation record tells us
     * what happened during the latest
     * processed hour.
     */
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

    tooltip.innerHTML = `
      <div class="tooltip-title">
        ${definition.name}
      </div>

      <div class="tooltip-subtitle">
        ${instance.instance_id}
        · Tile ${instance.row + 1},
        ${instance.column + 1}
      </div>

      ${tooltipSection(
        "Permanent values",
        permanentRows
      )}

      ${tooltipSection(
        "Rates",
        rateRows
      )}

      ${tooltipSection(
        "Current state",
        stateRows
      )}

      ${tooltipSection(
        "Current operation",
        operationRows
      )}
    `;

    tooltip.hidden = false;

    positionTooltip(event);
  }

  // ------------------------------------------------------------
  // Grass tile tooltip
  // ------------------------------------------------------------

  function showGrassTooltip(
    column,
    row,
    event
  ) {
    const defaultTileId =
      simulationState?.map
        ?.default_tile ??
      "grass-tile";

    const definition =
      definitionsById.get(
        defaultTileId
      );

    if (!definition) {
      return;
    }

    /*
     * A grass tile normally inherits the
     * map default and therefore has no
     * explicit GameState entry.
     *
     * If that individual tile eventually
     * acquires persistent state, find it
     * here.
     */
    const tileState =
      simulationState
        ?.tile_states
        ?.find((tile) => {
          const tileColumn =
            tile.column ??
            tile.x;

          const tileRow =
            tile.row ??
            tile.y;

          return (
            tileColumn === column &&
            tileRow === row
          );
        });

    const permanentRows =
      flattenObject(definition)
        .filter(
          ([label]) => {
            const lower =
              label.toLowerCase();

            return (
              lower !== "id" &&
              lower !== "name" &&
              lower !== "image" &&
              !lower.includes("rate") &&
              !lower.includes("yield") &&
              !lower.includes("processing rate") &&
              !lower.includes("degradation rate") &&
              !lower.includes("per day") &&
              !lower.includes("per year") &&
              !lower.includes("per hour")
            );
          }
        );

    const rateRows =
      extractRates(definition);

    const stateRows =
      tileState
        ? flattenObject(tileState)
            .filter(
              ([label]) =>
                ![
                  "Column",
                  "Row",
                  "X",
                  "Y",
                  "Type",
                ].includes(label)
            )
        : [
            [
              "Land state",
              "Unimproved grass",
            ],
          ];

    tooltip.innerHTML = `
      <div class="tooltip-title">
        ${definition.name}
      </div>

      <div class="tooltip-subtitle">
        Tile ${row + 1},
        ${column + 1}
      </div>

      ${tooltipSection(
        "Permanent values",
        permanentRows
      )}

      ${tooltipSection(
        "Rates",
        rateRows
      )}

      ${tooltipSection(
        "Current state",
        stateRows
      )}
    `;

    tooltip.hidden = false;

    positionTooltip(event);
  }

  // ------------------------------------------------------------
  // Building placement helpers
  // ------------------------------------------------------------

  function footprint() {
    const building =
      definitionsById.get(
        selectedId
      );

    if (!building) {
      return null;
    }

    return rotated
      ? {
          ...building,
          width:
            building.height,
          height:
            building.width,
        }
      : building;
  }

  function canPlace(
    column,
    row,
    width,
    height
  ) {
    if (
      column + width >
        gridSize ||
      row + height >
        gridSize
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
    hoverPosition = {
      column,
      row,
    };

    removePreview();

    const building =
      footprint();

    if (!building) {
      return;
    }

    preview =
      document.createElement(
        "img"
      );

    preview.className =
      "building-sprite building-preview";

    preview.src =
      `/static/assets/sprites/${building.image}`;

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

    landGrid.appendChild(
      preview
    );
  }

  // ------------------------------------------------------------
  // Clock
  // ------------------------------------------------------------

  function setDateAndClock(
    value
  ) {
    const date =
      new Date(value);

    document.getElementById(
      "simulation-date"
    ).textContent =
      new Intl.DateTimeFormat(
        undefined,
        {
          year: "numeric",
          month: "short",
          day: "numeric",
        }
      ).format(date);

    document.getElementById(
      "simulation-clock"
    ).textContent =
      new Intl.DateTimeFormat(
        undefined,
        {
          hour: "numeric",
          minute: "2-digit",
        }
      ).format(date);
  }

  // ------------------------------------------------------------
  // Resource display
  // ------------------------------------------------------------

  function renderResources() {
    const resourceList =
      document.getElementById(
        "resource-list"
      );

    resourceList.replaceChildren();

    Object.entries(
      simulationState.resources ??
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

    [
      "electricity",
      "water",
      "produce",
    ].forEach(
      (resourceId) => {
        const resource =
          simulationState
            .resources?.[
              resourceId
            ];

        const element =
          document.getElementById(
            `stat-${resourceId}`
          );

        if (!element) {
          return;
        }

        if (!resource) {
          element.textContent =
            "--";

          return;
        }

        element.textContent =
          `${formatAmount(
            resource.amount
          )} ${resource.unit}`;
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
              .resources?.[
                resourceId
              ];

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
            )} ${resource.unit} ` +
            `${resource.name.toLowerCase()}`
          );
        }
      )
      .join(", ");
  }

  // ------------------------------------------------------------
  // Facility status panel
  // ------------------------------------------------------------

  function renderOperations() {
    const list =
      document.getElementById(
        "facility-status-list"
      );

    list.replaceChildren();

    if (
      !simulationState
        .instances?.length
    ) {
      const item =
        document.createElement(
          "li"
        );

      item.textContent =
        "No facilities placed.";

      list.appendChild(item);

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

          const operation =
            instance.last_operation;

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
                operation.utilization_pct !=
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
                `Error: ${operation.reason ??
                  "unknown error"}`;
            } else {
              statusText =
                `Idle${
                  operation.reason
                    ? `: ${operation.reason}`
                    : ""
                }`;
            }

            let laborText = "";

            if (
              operation.labor_used !=
              null
            ) {
              laborText =
                ` · ${formatAmount(
                  operation.labor_used
                )} labor h`;
            } else if (
              operation.accrued_labor_requirement !=
              null
            ) {
              laborText =
                ` · ${formatAmount(
                  operation.accrued_labor_requirement
                )} labor h accrued`;
            }

            detail.textContent =
              `Tile ${instance.row + 1}, ` +
              `${instance.column + 1} · ` +
              `${statusText}` +
              laborText +
              (flows.length
                ? ` · ${flows.join(
                    "; "
                  )}`
                : "");
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

  // ------------------------------------------------------------
  // Render placed facility
  // ------------------------------------------------------------

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

    sprite.title =
      `${definition.name} · ` +
      `${instance.width * 5} × ` +
      `${instance.height * 5} ft`;

    sprite.style.gridColumn =
      `${instance.column + 1} / ` +
      `span ${instance.width}`;

    sprite.style.gridRow =
      `${instance.row + 1} / ` +
      `span ${instance.height}`;

    sprite.addEventListener(
      "pointerenter",
      (event) => {
        showFacilityTooltip(
          instance,
          event
        );
      }
    );

    sprite.addEventListener(
      "pointermove",
      (event) => {
        positionTooltip(
          event
        );
      }
    );

    sprite.addEventListener(
      "pointerleave",
      hideTooltip
    );

    landGrid.appendChild(
      sprite
    );

    placements.push(
      instance
    );
  }

  // ------------------------------------------------------------
  // Render state
  // ------------------------------------------------------------

  function renderState() {
    setDateAndClock(
      simulationState.current_time
    );

    renderResources();
    renderOperations();
  }

  // ------------------------------------------------------------
  // API helpers
  // ------------------------------------------------------------

  async function requestJson(
    url,
    options = {}
  ) {
    const response =
      await fetch(
        url,
        options
      );

    const result =
      await response.json();

    if (!response.ok) {
      throw new Error(
        result.error ||
          "Simulation request failed."
      );
    }

    return result;
  }

  // ------------------------------------------------------------
  // Build menu
  // ------------------------------------------------------------

  function createBuildOptions(
    definitions
  ) {
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

        image.alt = "";

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
                button.dataset
                  .building;

              rotated = false;

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

              rotateButton.disabled =
                false;

              cancelButton.disabled =
                false;

              const building =
                footprint();

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

  // ------------------------------------------------------------
  // Load simulation
  // ------------------------------------------------------------

  async function loadSimulation() {
    try {
      simulationState =
        await requestJson(
          "/api/simulation"
        );

      createBuildOptions(
        simulationState
          .facility_definitions ??
          []
      );

      (
        simulationState.instances ??
        []
      ).forEach(
        renderInstance
      );

      renderState();

      tickButton.disabled =
        false;
    } catch (error) {
      status.textContent =
        error.message;

      tickButton.disabled =
        true;
    }
  }

  // ------------------------------------------------------------
  // Map hover / preview
  // ------------------------------------------------------------

  landGrid.addEventListener(
    "pointerover",
    (event) => {
      const cell =
        event.target.closest(
          ".grid-cell"
        );

      if (cell) {
        showPreview(
          Number(
            cell.dataset.column
          ),
          Number(
            cell.dataset.row
          )
        );
      }
    }
  );

  // ------------------------------------------------------------
  // Grass tile tooltip
  // ------------------------------------------------------------

  landGrid.addEventListener(
    "pointermove",
    (event) => {
      /*
       * Facility sprites have their own
       * tooltip event handlers.
       */
      if (
        event.target.closest(
          ".placed-building"
        )
      ) {
        return;
      }

      const cell =
        event.target.closest(
          ".grid-cell"
        );

      if (!cell) {
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

      /*
       * Do not describe the land as
       * unimproved grass if a placed
       * facility occupies this tile.
       */
      const occupyingInstance =
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
        );

      if (
        occupyingInstance
      ) {
        hideTooltip();

        return;
      }

      showGrassTooltip(
        column,
        row,
        event
      );
    }
  );

  landGrid.addEventListener(
    "pointerleave",
    hideTooltip
  );

  // ------------------------------------------------------------
  // Facility placement
  // ------------------------------------------------------------

  landGrid.addEventListener(
    "click",
    async (event) => {
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
              method: "POST",

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
                  rotated,
                }),
            }
          );

        simulationState
          .instances
          .push(instance);

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

  // ------------------------------------------------------------
  // Advance simulation one hour
  // ------------------------------------------------------------

  tickButton.addEventListener(
    "click",
    async () => {
      tickButton.disabled =
        true;

      try {
        const result =
          await requestJson(
            "/api/tick",
            {
              method: "POST",
            }
          );

        simulationState =
          result.state;

        renderState();

        const operating =
          result.operations.filter(
            (operation) =>
              operation.status ===
              "operating"
          ).length;

        const processedLabel =
          result.state
            ?.current_time
            ? new Date(
                result.state
                  .current_time
              ).toLocaleString()
            : (
                `day ${
                  result.processed_at
                    ?.day ?? "?"
                }, hour ${
                  result.processed_at
                    ?.hour ?? "?"
                }`
              );

        status.textContent =
          `Hour processed: ` +
          `${processedLabel}. ` +
          `${operating} of ` +
          `${result.operations.length} ` +
          "facilities operating.";
      } catch (error) {
        status.textContent =
          error.message;
      } finally {
        tickButton.disabled =
          false;
      }
    }
  );

  // ------------------------------------------------------------
  // Rotation
  // ------------------------------------------------------------

  rotateButton.addEventListener(
    "click",
    () => {
      if (!selectedId) {
        return;
      }

      rotated =
        !rotated;

      const building =
        footprint();

      status.textContent =
        `${building.name} rotated ` +
        `(${building.width * 5} × ` +
        `${building.height * 5} ft).`;

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

  // ------------------------------------------------------------
  // Cancel placement
  // ------------------------------------------------------------

  function cancelPlacement() {
    selectedId = null;
    rotated = false;

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

    rotateButton.disabled =
      true;

    cancelButton.disabled =
      true;

    status.textContent =
      "Select a structure, then click an open tile to place it.";
  }

  cancelButton.addEventListener(
    "click",
    cancelPlacement
  );

  // ------------------------------------------------------------
  // Keyboard controls
  // ------------------------------------------------------------

  document.addEventListener(
    "keydown",
    (event) => {
      if (
        event.key ===
        "Escape"
      ) {
        cancelPlacement();
      }

      if (
        event.key.toLowerCase() ===
          "r" &&
        selectedId
      ) {
        rotateButton.click();
      }
    }
  );

  // ------------------------------------------------------------
  // Start application
  // ------------------------------------------------------------

  loadSimulation();
}
