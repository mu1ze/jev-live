import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
const path=new URL('../static/visual-actions.mjs',import.meta.url);
const mod=existsSync(path)?await import(path):{};
const rule={id:'bottle',label:'bottle',kind:'cool',text:'',sound:false};
const positive=[{label:'bottle',confidence:.9}];
const engine=()=>new mod.VisualActions([rule]);
test('two successive confident exact-label successes enter once, never from a single result',()=>{
  assert.equal(typeof mod.VisualActions,'function','pure recognition action engine exists');
  const e=engine();
  assert.deepEqual(e.accept(positive,0,0).entered,[]);
  assert.deepEqual(e.accept(positive,250,250).entered.map(r=>r.id),['bottle']);
  assert.equal(e.accept(positive,500,500).entered.length,0);
  assert.equal(e.tick(900).active.length,1,'box TTL is not semantic expiry');
});
