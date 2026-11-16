import {FILTER_KINDS, safeLink} from './visual-actions.mjs';

// A custom action is a named list of steps. The catalog below is the single
// source of truth: each step kind says how it runs and which fields it needs,
// and the editor, validation and saved-state checks are all generated from it.
//  - state: lasts while the rule is active (filters, cards, keep-awake)
//  - tap:   a card with a button you tap (browsers only launch apps/share from a tap)
//  - event: fires once when the rule turns on (or off, if chosen); runs in order
const control=/[\u0000-\u001f\u007f]/;
const line=max=>v=>typeof v==='string'&&v.trim().length>0&&v.length<=max&&!control.test(v);
const message=max=>v=>typeof v==='string'&&v.trim().length>0&&v.length<=max;
const num=(min,max)=>v=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max;
const hexBytes=(max,check=()=>true)=>v=>typeof v==='string'&&new RegExp(`^[0-9a-fA-F]{2}( ?[0-9a-fA-F]{2}){0,${max-1}}$`).test(v.trim())&&check(parseHex(v));
const uuid=v=>typeof v==='string'&&(/^(0x)?[0-9a-fA-F]{4}$/.test(v)||/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(v));
const FILTER_FUNCTIONS='blur|brightness|contrast|grayscale|hue-rotate|invert|opacity|saturate|sepia';
export const validCss=v=>typeof v==='string'&&v.length<=200&&new RegExp(`^\\s*((${FILTER_FUNCTIONS})\\(\\s*\\d{1,4}(\\.\\d{1,3})?(px|deg|%)?\\s*\\)\\s*){1,8}$`).test(v);
export const validHeaders=v=>v===''||(typeof v==='string'&&v.length<=4000&&v.split('\n').length<=8&&v.split('\n').every(l=>/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}:[^\u0000-\u0008\u000a-\u001f\u007f]{0,2048}$/.test(l.replace(/\r$/,''))));
export function parseHex(v) { return (String(v).replace(/\s+/g,'').match(/../g)||[]).map(h=>parseInt(h,16)); }
export function headerPairs(v) { return v?v.split('\n').map(l=>l.replace(/\r$/,'')).filter(Boolean).map(l=>{const i=l.indexOf(':');return [l.slice(0,i),l.slice(i+1).trim()];}):[]; }
export function bluetoothUuid(v) { return /^(0x)?[0-9a-fA-F]{4}$/.test(v)?parseInt(v.replace(/^0x/,''),16):v.toLowerCase(); }
export function validWebhookUrl(url) { return safeLink(url)&&/^https?:\/\/[^/]/.test(url); }

