export function validRule(rule) {
  return !!rule&&typeof rule.id==='string'&&rule.id.length>0&&rule.id.length<=80&&
    typeof rule.label==='string'&&rule.label===rule.label.trim()&&/^[\p{L}\p{N}_][\p{L}\p{N}_ .'()/-]{0,79}$/u.test(rule.label)&&
    ['cool','warm','money','card'].includes(rule.kind)&&typeof rule.sound==='boolean'&&
    typeof rule.text==='string'&&rule.text.length<=240&&(rule.kind!=='card'||rule.text.trim().length>0);
}

// Pure semantic state, independent of preview geometry, workers and wall clock.
export class VisualActions {
  constructor(rules=[]) { this.rules=rules; this.reset(); }
  reset() { this.states=new Map();this.lastCapture=-Infinity; }
  tick(now) {
    const exited=[];
    for(const rule of this.rules) {
      const state=this.states.get(rule.id);
      if(state?.active&&(now-state.positive>=2500||(state.missing!==null&&now-state.missing>=1200))) {
        // Effect expiry must not discard still-consecutive capture history.
        state.active=false;exited.push(rule);
      }
    }
    return this.result([],exited);
  }
  accept(items,captured,now,threshold=.7) {
    const {exited}=this.tick(now), entered=[];
    if(!Number.isFinite(captured)||!Number.isFinite(now)||captured>now||now-captured>=2500||captured<=this.lastCapture) return this.result([],exited);
    this.lastCapture=captured;
    for(const rule of this.rules) {
      const state=this.states.get(rule.id)||{hits:0,active:false,missing:null,next:0,positive:-Infinity};
      this.states.set(rule.id,state);
      if(items.some(d=>d.label===rule.label&&Number.isFinite(d.confidence)&&d.confidence<=1&&d.confidence>=Math.max(.7,threshold))) {
        // Confirmation follows capture intervals, not render ticks or reply latency.
        state.hits=captured-state.positive>=2500?1:state.hits+1;state.missing=null;state.positive=captured;
        if(state.hits>=2&&!state.active&&now>=state.next) {
          state.active=true;state.next=now+2000;entered.push(rule);
        }
      } else {state.hits=0;state.missing??=now;}
    }
    return this.result(entered,exited);
  }
  result(entered,exited) {
    const active=this.rules.filter(r=>this.states.get(r.id)?.active);
    return {active,entered,exited,filter:active.find(r=>r.kind!=='card')?.kind||''};
  }
}
