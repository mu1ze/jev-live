/* Dedicated CLASSIC worker. Its HTTP response owns the restrictive CSP. */
importScripts('tracker-classic.js', 'trackingvendor/opencv.js');
let tracker=null;
cv.onRuntimeInitialized=()=>postMessage({type:'ready',version:'4.13.0'});
onmessage=async ({data:m})=>{
  try {
    if(m.type==='proof') {
      let fetchBlocked=false;try{await fetch('api/config');}catch{fetchBlocked=true;}
      postMessage({type:'proof',fetchBlocked});return;
    }
    if(m.type==='reset') {tracker?.dispose();tracker=null;return;}
    const started=performance.now();let seedResult;
    if(m.type==='frame') {
      if(!tracker||tracker.width!==m.width||tracker.height!==m.height){tracker?.dispose();tracker=new PixelTracker(cv,m.width,m.height);}
      tracker.push(new ImageData(new Uint8ClampedArray(m.pixels),m.width,m.height),m.frameId,m.timestamp);
    } else if(m.type==='seed') {
      const result=tracker?.seed(m.frameId,m.detections);
      // Only reason codes/counts leave diagnostics; no labels or pixel/box payloads.
      if(result)seedResult={accepted:result.accepted,rejected:result.rejected.map(({reason})=>({reason})),replayMs:result.replayMs};
    }
    postMessage({type:m.type,token:m.token,generation:m.generation,frameId:m.frameId,measured:tracker?.frames.at(-1)?.timestampMs,tracks:tracker?.snapshot()||[],processingMs:performance.now()-started,diagnostics:tracker?.diagnostics(),seedResult});
  } catch(error) {
    const code=m.type==='seed'?'seed-replay-error':m.type==='reset'?'reset-error':'frame-processing-error';
    const detail=['Error','TypeError','RangeError','ReferenceError','RuntimeError'].includes(error?.name)?error.name:'unclassified';
    postMessage({type:'failure',generation:m.generation,code,detail});
  }
};
