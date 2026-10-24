const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('static/script.js', 'utf8');
const element = () => ({hidden: false, disabled: false, textContent: '', focus() {}, addEventListener() {}});
const calls = [];
const context = vm.createContext({
  gameLoaded: true, gameSwitchInFlight: false, saveInFlight: false, advanceInFlight: false,
  startupOverlay: {hidden: true}, startupMainActions: element(), loadGamePanel: element(),
  startupStatus: element(), returnToGameButton: element(), newGameButton: element(), loadGameButton: element(),
  openNewGameButton: element(), openLoadGameButton: element(),
  closeInspector() {}, clearMapSelection() {}, cancelPlacement() {},
  stopRuntime: label => calls.push(['stop', label]), startRuntime: () => calls.push(['start']),
  showSavedGames: () => calls.push(['list']), window: {setTimeout},
  api: async url => { calls.push(['api', url]); return {game_name: 'Next', state: {}, save_id: null}; },
  setGameLoaded: () => { context.startupOverlay.hidden = true; calls.push(['loaded']); },
});
const begin = source.slice(source.indexOf('  async function beginNewGame('), source.indexOf('  async function showSavedGames('));
const load = source.slice(source.indexOf('  async function loadSavedGame('), source.indexOf('  async function waitForAdvance('));
const chooser = source.slice(source.indexOf('  async function waitForAdvance('), source.indexOf('  newGameButton.addEventListener('));
vm.runInContext(begin + load + chooser, context);
(async () => {
  vm.runInContext('openGameChooser()', context);
  assert.equal(context.startupOverlay.hidden, false);
  assert.equal(context.returnToGameButton.hidden, false);
  assert.equal(calls.at(-1)[0], 'stop');
  vm.runInContext('returnToGame()', context);
  assert.equal(context.startupOverlay.hidden, true);
  assert.deepEqual(calls.at(-1), ['start']);
  vm.runInContext('openGameChooser(true)', context);
  assert.deepEqual(calls.at(-1), ['list']);
  context.advanceInFlight = true;
  const pending = vm.runInContext('loadSavedGame("saves/test.json")', context);
  assert.equal(context.returnToGameButton.disabled, true);
  assert(!calls.some(c => c[0] === 'api'));
  vm.runInContext('returnToGame()', context);
  assert.equal(context.startupOverlay.hidden, false);
  context.advanceInFlight = false;
  await pending;
  assert(calls.some(c => c[1] === '/api/load-game'));
  assert.equal(context.gameSwitchInFlight, false);
  assert.equal(context.returnToGameButton.disabled, false);
  vm.runInContext('openGameChooser()', context);
  await vm.runInContext('beginNewGame()', context);
  assert(calls.some(c => c[1] === '/api/new-game'));
  console.log('Game chooser checks passed: in-game controls, return, load, new game, and pending-tick ordering.');
})().catch(error => {console.error(error); process.exitCode = 1;});
