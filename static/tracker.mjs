// Pixel-only sparse LK tracker. No fixture/ground-truth dependency.
export const median = a => { const b = [...a].sort((x,y)=>x-y); return b.length ? b[Math.floor(b.length/2)] : 0; };
export class PixelTracker {
  constructor(cv, width, height, {bufferSize=128, maxHistoryBytes=48*1024*1024, maxGapMs=200, maxTracks=24, maxTrackAgeMs=10000}={}) {
    Object.assign(this,{cv,width,height,maxGapMs,maxTracks,maxTrackAgeMs});
    this.bufferSize=Math.max(1,Math.min(128,bufferSize));
    this.maxHistoryBytes=Math.max(0,Math.min(48*1024*1024,maxHistoryBytes));
    this.budgetEvicted=-1;this.rejects={};this.losses={};
    this.frames=[]; this.tracks=new Map(); this.events=[]; this.serial=0;
  }
  dispose() { for(const f of this.frames) f.gray.delete(); this.frames=[]; this.tracks.clear(); }
  snapshot() { return [...this.tracks.values()].map(t=>({id:t.id,label:t.label,box:[t.box[0]/this.width,t.box[1]/this.height,t.box[2]/this.width,t.box[3]/this.height],points:t.points.length,confidence:t.confidence})); }
  lose(t,reason,frameId) { this.losses[reason]=Math.min(1e9,(this.losses[reason]||0)+1);this.tracks.delete(t.id); this.events.push({id:t.id,reason,frameId}); if(this.events.length>128) this.events.splice(0,this.events.length-128); }
  push(imageData, frameId, timestampMs) {
    const cv=this.cv, rgba=cv.matFromImageData(imageData), gray=new cv.Mat();
    cv.cvtColor(rgba,gray,cv.COLOR_RGBA2GRAY); rgba.delete();
    const prev=this.frames.at(-1), next={gray,frameId,timestampMs};
    if(prev && (timestampMs<=prev.timestampMs || frameId<=prev.frameId)) { gray.delete(); throw Error('Frames must be monotonic'); }
    if(prev && timestampMs-prev.timestampMs>this.maxGapMs) for(const t of [...this.tracks.values()]) this.lose(t,'frame-gap',frameId);
    if(prev) this.advance(prev,next,[...this.tracks.values()]);
    this.frames.push(next);
    while(this.frames.length && (timestampMs-this.frames[0].timestampMs>=4000 || this.frames.length>this.bufferSize || this.frames.length*this.width*this.height>this.maxHistoryBytes)) {
      const expired=timestampMs-this.frames[0].timestampMs>=4000;
      const old=this.frames.shift();if(!expired)this.budgetEvicted=old.frameId;old.gray.delete();
    }
    next.tracks=this.snapshot();
    return next.tracks;
  }
  // normalized [x,y,width,height], stamped at *capture* frame; replay pixel evidence to latest frame.
  diagnostics() { return {historyFrames:this.frames.length,historyBytes:this.frames.length*this.width*this.height,historyMs:this.frames.length?this.frames.at(-1).timestampMs-this.frames[0].timestampMs:0,rejects:{...this.rejects},losses:{...this.losses}}; }
  counted(result) { for(const {reason} of result.rejected)this.rejects[reason]=Math.min(1e9,(this.rejects[reason]||0)+1);return result; }
  seed(frameId, detections) {
    const capture=this.frames.find(f=>f.frameId===frameId);
    if(!capture) return this.counted({accepted:[],rejected:detections.map(d=>({label:d.label,reason:frameId<=this.budgetEvicted?'capture-history-budget':'capture-frame-expired'})),replayMs:0});
    const trial=new PixelTracker(this.cv,this.width,this.height,{maxTracks:this.maxTracks,maxGapMs:this.maxGapMs,maxTrackAgeMs:this.maxTrackAgeMs});
    trial.frames=this.frames; trial.serial=this.serial;
    const result=trial.seedRaw(frameId,detections);this.serial=trial.serial;
    const overlap=(a,b)=>{const w=Math.max(0,Math.min(a[0]+a[2],b[0]+b[2])-Math.max(a[0],b[0])),h=Math.max(0,Math.min(a[1]+a[3],b[1]+b[3])-Math.max(a[1],b[1]));return w*h/(a[2]*a[3]+b[2]*b[3]-w*h);};
    const accepted=[];
    for(const t of trial.tracks.values()) {
      const d=detections.find(d=>d.label===t.label);
      const past=(capture.tracks||[]).find(p=>p.label===t.label&&overlap(p.box,d.box)>.2);
      const current=past&&this.tracks.get(past.id);
      if(past&&!current) {result.rejected.push({label:t.label,reason:'previous-track-lost'});continue;}
      const normalized=[t.box[0]/this.width,t.box[1]/this.height,t.box[2]/this.width,t.box[3]/this.height];
      if(current) {
        const b=[current.box[0]/this.width,current.box[1]/this.height,current.box[2]/this.width,current.box[3]/this.height];
        if(overlap(b,normalized)<=.2) {result.rejected.push({label:t.label,reason:'association-failed'});continue;}
        t.id=current.id;
      } else if([...this.tracks.values()].some(p=>p.label===t.label)||this.tracks.size>=this.maxTracks) {result.rejected.push({label:t.label,reason:'unassociated-or-capacity'});continue;}
      t.confidence=d.confidence;
      this.tracks.set(t.id,t);accepted.push(t.id);
      if(!past) (capture.tracks ||= []).push({id:t.id,label:t.label,box:d.box});
    }
    this.frames.at(-1).tracks=this.snapshot();
    return this.counted({...result,accepted});
  }
  seedRaw(frameId, detections) {
    const i=this.frames.findIndex(f=>f.frameId===frameId);
    if(i<0) return {accepted:[],rejected:detections.map(d=>({label:d.label,reason:'capture-frame-expired'})),replayMs:0};
    const start=performance.now(), accepted=[], rejected=[], fresh=[], cv=this.cv;
    for(const d of detections) {
      const b=d.box;
      if(!Array.isArray(b)||b.length!==4||!b.every(Number.isFinite)||b[0]<0||b[1]<0||b[2]<=0||b[3]<=0||b[0]+b[2]>1.000001||b[1]+b[3]>1.000001||this.tracks.size>=this.maxTracks) { rejected.push({label:d.label,reason:'invalid-box-or-capacity'}); continue; }
      const box=[b[0]*this.width,b[1]*this.height,b[2]*this.width,b[3]*this.height];
      // Interior only: OpenCV normalizes reversed rectangle endpoints, so reject tiny interiors first.
      const inset=Math.max(8,Math.min(box[2],box[3])*.15);
      const left=Math.max(0,Math.ceil(box[0]+inset)), top=Math.max(0,Math.ceil(box[1]+inset));
      const right=Math.min(this.width-1,Math.floor(box[0]+box[2]-inset)), bottom=Math.min(this.height-1,Math.floor(box[1]+box[3]-inset));
      if(left>=right||top>=bottom) { rejected.push({label:d.label,reason:'insufficient-texture'}); continue; }
      const mask=cv.Mat.zeros(this.height,this.width,cv.CV_8UC1), corners=new cv.Mat();
      cv.rectangle(mask,new cv.Point(left,top),new cv.Point(right,bottom),new cv.Scalar(255),-1);
      cv.goodFeaturesToTrack(this.frames[i].gray,corners,60,.02,4,mask,3,false,.04);
      const points=[]; for(let k=0;k<corners.rows;k++) {
        const x=corners.data32F[2*k], y=corners.data32F[2*k+1];
        if(x>box[0]&&y>box[1]&&x<box[0]+box[2]&&y<box[1]+box[3]&&x>0&&y>0&&x<this.width&&y<this.height) points.push([x,y]);
      }
      mask.delete(); corners.delete();
      if(points.length<6) { rejected.push({label:d.label,reason:'insufficient-texture'}); continue; }
      const t={id:`track-${++this.serial}`,label:d.label,box,points,seedTimestampMs:this.frames[i].timestampMs}; this.tracks.set(t.id,t); fresh.push(t); accepted.push(t.id);
    }
    for(let k=i+1;k<this.frames.length;k++) {
      const prev=this.frames[k-1], next=this.frames[k];
      if(next.timestampMs-prev.timestampMs>this.maxGapMs) for(const t of fresh.filter(t=>this.tracks.has(t.id))) this.lose(t,'replay-gap',next.frameId);
      this.advance(prev,next,fresh.filter(t=>this.tracks.has(t.id)));
      // Never publish an intermediate replay position as present-time evidence.
      // CPU budget is checked between indivisible OpenCV transitions.
      if(performance.now()-start>=2000) {
        for(const t of fresh.filter(t=>this.tracks.has(t.id)))this.lose(t,'replay-budget',next.frameId);
        break;
      }
    }
    for(const t of fresh)if(!this.tracks.has(t.id))rejected.push({label:t.label,reason:this.events.findLast(e=>e.id===t.id)?.reason||'pixel-evidence-lost'});
    return {accepted:accepted.filter(id=>this.tracks.has(id)),rejected,replayMs:performance.now()-start};
  }
  advance(prev,next,tracks) {
    tracks=tracks.filter(t=>{
      if(next.timestampMs-t.seedTimestampMs>this.maxTrackAgeMs) {this.lose(t,'revalidation-expired',next.frameId);return false;}
      return true;
    });
    if(!tracks.length) return;
    const cv=this.cv, coords=tracks.flatMap(t=>t.points.flat()), p=cv.matFromArray(coords.length/2,1,cv.CV_32FC2,coords);
    const q=new cv.Mat(), back=new cv.Mat(), s=new cv.Mat(), e=new cv.Mat(), bs=new cv.Mat(), be=new cv.Mat();
    const win=new cv.Size(21,21), criteria=new cv.TermCriteria(cv.TERM_CRITERIA_COUNT|cv.TERM_CRITERIA_EPS,30,.01);
    try {
      cv.calcOpticalFlowPyrLK(prev.gray,next.gray,p,q,s,e,win,3,criteria,0,1e-4);
      cv.calcOpticalFlowPyrLK(next.gray,prev.gray,q,back,bs,be,win,3,criteria,0,1e-4);
      let offset=0;
      for(const t of tracks) {
        let pairs=[];
        for(let j=0;j<t.points.length;j++) {
          const k=offset+j, a=t.points[j], b=[q.data32F[2*k],q.data32F[2*k+1]], r=[back.data32F[2*k],back.data32F[2*k+1]];
          if(s.data[k]&&bs.data[k]&&e.data32F[k]<18&&Math.hypot(a[0]-r[0],a[1]-r[1])<1&&b[0]>=3&&b[1]>=3&&b[0]<this.width-3&&b[1]<this.height-3) pairs.push({a,b});
        }
        offset+=t.points.length;
        if(pairs.length<6 || pairs.length/t.points.length<.45) { this.lose(t,'pixel-evidence-lost',next.frameId); continue; }
        // Robust median pairwise isotropic scale + median translation, then reject residual outliers.
        let scales=[];
        for(let a=0;a<pairs.length;a++) for(let b=a+1;b<pairs.length;b++) {
          const old=Math.hypot(pairs[a].a[0]-pairs[b].a[0],pairs[a].a[1]-pairs[b].a[1]);
          if(old>15) scales.push(Math.hypot(pairs[a].b[0]-pairs[b].b[0],pairs[a].b[1]-pairs[b].b[1])/old);
        }
        const scale=median(scales)||1;
        const tx=median(pairs.map(v=>v.b[0]-scale*v.a[0])), ty=median(pairs.map(v=>v.b[1]-scale*v.a[1]));
        pairs=pairs.filter(v=>Math.hypot(v.b[0]-(scale*v.a[0]+tx),v.b[1]-(scale*v.a[1]+ty))<2);
        if(pairs.length<6||scale<.9||scale>1.12) { this.lose(t,'incoherent-motion',next.frameId); continue; }
        t.box=[t.box[0]*scale+tx,t.box[1]*scale+ty,t.box[2]*scale,t.box[3]*scale];
        const [x,y,w,h]=t.box, visible=Math.max(0,Math.min(x+w,this.width)-Math.max(x,0))*Math.max(0,Math.min(y+h,this.height)-Math.max(y,0))/(w*h);
        if(visible<.6) { this.lose(t,'leaving-frame',next.frameId); continue; }
        t.points=pairs.map(v=>v.b);
      }
    } finally { for(const m of [p,q,back,s,e,bs,be]) m.delete(); }
  }
}
