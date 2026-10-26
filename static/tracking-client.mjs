// Main thread: bounded transfers only. No optical flow or runtime on UI thread.
export class TrackingClient {
  constructor(onchange) {this.onchange=onchange;this.generation=0;this.serial=0;this.tracks=[];this.lossCutoffs=new Map();this.ready=false;this.busy=false;this.state='tracker initialization pending';this.lastMeasured=0;this.clearDiagnostics();}
  clearDiagnostics() {this.samples=[];this.completions=[];this.metricStart=performance.now();this.turnaround=0;this.processingMs=0;this.replayMs=0;this.workerStats={};this.localRejects={};}
  sampleInterval() {return Math.min(160,Math.max(1000/30,this.turnaround*1.35));}
  record(list,now) {list.push(now);while(list.length>180||list[0]<now-5000)list.shift();}
  diagnostics(now=performance.now()) {
    const number=v=>Number.isFinite(v)&&v>=0?Math.min(1e9,v):0;
    const counts=(source,keys)=>Object.fromEntries(keys.filter(k=>number(source?.[k])).map(k=>[k,number(source[k])]));
    const rejects=counts(this.workerStats.rejects,['capture-history-budget','capture-frame-expired','invalid-box-or-capacity','insufficient-texture','previous-track-lost','association-failed','unassociated-or-capacity','replay-gap','pixel-evidence-lost','incoherent-motion','leaving-frame','revalidation-expired','replay-budget']);
    for(const [key,value] of Object.entries(this.localRejects))rejects[key]=number(value);
    const hz=list=>list.filter(t=>t>now-5000).length/(Math.max(1,Math.min(5000,now-this.metricStart))/1000);
    return {sampleHz:hz(this.samples),completionHz:hz(this.completions),processingMs:this.processingMs,replayMs:this.replayMs,intervalMs:this.sampleInterval(),historyFrames:number(this.workerStats.historyFrames),historyBytes:number(this.workerStats.historyBytes),historyMs:number(this.workerStats.historyMs),rejects,losses:counts(this.workerStats.losses,['frame-gap','pixel-evidence-lost','incoherent-motion','leaving-frame','revalidation-expired'])};
  }
  reject(reason) {this.localRejects[reason]=Math.min(1e9,(this.localRejects[reason]||0)+1);}
  start() {
    if(this.worker) return;
    this.failureCode=null;this.failureDetail=null;
    this.state='initializing pixel tracker · cold download/runtime may take up to 60s';
    try {
      const worker=this.worker=new Worker(new URL('./tracking-worker.js',import.meta.url));
      this.loadTimer=setTimeout(()=>this.failure('initialization-timeout'),60000);
      worker.onerror=e=>{if(worker===this.worker)this.failure(this.ready?'worker-runtime-error':'worker-load-error',this.errorDetail(e));};
      worker.onmessageerror=()=>{if(worker===this.worker)this.failure('worker-message-error');};
      worker.onmessage=({data:m})=>{
        if(worker!==this.worker)return;
        if(m.type==='ready'){clearTimeout(this.loadTimer);this.ready=true;this.state='pixel tracker ready';this.onchange();return;}
        if(m.type==='failure'){
          if(m.generation!==undefined&&m.generation!==this.generation)return;
          const code=['frame-processing-error','seed-replay-error','reset-error'].includes(m.code)?m.code:'worker-processing-error';
          this.failure(code,['Error','TypeError','RangeError','ReferenceError','RuntimeError'].includes(m.detail)?m.detail:'unclassified');return;
        }
        if(m.generation!==this.generation)return;
        if(m.type==='frame'||m.type==='seed') {
          const now=performance.now();
          if(m.type==='frame') {
            this.busy=false;this.record(this.completions,now);
            const elapsed=Math.max(0,now-this.busySince);
            this.turnaround=this.turnaround?this.turnaround*.8+elapsed*.2:elapsed;
            this.processingMs=Number.isFinite(m.processingMs)?Math.max(0,Math.min(10000,m.processingMs)):0;
          } else this.replayMs=Number.isFinite(m.seedResult?.replayMs)?Math.max(0,Math.min(10000,m.seedResult.replayMs)):0;
          this.workerStats=m.diagnostics||this.workerStats;
          this.workerStats=this.diagnostics(now); // discard all non-allowlisted fields immediately
          // Loss time is measured capture time, never semantic response arrival.
          // Old snapshots cannot restore geometry rejected by newer pixel evidence.
          const ids=new Set(m.tracks.map(t=>t.id));
          for(const t of this.tracks)if(!ids.has(t.id))this.lossCutoffs.set(t.label,Math.max(this.lossCutoffs.get(t.label)||0,m.measured||this.lastMeasured));
          for(const [label,cutoff] of this.lossCutoffs)if(now-cutoff>=350)this.lossCutoffs.delete(label);
          this.tracks=m.tracks;this.lastMeasured=m.measured||0;if(this.tracks.length)this.engaged=true;
          this.state=this.tracks.length?'measured pixel tracking':'no supported pixel tracks · snapshot detection';
          this.onchange();
        }
      };
    } catch(e) {this.failure('worker-construction-error',this.errorDetail(e));}
  }
  errorDetail(error) {
    // Never echo arbitrary exception text, filenames, URLs, targets or pixel data.
    const message=String(error?.message||'').toLowerCase();
    const category=/memory|allocation/.test(message)?'memory':/network|fetch|importscripts/.test(message)?'network-or-script-load':/security|content security|csp/.test(message)?'security-policy':/wasm|runtime|abort/.test(message)?'runtime':'unclassified';
    const line=Number.isSafeInteger(error?.lineno)&&error.lineno>0?` · line ${error.lineno}:${Number.isSafeInteger(error.colno)&&error.colno>=0?error.colno:0}`:'';
    return category+line;
  }
  failure(code='frame-capture-error',detail='') {this.close();this.failureCode=code;this.failureDetail=detail;this.state=`tracker unavailable · snapshot fallback · ${code}${detail?' · '+detail:''}`;this.onchange('failure');}
  reset() {this.clearDiagnostics();this.generation++;this.tracks=[];this.lossCutoffs.clear();this.busy=false;this.lastMeasured=0;this.worker?.postMessage({type:'reset'});this.onchange();}
  close() {clearTimeout(this.loadTimer);this.worker?.terminate();this.worker=null;this.ready=false;this.reset();}
  push(canvas,context,timestamp) {
    if(!this.ready||this.busy)return null;
    const dimensions=`${canvas.width}x${canvas.height}`;
    if(this.dimensions&&dimensions!==this.dimensions)this.reset();
    this.dimensions=dimensions;
    const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;
    const capture={frameId:++this.serial,generation:this.generation,timestamp};
    this.busy=true;this.busySince=performance.now();this.record(this.samples,this.busySince);
    this.worker.postMessage({type:'frame',...capture,width:canvas.width,height:canvas.height,pixels:pixels.buffer},[pixels.buffer]);
    return capture;
  }
  seed(capture,detections,threshold) {
    if(!capture){this.reject('capture-unavailable');return;}
    if(capture.generation!==this.generation){this.reject('source-changed');return;}
    if(!this.ready){this.reject('worker-not-ready');return;}
    if(performance.now()-capture.timestamp>=4000){this.reject('capture-too-old');return;}
    const seeds=detections.filter(d=>d.confidence>=threshold).map(d=>({label:d.label,confidence:d.confidence,box:[d.box.left,d.box.top,d.box.right-d.box.left,d.box.bottom-d.box.top]}));
    this.worker.postMessage({type:'seed',...capture,detections:seeds});
  }
  current(now) {
    // Visual evidence expires quickly; worker liveness has a separate bounded budget.
    // A slow frame/replay must not kill a responsive worker or expose stale boxes.
    if(this.busy&&now-this.busySince>10000)this.failure('frame-timeout','no frame reply within 10s');
    // Hide expired geometry without erasing identities needed by delayed loss replies.
    if(this.lastMeasured&&now-this.lastMeasured>350)return [];
    return this.tracks.map(t=>({id:`${this.generation}:${t.id}`,label:t.label,confidence:t.confidence,tracked:true,box:{left:t.box[0],top:t.box[1],right:t.box[0]+t.box[2],bottom:t.box[1]+t.box[3]}}));
  }
}
