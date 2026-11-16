export const FILTER_KINDS=['cool','warm','money'];
// Device shortcuts run on this device only: no webhooks, no extra uploads.
// shortcut/link become a one-tap card because browsers require a tap to launch apps.
export const DEVICE_KINDS=['notify','speak','shortcut','link'];
export const TAP_KINDS=['shortcut','link'];
const TEXT_KINDS=['card','notify','speak','shortcut'];
const BLOCKED_SCHEMES=new Set(['javascript:','data:','blob:','file:','vbscript:','about:','filesystem:','view-source:','chrome:','chrome-extension:','edge:','ws:','wss:']);

// Accepts https/http links and app schemes (shortcuts:, tel:, spotify:, …). Script,
// data and local-file schemes are refused; the stored value is the parser-normalized href.
export function safeLink(value) {
  if(typeof value!=='string'||!value||value.length>2000||/[\s\u0000-\u001f\u007f]/.test(value))return false;
  let url;try {url=new URL(value);} catch {return false;}
  if(url.href!==value||BLOCKED_SCHEMES.has(url.protocol)||!/^[a-z][a-z0-9+.-]*:$/.test(url.protocol))return false;
  if(url.username||url.password)return false;
  return !['http:','https:'].includes(url.protocol)||!!url.hostname;
}
export function normalizeLink(value) {
  try {return new URL(String(value).trim()).href;} catch {return String(value).trim();}
}
// Apple Shortcuts (iOS, iPadOS, macOS). The recognized label is passed as text input.
export function actionHref(rule) {
  if(rule.kind==='shortcut')return `shortcuts://run-shortcut?name=${encodeURIComponent(rule.text)}&input=text&text=${encodeURIComponent(rule.label)}`;
  return rule.kind==='link'?rule.url:'';
}

export function validRule(rule) {
  return !!rule&&typeof rule.id==='string'&&rule.id.length>0&&rule.id.length<=80&&
    typeof rule.label==='string'&&rule.label===rule.label.trim()&&/^[\p{L}\p{N}_][\p{L}\p{N}_ .'()/-]{0,79}$/u.test(rule.label)&&
    (rule.mode===undefined||['toggle','present'].includes(rule.mode))&&
    [...FILTER_KINDS,'card',...DEVICE_KINDS,'custom'].includes(rule.kind)&&typeof rule.sound==='boolean'&&
    typeof rule.text==='string'&&rule.text.length<=240&&(!TEXT_KINDS.includes(rule.kind)||rule.text.trim().length>0)&&
    (rule.kind!=='shortcut'||!/[\u0000-\u001f\u007f]/.test(rule.text))&&
    (rule.kind==='link'?safeLink(rule.url):rule.url===undefined||rule.url==='')&&
    (rule.kind==='custom'?typeof rule.action==='string'&&/^action-[0-9]{1,6}$/.test(rule.action):rule.action===undefined);
}

// Missing mode explicitly migrates to Toggle, just like new UI rules.
// Successful capture observations alone can change presence; clocks are not absence.
// stepsOf maps a rule to its steps (custom actions); a built-in rule is its own single step.
export class VisualActions {
  constructor(rules=[],stepsOf=rule=>[rule]) { this.rules=rules;this.stepsOf=stepsOf;this.reset(); }
  reset() { this.states=new Map();this.lastCapture=-Infinity; }
  tick() { return this.result([],[]); }
  accept(items,captured,now,threshold=.7) {
    const entered=[],exited=[];
    if(!Number.isFinite(captured)||!Number.isFinite(now)||captured>now||now-captured>=2500||captured<=this.lastCapture) return this.result([],[]);
    const gap=captured-this.lastCapture;this.lastCapture=captured;
    for(const rule of this.rules) {
      const state=this.states.get(rule.id)||{hits:0,active:false,armed:true,confirmed:false,missing:null,misses:0,positive:-Infinity};
      this.states.set(rule.id,state);
      if(gap>=2500) {state.hits=0;state.missing=null;state.misses=0;}
      if(items.some(d=>d.label===rule.label&&Number.isFinite(d.confidence)&&d.confidence<=1&&d.confidence>=Math.max(.7,threshold))) {
        state.hits=captured-state.positive>=2500?1:state.hits+1;
        state.missing=null;state.misses=0;state.positive=captured;
        if(state.hits>=2&&state.armed) {
          state.confirmed=true;state.armed=false;
          state.active=rule.mode==='present'?true:!state.active;
          (state.active?entered:exited).push(rule);
        }
      } else {
        state.hits=0;state.missing??=captured;state.misses++;
        if(state.misses>=3&&captured-state.missing>=2000) {
          state.armed=true;state.confirmed=false;
          if(rule.mode==='present'&&state.active) {state.active=false;exited.push(rule);}
        }
      }
    }
    return this.result(entered,exited);
  }
  result(entered,exited) {
    const active=this.rules.filter(r=>this.states.get(r.id)?.active);
    let filter='';
    for(const rule of active) {filter=this.stepsOf(rule).find(step=>FILTER_KINDS.includes(step.kind))?.kind||'';if(filter)break;}
    return {active,entered,exited,filter};
  }
}
