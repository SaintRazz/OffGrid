const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('static/script.js', 'utf8');
const calls = [];
const element = () => ({disabled: false, textContent: '', value: '', addEventListener() {}, focus() {}, select() {}});
const context = vm.createContext({
  gameLoaded: true, currentSaveId: null, saveInFlight: false,
  saveNameInput: element(), saveDialogStatus: element(), saveStatus: element(),
  currentGameName: {textContent: 'New Game'},
  saveGameButton: element(), saveAsButton: element(), confirmSaveButton: element(),
  saveGameForm: element(), document: {getElementById: element},
  saveDialog: {open: false, showModal() {this.open = true;}, close() {this.open = false;}},
  startupOverlay: {hidden: true}, renderMapTransform() {}, setRuntimeRunning() {},
  api: async (url, options) => {
    calls.push({url, payload: JSON.parse(options.body)});
    if (context.failSave) throw new Error('Disk unavailable');
    return {save_id: 'saves/test.json', game_name: JSON.parse(options.body).name || 'My Farm'};
  },
});
vm.runInContext(source.slice(source.indexOf('  function openSaveDialog('), source.indexOf('  initialize();')), context);
(async () => {
  await vm.runInContext('initialize()', context);
  assert.equal(context.startupOverlay.hidden, false);
  assert.equal(calls.length, 0, 'Launch never silently resumes a server session');
  await vm.runInContext('saveCurrentGame()', context);
  assert(context.saveDialog.open);
  assert.equal(calls.length, 0, 'First save asks for a name');
  await vm.runInContext('saveCurrentGame("My Farm")', context);
  assert.equal(calls.at(-1).payload.name, 'My Farm');
  assert.equal(context.currentSaveId, 'saves/test.json');
  assert.equal(context.currentGameName.textContent, 'My Farm');
  assert.equal(context.saveDialog.open, false);
  await vm.runInContext('saveCurrentGame()', context);
  assert.deepEqual(calls.at(-1).payload, {});
  vm.runInContext('openSaveDialog()', context);
  assert.equal(context.saveNameInput.value, 'My Farm copy');
  context.failSave = true;
  await vm.runInContext('saveCurrentGame("Copy")', context);
  assert.equal(context.saveDialog.open, true);
  assert(context.saveDialogStatus.textContent.includes('Disk unavailable'));
  assert.equal(context.saveGameButton.disabled, false);
  assert.equal(context.saveInFlight, false);
  console.log('Save UI checks passed: launch choice, name prompt, Save, Save As, and error recovery.');
})().catch(error => {console.error(error); process.exitCode = 1;});
