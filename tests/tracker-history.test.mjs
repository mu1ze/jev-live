import test from 'node:test';
import assert from 'node:assert/strict';
import {PixelTracker} from '../static/tracker.mjs';
// Gray allocation seam only; real worker replay is covered in Chromium.
const cv={Mat:class {delete(){this.deleted=true;}},matFromImageData:()=>({delete(){}}),cvtColor(){},COLOR_RGBA2GRAY:0};
const push=(t,id,ms)=>t.push({},id,ms);
test('replay CPU budget atomically rejects unfinished seeds instead of publishing partial motion',context=>{
  let now=0,calls=0;context.mock.method(performance,'now',()=>now);
  const flowCv={Mat:class {constructor(){this.rows=6;this.data32F=new Float32Array([50,50,60,50,70,50,50,60,60,60,70,60]);}delete(){} static zeros(){return new this();}},Point:class{},Scalar:class{},rectangle(){},goodFeaturesToTrack(){}};
  const t=new PixelTracker(flowCv,320,320);
  t.frames=Array.from({length:76},(_,i)=>({frameId:i,timestampMs:i*100/3,gray:{}}));
  t.advance=()=>{now+=700;calls++;}; // controlled CPU clock at the optical-flow boundary
  const result=t.seedRaw(0,[{label:'fixture',box:[.1,.1,.5,.5]}]);
  assert.equal(result.accepted.length,0);
  assert.equal(result.rejected[0].reason,'replay-budget');
  assert.ok(calls<=3,'must stop between transitions, not finish 75 transitions');
  assert.equal(t.tracks.size,0);
});

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
