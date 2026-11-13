import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
const path=new URL('../static/visual-actions.mjs',import.meta.url);
const mod=existsSync(path)?await import(path):{};
const rule={id:'bottle',label:'bottle',kind:'cool',text:'',sound:false};
const positive=[{label:'bottle',confidence:.9}];
const engine=()=>new mod.VisualActions([rule]);
test('freshness is capture-bounded at 2500ms even without negatives; duplicate and future evidence rejected',()=>{
  const e=engine();e.accept(positive,0,0);
  assert.equal(e.accept(positive,0,100).active.length,0,'duplicate is not a second success');
  assert.equal(e.accept(positive,200,100).active.length,0,'future capture invalid');
  e.accept(positive,250,250);
  assert.equal(e.tick(2749).active.length,1);
  assert.equal(e.tick(2750).active.length,0,'errors/no replies cannot sustain an action');
  assert.equal(e.accept(positive,300,2800).active.length,0,'late result rejected at exact stale boundary');
  assert.equal(e.accept(positive,3000,3000).active.length,0,'stale streak starts over');
  assert.equal(e.accept(positive,3250,3250).entered.length,1);
  e.reset();assert.equal(e.tick(3300).active.length,0);
});
test('confidence and exact labels break streaks; competing filters use rule order while cards coexist',()=>{
  const rules=[rule,{...rule,id:'warm',kind:'warm'},{...rule,id:'card',kind:'card',text:'<b>local</b>'}];
  const e=new mod.VisualActions(rules);
  for(const detections of [[{label:'Bottle',confidence:.99}],[{label:'bottle',confidence:.69}],[{label:'bottle',confidence:Infinity}]]) {
    e.reset();e.accept(detections,0,0);
    assert.equal(e.accept(positive,100,100).entered.length,0);
    e.reset();
  }
  e.accept(positive,0,0);
  const result=e.accept(positive,250,250);
  assert.equal(result.filter,'cool');assert.equal(result.active.length,3);
  e.reset();e.accept(positive,0,0,.95);
  assert.equal(e.accept(positive,250,250,.95).active.length,0);
});
test('two successive confident exact-label successes enter once, never from a single result',()=>{
  assert.equal(typeof mod.VisualActions,'function','pure recognition action engine exists');
  const e=engine();
  assert.deepEqual(e.accept(positive,0,0).entered,[]);
  assert.deepEqual(e.accept(positive,250,250).entered.map(r=>r.id),['bottle']);
  assert.equal(e.accept(positive,500,500).entered.length,0);
  assert.equal(e.tick(900).active.length,1,'box TTL is not semantic expiry');
});
test('absence grace suppresses flicker and disappearance rearms only after cooldown',()=>{
  const e=engine();e.accept(positive,0,0);e.accept(positive,250,250);
  e.accept([],500,500);assert.equal(e.tick(1699).active.length,1);
  assert.equal(e.accept(positive,1699,1699).active.length,1,'brief dropout recovers');
  e.accept([],1800,1800);
  assert.equal(e.tick(3000).active.length,0);
  e.accept(positive,3100,3100);
  assert.equal(e.accept(positive,3350,3350).entered.length,1);
  const fast=engine();fast.accept(positive,0,0);fast.accept(positive,100,100);
  fast.accept([],200,200);fast.tick(1400);
  fast.accept(positive,1500,1500);assert.equal(fast.accept(positive,1600,1600).active.length,0);
  assert.equal(fast.accept(positive,2100,2100).entered.length,1);
});