const T={label:'Use {{label}}, {{event}}, {{time}} or {{rule}} anywhere'};
export const CATALOG={
  cool:{name:'Underwater / cool filter',group:'Look',run:'state'},
  warm:{name:'Warm glow filter',group:'Look',run:'state'},
  money:{name:'Money glow filter',group:'Look',run:'state'},
  filter:{name:'Custom filter',group:'Look',run:'state',fields:{css:{label:'CSS filter',placeholder:'grayscale(1) contrast(140%)',default:'grayscale(1) contrast(140%)',check:validCss,help:`Any of: ${FILTER_FUNCTIONS.replaceAll('|',', ')}`}}},
  card:{name:'Text card',group:'Look',run:'state',fields:{text:{label:'Card message',input:'textarea',max:240,check:message(240)}}},
  wakelock:{name:'Keep screen awake',group:'Look',run:'state',help:'Holds a screen wake lock while the rule is active.'},
  notify:{name:'System notification',group:'Alert',run:'event',fields:{text:{label:'Notification message',input:'textarea',max:240,check:message(240),template:true}}},
  speak:{name:'Speak aloud',group:'Alert',run:'event',fields:{text:{label:'Words to speak',input:'textarea',max:240,check:message(240),template:true}}},
  chime:{name:'Chime',group:'Alert',run:'event'},
  tone:{name:'Custom beep',group:'Alert',run:'event',fields:{freq:{label:'Pitch (Hz)',input:'number',min:50,max:4000,step:1,default:880,check:num(50,4000)},ms:{label:'Each beep (ms)',input:'number',min:30,max:2000,step:10,default:200,check:num(30,2000)},repeat:{label:'Beeps',input:'number',min:1,max:10,step:1,default:3,check:num(1,10)}}},
  vibrate:{name:'Vibrate',group:'Alert',run:'event',help:'Phones and tablets with a vibration motor (Android).',fields:{pattern:{label:'Pattern · ms on, off, on…',placeholder:'200,100,200',default:'200,100,200',check:v=>typeof v==='string'&&/^\d{1,4}(\s*,\s*\d{1,4}){0,19}$/.test(v.trim())}}},
  snapshot:{name:'Save a photo',group:'Capture',run:'event',help:'Downloads the current camera frame as a JPEG.'},
  record:{name:'Record a clip',group:'Capture',run:'event',help:'Records the camera and downloads the video.',fields:{seconds:{label:'Seconds',input:'number',min:1,max:60,step:1,default:10,check:num(1,60)}}},
  copy:{name:'Copy text',group:'Apps',run:'event',fields:{text:{label:'Text to copy',input:'textarea',max:240,check:message(240),template:true}}},
  share:{name:'Share sheet · tap',group:'Apps',run:'tap',help:'Opens your device’s share sheet: Messages, WhatsApp, Mail, AirDrop…',fields:{text:{label:'Text to share',input:'textarea',max:240,check:message(240),template:true}}},
  shortcut:{name:'Apple Shortcut · tap',group:'Apps',run:'tap',help:'Runs a Shortcut on iPhone, iPad or Mac; the label is passed as input.',fields:{text:{label:'Shortcut name',max:240,check:line(240)}}},
  link:{name:'App or link · tap',group:'Apps',run:'tap',help:'https:// opens a tab; app links (tel:, sms:, mailto:, spotify:, intent:, …) open the app.',fields:{url:{label:'Link or app URL',placeholder:'https://… · tel:… · spotify:…',max:2000,link:true,check:safeLink}}},
  webhook:{name:'Webhook',group:'Network',run:'event',help:'Sent by this app’s server: Home Assistant, IFTTT, Zapier, n8n, ntfy, Discord, Slack…',fields:{
    url:{label:'Webhook URL · http(s)',placeholder:'https://hooks.example.com/…',max:2000,link:true,check:validWebhookUrl},
    method:{label:'Method',input:'select',options:['POST','PUT','GET'],default:'POST',check:v=>['POST','PUT','GET'].includes(v)},
    headers:{label:'Headers · one Name: value per line (optional)',input:'textarea',placeholder:'Authorization: Bearer …',max:4000,optional:true,check:validHeaders},
    text:{label:'Body',input:'textarea',max:1000,default:'{"label": "{{label}}", "event": "{{event}}", "time": "{{time}}"}',check:v=>typeof v==='string'&&v.length<=1000,template:true,keepSpace:true}}},
  bluetooth:{name:'Bluetooth device write',group:'Hardware',run:'event',device:'bluetooth',help:'Writes bytes to a paired Bluetooth LE device (lights, plugs, microcontrollers). Chrome/Edge on desktop or Android.',fields:{
    service:{label:'Service UUID',placeholder:'0xffe0 or full UUID',check:uuid},
    characteristic:{label:'Characteristic UUID',placeholder:'0xffe1 or full UUID',check:uuid},
    hex:{label:'Bytes (hex)',placeholder:'7e 00 04 f0 00 01 ff 00 ef',check:hexBytes(128)}}},
  serial:{name:'Serial port write',group:'Hardware',run:'event',device:'serial',help:'Sends text to a USB serial device such as an Arduino. Chrome/Edge on desktop.',fields:{
    text:{label:'Text to send',max:240,check:message(240),template:true},
    ending:{label:'Line ending',input:'select',options:[['\n','New line'],['\r\n','CR + LF'],['','None']],default:'\n',check:v=>['\n','\r\n',''].includes(v)}}},
  midi:{name:'MIDI message',group:'Hardware',run:'event',device:'midi',help:'Sends to every MIDI output: music apps, OBS, lighting desks. Chrome/Edge/Firefox.',fields:{
    hex:{label:'MIDI bytes (hex)',placeholder:'90 3c 7f (note on, middle C)',check:hexBytes(48,bytes=>bytes[0]>=0x80&&bytes[0]!==0xf0&&bytes[0]!==0xf7)}}},
  wait:{name:'Wait',group:'Flow',run:'event',help:'Pauses before the next step. A reset or Stop cancels the rest.',fields:{seconds:{label:'Seconds',input:'number',min:0.1,max:60,step:0.1,default:2,check:num(0.1,60)}}},
};
export const STEP_GROUPS={Look:'Look',Alert:'Alerts',Capture:'Camera',Apps:'Apps & sharing',Network:'Internet',Hardware:'Hardware',Flow:'Flow'};
export const STEP_KINDS=Object.keys(CATALOG);
export const STEP_NAMES=Object.fromEntries(STEP_KINDS.map(k=>[k,CATALOG[k].name]));
export const EVENT_KINDS=STEP_KINDS.filter(k=>CATALOG[k].run==='event');
export const TAP_STEPS=STEP_KINDS.filter(k=>CATALOG[k].run==='tap');
export const MAX_ACTIONS=12, MAX_STEPS=10, WEBHOOK_BODY=1000;
export const PRESET_FILTERS=FILTER_KINDS;

