// Dependency-free checks for the garden inspector and transfer controls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {execFileSync} = require('node:child_process');
const fixture = JSON.parse(execFileSync(process.env.PYTHON || 'python', ['-c', `
import json
from simulation import Simulation
s=Simulation('facilities.json','resources.json','HouseholdProfile.json','NewGame.json')
plots=[]
for state,crop,age in [('prepared',None,0),('planted','russet_burbank',57),('harvestable','russet_burbank',125),('harvestable','beefsteak_tomato',94),('harvested',None,143),('preparing',None,0)]:
 p={'instance_id':state+str(age),'facility_id':'garden-plot','column':2,'row':2,'plot_state':state,'crop_id':crop,'crop_age_hours':age*24}
 s._normalize_instance(p)
 p['garden_status']=s.garden_status(p)
 plots.append(p)
print(json.dumps({'plots':plots,'state':s.state()}))
`], {encoding:'utf8'}));
const source = fs.readFileSync('static/script.js','utf8');
function extract(name, next) {
  const start = source.indexOf(`  function ${name}(`);
  const end = source.indexOf(`  function ${next}(`, start);
  assert(start >= 0 && end > start, `Locate ${name}`);
  return source.slice(start,end);
}
class Element {
  constructor(tag) { this.tag=tag; this.children=[]; this.textContent=''; this.listeners={}; }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.children.push(child); }
  replaceChildren(...children) { this.children=children; }
  addEventListener(event, callback) { this.listeners[event]=callback; }
}
const calls=[];
const context={
  document:{createElement: tag=>new Element(tag)},
  inspectorContent:new Element('section'), inspectorTitle:new Element('h2'),
  simulationState:fixture.state,
  formatAmount: (v, digits=2)=>Number(v).toFixed(digits),
  resourceLabel: rid=>fixture.state.resource_definitions[rid]?.name ?? rid,
  resourceUnit: rid=>fixture.state.resource_definitions[rid]?.unit ?? 'lb',
  submitGardenAction:(id,payload)=>calls.push({id,payload}),
};
vm.createContext(context);
vm.runInContext(extract('appendGardenPanel','renderSelectionSummary') +
                extract('renderSelectionSummary','openSelection') +
                extract('managedContentOptions','collectionOptions') +
                extract('collectionOptions','renderContentsManager'), context);
function textTree(node) { return [node.textContent,...node.children.map(textTree)].join(' '); }
for (const plot of fixture.plots) {
  context.selection={kind:'map',instance:plot,definition:fixture.state.facility_definitions.find(d=>d.id==='garden-plot')};
  vm.runInContext('renderSelectionSummary(selection)',context);
  const text=textTree(context.inspectorContent);
  assert(text.includes('Fertility') && text.includes('Environmental rainfall'));
  assert(text.includes('Crop age') && text.includes('Supplemental water demand'));
  assert(text.includes('Projected seasonal yield'));
  assert.equal(context.inspectorTitle.textContent,plot.garden_status.display_name);
  const buttons=context.inspectorContent.children.filter(e=>e.tag==='button');
  if (plot.plot_state==='prepared') {
    assert.equal(buttons.filter(e=>e.textContent.startsWith('Plant ')).length,2);
    buttons[0].listeners.click();
    assert.equal(calls.at(-1).payload.action,'plant');
  }
  if (plot.plot_state==='harvested') {
    assert(text.includes('Needs remediation'));
    assert.equal(buttons.filter(e=>e.textContent.startsWith('Remediate:')).length,2);
  }
  const inputs=vm.runInContext('managedContentOptions(selection)',context);
  assert.equal(inputs.length,plot.crop_id ? 1 : 0);
  if (plot.crop_id) assert.equal(inputs[0].resourceId,'non_potable_water');
  assert.equal(vm.runInContext('collectionOptions(selection)',context).length,2);
}
new Function(source);
console.log('Garden UI checks passed: six plot states, action controls, irrigation and local harvest options.');
