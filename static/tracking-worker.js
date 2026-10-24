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
    if(m.type==='frame') {
      if(!tracker||tracker.width!==m.width||tracker.height!==m.height){tracker?.dispose();tracker=new PixelTracker(cv,m.width,m.height,{bufferSize:64});}
      tracker.push(new ImageData(new Uint8ClampedArray(m.pixels),m.width,m.height),m.frameId,m.timestamp);
    } else if(m.type==='seed') {
      tracker?.seed(m.frameId,m.detections);
    }
    postMessage({type:m.type,token:m.token,generation:m.generation,frameId:m.frameId,measured:tracker?.frames.at(-1)?.timestampMs,tracks:tracker?.snapshot()||[]});
  } catch {postMessage({type:'failure'});}
};
