import {VisualActions} from './visual-actions.mjs';
const $=id=>document.getElementById(id);
const names={cool:'Underwater / cool',warm:'Warm glow',money:'Money glow',card:'Text card'};

// Owns only display reactions; semantic scheduling and source epochs stay in app.js.
export class ActionView {
  constructor() {
    this.rules=[];this.engine=new VisualActions();this.generation=0;
    $('actions-enabled').addEventListener('change',()=>this.reset());
    document.querySelectorAll('[data-preset]').forEach(button=>button.addEventListener('click',()=>{
      if(!this.rules.some(r=>r.id==='preset-bottle')) {
        this.rules.push({id:'preset-bottle',label:'bottle',kind:'cool',text:'',sound:false});
        this.engine.rules=this.rules;this.reset();this.renderRules();
      }
    }));
    $('labels').addEventListener('input',()=>this.renderRules());
  }
  reset() {
    this.generation++;this.engine.reset();this.present(this.engine.tick(performance.now()));
  }
  accept(items,captured,now,generation,threshold) {
    if(generation!==this.generation||!$('actions-enabled').checked||document.hidden)return;
    this.present(this.engine.accept(items,captured,now,threshold));
  }
  tick(now) { this.present(this.engine.tick(now)); }
  present(result) {
    for(const id of ['video','photo']) {
      const node=$(id);
      if(result.filter) {if(node.dataset.actionFilter!==result.filter)node.dataset.actionFilter=result.filter;}
      else if(node.hasAttribute('data-action-filter'))node.removeAttribute('data-action-filter');
    }
    const message=!$('actions-enabled').checked?'Actions off · preview unchanged':result.active.length?`${result.active.length} active · ${result.active.map(r=>r.label).join(', ')}`:'Armed · waiting for two fresh positive results';
    if($('actions-state').textContent!==message)$('actions-state').textContent=message;
    for(const rule of result.entered)this.log(`${rule.label} → ${names[rule.kind]} activated`);
    for(const rule of result.exited)this.log(`${rule.label} → cleared (absence or expired evidence)`);
  }
  log(message) {
    const li=document.createElement('li');li.textContent=message;
    $('action-events').prepend(li);
    while($('action-events').children.length>40)$('action-events').lastChild.remove();
  }
  renderRules() {
    const labels=$('labels').value.split(',').map(s=>s.trim());
    const nodes=this.rules.map(rule=>{
      const li=document.createElement('li');li.dataset.ruleId=rule.id;
      li.textContent=`${rule.label} → ${names[rule.kind]} · ${labels.includes(rule.label)?'Target configured':'Target not configured — add exact label above'}`;
      return li;
    });
    $('action-rules').replaceChildren(...nodes);
  }
}
