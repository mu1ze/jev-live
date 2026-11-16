import {VisualActions, validRule, normalizeLink, actionHref} from './visual-actions.mjs';
import {ActionAudio} from './action-audio.mjs';
import {CATALOG, STEP_GROUPS, STEP_NAMES, TAP_STEPS, PRESET_FILTERS, MAX_ACTIONS, MAX_STEPS, validStep, validAction, stepsOf, fillTemplate, headerPairs, loadSaved, save, forget} from './custom-actions.mjs';
import {DeviceActions} from './device-actions.mjs';
const $=id=>document.getElementById(id);
const modeName=rule=>rule.mode==='present'?'While present':'Toggle';
const names={cool:'Underwater / cool',warm:'Warm glow',money:'Money glow',card:'Text card',notify:'Notification',speak:'Speak aloud',shortcut:'Apple Shortcut',link:'App or link'};
// Text field caption per action kind; kinds missing here hide the field.
const textFields={card:'Card message',notify:'Notification message',speak:'Words to speak',shortcut:'Shortcut name · exactly as in the Shortcuts app'};
const presets={bottle:{kind:'cool'},wallet:{kind:'money'},lighter:{kind:'warm'},keys:{kind:'shortcut',text:'Leaving Home'},'cell phone':{kind:'speak',text:'Phone spotted. Back to focus.'}};
const detail=rule=>rule.kind==='shortcut'?` “${rule.text}”`:rule.kind==='link'?` ${linkName(rule.url)}`:'';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const storage=()=>{try {return window.localStorage;} catch {return null;}};
function linkName(url) {
  try {const parsed=new URL(url);return parsed.hostname||parsed.protocol.slice(0,-1);} catch {return 'link';}
}

