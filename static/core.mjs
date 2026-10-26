export function projectBox(box, sourceWidth, sourceHeight, viewWidth, viewHeight) {
  const scale = Math.min(viewWidth / sourceWidth, viewHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return {left:(viewWidth-width)/2 + box.left*width, top:(viewHeight-height)/2 + box.top*height,
    width:(box.right-box.left)*width, height:(box.bottom-box.top)*height};
}

export function snapshotSize(width, height) {
  if(!Number.isFinite(width) || !Number.isFinite(height) || width<=0 || height<=0) throw new Error('Invalid image dimensions.');
  const scale=Math.max(Math.min(1,640/Math.max(width,height)),280/Math.min(width,height));
  const result={width:Math.round(width*scale),height:Math.round(height*scale)};
  if(Math.max(result.width,result.height)>640) throw new Error('Image is too narrow. Crop it to a less extreme aspect ratio.');
  return result;
}

export class CompletionRate {
  constructor(windowMs=5000) { this.windowMs=windowMs; this.reset(0); }
  reset(now) { this.started=now; this.completed=[]; }
  record(now) { this.completed.push(now); }
  value(now) {
    this.completed=this.completed.filter(time=>time>now-this.windowMs);
    const elapsed=Math.min(this.windowMs,now-this.started);
    return elapsed>0?this.completed.length*1000/elapsed:0;
  }
}

export class FrameState {
  constructor(ttl=4000) { this.ttl=ttl; this.epoch=0; this.captured=0; this.items=[]; }
  reset() { this.epoch++; this.items=[]; this.captured=0; return this.epoch; }
  accept(epoch, items, captured, now) {
    if(epoch !== this.epoch || now-captured >= this.ttl) return false;
    this.items=items; this.captured=captured; return true;
  }
  liveVisible(now, threshold, tracks, lossCutoffs=new Map()) {
    const labels=new Set(tracks.map(t=>t.label));
    const snapshots=now-this.captured<350 ? this.visible(now,threshold).filter(d=>!labels.has(d.label)&&this.captured>(lossCutoffs.get(d.label)??-Infinity)) : [];
    return [...tracks,...snapshots];
  }
  visible(now, threshold) { return now-this.captured < this.ttl ? this.items.filter(d=>d.confidence >= threshold) : []; }
}
