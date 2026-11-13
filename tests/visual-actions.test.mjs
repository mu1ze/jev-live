import test from 'node:test';
import assert from 'node:assert/strict';
import {VisualActions,validRule} from '../static/visual-actions.mjs';
const rule={id:'bottle',label:'bottle',kind:'cool',text:'',sound:false};
const positive=[{label:'bottle',confidence:.9}];
const engine=(mode)=>new VisualActions([{...rule,...(mode?{mode}:{})}]);
const confirm=(e,t=0,delay=0)=>{e.accept(positive,t,t+delay);return e.accept(positive,t+1400,t+1400+delay);};

test('rule validation explicitly migrates absent mode to Toggle and rejects unknown modes',()=>{
  for(const mode of [undefined,'toggle','present'])assert.equal(validRule({...rule,mode}),true);
  for(const bad of [{mode:'expiry'},{label:' bottle'},{label:'Bottle, wallet'},{kind:'webhook'},{sound:'yes'},{text:'x'.repeat(241)},{kind:'card',text:' '}])assert.equal(validRule({...rule,...bad}),false);
  assert.equal(validRule({...rule,kind:'card',text:'<img src=x>'}),true);
});
test('toggle latches across time and needs three capture-timed negatives before two positives flip it',()=>{
  const e=engine();confirm(e);
  assert.equal(e.tick(10000).active.length,1,'silence is not absence');
  for(const t of [10000,11000,12000])e.accept([],t,t);
  assert.equal(e.tick(12000).active.length,1,'absence rearms, never clears a toggle');
  assert.equal(e.accept(positive,12250,12250).active.length,1);
  assert.equal(e.accept(positive,12500,12500).exited.length,1);
  for(const t of [12750,13000,14000])assert.equal(e.accept(positive,t,t).active.length,0,'sustained appearance never flips twice');
  for(const t of [15000,16000,17000])e.accept([],t,t);
  assert.equal(confirm(e,18000).entered.length,1,'repeat cycle switches back on');
});
test('While present clears only on three successful negatives spanning at least two capture seconds',()=>{
  const e=engine('present');confirm(e,0,1400);
  for(const t of [3900,10000,50000])assert.equal(e.tick(t).active.length,1,'render time/errors/no replies never imply absence');
  e.accept([],50000,51400);e.accept([],51000,52400);
  assert.equal(e.tick(54000).active.length,1,'two negatives do not suffice');
  assert.equal(e.accept([],52000,53400).exited.length,1);
  assert.equal(confirm(e,53400,1400).entered.length,1);
});
test('absence evidence must be distinct, successive, fresh and capture-timed at boundaries',()=>{
  for(const mode of ['toggle','present'])for(const gap of [2499,2500]) {
    const e=engine(mode);confirm(e);
    e.accept([],2000,3400);e.accept([],2000,3400);e.accept([],1000,3400);
    e.accept([],4500,7000); // exactly stale, cannot add absence
    e.accept([],2000+gap,3400+gap);
    e.accept([],2001+gap,3401+gap);
    assert.equal(e.states.get(rule.id).armed,gap<2500,'gap >=2500 restarts absence');
    if(gap>=2500){e.accept([],6000,7400);assert.equal(e.states.get(rule.id).armed,false);e.accept([],6500,7900);assert.equal(e.states.get(rule.id).armed,true);}
  }
});
test('brief negative and positive interrupt absence; 1999ms never rearms',()=>{
  const e=engine();confirm(e);
  for(const t of [2000,3000,3999])e.accept([],t,t);
  assert.equal(e.states.get(rule.id).armed,false);
  e.accept(positive,4000,4000);
  for(const t of [4100,5000,6000])e.accept([],t,t);
  assert.equal(e.states.get(rule.id).armed,false);
  e.accept([],6100,6100);assert.equal(e.states.get(rule.id).armed,true);
});
test('two fresh exact-label confident captures confirm; invalid captures cannot flip or rearm',()=>{
  for(const mode of ['toggle','present']) {
    const e=engine(mode);e.accept(positive,0,1400);e.tick(2500);
    for(const [capture,now] of [[0,1500],[-1,1500],[2000,1500],[1,2501],[NaN,2000]])assert.equal(e.accept(positive,capture,now).active.length,0);
    assert.equal(e.accept(positive,1400,2800).entered.length,1,'serial 1400ms replies confirm');
    for(const t of [2800,4200,5600,7000])assert.equal(e.accept(positive,t,t+1400).entered.length,0);
    assert.equal(e.tick(20000).active.length,1);
    e.reset();assert.equal(e.tick(20000).active.length,0);
  }
  for(const gap of [2499,2500,5000]){const e=engine();e.accept(positive,0,1400);assert.equal(e.accept(positive,gap,gap+1400).entered.length,gap<2500?1:0);}
  for(const bad of [[{label:'Bottle',confidence:.99}],[{label:'bottle',confidence:.69}],[{label:'bottle',confidence:Infinity}],[{label:'bottle',confidence:1.1}],[]]){const e=engine();e.accept(positive,0,0);e.accept(bad,250,250);assert.equal(e.accept(positive,500,500).entered.length,0);}
  const e=engine();e.accept(positive,0,0,.95);assert.equal(e.accept(positive,250,250,.95).active.length,0);
});
test('filter priority and cards coexist across independent mixed-mode rule states',()=>{
  const e=new VisualActions([rule,{...rule,id:'warm',kind:'warm',mode:'present'},{...rule,id:'card',kind:'card',text:'<b>local</b>'}]);
  assert.equal(confirm(e).filter,'cool');assert.equal(e.tick(1500).active.length,3);
  for(const t of [2000,3000,4000])e.accept([],t,t);
  assert.equal(e.tick(5000).active.length,2);
  const off=confirm(e,5000);assert.equal(off.active.length,1);assert.equal(off.filter,'warm');assert.equal(off.exited.length,2);
});
