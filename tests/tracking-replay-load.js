async () => {
  const w=new Worker('tracking-worker.js');
  await new Promise(r=>w.onmessage=e=>{if(e.data.type==='ready')r()});
  const command=m=>new Promise(resolve=>{w.onmessage=e=>resolve(e.data);w.postMessage(m)});
  const c=document.createElement('canvas');c.width=640;c.height=480;const ctx=c.getContext('2d');
  const tile=document.createElement('canvas');tile.width=48;tile.height=48;const tx=tile.getContext('2d');let s=42;
  for(let y=0;y<48;y+=2)for(let x=0;x<48;x+=2){s=(s*1664525+1013904223)>>>0;tx.fillStyle=`rgb(${s&255},${s>>>8&255},${s>>>16&255})`;tx.fillRect(x,y,2,2)}
  const seeds=id=>Array.from({length:24},(_,i)=>({label:`fixture ${i}`,confidence:.9,box:[(i%8*80+16+(i%2?-1:1)*id*.25)/640,(Math.floor(i/8)*160+40)/480,48/640,.1]}));
  const frame=async id=>{ctx.fillStyle='#222';ctx.fillRect(0,0,640,480);for(const d of seeds(id))ctx.drawImage(tile,d.box[0]*640,d.box[1]*480);return command({type:'frame',generation:1,frameId:id,timestamp:id*100/3,width:640,height:480,pixels:ctx.getImageData(0,0,640,480).data.buffer})};
  try {
    for(let i=0;i<=75;i++)await frame(i);
    const delayed=await command({type:'seed',generation:1,frameId:0,detections:seeds(0)});
    const fresh=await command({type:'seed',generation:1,frameId:75,detections:seeds(75)});
    const runs=[];for(let i=76;i<=90;i++)runs.push(await frame(i));
    const times=runs.map(r=>r.processingMs).sort((a,b)=>a-b);
    return {delayed,freshTracks:fresh.tracks.length,continued:runs.at(-1).tracks.length,medianMs:times[7],p95Ms:times[14]};
  } finally {w.terminate()}
}
