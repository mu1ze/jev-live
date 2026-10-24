import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
const modulePath = new URL('../static/core.mjs', import.meta.url);
test('letterbox projection matches contained image at any aspect ratio', async () => {
  assert.ok(existsSync(modulePath), 'projection module not implemented');
  const {projectBox} = await import(modulePath);
  const actual=projectBox({left:.1,right:.9,top:.2,bottom:.8}, 640,480,1000,500);
  const expected={left:1000/6+.1*(2000/3),top:100,width:.8*(2000/3),height:300};
  for(const key of Object.keys(expected)) assert.ok(Math.abs(actual[key]-expected[key]) < 1e-8);
  assert.deepEqual(projectBox({left:0,right:1,top:0,bottom:1}, 1000,500,400,400), {left:0,top:100,width:400,height:200});
});
test('snapshot dimensions honor Jev minimum and cap without distorting boxes', async () => {
  const core=await import(modulePath);
  assert.equal(typeof core.snapshotSize,'function');
  assert.deepEqual(core.snapshotSize(1920,1080),{width:640,height:360});
  assert.deepEqual(core.snapshotSize(1280,720),{width:640,height:360});
  assert.throws(()=>core.snapshotSize(1600,600), /narrow/);
  assert.deepEqual(core.snapshotSize(100,100),{width:280,height:280});
  assert.throws(()=>core.snapshotSize(2000,100));
});
test('completed update rate measures successes over elapsed time, not target Hz', async () => {
  const {CompletionRate}=await import(modulePath);
  assert.equal(typeof CompletionRate,'function');
  const rate=new CompletionRate(5000);
  rate.reset(0);
  assert.equal(rate.value(250),0);
  rate.record(1000);assert.equal(rate.value(1000),1);
  rate.record(2000);assert.equal(rate.value(2000),1);
  assert.equal(rate.value(7000),0);
  rate.reset(8000);assert.equal(rate.value(8000),0);
});
test('run epochs discard late replies and frames expire by capture time', async () => {
  assert.ok(existsSync(modulePath), 'frame state not implemented');
  const {FrameState} = await import(modulePath);
  const state = new FrameState(4000);
  const epoch = state.reset();
  assert.equal(state.accept(epoch, [{confidence:.8}], 100, 200), true);
  assert.equal(state.visible(4099,.7).length,1);
  assert.equal(state.visible(4100,.7).length,0);
  const next = state.reset();
  assert.equal(state.accept(epoch,[{confidence:1}],5000,5001),false);
  assert.equal(state.accept(next,[{confidence:1}],100,5001),false);
  assert.equal(state.visible(5001,0).length,0);
});
