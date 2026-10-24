// Main thread: bounded transfers only. No optical flow or runtime on UI thread.
export class TrackingClient {
  constructor(onchange) {this.onchange=onchange;this.generation=0;this.serial=0;this.tracks=[];this.ready=false;this.busy=false;this.state='tracker initialization pending';this.lastMeasured=0;}
  start() {
    if(this.worker) return;
    this.state='initializing pixel tracker';
    try {
      const worker=this.worker=new Worker(new URL('./tracking-worker.js',import.meta.url));
      this.loadTimer=setTimeout(()=>this.failure(),15000);
      worker.onerror=()=>this.failure();worker.onmessageerror=()=>this.failure();
      worker.onmessage=({data:m})=>{
        if(worker!==this.worker)return;
        if(m.type==='ready'){clearTimeout(this.loadTimer);this.ready=true;this.state='pixel tracker ready';this.onchange();return;}
        if(m.type==='failure'){this.failure();return;}
        if(m.generation!==this.generation)return;
        if(m.type==='frame')this.busy=false;
        if(m.type==='frame'||m.type==='seed') {
          this.tracks=m.tracks;this.lastMeasured=m.measured||0;if(this.tracks.length)this.engaged=true;
          this.state=this.tracks.length?'measured pixel tracking':'no supported pixel tracks · snapshot detection';
          this.onchange();
        }
      };
    } catch {this.failure();}
  }
  failure() {this.close();this.state='tracker unavailable · snapshot fallback';this.onchange('failure');}
  reset() {this.generation++;this.tracks=[];this.busy=false;this.lastMeasured=0;this.worker?.postMessage({type:'reset'});this.onchange();}
  close() {clearTimeout(this.loadTimer);this.worker?.terminate();this.worker=null;this.ready=false;this.reset();}
  push(canvas,context,timestamp) {
    if(!this.ready||this.busy)return null;
    const dimensions=`${canvas.width}x${canvas.height}`;
    if(this.dimensions&&dimensions!==this.dimensions)this.reset();
    this.dimensions=dimensions;
    const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;
    const capture={frameId:++this.serial,generation:this.generation,timestamp};
    this.busy=true;this.busySince=performance.now();
    this.worker.postMessage({type:'frame',...capture,width:canvas.width,height:canvas.height,pixels:pixels.buffer},[pixels.buffer]);
    return capture;
  }
  seed(capture,detections,threshold) {
    if(!capture||capture.generation!==this.generation||!this.ready||performance.now()-capture.timestamp>=4000)return;
    const seeds=detections.filter(d=>d.confidence>=threshold).map(d=>({label:d.label,confidence:d.confidence,box:[d.box.left,d.box.top,d.box.right-d.box.left,d.box.bottom-d.box.top]}));
    this.worker.postMessage({type:'seed',...capture,detections:seeds});
  }
  current(now) {
    if(this.busy&&now-this.busySince>350)this.failure();
    if(this.lastMeasured&&now-this.lastMeasured>350&&!this.busy)this.reset();
    return this.tracks.map(t=>({id:`${this.generation}:${t.id}`,label:t.label,confidence:t.confidence,tracked:true,box:{left:t.box[0],top:t.box[1],right:t.box[0]+t.box[2],bottom:t.box[1]+t.box[3]}}));
  }
}
