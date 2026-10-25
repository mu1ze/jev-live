async () => {
  // Synthetic pixels/ground truth live only in this fixture, never in tracker updates.
  const w=new Worker('tracking-worker.js');
  await new Promise(r=>w.onmessage=e=>{if(e.data.type==='ready')r()});
  const command=m=>new Promise(resolve=>{w.onmessage=e=>resolve(e.data);w.postMessage(m)});
  const c=document.createElement('canvas');c.width=360;c.height=320;const ctx=c.getContext('2d');
  const tiles=[42,991].map(state=>{const t=document.createElement('canvas');t.width=80;t.height=80;const tx=t.getContext('2d');for(let y=0;y<80;y+=2)for(let x=0;x<80;x+=2){state=(state*1664525+1013904223)>>>0;tx.fillStyle=`rgb(${state&255},${state>>>8&255},${state>>>16&255})`;tx.fillRect(x,y,2,2)}return t});
  const iou=(a,b)=>{if(!a)return 0;const area=v=>v[2]*v[3],w=Math.max(0,Math.min(a[0]+a[2],b[0]+b[2])-Math.max(a[0],b[0])),h=Math.max(0,Math.min(a[1]+a[3],b[1]+b[3])-Math.max(a[1],b[1]));return w*h/(area(a)+area(b)-w*h)};
  const results={};
  try {
    for(const mode of ['blur','partial','crossing','fast','removed']) {
      w.postMessage({type:'reset'});
      const box=(i,j=0)=>[(j?260-i*5:mode==='fast'?40+(i*16%384<=192?i*16%384:384-i*16%384):40+i*(mode==='crossing'?5:2))/360,120/320,80/360,.25];
      const count=mode==='crossing'?2:1;
      const detections=i=>Array.from({length:count},(_,j)=>({label:`fixture-${j}`,confidence:.9,box:box(i,j)}));
      const frame=async i=>{
        ctx.fillStyle='#222';ctx.fillRect(0,0,360,320);
        if(mode!=='removed'||i<12||i>=20)for(let j=0;j<count;j++){
          const b=box(i,j);ctx.filter=mode==='blur'&&i>=12&&i<20?'blur(6px)':'none';ctx.drawImage(tiles[j],b[0]*360,120);ctx.filter='none';
          if(mode==='partial'&&i>=12&&i<20){ctx.fillStyle='#222';ctx.fillRect(b[0]*360,120,48,80)}
        }
        return command({type:'frame',generation:1,frameId:i,timestamp:i*50,width:360,height:320,pixels:ctx.getImageData(0,0,360,320).data.buffer});
      };
      await frame(0);
      const initial=await command({type:'seed',generation:1,frameId:0,detections:detections(0)});
      let supported=0,eligible=0,survived=0,sum=0,lossFrames=0,phantomFrames=0,switches=0,firstLoss=null,firstReacquired=null,stale=null,fresh=null,latest;
      const previous=new Map(initial.tracks.map(t=>[t.label,t.id]));
      for(let i=1;i<=40;i++) {
        latest=await frame(i);
        if(mode==='removed'&&i===24){stale=await command({type:'seed',generation:1,frameId:0,detections:detections(0)});fresh=await command({type:'seed',generation:1,frameId:20,detections:detections(20)});latest=fresh;}
        if(latest.tracks.length<count){lossFrames++;firstLoss??=i*50;}
        if(mode==='removed'&&i>=20&&latest.tracks.length)firstReacquired??=i*50;
        if(mode==='removed'&&i>=12&&i<20){if(latest.tracks.length)phantomFrames++;continue;}
        for(let j=0;j<count;j++) {
          eligible++;const t=latest.tracks.find(t=>t.label===`fixture-${j}`),v=iou(t?.box,box(i,j));
          if(v>=.5)supported++;if(t){survived++;sum+=v;if(previous.has(t.label)&&previous.get(t.label)!==t.id)switches++;previous.set(t.label,t.id);}
        }
      }
      const refresh=mode==='removed'?null:await command({type:'seed',generation:1,frameId:36,detections:detections(36)});
      results[mode]={refreshTracks:refresh?.tracks.length,refreshReplayMs:refresh?.seedResult?.replayMs,coverage:supported/eligible,meanIoU:sum/eligible,survivorIoU:survived?sum/survived:0,eligible,lossFrames,phantomFrames,firstLossMs:firstLoss,identityChanges:switches,reacquisitionMs:firstReacquired===null?null:firstReacquired-1000,initial:initial.tracks.length,staleTracks:stale?.tracks.length,freshTracks:fresh?.tracks.length,newIdentity:fresh?fresh.tracks[0]?.id!==initial.tracks[0]?.id:null,diagnostics:latest.diagnostics,staleRejects:stale?.seedResult?.rejected};
    }
    return results;
  } finally {w.terminate()}
}
