import {VisualActions, validRule} from './visual-actions.mjs';
import {ActionAudio} from './action-audio.mjs';
const $=id=>document.getElementById(id);
const modeName=rule=>rule.mode==='present'?'While present':'Toggle';
const names={cool:'Underwater / cool',warm:'Warm glow',money:'Money glow',card:'Text card'};

// Owns only display reactions; semantic scheduling and source epochs stay in app.js.
export class ActionView {
  constructor() {
    this.rules=[];this.engine=new VisualActions();this.generation=0;this.nextId=1;this.editId=null;this.cardKey='';
    this.targets=new VisualActions();this.identifierNodes=new Map();
    this.audio=new ActionAudio();
    $('actions-sound').disabled=!(window.AudioContext||window.webkitAudioContext);
    if($('actions-sound').disabled)$('actions-sound-hint').textContent='WebAudio unavailable. Visual rules still work.';
    $('actions-sound').addEventListener('change',async()=>{
      const requested=$('actions-sound').checked;
      const ready=await this.audio.allow(requested);
      if(requested!==$('actions-sound').checked)return;
      $('actions-sound-hint').textContent=ready?'Sound ready · short chime on opted-in rules only.':'Sound off or paused · toggle to allow again.';
    });
    $('actions-enabled').addEventListener('change',()=>this.reset());
    $('reset-actions').addEventListener('click',()=>this.reset());
    $('clear-action-events').addEventListener('click',()=>$('action-events').replaceChildren());
    document.querySelectorAll('[data-preset]').forEach(button=>button.addEventListener('click',()=>{
      const label=button.dataset.preset, id=`preset-${label}`;
      if(!this.rules.some(r=>r.id===id)&&this.rules.length<12) {
        this.rules.push({id,label,mode:'toggle',kind:{bottle:'cool',wallet:'money',lighter:'warm'}[label],text:'',sound:false});
        this.engine.rules=this.rules;this.reset();this.renderRules();
      }
    }));
    $('labels').addEventListener('input',()=>this.renderRules());
    $('rule-kind').addEventListener('change',()=>this.editorKind());
    $('rule-cancel').addEventListener('click',()=>this.clearEditor());
    $('rule-form').addEventListener('submit',event=>{event.preventDefault();this.saveRule();});
  }
  editorKind() {
    const card=$('rule-kind').value==='card';
    $('rule-text-field').hidden=!card;$('rule-text').required=card;
  }
  clearEditor() {
    this.editId=null;$('rule-form').reset();this.editorKind();
    $('rule-save').textContent='Add rule';$('rule-cancel').hidden=true;$('rule-error').hidden=true;
    $('rule-editor-title').textContent='Create a rule';
  }
  saveRule() {
    const rule={id:this.editId||`rule-${this.nextId}`,label:$('rule-label').value.trim(),kind:$('rule-kind').value,mode:$('rule-mode').value,text:$('rule-text').value.trim(),sound:$('rule-sound').checked};
    if(!validRule(rule)||(!this.editId&&this.rules.length>=12)) {
      $('rule-error').textContent='Use one simple target (up to 80 characters), a card message if needed, and at most 12 rules.';
      $('rule-error').hidden=false;return;
    }
    if(this.editId)this.rules=this.rules.map(r=>r.id===this.editId?rule:r);
    else {this.rules.push(rule);this.nextId++;}
    this.engine.rules=this.rules;this.reset();this.renderRules();this.clearEditor();
    $('rule-label').focus();
  }
  editRule(rule) {
    this.reset();this.editId=rule.id;
    $('rule-mode').value=rule.mode||'toggle';$('rule-label').value=rule.label;$('rule-kind').value=rule.kind;$('rule-text').value=rule.text;$('rule-sound').checked=rule.sound;
    this.editorKind();$('rule-save').textContent='Save changes';$('rule-cancel').hidden=false;
    $('rule-editor-title').textContent='Edit rule';$('rule-label').focus();
  }
  deleteRule(id) {
    this.reset();this.rules=this.rules.filter(r=>r.id!==id);this.engine.rules=this.rules;
    this.renderRules();if(this.editId===id)this.clearEditor();$('rule-label').focus();
  }
  reset() {
    for(const rule of this.engine.result([],[]).active)this.log(`${rule.label} → cleared (settings or source reset)`);
    this.audio.cancel();this.generation++;this.engine.reset();this.targets.reset();this.present(this.engine.tick(performance.now()));
  }
  accept(items,captured,now,generation,threshold) {
    if(generation!==this.generation||document.hidden)return;
    this.targets.rules=$('labels').value.split(',').map(s=>s.trim()).filter(Boolean).map(label=>({id:label,label,mode:'present'}));
    this.targets.accept(items,captured,now,threshold);
    if(!$('actions-enabled').checked)return;
    this.present(this.engine.accept(items,captured,now,threshold));
  }
  tick(now) { this.present(this.engine.tick(now)); }
  present(result) {
    for(const id of ['video','photo']) {
      const node=$(id);
      if(result.filter) {if(node.dataset.actionFilter!==result.filter)node.dataset.actionFilter=result.filter;}
      else if(node.hasAttribute('data-action-filter'))node.removeAttribute('data-action-filter');
    }
    const cards=result.active.filter(r=>r.kind==='card'), key=JSON.stringify(cards.map(r=>[r.id,r.text]));
    if(key!==this.cardKey) {
      this.cardKey=key;$('action-cards').tabIndex=cards.length?0:-1;
      $('action-cards').replaceChildren(...cards.map(rule=>{const node=document.createElement('p');node.textContent=rule.text;return node;}));
    }
    const message=!$('actions-enabled').checked?'Actions off · preview unchanged':result.active.length?`${result.active.length} active · ${result.active.map(r=>r.label).join(', ')}`:'Armed · waiting for two fresh positive results';
    if($('actions-state').textContent!==message)$('actions-state').textContent=message;
    for(const rule of result.entered)this.log(`${rule.label} → ${names[rule.kind]} activated`);
    if(result.entered.some(r=>r.sound)&&$('actions-enabled').checked&&$('actions-sound').checked&&!document.hidden)this.audio.play();
    for(const rule of result.exited)this.log(`${rule.label} → effect OFF (confirmed absence or toggle return)`);
  }
  identifiers(recognized,captured,now) {
    const labels=$('labels').value.split(',').map(s=>s.trim()).filter(Boolean);
    const rows=new Map();
    const recent=!document.hidden&&captured&&now-captured<4000;
    for(const label of labels) {
      const found=recent&&recognized.some(d=>d.label===label);
      const confirmed=found&&this.targets.states.get(label)?.hits>=2;
      rows.set(`target:${label}`,`${label} · ${found?`${confirmed?'Confirmed':'Recognized'} · last capture ${Math.floor((now-captured)/1000)}s ago · not current location`:'Scanning / uncertain · no recent positive capture'}`);
    }
    for(const rule of this.rules) {
      const state=this.engine.states.get(rule.id);
      const enabled=$('actions-enabled').checked;
      const uncertain=!Number.isFinite(this.engine.lastCapture)||now-this.engine.lastCapture>=2500;
      rows.set(`rule:${rule.id}`,`${rule.label} · ${modeName(rule)} · effect ${state?.active?'ON':'OFF'} · ${!enabled?'actions disabled':state?.armed===false?'Confirmed appearance · remove and return':state?.confirmed?'Confirmed':'Armed · two positives needed'}${enabled&&uncertain?' · scanning paused / uncertain (not absence)':''}`);
    }
    for(const [key,node] of this.identifierNodes)if(!rows.has(key)){node.remove();this.identifierNodes.delete(key);}
    for(const [key,message] of rows) {
      let node=this.identifierNodes.get(key);
      if(!node){node=document.createElement('p');node.className='target-identifier';this.identifierNodes.set(key,node);$('target-identifiers').append(node);}
      if(node.textContent!==message)node.textContent=message;
    }
  }
  log(message) {
    const li=document.createElement('li'), time=document.createElement('time'), now=new Date();
    time.dateTime=now.toISOString();time.textContent=now.toLocaleTimeString();
    li.append(time,document.createTextNode(` · ${message}`));
    $('action-events').prepend(li);
    while($('action-events').children.length>40)$('action-events').lastChild.remove();
  }
  renderRules() {
    const labels=$('labels').value.split(',').map(s=>s.trim());
    const nodes=this.rules.map(rule=>{
      const li=document.createElement('li');li.dataset.ruleId=rule.id;
      const description=document.createElement('p');
      description.textContent=`${rule.label} → ${names[rule.kind]} · ${modeName(rule)}${rule.sound?' · chime':''}`;
      const hint=document.createElement('p');hint.className='hint';
      hint.textContent=labels.includes(rule.label)?'Target configured':'Target not configured — add exact label above';
      const controls=document.createElement('div');controls.className='rule-buttons';
      for(const [name,action] of [['Edit',()=>this.editRule(rule)],['Delete',()=>this.deleteRule(rule.id)]]) {
        const button=document.createElement('button');button.type='button';button.className='secondary';button.textContent=name;
        button.addEventListener('click',action);controls.append(button);
      }
      li.append(description,hint,controls);
      return li;
    });
    $('action-rules').replaceChildren(...nodes);
  }
}
