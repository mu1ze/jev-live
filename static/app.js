import {CompletionRate, FrameState, projectBox, snapshotSize} from './core.mjs';
import {TrackingClient} from './tracking-client.mjs';

const $ = id => document.getElementById(id);
const video=$('video'), photo=$('photo'), stage=$('stage');
const frame=new FrameState(4000), rate=new CompletionRate(5000);
let running=false, pending=false, timer=null, stream=null, uploaded=null, photoURL=null;
let sourceWidth=1, sourceHeight=1, serverKey=false, lastCapture=null;
const boxNodes=new Map();
const tracking=new TrackingClient(()=>{if(running)render();});
let sampleTimer=null, lastSample=0, lastVideoFrame=-1, presentedFrame=0, videoCallback=null;
let lastTrackingCapture=null, qualityFrame=-1, qualityChanged=0;
// Prefer actual presented frames; older MediaStream implementations may expose
// no quality API, throw, or leave totalVideoFrames at zero indefinitely.
function watchVideo() {
  const source=stream;
  presentedFrame=0;qualityFrame=-1;qualityChanged=0;
  if(typeof video.requestVideoFrameCallback!=='function')return;
  const next=()=>{
    if(!running||source!==stream)return;
    presentedFrame++;sample();
    videoCallback=video.requestVideoFrameCallback(next);
  };
  videoCallback=video.requestVideoFrameCallback(next);
}
function videoFrame(now) {
  if(typeof video.requestVideoFrameCallback==='function')return presentedFrame||null;
  try {
    const count=video.getVideoPlaybackQuality?.().totalVideoFrames;
    if(Number.isFinite(count)&&count>0) {
      if(count!==qualityFrame){qualityFrame=count;qualityChanged=now;}
      if(now-qualityChanged<160)return `quality:${count}`;
    }
  } catch { /* Optional browser capability, not a camera failure. */ }
  return now-lastSample>=80?`time:${now}`:null;
}
function trackingFrame(now) {
  if(!tracking.ready)return null;
  const mediaFrame=videoFrame(now);
  if(mediaFrame!==null&&mediaFrame===lastVideoFrame)return now-lastSample<80?lastTrackingCapture:null;
  if(mediaFrame===null||tracking.busy||now-lastSample+1<tracking.sampleInterval())return null;
  const capture=tracking.push(snapshotCanvas,snapshotContext,now);
  if(capture){lastSample=now;lastVideoFrame=mediaFrame;lastTrackingCapture=capture;}
  return capture;
}
function text(id,value) { if($(id).textContent!==value) $(id).textContent=value; }
function style(node,key,value) { if(node.style[key]!==value) node.style[key]=value; }
let failures=0, retryAt=0;
function backoff() { failures=Math.min(failures+1,5); retryAt=performance.now()+Math.min(30000,3000*2**(failures-1)); }

