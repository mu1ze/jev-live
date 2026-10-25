import test from 'node:test';
import assert from 'node:assert/strict';
import {PixelTracker} from '../static/tracker.mjs';
// Gray allocation seam only; real worker replay is covered in Chromium.
const cv={Mat:class {delete(){this.deleted=true;}},matFromImageData:()=>({delete(){}}),cvtColor(){},COLOR_RGBA2GRAY:0};
const push=(t,id,ms)=>t.push({},id,ms);
test('loss counters survive bounded event truncation without labels or IDs',()=>{
  const t=new PixelTracker(null,320,320);
  for(let i=0;i<300;i++)t.lose({id:`secret-${i}`},'pixel-evidence-lost',i);
  assert.equal(t.events.length,128);
  assert.equal(t.diagnostics().losses['pixel-evidence-lost'],300);
  assert.doesNotMatch(JSON.stringify(t.diagnostics()),/secret/);
});

test('history retains four seconds at 30 Hz instead of an arbitrary frame count',()=>{
  const t=new PixelTracker(cv,640,360);
  for(let i=0;i<=100;i++)push(t,i,i*100/3);
  assert.equal(t.frames[0].frameId,0,'a 2.5s semantic capture must still have pixels');
  for(let i=101;i<=150;i++)push(t,i,i*100/3);
  assert.ok(t.frames.length<=128);
  assert.ok(t.frames.at(-1).timestampMs-t.frames[0].timestampMs<4000);
  assert.ok(t.frames.length>=119);
  t.dispose();
});
test('history has strict gray-byte and count caps with explicit budget rejection',()=>{
  const t=new PixelTracker(cv,640,480,{maxHistoryBytes:640*480*20,bufferSize:1000});
  for(let i=0;i<90;i++)push(t,i,i*33);
  assert.equal(t.frames.length,20);
  const result=t.seed(0,[{label:'private target',box:[.1,.1,.4,.4]}]);
  assert.equal(result.rejected[0].reason,'capture-history-budget');
  assert.ok(t.diagnostics().historyBytes<=640*480*20);
  assert.equal(t.diagnostics().rejects['capture-history-budget'],1);
  assert.doesNotMatch(JSON.stringify(t.diagnostics()),/private target|box|pixels/);
  t.dispose();
});
