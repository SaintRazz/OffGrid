const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('static/script.js', 'utf8');
const calls = [];
let nextTimer = 0;
const context = vm.createContext({
  gameSpeedSelect: {value: '1'},
  runtimeStatus: {classList: {toggle() {}}},
  runtimeLabel: {},
  window: {setInterval: () => ++nextTimer},
  clearInterval: id => calls.push(['clear', id]),
  api: async (url, options) => {
    calls.push(JSON.parse(options.body).minutes);
    if (context.failAdvance) throw new Error('Temporary failure');
    return {state: {}};
  },
  renderState() {}, nextDayButton: {}, statusLine: {},
  inspectorOverlay: {hidden: true},
});
vm.runInContext(`
  let runtimeTimer = null;
  let gameLoaded = true;
  let advanceInFlight = false;
  let selectedMapObject = {};
  let inspectorMode = 'summary';
  const GAME_PULSE_MS = 1000;
` + source.slice(source.indexOf('  function currentSpeedMinutes('),
                 source.indexOf('  function setDateAndClock(')) +
    source.slice(source.indexOf('  function closeInspector('),
                 source.indexOf('  function compostStatus(')), context);
async function run(code) { return vm.runInContext(code, context); }
(async () => {
  await run('startRuntime(); runGamePulse()');
  assert.equal(calls.at(-1), 1);
  context.gameSpeedSelect.value = '0';
  await run('startRuntime(); runGamePulse()');
  assert.deepEqual(calls.at(-1), ['clear', 1]);
  assert.equal(context.runtimeLabel.textContent, 'Paused');
  context.gameSpeedSelect.value = '60';
  await run('startRuntime(); runGamePulse()');
  assert.equal(calls.at(-1), 60);
  context.inspectorOverlay.hidden = false;
  await run('runGamePulse();');
  assert.equal(calls.at(-1), 60);
  await run('closeInspector(); runGamePulse()');
  assert.equal(nextTimer, 2);
  // Management stops ticking without overwriting the selected speed.
  context.inspectorOverlay.hidden = false;
  await run('inspectorMode = "contents"; startRuntime()');
  assert.equal(await run('runtimeTimer'), null);
  assert.equal(context.gameSpeedSelect.value, '60');
  const pausedCalls = calls.length;
  await run('runGamePulse(); advanceSimulation(1440)');
  assert.equal(calls.length, pausedCalls);
  await run('closeInspector(); closeInspector(); runGamePulse()');
  assert.equal(nextTimer, 3, 'Closing repeatedly creates only one timer');
  assert.equal(calls.at(-1), 60);
  context.gameSpeedSelect.value = '0';
  context.inspectorOverlay.hidden = false;
  await run('inspectorMode = "storage"; startRuntime(); closeInspector()');
  assert.equal(await run('runtimeTimer'), null, 'Manual Pause survives closing');
  context.gameSpeedSelect.value = '30';
  context.inspectorOverlay.hidden = false;
  await run('inspectorMode = "order"; startRuntime()');
  context.gameSpeedSelect.value = '60';
  await run('startRuntime()');
  assert.equal(await run('runtimeTimer'), null, 'Speed changes do not unpause management');
  await run('closeInspector()');
  context.failAdvance = true;
  await run('runGamePulse()');
  assert.equal(await run('runtimeTimer'), 4);
  context.failAdvance = false;
  await run('runGamePulse()');
  assert.equal(calls.at(-1), 60);
  context.gameSpeedSelect.value = '0';
  await run('startRuntime(); advanceSimulation(1440)');
  assert.equal(calls.at(-1), 1440);
  assert.equal(await run('runtimeTimer'), null);
  // A response already in flight must not reset newly opened management forms.
  let finishAdvance;
  context.api = () => new Promise(resolve => { finishAdvance = resolve; });
  let refreshInspector;
  context.renderState = (_state, _activity, refresh) => { refreshInspector = refresh; };
  context.gameSpeedSelect.value = '1';
  const pending = run('advanceSimulation(1)');
  context.inspectorOverlay.hidden = false;
  await run('inspectorMode = "contents"; startRuntime()');
  finishAdvance({state: {}});
  await pending;
  assert.equal(refreshInspector, false);
  new Function(source);
  console.log('Runtime checks passed: explicit pause/resume, inspector interactions, error recovery, and manual day advancement.');
})().catch(error => { console.error(error); process.exitCode = 1; });
