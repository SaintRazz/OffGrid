# Garden implementation

Files changed: `app.py`, `simulation.py`, `garden.py`, `facilities.json`, `resources.json`, `crop.json`, `static/script.js`, `tests/test_garden.py`, `tests/test_garden_ui.js`, and this document. Existing save files were not edited.

## Definition and runtime responsibilities

`crop.json` contains a shared `performance` configuration and a `crops` mapping. Each crop defines its planting resource/quantity, growth habit, maturity and season length, expected harvest, seasonal fertility draw, phase array (end day, daily water, routine labor), and one-time labor-event array (day, name, hours). Tomato additionally defines a harvest-release interval. The fictional tomato is explicitly described as a standardized representative, not a real cultivar with exact measured characteristics.

`facilities.json` defines the one-tile physical soil footprint, preparation/remediation, amendment contributions, irrigation allowance and shared environment. `resources.json` defines native resource units and carried masses. `garden.py` owns crop calculations; `simulation.py` integrates its mixin with existing tasks, transfers, reservations and hourly processing. JavaScript displays backend status and submits actions; it does not calculate biological performance or irrigation demand.

New transferable resources: `seed_potato`, `potato`, `tomato`, `commercial_garden_amendment` are continuous lb quantities with 1 lb/native-unit mass. `tomato_transplant` is discrete, with 0.25 lb carried mass per plant. Seeds, transplants and commercial amendment are orderable; orders remain unlimited and arrive at House Storage. Mature compost uses the existing resource and bucket path.

## Exact physical and climate constants

- Plot: 1 tile, 5 x 5 ft, 25 sq ft. Conversion reserves the site immediately; a cancelled preparation restores the grass area and amendment.
- Preparation: 1.5 hours (90 minutes), target fertility 95/100. Initial amendment: 10 lb mature compost or 2 lb commercial amendment. If both are carried, commercial amendment is selected first.
- Remediation: 0.25 hours (15 minutes), including when no amendment is needed. Amendment = max(0, 95 - fertility) / contribution; compost contributes 9.5 fertility/lb and commercial amendment 47.5 fertility/lb.
- Poor fertility warning below 50. Fertility persists after harvest; remediation restores toward 95.
- Rainfall: 0.160 inches/day; conversion 0.6233766 gal per inch per sq ft. This yields 9.9740256 gal/day per 100 sq ft barrel catchment and 2.4935064 gal/day per plot.
- Only supplemental deficits consume manually delivered non-potable water. The 5 gal bounded irrigation allowance uses existing carried-water delivery/reservation rules. Environmental surplus is ignored and never fills that allowance or inventory. This is a simple supplied-water credit, not a detailed soil-moisture model. Water reserved for delivery after a crop has finished is returned to carried inventory.

## Crop constants

Planting/harvest yields use the agreed commercial-acre / 1764 * 0.75 calibration; water and labor do not receive that factor.

### Russet Burbank Potato

- ID: `russet_burbank`; planting: 0.8 seed_potato; planting labor: 0.5 h.
- First maturity: 125 days; season end: 125 days; full seasonal yield: 19.3 lb; seasonal fertility draw: 40 points.
- Harvest labor: 0.75 h (45-minute terminal digging task, output remains local).

| Phase through crop day | Water gal/day | Routine labor h/day |
| --- | ---: | ---: |
| Establishment / emergence (through 20) | 2.5 | 0.005 |
| Vegetative growth (through 45) | 3 | 0.015 |
| Tuber initiation / bulking (through 95) | 4 | 0.01 |
| Maturation (through 110) | 2 | 0.004 |
| Senescence / skin set (through 125) | 0.5 | 0.002 |

| Major event | Due day | Labor h |
| --- | ---: | ---: |
| Early weeding | 12 | 0.1 |
| First hilling | 28 | 0.25 |
| Second hilling / bed maintenance | 48 | 0.2 |

### Generic Beefsteak Tomato

- ID: `beefsteak_tomato`; planting: 2 tomato_transplant; planting labor: 0.4 h.
- First maturity: 80 days; season end: 143 days; full seasonal yield: 17 lb; seasonal fertility draw: 45 points.
- Harvest labor: 0.08 h per picking (rounded up to 5 task minutes).
- Production window: days 80-143 (63 days / nine weeks). First batch appears on day 82; further batches release every two days, plus the final one-day remainder. Full-care batch yield is proportional to released production days. Uncollected output persists at the plot after season end.

