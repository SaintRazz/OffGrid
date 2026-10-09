"use strict";

const landGrid = document.getElementById("land-grid");

if (landGrid) {
  const gridSize = 42;
  const placements = [];
  const definitionsById = new Map();

  // ============================================================
  // Main interface elements
  // ============================================================

  const buildList = document.getElementById("build-list");
  const cancelButton = document.getElementById("cancel-building");
  const tickButton = document.getElementById("advance-tick");
  const status = document.getElementById("placement-status");

  const currentGameName =
    document.getElementById("current-game-name");

  const infoTabs =
    document.querySelectorAll(".info-tab");

  const infoPanels =
    document.querySelectorAll(".info-panel");

  // ============================================================
  // Startup interface
  // ============================================================

  const startupOverlay =
    document.getElementById("startup-overlay");

  const startupMainActions =
    document.getElementById("startup-main-actions");

  const newGameButton =
    document.getElementById("new-game-button");

  const loadGameButton =
    document.getElementById("load-game-button");

  const loadGamePanel =
    document.getElementById("load-game-panel");

  const saveGameList =
    document.getElementById("save-game-list");

  const backToStartButton =
    document.getElementById("back-to-start-button");

  const startupStatus =
    document.getElementById("startup-status");

  // ============================================================
  // Runtime state
  // ============================================================

  let selectedId = null;
  let hoverPosition = null;
  let preview = null;
  let simulationState = null;

  // ============================================================
  // Tooltip
  // ============================================================

  const tooltip = document.createElement("div");

  tooltip.className = "map-tooltip";
  tooltip.hidden = true;

  document.body.appendChild(tooltip);

  function hideTooltip() {
    tooltip.hidden = true;
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

  // ============================================================
  // Build map grid
  // ============================================================

  for (
    let row = 0;
    row < gridSize;
    row += 1
  ) {
    for (
      let column = 0;
      column < gridSize;
      column += 1
    ) {
      const cell =
        document.createElement("div");

      cell.className =
        "grid-cell";

      cell.setAttribute(
        "role",
        "gridcell"
      );

      cell.setAttribute(
        "aria-label",
        `Grass tile, row ${row + 1}, column ${column + 1}`
      );

      cell.dataset.row =
        row;

      cell.dataset.column =
        column;

      cell.style.gridRow =
        String(row + 1);

      cell.style.gridColumn =
        String(column + 1);

      landGrid.appendChild(cell);
    }
  }

  // ============================================================
  // General formatting helpers
  // ============================================================

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
        (letter) =>
          letter.toUpperCase()
      );
  }

  function formatTooltipValue(
    value
  ) {
    if (
      value === null ||
      value === undefined
    ) {
      return "—";
    }

    if (
      typeof value ===
      "number"
    ) {
      return formatAmount(value);
    }

    if (
      typeof value ===
      "boolean"
    ) {
      return value
        ? "Yes"
        : "No";
    }

    return String(value);
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

    Object.entries(object)
      .forEach(
        ([key, value]) => {
          const label =
            prefix
              ? `${prefix} · ${prettyName(key)}`
              : prettyName(key);

          if (
            value !== null &&
            typeof value ===
              "object" &&
            !Array.isArray(value)
          ) {
            flattenObject(
              value,
              label,
              result
            );

            return;
          }

          if (
            Array.isArray(value)
          ) {
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
            formatTooltipValue(
              value
            ),
          ]);
        }
      );

    return result;
  }

  function isRateField(key) {
    const name =
      key.toLowerCase();

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

  function extractRates(
    definition
  ) {
    const rates = [];

    function walk(
      object,
      prefix = ""
    ) {
      if (
        !object ||
        typeof object !==
          "object"
      ) {
        return;
      }

      Object.entries(object)
        .forEach(
          ([key, value]) => {
            const label =
              prefix
                ? `${prefix} · ${prettyName(key)}`
                : prettyName(key);

            if (
              value !== null &&
              typeof value ===
                "object" &&
              !Array.isArray(
                value
              )
            ) {
              walk(
                value,
                label
              );

              return;
            }

            if (
              isRateField(key)
            ) {
              rates.push([
                label,
                formatTooltipValue(
                  value
                ),
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

    const body =
      rows
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

  // ============================================================
  // Facility tooltips
  // ============================================================

  function getCurrentInstance(
    instanceId
  ) {
    return (
      simulationState
        ?.instances
        ?.find(
          (instance) =>
            instance.instance_id ===
            instanceId
        ) ??
      null
    );
  }

  function showFacilityTooltip(
    instanceId,
    event
  ) {
    const instance =
      getCurrentInstance(
        instanceId
      );

    if (!instance) {
      hideTooltip();
      return;
    }

    const definition =
      definitionsById.get(
        instance.facility_id
      );

    if (!definition) {
      hideTooltip();
      return;
    }

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
              !lower.includes(
                "rate"
              ) &&
              !lower.includes(
                "yield"
              ) &&
              !lower.includes(
                "processing rate"
              ) &&
              !lower.includes(
                "degradation rate"
              ) &&
              !lower.includes(
                "per day"
              ) &&
              !lower.includes(
                "per year"
              ) &&
              !lower.includes(
                "per hour"
              )
            );
          }
        );

    const rateRows =
      extractRates(definition);

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
              "Last Operation",
            ].includes(label)
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

  // ============================================================
  // Grass tile tooltips
  // ============================================================

  function showGrassTooltip(
    column,
    row,
    event
  ) {
    if (!simulationState) {
      return;
    }

    const defaultTileId =
      simulationState
        .map
        ?.default_tile ??
      "grass-tile";

    const definition =
      definitionsById.get(
        defaultTileId
      );

    if (!definition) {
      return;
    }

    const tileState =
      simulationState
        .tile_states
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
              !lower.includes(
                "rate"
              ) &&
              !lower.includes(
                "yield"
              ) &&
              !lower.includes(
                "processing rate"
              ) &&
              !lower.includes(
                "degradation rate"
              ) &&
              !lower.includes(
                "per day"
              ) &&
              !lower.includes(
                "per year"
              ) &&
              !lower.includes(
                "per hour"
              )
            );
          }
        );

    const rateRows =
      extractRates(
        definition
      );

    const stateRows =
      tileState
        ? flattenObject(
            tileState
          ).filter(
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

  // ============================================================
  // Placement helpers
  // ============================================================

  function footprint() {
    return (
      definitionsById.get(
        selectedId
      ) ??
      null
    );
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

  // ============================================================
  // Clock
  // ============================================================

  function setDateAndClock(
    value
  ) {
    const dateElement =
      document.getElementById(
        "simulation-date"
      );

    const clockElement =
      document.getElementById(
        "simulation-clock"
      );

    if (!value) {
      dateElement.textContent =
        "Not started";

      clockElement.textContent =
        "--:--";

      return;
    }

    const date =
      new Date(value);

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
  // Household profile displays
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
      addListItem(list, "Household profile", "Unavailable");
      return;
    }

    addListItem(
      list,
      "Profile",
      profile.name ?? profile.profile_id ?? "Default household"
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
      profile.all_electric ? "All-electric" : "Mixed"
    );

    addListItem(
      list,
      "Seasonal model",
      profile.seasonal_modeling ? "Enabled" : "Annual-average daily values"
    );
  }

  function renderConsumption() {
    const consumptionList =
      document.getElementById("consumption-list");

    const electricityList =
      document.getElementById("electricity-breakdown-list");

    if (!consumptionList || !electricityList) {
      return;
    }

    consumptionList.replaceChildren();
    electricityList.replaceChildren();

    const baseline = dailyHouseholdBaseline();
    const flows = baseline.dailyFlows;
    const electricity = baseline.electricity;

    addListItem(
      consumptionList,
      "Groceries",
      `$${formatAmount(flows.groceries_usd ?? 0)} / day`
    );

    addListItem(
      consumptionList,
      "Tap water",
      `${formatAmount(flows.tap_water_gal ?? 0)} gal / day`
    );

    addListItem(
      consumptionList,
      "Electricity",
      `${formatAmount(electricity.total ?? 0)} kWh / day`
    );

    const endUses = [
      ["HVAC cooling", "hvac_cooling"],
      ["HVAC heating", "hvac_heating"],
      ["Water heating", "water_heating"],
      ["Refrigeration / freezer", "refrigeration_freezer"],
      ["Cooking", "cooking"],
      ["Lighting", "lighting"],
      ["Laundry", "laundry"],
      [
        "Electronics / personal plug loads",
        "electronics_personal_plug_loads",
      ],
      [
        "Other household electrical loads",
        "other_household_electrical_loads",
      ],
    ];

    endUses.forEach(([label, key]) => {
      if (electricity[key] == null) {
        return;
      }

      addListItem(
        electricityList,
        label,
        `${formatAmount(electricity[key])} kWh / day`
      );
    });
  }

  function renderWasteWater() {
    const list =
      document.getElementById("waste-water-list");

    if (!list) {
      return;
    }

    list.replaceChildren();

    const { dailyFlows: flows } =
      dailyHouseholdBaseline();

    const rows = [
      ["Greywater", "greywater_gal", "gal / day"],
      ["Blackwater", "blackwater_gal", "gal / day"],
      ["Other water use", "other_water_use_gal", "gal / day"],
      ["Kitchen waste", "kitchen_waste_lb", "lb / day"],
      [
        "Recyclable paper / cardboard",
        "recyclable_paper_lb",
        "lb / day",
      ],
      ["Recyclable plastic", "recyclable_plastic_lb", "lb / day"],
      ["Recyclable glass", "recyclable_glass_lb", "lb / day"],
      ["Recyclable metal", "recyclable_metal_lb", "lb / day"],
      [
        "Residual non-food waste",
        "residual_nonfood_waste_lb",
        "lb / day",
      ],
    ];

    rows.forEach(([label, key, unit]) => {
      addListItem(
        list,
        label,
        `${formatAmount(flows[key] ?? 0)} ${unit}`
      );
    });

    const greywater =
      Number(flows.greywater_gal ?? 0);

    const blackwater =
      Number(flows.blackwater_gal ?? 0);

    addListItem(
      list,
      "Total wastewater",
      `${formatAmount(greywater + blackwater)} gal / day`
    );
  }

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
  // Facility operations panel
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

            let laborText = "";

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
  // Render a placed facility
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
          instance.instance_id,
          event
        );
      }
    );

    sprite.addEventListener(
      "pointermove",
      (event) => {
        /*
         * Re-read the current instance
         * each time so tooltip data does
         * not become stale after a tick.
         */
        showFacilityTooltip(
          instance.instance_id,
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

  // ============================================================
  // Main state rendering
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
                button
                  .dataset
                  .building;

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
  // Clear/reset rendered game
  // ============================================================

  function clearRenderedGame() {
    selectedId = null;
    hoverPosition = null;

    removePreview();
    hideTooltip();

    placements.length = 0;

    landGrid
      .querySelectorAll(
        ".placed-building"
      )
      .forEach(
        (sprite) =>
          sprite.remove()
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

    simulationState = state;

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
      "Select a structure, then click an open tile to place it.";
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
    setStartupBusy(true);

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
      setStartupBusy(false);
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
        setStartupBusy(true);

        startupStatus.textContent =
          `Loading ${save.filename}...`;

        try {
          const result =
            await requestJson(
              "/api/load-game",
              {
                method: "POST",

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
    setStartupBusy(true);

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
            saveGameList
              .appendChild(
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
      setStartupBusy(false);
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
  // Left-side tab controls
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
          String(active)
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
  // Map hover / placement preview
  // ============================================================

  landGrid.addEventListener(
    "pointerover",
    (event) => {
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
  // Grass tile hover
  // ============================================================

  landGrid.addEventListener(
    "pointermove",
    (event) => {
      if (!simulationState) {
        return;
      }

      /*
       * Placed facilities have their own
       * tooltip handlers.
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

  // ============================================================
  // Place facility
  // ============================================================

  landGrid.addEventListener(
    "click",
    async (event) => {
      if (!simulationState) {
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
  // Advance one simulation hour
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
              method: "POST",
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
                result.state
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

  // ============================================================
  // Cancel placement
  // ============================================================

  function cancelPlacement() {
    selectedId = null;

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
        ? "Select a structure, then click an open tile to place it."
        : "Choose New Game or Load Game to begin.";
  }

  cancelButton.addEventListener(
    "click",
    cancelPlacement
  );

  // ============================================================
  // Keyboard controls
  // ============================================================

  document.addEventListener(
    "keydown",
    (event) => {
      if (
        event.key ===
        "Escape"
      ) {
        cancelPlacement();
      }
    }
  );

  // ============================================================
  // Initial application state
  // ============================================================

  clearRenderedGame();

  currentGameName.textContent =
    "No game loaded";

  startupOverlay.hidden =
    false;

  showStartupMain();
}