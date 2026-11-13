export function validRule(rule) {
  return !!rule&&typeof rule.id==='string'&&rule.id.length>0&&rule.id.length<=80&&
    typeof rule.label==='string'&&rule.label===rule.label.trim()&&/^[\p{L}\p{N}_][\p{L}\p{N}_ .'()/-]{0,79}$/u.test(rule.label)&&
    (rule.mode===undefined||['toggle','present'].includes(rule.mode))&&
    ['cool','warm','money','card'].includes(rule.kind)&&typeof rule.sound==='boolean'&&
    typeof rule.text==='string'&&rule.text.length<=240&&(rule.kind!=='card'||rule.text.trim().length>0);
}

// Missing mode explicitly migrates to Toggle, just like new UI rules.
// Successful capture observations alone can change presence; clocks are not absence.
export class VisualActions {
  constructor(rules=[]) { this.rules=rules; this.reset(); }
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
    return {active,entered,exited,filter:active.find(r=>r.kind!=='card')?.kind||''};
  }
}
