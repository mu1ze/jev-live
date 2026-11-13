// Pure semantic state, independent of preview geometry, workers and wall clock.
export class VisualActions {
  constructor(rules=[]) { this.rules=rules; this.reset(); }
  reset() { this.states=new Map(); }
  tick(now) { return this.result([],[]); }
  accept(items,captured,now,threshold=.7) {
    const entered=[];
    for(const rule of this.rules) {
      const state=this.states.get(rule.id)||{hits:0,active:false};
      this.states.set(rule.id,state);
      if(items.some(d=>d.label===rule.label&&d.confidence>=threshold)) {
        state.hits++;
        if(state.hits>=2&&!state.active) {state.active=true;entered.push(rule);}
      } else state.hits=0;
    }
    return this.result(entered,[]);
  }
  result(entered,exited) {
    return {active:this.rules.filter(r=>this.states.get(r.id)?.active),entered,exited};
  }
}