export function validStep(step) {
  const spec=step&&typeof step==='object'&&Object.hasOwn(CATALOG,step.kind)?CATALOG[step.kind]:null;
  if(!spec)return false;
  const fields=spec.fields||{};
  for(const key of Object.keys(step)) {
    if(key==='kind')continue;
    if(key==='on'){if(spec.run!=='event'||!['on','off'].includes(step.on))return false;continue;}
    if(!Object.hasOwn(fields,key)||!fields[key].check(step[key]))return false;
  }
  return Object.entries(fields).every(([key,field])=>field.optional||Object.hasOwn(step,key));
}

export function validAction(action) {
  return !!action&&typeof action.id==='string'&&/^action-[0-9]{1,6}$/.test(action.id)&&
    typeof action.name==='string'&&action.name===action.name.trim()&&action.name.length>=1&&action.name.length<=60&&!control.test(action.name)&&
    Array.isArray(action.steps)&&action.steps.length>=1&&action.steps.length<=MAX_STEPS&&action.steps.every(validStep);
}

// Built-in rules are one-step actions; legacy `sound` becomes a chime step.
export function stepsOf(rule,actions) {
  if(rule.kind==='custom')return actions.find(a=>a.id===rule.action)?.steps||[];
  const step={kind:rule.kind};
  if(['card','notify','speak','shortcut'].includes(rule.kind))step.text=rule.text;
  if(rule.kind==='link')step.url=rule.url;
  return rule.sound?[step,{kind:'chime'}]:[step];
}

// {{label}}, {{event}} (on/off), {{time}} (ISO) and {{rule}} are the only placeholders.
// Values are JSON-escaped when the template looks like JSON, so a label cannot break it.
export function fillTemplate(template,values) {
  const json=/^\s*(\[|\{\s*["}])/.test(template);
  return template.replace(/\{\{\s*(label|event|time|rule)\s*\}\}/g,(_,name)=>{
    const value=String(values[name]??'');
    return json?JSON.stringify(value).slice(1,-1):value;
  });
}

export const STORAGE_KEY='jev-live.visual-actions.v1';

// Rules and custom actions only. The API key and frames are never stored.
// {remember:false} is stored alone when the person turns saving off.
export function loadSaved(storage,validRule) {
  try {
    const raw=storage?.getItem(STORAGE_KEY);if(!raw)return null;
    const saved=JSON.parse(raw);
    if(!saved||saved.version!==1)return null;
    if(saved.remember===false)return {remember:false};
    const actions=(Array.isArray(saved.actions)?saved.actions:[]).filter(validAction).slice(0,MAX_ACTIONS);
    const ids=new Set(actions.map(a=>a.id));
    const rules=(Array.isArray(saved.rules)?saved.rules:[]).filter(r=>validRule(r)&&(r.kind!=='custom'||ids.has(r.action))).slice(0,12);
    // Counters continue past every restored id, whatever the stored counters say.
    const next=(items,prefix)=>1+Math.max(0,...items.map(item=>Number(item.id.startsWith(prefix)?item.id.slice(prefix.length):0)||0));
    return {remember:true,rules,actions,nextId:next(rules,'rule-'),nextAction:next(actions,'action-')};
  } catch {return null;}
}
export function save(storage,state) {
  try {storage?.setItem(STORAGE_KEY,JSON.stringify({version:1,...state}));return true;} catch {return false;}
}
export function forget(storage) {
  try {storage?.removeItem(STORAGE_KEY);} catch { /* storage unavailable */ }
}
