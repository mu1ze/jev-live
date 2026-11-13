import test from 'node:test';
import assert from 'node:assert/strict';
import {PixelTracker} from '../static/tracker.mjs';
const cv={Mat:class {constructor(){this.rows=6;this.data32F=new Float32Array([50,50,60,50,70,50,50,60,60,60,70,60]);}delete(){} static zeros(){return new this();}},Point:class{},Scalar:class{},rectangle(){},goodFeaturesToTrack(){}};
test('cooperative seed replay accepts intervening 12Hz frames without a self-inflicted gap',()=>{
  const t=new PixelTracker(cv,320,320);
  t.frames=Array.from({length:18},(_,i)=>({frameId:i,timestampMs:i*83,gray:{}}));
  // Test scheduling at the real transition seam; pixel correctness is tested in Chromium.
  const original=PixelTracker.prototype.advance;
  PixelTracker.prototype.advance=function(){};
  try {
    assert.equal(typeof t.seedSteps,'function','replay must yield to frame messages');
    const replay=t.seedSteps(0,[{label:'person',confidence:.9,box:[.1,.1,.5,.5]}]);
    let steps=0,result;
    do {
      result=replay.next();
      if(!result.done && steps++%4===0) {
        const last=t.frames.at(-1);t.frames.push({frameId:last.frameId+1,timestampMs:last.timestampMs+83,gray:{}});
      }
    } while(!result.done);
    assert.equal(result.value.accepted.length,1);
    assert.ok(steps>=17);
    assert.equal(t.tracks.size,1);
    assert.deepEqual(t.diagnostics().rejects,{});
  } finally {PixelTracker.prototype.advance=original;}
});
