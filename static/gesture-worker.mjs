/* Dedicated MODULE worker for gesture control. Its HTTP response owns the CSP:
   it may only fetch this app's own files, so frames, landmarks and the bundle's
   optional usage logging never leave the device. */
import {HandLandmarker, FaceLandmarker} from './gesturevendor/vision_bundle.mjs';
// MediaPipe clears self.ModuleFactory after building each model, and a module
// script only runs once per worker, so keep our own reference and restore it
// before every build (GPU→CPU fallback, switching hand↔face).
import ModuleFactory from './gesturevendor/vision_wasm_module_internal.js';

const fileset={
  wasmLoaderPath:new URL('gesturevendor/vision_wasm_module_internal.js',self.location.href).href,
  wasmBinaryPath:new URL('gesturevendor/vision_wasm_module_internal.wasm',self.location.href).href,
};
// Only the face points the head controls need: nose tip, outer eye corners,
// cheek edges, forehead, chin and inner lips (in this order).
export const FACE_POINTS=[1,33,263,234,454,10,152,13,14];
const models={}, loading={};
let lastTimestamp=0;

async function create(mode,delegate) {
  self.ModuleFactory=ModuleFactory;
  const options={baseOptions:{modelAssetPath:`gesturevendor/${mode==='hand'?'hand':'face'}_landmarker.task`,delegate},runningMode:'VIDEO'};
  if(mode==='hand')return HandLandmarker.createFromOptions(fileset,{...options,numHands:1,minHandDetectionConfidence:.5,minHandPresenceConfidence:.5,minTrackingConfidence:.5});
  return FaceLandmarker.createFromOptions(fileset,{...options,numFaces:1,outputFaceBlendshapes:false,outputFacialTransformationMatrixes:false});
}
function load(mode,only) {
  // GPU is much faster where WebGL2 is available in workers; CPU always works.
  const order=only==='CPU'||typeof OffscreenCanvas==='undefined'?['CPU']:only==='GPU'?['GPU']:['GPU','CPU'];
  const pending=loading[mode]??=(async()=>{
    for(const delegate of order) {
      try {models[mode]=await create(mode,delegate);return delegate;}
      catch(error) {if(delegate===order.at(-1))throw error;}
    }
  })();
  pending.catch(()=>{if(loading[mode]===pending)delete loading[mode];}); // allow a retry
  return pending;
}

function pack(points,indices) {
  const list=indices?indices.map(i=>points[i]):points, out=new Float32Array(list.length*3);
  list.forEach((p,i)=>{out[i*3]=p.x;out[i*3+1]=p.y;out[i*3+2]=p.z||0;});
  return out;
}

onmessage=async({data:m})=>{
  try {
    if(m.type==='load') {
      const delegate=await load(m.mode,m.delegate);
      postMessage({type:'ready',mode:m.mode,delegate});return;
    }
    if(m.type==='frame') {
      const started=performance.now(), model=models[m.mode];
      if(!model){m.bitmap.close();postMessage({type:'result',id:m.id,mode:m.mode,points:null,processingMs:0});return;}
      // VIDEO mode requires strictly increasing timestamps.
      const timestamp=Math.max(lastTimestamp+1,Math.round(m.timestamp));lastTimestamp=timestamp;
      let points=null, handedness='';
      try {
        if(m.mode==='hand') {
          const result=model.detectForVideo(m.bitmap,timestamp);
          if(result.landmarks?.[0]?.length===21){points=pack(result.landmarks[0]);handedness=result.handedness?.[0]?.[0]?.categoryName||'';}
        } else {
          const result=model.detectForVideo(m.bitmap,timestamp);
          if(result.faceLandmarks?.[0]?.length>=468)points=pack(result.faceLandmarks[0],FACE_POINTS);
        }
      } finally {m.bitmap.close();}
      postMessage({type:'result',id:m.id,mode:m.mode,points,handedness,processingMs:performance.now()-started},points?[points.buffer]:[]);
    }
  } catch(error) {
    m.bitmap?.close?.();
    const detail=['Error','TypeError','RangeError','RuntimeError'].includes(error?.name)?error.name:'unclassified';
    postMessage({type:'failure',id:m.id,mode:m.mode,stage:m.type,detail,message:String(error?.message||'').slice(0,200)});
  }
};