function status(message, kind='') { text('status',message); const name=`state-badge ${kind}`; if($('badge').className!==name) $('badge').className=name; }
function liveStatus() {
  if(document.hidden) return;
  status('Camera live','live'); text('stage-note',`LIVE PREVIEW · ${tracking.state.toUpperCase()}`);
}
function clearBoxes() { frame.items=[]; for(const node of boxNodes.values()) node.remove(); boxNodes.clear(); text('count','0'); text('age','—'); text('results','No detections yet. Camera mode can track visually supported objects.'); }
function reset() { frame.reset();tracking.engaged=false;tracking.reset();lastVideoFrame=-1;lastTrackingCapture=null;lastSample=0; rate.reset(performance.now()); $('rate').textContent='0.0 /s'; clearBoxes(); clearTimeout(timer); timer=null; }
function fail(message) { clearBoxes(); $('error').textContent=message; $('error').hidden=false; status('Needs attention'); }
function clearError() { $('error').hidden=true; $('error').textContent=''; }
function credentials() {
  if(!$('key').value.trim() && !serverKey) throw new Error('Enter your TypeSafe API key first. It stays in memory only.');
  const labels=$('labels').value.split(',').map(s=>s.trim()).filter(Boolean);
  if(!labels.length || labels.length>24 || new Set(labels).size!==labels.length || labels.some(s=>! /^[\p{L}\p{N}_][\p{L}\p{N}_ .,'()/-]{0,79}$/u.test(s))) throw new Error('Choose 1–24 unique targets, up to 80 characters each. Use simple names without backticks.');
  return {key:$('key').value.trim(),labels};
}
function updateButtons() { $('start').disabled=running; $('analyze').disabled=!uploaded || pending || running; }
function stop() {
  if(videoCallback!==null)video.cancelVideoFrameCallback?.(videoCallback);
  videoCallback=null;
  running=false; clearInterval(sampleTimer);sampleTimer=null;tracking.close();reset(); $('results').setAttribute('aria-busy','false');
  if(stream) stream.getTracks().forEach(track=>track.stop());
  stream=null; video.srcObject=null;
  $('empty').hidden=!!uploaded; video.hidden=true; photo.hidden=!uploaded;
  if(uploaded) {sourceWidth=uploaded.width;sourceHeight=uploaded.height;$('source-label').textContent='STILL IMAGE';}
  $('stage-note').textContent='STOPPED · NO NEW FRAMES SENT';
  status('Stopped'); clearError(); updateButtons();
}
const snapshotCanvas=document.createElement('canvas');
const snapshotContext=snapshotCanvas.getContext('2d');
function snapshot(source,w,h) {
  drawSnapshot(source,w,h);
  return snapshotCanvas.toDataURL('image/jpeg',.82).split(',')[1];
}
function drawSnapshot(source,w,h) {
  const size=snapshotSize(w,h);
  if(snapshotCanvas.width!==size.width) snapshotCanvas.width=size.width;
  if(snapshotCanvas.height!==size.height) snapshotCanvas.height=size.height;
  snapshotContext.drawImage(source,0,0,size.width,size.height);
}
function sample() {
  if(!running||document.hidden||!tracking.ready||tracking.busy||video.readyState<2)return;
  const now=performance.now();
  if(now-lastSample+1<tracking.sampleInterval())return;
  try {drawSnapshot(video,video.videoWidth,video.videoHeight);trackingFrame(now);}
  catch {tracking.failure();}
}
function schedule() {
  clearTimeout(timer);
  if(running && stream && !pending && !document.hidden) {
    const elapsed=lastCapture===null?Infinity:performance.now()-lastCapture;
    timer=setTimeout(()=>detect(false),Math.max(0,Number($('cadence').value)-elapsed,retryAt-performance.now()));
  }
}
async function detect(single) {
  if(pending || (!single && (!running || document.hidden))) return;
  if(!single && performance.now()<retryAt) {schedule();return;}
  const epoch=frame.epoch;
  let payload,capture=null;
  try {
    payload=credentials();
    if(!single && video.readyState<2) { schedule(); return; }
    const source=single?photo:video;
    sourceWidth=single?photo.naturalWidth:video.videoWidth;
    sourceHeight=single?photo.naturalHeight:video.videoHeight;
    payload.image=snapshot(source,sourceWidth,sourceHeight); payload.format='jpg';
    if(!single)capture=trackingFrame(performance.now());
  } catch(e) { backoff(); fail(e.message); schedule(); return; }
  const captured=performance.now(); lastCapture=captured;
  pending=true; updateButtons(); clearError(); $('results').setAttribute('aria-busy','true');
  if(single) {status('Asking Jev…','busy');text('stage-note','ANALYZING SELECTED IMAGE');}
  else liveStatus();
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),28000);
  try {
    const response=await fetch('api/detect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:controller.signal,credentials:'same-origin',cache:'no-store'});
    const data=await response.json();
    if(!response.ok) throw new Error(data.error || 'Detection failed. Please try again.');
    if(!Array.isArray(data.detections)) throw new Error('Unexpected response from server.');
    failures=0; retryAt=0;
    if(epoch!==frame.epoch) return;
    const now=performance.now();
    if(!single) rate.record(now);
    $('latency').textContent=`${((now-captured)/1000).toFixed(2)} s`;
    if(frame.accept(epoch,data.detections,captured,now)) {
      if(!single)tracking.seed(capture,data.detections,Number($('confidence').value));
      if(single) {status('Image analyzed','live');text('stage-note','SNAPSHOT RESULT · EXPIRES 4s AFTER CAPTURE');}
      else liveStatus();
      render(true);
    } else {
      if(single||!tracking.current(now).length)clearBoxes();
      if(single) {status('Result too old');text('stage-note','RESULT EXPIRED · PREVIEW IS NOT TRACKING');}
    }
  } catch(e) {
    backoff();
    if(epoch===frame.epoch) {
      const message=e.name==='AbortError'?'Request timed out. Automatic retries are slowed down.':(e.message || 'Connection failed. Try again.');
      if(!single&&tracking.current(performance.now()).length){text('error',message);$('error').hidden=false;liveStatus();}
      else fail(message);
    }
  } finally {
    clearTimeout(timeout); payload.key=''; pending=false; $('results').setAttribute('aria-busy','false'); updateButtons();
    if(running) schedule();
  }
}
async function start() {
  try {credentials();} catch(e) {fail(e.message);return;}
  stop(); clearError(); running=true; const epoch=frame.epoch;
  status('Opening camera…','busy'); updateButtons();
  try {
    if(!navigator.mediaDevices?.getUserMedia) throw new Error('Camera requires HTTPS or localhost. You can use image upload instead.');
    const next=await navigator.mediaDevices.getUserMedia({video:{width:{ideal:1280},height:{ideal:720},facingMode:'environment'},audio:false});
    if(epoch!==frame.epoch || !running) {next.getTracks().forEach(t=>t.stop());return;}
    stream=next; video.srcObject=stream; video.hidden=false; photo.hidden=true; $('empty').hidden=true;
    await video.play();
    if(epoch!==frame.epoch || !running) return;
    $('source-label').textContent='LIVE CAMERA'; liveStatus();
    watchVideo();tracking.start();sampleTimer=setInterval(sample,20);
    stream.getVideoTracks()[0].addEventListener('ended',()=>{if(running){stop();fail('Camera disconnected. Reconnect and Start again.');}});
    detect(false);
  } catch(e) {
    if(epoch!==frame.epoch) return;
    stop(); fail(e.name==='NotAllowedError'?'Camera permission denied. Allow camera access or use an image.':e.name==='NotFoundError'?'No camera found. Choose an image below instead.':e.message);
  }
}
async function upload() {
  stop(); clearError(); const epoch=frame.epoch; const file=$('upload').files[0];
  uploaded=null; photo.hidden=true; $('empty').hidden=false; updateButtons();
  if(photoURL) {URL.revokeObjectURL(photoURL);photoURL=null;}
  if(!file) return;
  if(!['image/jpeg','image/png'].includes(file.type) || file.size>15*1024*1024) {fail('Choose a JPEG or PNG image up to 15 MiB.');return;}
  status('Preparing image…','busy');
  const url=URL.createObjectURL(file);
  try {
    const img=new Image(); img.src=url; await img.decode();
    if(epoch!==frame.epoch) return;
    if(img.naturalWidth<32 || img.naturalHeight<32 || img.naturalWidth*img.naturalHeight>40000000) throw new Error('Choose an image between 64 × 64 and 40 megapixels.');
    photo.src=url; await photo.decode();
    if(epoch!==frame.epoch) return;
    photoURL=url; uploaded={width:photo.naturalWidth,height:photo.naturalHeight};
    sourceWidth=uploaded.width; sourceHeight=uploaded.height;
    photo.hidden=false; video.hidden=true; $('empty').hidden=true;
    $('filename').textContent=file.name; $('source-label').textContent='STILL IMAGE';
    $('stage-note').textContent='LOCAL PREVIEW · NOT SENT'; status('Image ready'); updateButtons();
  } catch(e) {if(epoch===frame.epoch) fail(e.message || 'Could not decode that image.');}
  finally {if(photoURL!==url) URL.revokeObjectURL(url);}
}
function render() {
  const now=performance.now();
  const tracks=running&&!document.hidden?tracking.current(now):[];
  const items=running&&document.hidden?[]:tracks.length||running&&tracking.engaged&&tracking.ready?tracks:frame.visible(now,Number($('confidence').value));
  if(running&&!document.hidden)liveStatus();
  text('rate',`${rate.value(now).toFixed(1)} /s`);
  if($('tracking-details').parentElement.open) {
    const d=tracking.diagnostics(now), counts=c=>Object.entries(c).map(([k,v])=>`${k}: ${v}`).join(', ')||'none';
    text('tracking-diagnostics',`Local only · rolling 5s · since source reset\nsample ${d.sampleHz.toFixed(1)} Hz · complete ${d.completionHz.toFixed(1)} Hz\nworker ${d.processingMs.toFixed(1)} ms · replay ${d.replayMs.toFixed(1)} ms\ncadence ${d.intervalMs.toFixed(0)} ms · history ${(d.historyMs/1000).toFixed(2)} s / ${d.historyFrames} frames / ${(d.historyBytes/1048576).toFixed(1)} MiB\nseed rejects: ${counts(d.rejects)}\ntrack losses: ${counts(d.losses)}`);
  }
  const visible=new Set(items.map(d=>d.id||d.label));
  for(const [label,node] of boxNodes) {
    if(!visible.has(label)) {node.remove();boxNodes.delete(label);}
  }
  const rect=items.length?stage.getBoundingClientRect():null;
  for(const detection of items) {
    const key=detection.id||detection.label;
    let box=boxNodes.get(key);
    if(!box) {
      box=document.createElement('div'); box.className='box';
      const label=document.createElement('span'); label.className='box-label';
      box.append(label); boxNodes.set(key,box); $('boxes').append(box);
      if(detection.tracked)box.dataset.trackId=detection.id;
    }
    const dims=projectBox(detection.box,sourceWidth,sourceHeight,rect.width,rect.height);
    for(const [k,v] of Object.entries(dims)) style(box,k,`${v}px`);
    const label=box.firstChild;
    const caption=`${detection.label} · ${Math.round(detection.confidence*100)}% recognition${detection.tracked?' · pixel tracking':' · snapshot'}`;
    if(label.textContent!==caption) label.textContent=caption;
    style(label,'bottom',dims.top<27?'auto':''); style(label,'top',dims.top<27?'0px':'');
  }
  text('count',String(items.length));
  text('results',items.length?items.map(d=>`${d.label} · ${Math.round(d.confidence*100)}% recognition · ${d.tracked?'pixel tracking':'snapshot only'}`).join('   /   '):frame.captured?'No fresh detections above threshold.':'No detections yet. Camera mode can track visually supported objects.');
  if(frame.captured) {
    const age=now-frame.captured;
    text('age',age<frame.ttl?`${(age/1000).toFixed(1)} s`:'Expired');
    if(age>=frame.ttl && !pending && !running) text('stage-note','BOXES EXPIRED · NO TRACKING');
  }
}
$('tracking-details').parentElement.addEventListener('toggle',()=>render());
$('start').addEventListener('click',start);
$('stop').addEventListener('click',stop);
$('upload').addEventListener('change',upload);
$('analyze').addEventListener('click',()=>{if(!uploaded || pending || running)return;running=false;reset();clearError();detect(true);});
$('clear-key').addEventListener('click',()=>{stop();$('key').value='';status('Key cleared');});
$('key').addEventListener('input',()=>{stop();});
$('labels').addEventListener('input',()=>{
  if(running && !stream) {stop();status('Targets updated · Start camera');return;}
  reset();clearError();
  if(running){liveStatus();if(!pending)schedule();}
});
$('confidence').addEventListener('input',()=>{$('confidence-value').value=`${Math.round(Number($('confidence').value)*100)}%`;render(true);});
$('cadence').addEventListener('change',()=>{if(running && !pending)schedule();});
document.addEventListener('visibilitychange',()=>{
  clearTimeout(timer); timer=null;
  if(running) {
    if(document.hidden) {frame.reset();tracking.reset();clearBoxes();status('Paused · tab hidden');$('stage-note').textContent='TAB HIDDEN · NEW SNAPSHOTS PAUSED';}
    else {liveStatus();schedule();}
  }
});
window.addEventListener('pagehide',stop);
new ResizeObserver(()=>render(true)).observe(stage);
setInterval(()=>render(),100);
fetch('api/config',{credentials:'same-origin',cache:'no-store'}).then(r=>{if(!r.ok)throw new Error('Access denied. Reopen your private access link.');return r.json();}).then(config=>{serverKey=!!config.serverKeyConfigured;if(serverKey){$('key-hint').textContent='optional · server key configured';$('key').placeholder='Optional key override';$('key-status').textContent='Secure server key configured. No key needed here; it stays on the server.';$('key-status').classList.add('configured');}}).catch(e=>fail(e.message));
