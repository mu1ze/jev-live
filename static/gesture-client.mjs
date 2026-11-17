// Main-thread side of the gesture worker: downsizes camera frames into
// transferable bitmaps and keeps at most one frame in flight, so the page never
// queues stale frames and the worker never falls behind the camera.
export class GestureClient {
  constructor(onResult,onState,factory=()=>new Worker('gesture-worker.mjs',{type:'module'})) {
    this.onResult=onResult;this.onState=onState;this.factory=factory;
    this.worker=null;this.mode=null;this.ready=false;this.busy=false;this.nextId=1;this.inflight=null;
    this.stats={frames:0,started:0,processingMs:0,latencyMs:0,delegate:''};this.times=[];
  }
  start(mode) {
    if(this.worker&&this.mode===mode)return;
    this.mode=mode;this.ready=false;this.busy=false;this.inflight=null;
    this.stats={frames:0,started:performance.now(),processingMs:0,latencyMs:0,delegate:''};this.times=[];
    if(!this.worker) {
      try {this.worker=this.factory();}
      catch {this.onState('failed','This browser cannot start the gesture tracker.');return;}
      this.worker.onmessage=({data})=>this.message(data);
      this.worker.onerror=event=>{event.preventDefault?.();this.fail(`The gesture tracker could not load in this browser${event.message?` (${String(event.message).slice(0,120)})`:''}.`);};
    }
    this.onState('loading',mode==='hand'?'Loading hand tracker…':'Loading face tracker…');
    this.worker.postMessage({type:'load',mode});
  }
  fail(message) {this.close();this.onState('failed',message);}
  close() {this.worker?.terminate();this.worker=null;this.ready=false;this.busy=false;this.inflight=null;this.mode=null;}
  message(data) {
    if(data.mode!==this.mode)return; // a reply for a mode we already left
    if(data.type==='ready'){this.ready=true;this.stats.delegate=data.delegate;this.onState('ready',`${data.mode==='hand'?'Hand':'Face'} tracker ready · ${data.delegate}`);return;}
    if(data.type==='failure') {
      if(data.stage==='load'){this.fail(`The ${data.mode==='hand'?'hand':'face'} tracker could not start in this browser${data.message?` (${data.message})`:''}.`);return;}
      this.busy=false;this.inflight=null;return;
    }
    if(data.type==='result'&&this.inflight?.id===data.id) {
      const now=performance.now();
      this.stats.frames++;this.times.push(now);if(this.times.length>90)this.times.shift();this.stats.processingMs+=(data.processingMs-this.stats.processingMs)*.1;
      this.stats.latencyMs+=(now-this.inflight.sent-this.stats.latencyMs)*.1;
      this.busy=false;this.inflight=null;
      this.onResult(data.points,data.handedness,now,data.world||null);
    }
  }
  // Returns true when a frame was submitted.
  async push(source,now) {
    if(!this.ready||this.busy||!this.worker)return false;
    const width=source.videoWidth||source.naturalWidth||source.width, height=source.videoHeight||source.naturalHeight||source.height;
    if(!width||!height)return false;
    this.busy=true;
    const id=this.nextId++, mode=this.mode, worker=this.worker;
    this.inflight={id,sent:now};
    try {
      // Landmark models run at ≤256 px; a 480 px frame keeps detail for small hands.
      const scale=Math.min(1,480/Math.max(width,height));
      const bitmap=await createImageBitmap(source,{resizeWidth:Math.round(width*scale),resizeHeight:Math.round(height*scale),resizeQuality:'low'});
      if(this.worker!==worker||this.mode!==mode||this.inflight?.id!==id){bitmap.close();return false;}
      worker.postMessage({type:'frame',id,mode,bitmap,timestamp:now},[bitmap]);
      return true;
    } catch {
      if(this.inflight?.id===id){this.busy=false;this.inflight=null;}
      return false;
    }
  }
  // Tracked frames per second over the last two seconds.
  rate(now) {return this.times.filter(t=>now-t<=2000).length/2;}
}
