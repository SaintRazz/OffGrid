const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('static/script.js', 'utf8').replaceAll('\r\n', '\n');
function extract(start, end) {
  return source.slice(source.indexOf(`  function ${start}(`), source.indexOf(`  function ${end}(`));
}
const nodes = [];
const calls = [];
const context = vm.createContext({
  GRID_SIZE: 42, clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
  landGrid: {
    getBoundingClientRect: () => ({left: 100, top: 200, width: 840, height: 840}),
    querySelectorAll: () => [], appendChild: node => nodes.push(node),
    addEventListener: (_event, listener) => { context.click = listener; },
  },
  document: {createElement: () => ({style: {}, dataset: {}, appendChild(child) { this.child = child; }})},
  definitionsById: new Map([['test', {name: 'Facility', image: 'test.png'}]]),
  simulationState: {instances: [
    {instance_id: 'one', facility_id: 'test', column: 1, row: 1, width: 1, height: 1, accrued_labor_requirement: 0.4},
    {instance_id: 'multi', facility_id: 'test', column: 3, row: 3, width: 2, height: 3},
  ]},
  renderHouse() {}, avatar: null, avatarTooltip: null,
  openSelection: (c, r) => calls.push(['select', c, r]),
  placeSelectedFacility: async (c, r) => calls.push(['build', c, r]),
  cancelPlacement() { calls.push(['cancel']); },
});
vm.runInContext('let placements = []; let gameLoaded = true; let suppressNextMapClick = false; let selectedBuildId = null;' +
  extract('mapCoordinatesFromClient', 'reservedHouseZones') +
  extract('facilityAt', 'markMapSelection') +
  extract('facilityTooltip', 'dailyBaseline'), context);
vm.runInContext('renderPlacements()', context);
assert.equal(nodes[0].style.gridColumn, '2 / span 1');
assert.equal(nodes[1].style.gridRow, '4 / span 3');
assert.equal(nodes[0].child.className, 'building-sprite');
assert.equal(nodes[0].title, 'Facility\nLabor due: 24 min');
for (const [hours, expected] of [[0,''], [1/3,''], [.75,'45 min'], [1,'1 h'], [1.5,'1 h 30 min']]) {
  context.hours = hours;
  const label = vm.runInContext('facilityTooltip({accrued_labor_requirement: hours}, "Test")', context);
  assert.equal(label, expected ? `Test\nLabor due: ${expected}` : 'Test');
}
vm.runInContext(source.slice(source.indexOf('  landGrid.addEventListener(\n    "click"'), source.indexOf('  gameSpeedSelect?.addEventListener')), context);
async function click(c, r, dx = .01, dy = .01) {
  await context.click({clientX: 100 + (c + dx) * 20, clientY: 200 + (r + dy) * 20, target: {closest: () => null}});
}
(async () => {
  for (const [dx,dy] of [[.01,.01],[.99,.01],[.01,.99],[.99,.99]]) {
    await click(1,1,dx,dy);
    assert.deepEqual(calls.at(-1), ['select',1,1]);
  }
  for (let c=3;c<5;c++) for (let r=3;r<6;r++) {
    await click(c,r);
    assert.deepEqual(calls.at(-1), ['select',c,r]);
  }
  await click(8,8);
  assert.deepEqual(calls.at(-1), ['select',8,8]);
  vm.runInContext('selectedBuildId = "test"',context);
  await click(8,8);
  assert.deepEqual(calls.at(-1), ['build',8,8]);
  vm.runInContext('suppressNextMapClick = true',context);
  const count=calls.length;
  await click(1,1);
  assert.equal(calls.length,count,'A drag ending must suppress selection');
  console.log('Map UI checks passed: footprint edges, multi-tile selection, grass, placement, drag suppression, and labor thresholds.');
})().catch(error => { console.error(error); process.exitCode=1; });