// Owns only display reactions; semantic scheduling and source epochs stay in app.js.
export class ActionView {
  constructor() {
    this.rules=[];this.actions=[];this.nextAction=1;this.editActionId=null;this.stepSeq=0;this.webhooksInFlight=new Set();
    this.engine=new VisualActions([],rule=>stepsOf(rule,this.actions));this.generation=0;this.nextId=1;this.editId=null;this.cardKey='';
    this.targets=new VisualActions();this.identifierNodes=new Map();
    this.audio=new ActionAudio();this.device=new DeviceActions();this.runs=0;
    $('actions-sound').disabled=!(window.AudioContext||window.webkitAudioContext);
    if($('actions-sound').disabled)$('actions-sound-hint').textContent='WebAudio unavailable. Visual rules still work.';
    $('actions-sound').addEventListener('change',async()=>{
      const requested=$('actions-sound').checked;
      if(!requested&&window.speechSynthesis)speechSynthesis.cancel();
      const ready=await this.audio.allow(requested);
      if(requested!==$('actions-sound').checked)return;
      $('actions-sound-hint').textContent=ready?'Sound ready · short chime on opted-in rules only.':'Sound off or paused · toggle to allow again.';
    });
    $('actions-enabled').addEventListener('change',()=>this.reset());
    $('reset-actions').addEventListener('click',()=>this.reset());
    $('clear-action-events').addEventListener('click',()=>$('action-events').replaceChildren());
    document.querySelectorAll('[data-preset]').forEach(button=>button.addEventListener('click',()=>{
      const label=button.dataset.preset, id=`preset-${label}`;
      $('rule-error').hidden=true;
      if(!this.rules.some(r=>r.id===id)&&this.rules.length<12) {
        const preset=presets[label];
        this.rules.push({id,label,mode:'toggle',kind:preset.kind,text:preset.text||'',sound:false});
        if(preset.kind==='notify')this.requestNotifications();
        this.engine.rules=this.rules;this.reset();this.renderRules();this.persist();
      }
      if(this.rules.some(r=>r.id===id))this.addTarget(label);
    }));
    $('labels').addEventListener('input',()=>this.renderRules());
    $('rule-kind').addEventListener('change',()=>{this.editorKind();if(this.steps({kind:$('rule-kind').value.startsWith('custom:')?'custom':$('rule-kind').value,action:$('rule-kind').value.slice(7),text:'',url:''}).some(step=>step.kind==='notify'))this.requestNotifications();});
    $('rule-cancel').addEventListener('click',()=>this.clearEditor());
    $('rule-form').addEventListener('submit',event=>{event.preventDefault();this.saveRule();});
    $('add-step').addEventListener('click',()=>this.addStepRow());
    $('action-cancel').addEventListener('click',()=>this.clearActionEditor());
    $('action-form').addEventListener('submit',event=>{event.preventDefault();this.saveAction();});
    $('actions-remember').addEventListener('change',()=>{
      if($('actions-remember').checked)this.persist();
      else {forget(storage());save(storage(),{remember:false});}
      $('actions-remember-hint').textContent=$('actions-remember').checked?'Saved in this browser only, including webhook URLs. Your API key is never saved.':'Not saved · rules and custom actions are lost when you close or reload this tab.';
    });
    this.setupDevices();this.clearActionEditor();this.restore();
  }
  // ---- Device permissions and connections ----
  setupDevices() {
    const support=this.device.support();
    $('allow-notifications').addEventListener('click',()=>this.requestNotifications());
    $('test-notification').addEventListener('click',async()=>{
      const problem=await this.device.notify('Jev Live · test','Notifications work on this device.','jev-test',false);
      this.log(problem?`Test notification not shown · ${problem}`:'Test notification sent');this.notificationStatus();
    });
    $('install-hint').hidden=!(support.ios&&!support.standalone&&!support.notifications);
    const connect=(button,state,supported,unsupported,run)=>{
      $(button).disabled=!supported;
      if(!supported){$(state).textContent=unsupported;return;}
      $(button).addEventListener('click',async()=>{$(state).textContent='Waiting for your choice…';$(state).textContent=await run();});
    };
    connect('pair-bluetooth','bluetooth-state',support.bluetooth,'Not available here · Chrome or Edge on desktop/Android',async()=>{
      const services=[...new Set([...this.actions.flatMap(a=>a.steps),...[...$('action-steps').children].map(li=>li.read())].filter(step=>step.kind==='bluetooth').flatMap(step=>[step.service])).values()].filter(Boolean);
      const result=await this.device.pairBluetooth(services);
      if(result.error)return result.error;
      this.log(`Bluetooth paired · ${result.name}`);
      return `Paired · ${result.name}${services.length?` · ${services.length} service${services.length===1?'':'s'} allowed`:' · add a Bluetooth step first, then pair again to allow its service'}`;
    });
    connect('pair-serial','serial-state',support.serial,'Not available here · Chrome or Edge on a desktop',async()=>{
      const baud=Math.min(4000000,Math.max(300,Number($('serial-baud').value)||9600));
      const result=await this.device.pairSerial(baud);
      if(result.error)return result.error;
      this.log(`Serial connected · ${result.name} at ${baud} baud`);return `Connected · ${result.name} · ${baud} baud`;
    });
    connect('enable-midi','midi-state',support.midi,'Not available in this browser',async()=>{
      const result=await this.device.enableMidi();
      if(result.error)return result.error;
      this.log(`MIDI enabled · ${result.outputs.length} output${result.outputs.length===1?'':'s'}`);
      return result.outputs.length?`Enabled · ${result.outputs.join(', ')}`:'Enabled · no outputs found yet';
    });
    const capabilities=[['vibrate','Vibrate'],['share','Share sheet'],['wakelock','Keep awake'],['record','Record clips']].map(([key,name])=>`${name} ${support[key]?'✓':'✗'}`);
    $('device-support').textContent=`This browser: ${capabilities.join(' · ')}`;
    this.notificationStatus();
  }
  notificationStatus() {
    const state=this.device.notificationState(), support=this.device.support();
    $('notification-state').textContent={granted:'Allowed ✓',denied:'Blocked · allow notifications in the browser’s site settings, then reload',default:'Not allowed yet',unsupported:support.ios&&!support.standalone?'Needs the home-screen app (see below)':'Not available in this browser'}[state];
    $('allow-notifications').disabled=state!=='default';
    $('test-notification').disabled=state!=='granted';
  }
  restore() {
    const saved=loadSaved(storage(),validRule);
    if(saved?.remember===false) {$('actions-remember').checked=false;$('actions-remember').dispatchEvent(new Event('change'));return;}
    if(!saved||(!saved.rules.length&&!saved.actions.length))return;
    Object.assign(this,{rules:saved.rules,actions:saved.actions,nextId:saved.nextId,nextAction:saved.nextAction});
    this.engine.rules=this.rules;this.renderActions();this.renderRules();
    for(const rule of this.rules)this.addTarget(rule.label);
    this.log(`Restored ${this.rules.length} rule${this.rules.length===1?'':'s'} and ${this.actions.length} custom action${this.actions.length===1?'':'s'} saved on this device`);
  }
  persist() {
    if(!$('actions-remember').checked)return;
    if(!save(storage(),{remember:true,rules:this.rules,actions:this.actions,nextId:this.nextId,nextAction:this.nextAction}))$('actions-remember-hint').textContent='This browser blocked saving · rules last until you close the tab.';
  }
  editorKind() {
    const kind=$('rule-kind').value, caption=textFields[kind], custom=this.actions.find(a=>`custom:${a.id}`===kind);
    $('rule-sound-label').hidden=!!custom;
    $('rule-text-field').hidden=!caption;$('rule-text').required=!!caption;
    if(caption)$('rule-text-caption').textContent=`${caption} · up to 240 characters`;
    $('rule-url-field').hidden=kind!=='link';$('rule-url').required=kind==='link';
    $('rule-kind-help').textContent={notify:'Shows a system notification. Your browser asks for permission once.',speak:'Speaks on this device. Needs “Allow short sounds on this device” below.',shortcut:'Apple devices: shows a one-tap button that runs your Shortcut, passing the label as input.',link:'Shows a one-tap button. https links open a new tab; app links (tel:, spotify:, shortcuts:, …) open the app.'}[kind]||(custom?`Runs your action “${custom.name}”: ${custom.steps.map(step=>STEP_NAMES[step.kind]).join(' → ')}.`:'Display only · no device access.');
  }
  // Called from a click/submit/change so browsers treat it as a user gesture.
  requestNotifications() {
    const before=this.device.notificationState();
    this.device.requestNotifications().then(state=>{
      if(state!==before||state!=='granted')this.log(`Notification permission: ${state==='unsupported'?'not available in this browser':state}`);
      this.notificationStatus();
    });
  }
  clearEditor() {
    this.editId=null;$('rule-form').reset();this.editorKind();
    $('rule-save').textContent='Add rule';$('rule-cancel').hidden=true;$('rule-error').hidden=true;
    $('rule-editor-title').textContent='Create a rule';
  }
  saveRule() {
    const choice=$('rule-kind').value, custom=choice.startsWith('custom:'), kind=custom?'custom':choice;
    const rule={id:this.editId||`rule-${this.nextId}`,label:$('rule-label').value.trim(),kind,mode:$('rule-mode').value,text:textFields[kind]?$('rule-text').value.trim():'',url:kind==='link'?normalizeLink($('rule-url').value):'',sound:!custom&&$('rule-sound').checked};
    if(custom)rule.action=choice.slice(7);
    if(!validRule(rule)||(!this.editId&&this.rules.length>=12)) {
      $('rule-error').textContent=kind==='link'&&!validRule({...rule,label:'x'})?'Use a full link such as https://… or an app link such as tel:… (script, data and file links are not allowed).':'Use one simple target (up to 80 characters), the message or name the action needs, and at most 12 rules.';
      $('rule-error').hidden=false;return;
    }
    if(this.editId)this.rules=this.rules.map(r=>r.id===this.editId?rule:r);
    else {this.rules.push(rule);this.nextId++;}
    this.engine.rules=this.rules;this.reset();this.renderRules();this.clearEditor();this.persist();
    if(stepsOf(rule,this.actions).some(step=>step.kind==='notify'))this.requestNotifications();
    this.addTarget(rule.label);
    $('rule-label').focus();
  }
  // A rule's exact label joins "Choose your targets" so it is recognized without
  // a second manual step. Existing targets are kept as-is; nothing is removed.
  addTarget(label) {
    const targets=$('labels').value.split(',').map(s=>s.trim()).filter(Boolean);
    if(targets.includes(label))return true;
    if(targets.length>=24) {
      $('rule-error').textContent=`Rule saved, but targets are full (24). Remove a target, then add “${label}”.`;
      $('rule-error').hidden=false;return false;
    }
    $('labels').value=[...targets,label].join(', ');
    // Same path as typing: resets effects, re-renders rules and reschedules recognition.
    $('labels').dispatchEvent(new Event('input',{bubbles:true}));
    return true;
  }
  editRule(rule) {
    this.reset();this.editId=rule.id;
    $('rule-mode').value=rule.mode||'toggle';$('rule-label').value=rule.label;$('rule-kind').value=rule.kind==='custom'?`custom:${rule.action}`:rule.kind;$('rule-text').value=rule.text;$('rule-url').value=rule.url||'';$('rule-sound').checked=rule.sound;
    this.editorKind();$('rule-save').textContent='Save changes';$('rule-cancel').hidden=false;
    $('rule-editor-title').textContent='Edit rule';$('rule-label').focus();
  }
  deleteRule(id) {
    this.reset();this.rules=this.rules.filter(r=>r.id!==id);this.engine.rules=this.rules;
    this.renderRules();if(this.editId===id)this.clearEditor();this.persist();$('rule-label').focus();
  }
  reset() {
    for(const rule of this.engine.result([],[]).active)this.log(`${rule.label} → cleared (settings or source reset)`);
    this.audio.cancel();if(window.speechSynthesis)speechSynthesis.cancel();this.generation++;this.runs++;this.engine.reset();this.targets.reset();this.present(this.engine.tick(performance.now()));
  }
  accept(items,captured,now,generation,threshold) {
    if(generation!==this.generation||document.hidden)return;
    this.targets.rules=$('labels').value.split(',').map(s=>s.trim()).filter(Boolean).map(label=>({id:label,label,mode:'present'}));
    this.targets.accept(items,captured,now,threshold);
    if($('workflow-mode').value!=='actions'||!$('actions-enabled').checked)return;
    this.present(this.engine.accept(items,captured,now,threshold));
  }
  tick(now) { this.present(this.engine.tick(now)); }
  present(result) {
    // First active filter step in rule order wins: a preset class or your own CSS filter.
    let look=null;
    for(const rule of result.active){look=this.steps(rule).find(step=>PRESET_FILTERS.includes(step.kind)||step.kind==='filter');if(look)break;}
    const filter=look?(look.kind==='filter'?'custom':look.kind):'', css=look?.kind==='filter'?look.css:'';
    for(const id of ['video','photo']) {
      const node=$(id);
      if(filter) {if(node.dataset.actionFilter!==filter)node.dataset.actionFilter=filter;}
      else if(node.hasAttribute('data-action-filter'))node.removeAttribute('data-action-filter');
      if(node.style.filter!==css)node.style.filter=css;
    }
    const awake=result.active.some(rule=>this.steps(rule).some(step=>step.kind==='wakelock'));
    if(awake!==this.device.wakeWanted)this.device.keepAwake(awake).then(problem=>{if(problem)this.log(`Keep screen awake · ${problem}`);});
    const cards=result.active.flatMap(rule=>this.steps(rule).filter(step=>step.kind==='card'||TAP_STEPS.includes(step.kind)).map(step=>[rule,step]));
    const key=JSON.stringify(cards.map(([rule,step])=>[rule.id,step]));
    if(key!==this.cardKey) {
      this.cardKey=key;$('action-cards').tabIndex=cards.length?0:-1;
      $('action-cards').replaceChildren(...cards.map(([rule,step])=>this.card(rule,step)));
    }
    const message=!$('actions-enabled').checked?'Actions off · preview unchanged':result.active.length?`${result.active.length} active · ${result.active.map(r=>r.label).join(', ')}`:'Armed · waiting for two fresh positive results';
    if($('actions-state').textContent!==message)$('actions-state').textContent=message;
    for(const rule of result.entered) {
      this.log(`${rule.label} → ${this.ruleName(rule)} activated${this.steps(rule).some(step=>TAP_STEPS.includes(step.kind))?' · tap the card to run':''}`);
      this.runEvents(rule,'on');
    }
    for(const rule of result.exited) {
      this.log(`${rule.label} → effect OFF (confirmed absence or toggle return)`);
      this.runEvents(rule,'off');
    }
  }
  steps(rule) { return stepsOf(rule,this.actions); }
  ruleName(rule) {
    return rule.kind==='custom'?`“${this.actions.find(a=>a.id===rule.action)?.name||'missing action'}”`:`${names[rule.kind]}${detail(rule)}`;
  }
  // Event steps fire once per change, in step order (default: when the rule turns on).
  // Wait steps pause the sequence; a reset/Stop/settings change cancels the rest.
  async runEvents(rule,event) {
    const run=this.runs, all=this.steps(rule), chime=all.some(step=>step.kind==='chime');
    const values={label:rule.label,event,time:new Date().toISOString(),rule:this.ruleName(rule)};
    const report=(step,problem)=>{if(problem)this.log(`${rule.label} → ${STEP_NAMES[step.kind]} · ${problem}`);};
    for(const [index,step] of all.entries()) {
      if(CATALOG[step.kind].run!=='event'||(step.on||'on')!==event)continue;
      if(run!==this.runs){this.log(`${rule.label} → remaining steps cancelled (reset)`);return;}
      const text=CATALOG[step.kind].fields?.text?.template?fillTemplate(step.text,values):step.text;
      const sound=$('actions-enabled').checked&&$('actions-sound').checked&&!document.hidden;
      switch(step.kind) {
        case 'wait': await sleep(step.seconds*1000);break;
        case 'notify': this.device.notify(`Jev Live · ${rule.label}`,text,index?`${rule.id}-${index}`:rule.id,!chime).then(problem=>report(step,problem&&`not shown · ${problem}`));break;
        case 'speak': this.speak(rule,text);break;
        case 'chime': if(sound)this.audio.play();break;
        case 'tone': if(!sound)report(step,'allow short sounds on this device first');else this.audio.beep(step.freq,step.ms,step.repeat);break;
        case 'vibrate': report(step,this.device.vibrate(step.pattern));break;
        case 'copy': this.device.copy(text).then(problem=>report(step,problem));break;
        case 'snapshot': this.device.snapshot(rule.label).then(problem=>{report(step,problem);if(!problem)this.log(`${rule.label} → photo saved to Downloads`);});break;
        case 'record': this.log(`${rule.label} → recording ${step.seconds}s…`);this.device.record(step.seconds,rule.label,`${rule.id}:${index}`).then(problem=>{report(step,problem);if(!problem)this.log(`${rule.label} → clip saved to Downloads`);});break;
        case 'webhook': this.webhook(rule,step,text,event,index);break;
        case 'bluetooth': this.device.bluetoothWrite(step.service,step.characteristic,step.hex).then(problem=>report(step,problem||null));break;
        case 'serial': this.device.serialWrite(text+step.ending).then(problem=>report(step,problem));break;
        case 'midi': report(step,this.device.midiSend(step.hex));break;
      }
    }
  }
  async webhook(rule,step,body,event,index) {
    const key=`${rule.id}:${index}`, host=linkName(step.url);
    if(this.webhooksInFlight.has(key)) {this.log(`${rule.label} → webhook ${host} skipped · previous call still running`);return;}
    this.webhooksInFlight.add(key);
    const request={url:step.url,method:step.method,body:step.method==='GET'?'':body};
    const headers=headerPairs(step.headers);if(headers.length)request.headers=headers;
    try {
      const response=await fetch('api/webhook',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',cache:'no-store',body:JSON.stringify(request)});
      const data=await response.json().catch(()=>({}));
      this.log(response.ok?`${rule.label} → webhook ${host} sent (${event}) · HTTP ${data.status}`:`${rule.label} → webhook ${host} failed · ${data.error||`HTTP ${response.status}`}`);
    } catch {this.log(`${rule.label} → webhook ${host} failed · could not reach this server`);}
    finally {this.webhooksInFlight.delete(key);}
  }
  // Text cards are plain text; tap cards add one real link the person must tap,
  // because browsers only launch apps or new tabs from a user gesture.
  card(rule,step) {
    const node=document.createElement('p');
    if(step.kind==='card') {node.textContent=step.text;return node;}
    node.className='run-card';node.textContent=`${rule.label} seen`;
    if(step.kind==='share') {
      const button=document.createElement('button');button.type='button';button.className='run-action';button.textContent='Share…';
      button.addEventListener('click',()=>{
        const text=fillTemplate(step.text,{label:rule.label,event:'on',time:new Date().toISOString(),rule:this.ruleName(rule)});
        this.device.share(text).then(problem=>this.log(`${rule.label} → share ${problem||'opened'}`));
      });
      node.append(document.createElement('br'),button);return node;
    }
    const target={...step,label:rule.label}, href=actionHref(target), link=document.createElement('a');
    link.href=href;link.className='run-action';
    link.textContent=step.kind==='shortcut'?`Run “${step.text}”`:`Open ${linkName(href)}`;
    if(/^https?:/.test(href)) {link.target='_blank';link.rel='noopener noreferrer';}
    link.addEventListener('click',()=>this.log(`${rule.label} → ${names[step.kind]}${detail(target)} run by tap`));
    node.append(document.createElement('br'),link);
    return node;
  }
  speak(rule,text) {
    if(!window.speechSynthesis||!window.SpeechSynthesisUtterance) {this.log(`${rule.label} → not spoken · speech not available in this browser`);return;}
    if(!$('actions-sound').checked) {this.log(`${rule.label} → not spoken · allow short sounds on this device first`);return;}
    speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  }
  identifiers(recognized,captured,now) {
    const labels=$('labels').value.split(',').map(s=>s.trim()).filter(Boolean);
    const rows=new Map();
    const recent=!document.hidden&&captured&&now-captured<4000;
    for(const label of labels) {
      const found=recent&&recognized.some(d=>d.label===label);
      const targetState=this.targets.states.get(label);
      const confirmed=found&&targetState?.positive===captured&&targetState.hits>=2;
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
      description.textContent=`${rule.label} → ${rule.kind==='custom'?`Custom ${this.ruleName(rule)}`:`${names[rule.kind]}${detail(rule)}`} · ${modeName(rule)}${rule.sound?' · chime':''}`;
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
  // ---- Custom action builder ----
  addStepRow(step={kind:'notify',text:''}) {
    if($('action-steps').children.length>=MAX_STEPS) {this.actionError(`An action has at most ${MAX_STEPS} steps.`);return;}
    const n=++this.stepSeq, li=document.createElement('li');li.className='step-row';
    const labelled=(text,control,id)=>{const wrap=document.createElement('div'),label=document.createElement('label');control.id=id;label.htmlFor=id;label.textContent=text;wrap.append(label,control);return {wrap,label};};
    const select=options=>{const node=document.createElement('select');for(const option of options){const [value,text]=Array.isArray(option)?option:[option,option];const o=document.createElement('option');o.value=value;o.textContent=text;node.append(o);}return node;};
    const kind=document.createElement('select');
    for(const [group,title] of Object.entries(STEP_GROUPS)) {
      const optgroup=document.createElement('optgroup');optgroup.label=title;
      for(const [key,spec] of Object.entries(CATALOG))if(spec.group===group){const o=document.createElement('option');o.value=key;o.textContent=spec.name;optgroup.append(o);}
      kind.append(optgroup);
    }
    const on=select([['on','When the rule turns on'],['off','When the rule turns off']]);
    const kindField=labelled(`Step ${$('action-steps').children.length+1}`,kind,`step-kind-${n}`), onField=labelled('Runs',on,`step-on-${n}`);
    kindField.label.className='step-title';
    const help=document.createElement('p');help.className='hint';
    const fieldsBox=document.createElement('div');let controls={};
    const build=(values)=>{
      const spec=CATALOG[kind.value];controls={};
      onField.wrap.hidden=spec.run!=='event';
      const tip=[spec.help,spec.run==='tap'?'Shows a card with a button while the rule is active.':'',Object.values(spec.fields||{}).some(f=>f.template)?'Use {{label}}, {{event}}, {{time}} or {{rule}} in text.':''].filter(Boolean).join(' ');
      help.textContent=tip;help.hidden=!tip;
      fieldsBox.replaceChildren(...Object.entries(spec.fields||{}).map(([key,field])=>{
        let control;
        if(field.input==='select')control=select(field.options);
        else if(field.input==='textarea'){control=document.createElement('textarea');control.rows=2;}
        else {control=document.createElement('input');control.type=field.input==='number'?'number':'text';control.spellcheck=false;control.autocomplete='off';}
        if(field.input==='number')Object.assign(control,{min:field.min,max:field.max,step:field.step});
        if(field.link)control.inputMode='url';
        if(field.max&&field.input!=='number'&&field.input!=='select')control.maxLength=field.max;
        if(field.placeholder)control.placeholder=field.placeholder;
        control.value=String(values[key]??field.default??'');
        controls[key]=control;
        return labelled(field.label,control,`step-${key}-${n}`).wrap;
      }));
      if(kind.value==='notify'&&this.device.notificationState()==='default'&&values.fromUser)this.requestNotifications();
    };
    kind.value=Object.hasOwn(CATALOG,step.kind)?step.kind:'notify';on.value=step.on||'on';build(step);
    kind.addEventListener('change',()=>{const keep=Object.fromEntries(Object.entries(controls).filter(([,c])=>c.value!=='').map(([k,c])=>[k,c.value]));build({...keep,fromUser:true});});
    const remove=document.createElement('button');remove.type='button';remove.className='secondary';remove.textContent='Remove step';
    remove.addEventListener('click',()=>{li.remove();this.numberSteps();});
    li.read=()=>{
      const spec=CATALOG[kind.value], out={kind:kind.value};
      if(spec.run==='event')out.on=on.value;
      for(const [key,field] of Object.entries(spec.fields||{})) {
        const raw=controls[key].value;
        const value=field.input==='number'?(raw.trim()===''?NaN:Number(raw)):field.link?normalizeLink(raw):field.input==='select'||field.keepSpace?raw:raw.trim();
        if(field.optional&&value==='')continue;
        out[key]=value;
      }
      return out;
    };
    li.problem=()=>{
      const value=li.read(), spec=CATALOG[value.kind];
      const bad=Object.entries(spec.fields||{}).find(([key,field])=>!(field.optional&&!(key in value))&&!field.check(value[key]));
      return bad?`check “${bad[1].label}”`:'';
    };
    li.append(kindField.wrap,onField.wrap,help,fieldsBox,remove);
    $('action-steps').append(li);
    return li;
  }
  numberSteps() {
    [...$('action-steps').children].forEach((li,i)=>{li.querySelector('.step-title').textContent=`Step ${i+1}`;});
  }
  actionError(message) {$('action-error').textContent=message;$('action-error').hidden=!message;}
  clearActionEditor() {
    this.editActionId=null;$('action-form').reset();$('action-steps').replaceChildren();this.addStepRow();
    $('action-save').textContent='Save action';$('action-cancel').hidden=true;$('action-editor-title').textContent='Build an action';this.actionError('');
  }
  saveAction() {
    const rows=[...$('action-steps').children], steps=rows.map(li=>li.read());
    const action={id:this.editActionId||`action-${this.nextAction}`,name:$('action-name').value.trim(),steps};
    const bad=steps.findIndex(step=>!validStep(step));
    if(!steps.length)return this.actionError('Add at least one step.');
    if(bad>=0)return this.actionError(`Step ${bad+1} (${STEP_NAMES[steps[bad].kind]}): ${rows[bad].problem()||'check its fields'}.`);
    if(!validAction(action))return this.actionError('Give the action a name up to 60 characters.');
    if(!this.editActionId&&this.actions.length>=MAX_ACTIONS)return this.actionError(`At most ${MAX_ACTIONS} custom actions.`);
    if(this.editActionId)this.actions=this.actions.map(a=>a.id===action.id?action:a);
    else {this.actions.push(action);this.nextAction++;}
    this.reset();this.renderActions();this.renderRules();this.clearActionEditor();this.persist();
    if(steps.some(step=>step.kind==='notify'))this.requestNotifications();
    this.log(`Custom action “${action.name}” saved · choose it in a rule under Your actions`);
  }
  editAction(action) {
    this.clearActionEditor();this.editActionId=action.id;$('action-name').value=action.name;
    $('action-steps').replaceChildren();for(const step of action.steps)this.addStepRow(step);
    $('action-save').textContent='Save changes';$('action-cancel').hidden=false;$('action-editor-title').textContent='Edit action';$('action-name').focus();
  }
  deleteAction(id) {
    const users=this.rules.filter(r=>r.action===id).length;
    if(users)return this.actionError(`Used by ${users} rule${users===1?'':'s'}. Change or delete ${users===1?'that rule':'those rules'} first.`);
    this.actions=this.actions.filter(a=>a.id!==id);if(this.editActionId===id)this.clearActionEditor();
    this.renderActions();this.persist();
  }
  renderActions() {
    $('custom-actions').replaceChildren(...this.actions.map(action=>{
      const li=document.createElement('li'), description=document.createElement('p'), steps=document.createElement('p'), controls=document.createElement('div');
      li.dataset.actionId=action.id;description.textContent=action.name;
      steps.className='hint';steps.textContent=action.steps.map(step=>`${STEP_NAMES[step.kind]}${step.on==='off'?' (on turn-off)':''}`).join(' → ');
      controls.className='rule-buttons';
      for(const [name,run] of [['Edit',()=>this.editAction(action)],['Delete',()=>this.deleteAction(action.id)]]) {
        const button=document.createElement('button');button.type='button';button.className='secondary';button.textContent=name;
        button.addEventListener('click',run);controls.append(button);
      }
      li.append(description,steps,controls);return li;
    }));
    const group=$('custom-kind-group'), selected=$('rule-kind').value;
    group.replaceChildren(...this.actions.map(action=>{const o=document.createElement('option');o.value=`custom:${action.id}`;o.textContent=action.name;return o;}));
    group.hidden=group.disabled=!this.actions.length;
    if([...$('rule-kind').options].some(o=>o.value===selected))$('rule-kind').value=selected;else $('rule-kind').value='cool';
    this.editorKind();
  }
}