| Phase through crop day | Water gal/day | Routine labor h/day |
| --- | ---: | ---: |
| Transplant establishment (through 14) | 0.75 | 0.008 |
| Vegetative growth (through 35) | 1 | 0.02 |
| Flowering / fruit set (through 60) | 1.5 | 0.03 |
| Fruit development / ripening (through 80) | 1.75 | 0.025 |
| Harvest production (through 143) | 1.5 | 0.025 |

| Major event | Due day | Labor h |
| --- | ---: | ---: |
| Early weeding | 10 | 0.1 |
| Staking / trellising | 21 | 0.3 |
| Support inspection / tying | 40 | 0.15 |

## Performance and gameplay assumptions

Each growing hour samples water, labor and fertility satisfaction, each capped at 1. Water satisfaction uses actual rain plus consumed delivered irrigation against phase demand. Fertility satisfaction is min(1, fertility / 50). Fertility depletes linearly across the configured season. Labor satisfaction uses routine backlog plus due, uncompleted major-event labor: max(0.1, 1 - max(0, backlog - 0.05 h) / 0.5 h). The 0.05-hour grace avoids penalizing promptly attended crops merely for the current hour of accrual. Routine service and major-event tasks are separate controls.

Seasonal performance is the product of the three cumulative mean satisfactions. Potato yield uses the frozen maturity performance when digging completes. Tomato batches use cumulative performance at each release and are not retroactively recalculated. Growth age advances even under deficient care; very poor fertility can reduce production to very little rather than blocking planting. Excess care cannot increase yield above the configured full expectation.

All exact labor durations, fertility draws/contributions, transplant mass, grace periods, backlog penalties and irrigation allowance are deliberate gameplay abstractions. Phase timing and supplied reference yields/water rates follow the requested calibration; no invented manual labor estimate is represented as a universal agricultural measurement. No seasons, frost, pests, individual N/P/K, storm events or detailed soil-moisture pools were added. Harvested produce stays local until collected through the existing 50 lb carrying and reservation checks; produce does not add egg grocery credit.

## Save compatibility and API

Garden fields are additive: `plot_state`, `fertility`, `crop_id`, `crop_age_hours`, bounded irrigation allowance, cumulative satisfaction samples/sums, seasonal production counters, pending/completed major events and last-crop summary. Existing `stored_outputs` carries potato/tomato harvests. Backend-derived `garden_status` supplies inspector values. States are preparing, prepared, planted, harvestable and harvested.

Legacy multi-tile garden footprints become one prepared tile per occupied tile, retaining the original anchor ID and converted area. Only the anchor keeps any existing outputs/crop state; new sibling tiles do not duplicate stock. Migration is idempotent and only runs during save normalization. Mid-task save/load retains reserved inputs and work remaining. All prior aliases, task/coordinate compatibility, rotation parameters and API routes remain. No existing save schema is discarded.

`POST /api/facilities` with garden-plot queues preparation after standard placement validation. `POST /api/gardens/<instance_id>/action` accepts plant (crop_id), remediate (optional amendment_resource_id), event (event_id), or terminal harvest. Existing service, fill, collect, order and cancellation endpoints are reused. Planting/preparation reserve carried inputs immediately, preserve their carrying mass until work completes, and refund on cancellation. Remediation clears crop progress while preserving fertility, historical summary and local outputs.

## Validation

- 73 Python tests passed: 43 garden regressions plus 30 existing transfer/simulation regressions. Tests cover both complete seasons, gradual deficits, phase timing, amendment/remediation, land conversion, source/carry limits, climate, water delivery/refund, saved tasks, migration idempotence, local harvests and existing solar/compost/BSFL/chicken/forage/egg/grocery flows.
- Dependency-free JavaScript checks render six plot states and verify planting/remediation actions, irrigation and local harvest options. Full JavaScript syntax also passes using VS Code bundled Node.
- Python syntax, all root JSON files and git diff whitespace checks pass.
- Existing tests/test_app.py still fails collection because it imports calculate_system_preview, absent before this push. Its old no-argument Simulation fixtures also target a superseded API. It was preserved, not silently skipped or rewritten.

Run: `python -m pytest tests/test_garden.py tests/test_transfer_update.py -q -p no:cacheprovider` and `node tests/test_garden_ui.js` (or VS Code bundled Node when standalone Node is unavailable).
