import {CompletionRate, FrameState, projectBox, snapshotSize} from './core.mjs';

const $ = id => document.getElementById(id);
const video=$('video'), photo=$('photo'), stage=$('stage');
const frame=new FrameState(4000), rate=new CompletionRate(5000);
let running=false, pending=false, timer=null, stream=null, uploaded=null, photoURL=null;
let sourceWidth=1, sourceHeight=1, serverKey=false, lastRender='', lastCapture=null;
let failures=0, retryAt=0;
function backoff() { failures=Math.min(failures+1,5); retryAt=performance.now()+Math.min(30000,3000*2**(failures-1)); }

function status(text, kind='') { $('status').textContent=text; $('badge').className=`state-badge ${kind}`; }
function clearBoxes() { frame.items=[]; $('boxes').replaceChildren(); $('count').textContent='0'; lastRender=''; $('age').textContent='—'; $('results').textContent='No detections yet. Boxes are snapshots, not tracking.'; }
function reset() { frame.reset(); rate.reset(performance.now()); $('rate').textContent='0.0 /s'; clearBoxes(); clearTimeout(timer); timer=null; }
function fail(message) { clearBoxes(); $('error').textContent=message; $('error').hidden=false; status('Needs attention'); }
function clearError() { $('error').hidden=true; $('error').textContent=''; }
function credentials() {
  if(!$('key').value.trim() && !serverKey) throw new Error('Enter your TypeSafe API key first. It stays in memory only.');
  const labels=$('labels').value.split(',').map(s=>s.trim()).filter(Boolean);
  if(!labels.length || labels.length>8 || new Set(labels).size!==labels.length || labels.some(s=>! /^[\p{L}\p{N}_][\p{L}\p{N}_ .,'()/-]{0,79}$/u.test(s))) throw new Error('Choose 1–8 unique targets, up to 80 characters each. Use simple names without backticks.');
  return {key:$('key').value.trim(),labels};
}
function updateButtons() { $('start').disabled=running; $('analyze').disabled=!uploaded || pending || running; }
function stop() {
  running=false; reset();
  if(stream) stream.getTracks().forEach(track=>track.stop());
  stream=null; video.srcObject=null;
  $('empty').hidden=!!uploaded; video.hidden=true; photo.hidden=!uploaded;
  if(uploaded) {sourceWidth=uploaded.width;sourceHeight=uploaded.height;$('source-label').textContent='STILL IMAGE';}
  $('stage-note').textContent='STOPPED · NO NEW FRAMES SENT';
  status('Stopped'); clearError(); updateButtons();
}
function snapshot(source,w,h) {
  const size=snapshotSize(w,h);
  const canvas=document.createElement('canvas');
  canvas.width=size.width; canvas.height=size.height;
  canvas.getContext('2d').drawImage(source,0,0,canvas.width,canvas.height);
  return canvas.toDataURL('image/jpeg',.82).split(',')[1];
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
  let payload;
  try {
    payload=credentials();
    if(!single && video.readyState<2) { schedule(); return; }
    const source=single?photo:video;
    sourceWidth=single?photo.naturalWidth:video.videoWidth;
    sourceHeight=single?photo.naturalHeight:video.videoHeight;
    payload.image=snapshot(source,sourceWidth,sourceHeight); payload.format='jpg';
  } catch(e) { backoff(); fail(e.message); schedule(); return; }
  const captured=performance.now(); lastCapture=captured;
  pending=true; updateButtons(); clearError(); status('Asking Jev…','busy');
  $('stage-note').textContent=single?'ANALYZING SELECTED IMAGE':'LIVE PREVIEW · ANALYZING SNAPSHOT';
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
      status(single?'Image analyzed':'Camera live','live');
      $('stage-note').textContent='SNAPSHOT RESULT · EXPIRES 4s AFTER CAPTURE';
      render(true);
    } else {clearBoxes();status('Result too old');$('stage-note').textContent='RESULT EXPIRED · PREVIEW IS NOT TRACKING';}
  } catch(e) {
    backoff();
    if(epoch===frame.epoch) fail(e.name==='AbortError'?'Request timed out. Automatic retries are slowed down.':(e.message || 'Connection failed. Try again.'));
  } finally {
    clearTimeout(timeout); payload.key=''; pending=false; updateButtons();
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
    $('source-label').textContent='LIVE CAMERA'; status('Camera live','live');
    $('stage-note').textContent='LIVE PREVIEW · SNAPSHOT DETECTION';
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
function render(force=false) {
  const now=performance.now(); const items=frame.visible(now,Number($('confidence').value));
  $('rate').textContent=`${rate.value(now).toFixed(1)} /s`;
  const rect=stage.getBoundingClientRect();
  const signature=JSON.stringify([items,rect.width,rect.height]);
  if(force || signature!==lastRender) {
    lastRender=signature; $('boxes').replaceChildren();
    for(const detection of items) {
      const box=document.createElement('div'); box.className='box';
      const dims=projectBox(detection.box,sourceWidth,sourceHeight,rect.width,rect.height);
      for(const [k,v] of Object.entries(dims)) box.style[k]=`${v}px`;
      const label=document.createElement('span');label.className='box-label';
      label.textContent=`${detection.label} · ${Math.round(detection.confidence*100)}%`;
      if(dims.top<27) {label.style.bottom='auto';label.style.top='0';}
      box.append(label);$('boxes').append(box);
    }
    $('count').textContent=String(items.length);
    $('results').textContent=items.length?items.map(d=>`${d.label} · ${Math.round(d.confidence*100)}%`).join('   /   '):frame.captured?'No fresh detections above threshold.':'No detections yet. Boxes are snapshots, not tracking.';
  }
  if(frame.captured) {
    const age=now-frame.captured;
    $('age').textContent=age<frame.ttl?`${(age/1000).toFixed(1)} s`:'Expired';
    if(age>=frame.ttl && !pending) $('stage-note').textContent='BOXES EXPIRED · NO TRACKING';
  }
}
$('start').addEventListener('click',start);
$('stop').addEventListener('click',stop);
$('upload').addEventListener('change',upload);
$('analyze').addEventListener('click',()=>{if(!uploaded || pending || running)return;running=false;reset();clearError();detect(true);});
$('clear-key').addEventListener('click',()=>{stop();$('key').value='';status('Key cleared');});
$('key').addEventListener('input',()=>{stop();});
$('labels').addEventListener('input',()=>{
  if(running && !stream) {stop();status('Targets updated · Start camera');return;}
  reset();clearError();
  if(running){status(pending?'Waiting for previous request…':'Targets updated','live');if(!pending)schedule();}
});
$('confidence').addEventListener('input',()=>{$('confidence-value').value=`${Math.round(Number($('confidence').value)*100)}%`;render(true);});
$('cadence').addEventListener('change',()=>{if(running && !pending)schedule();});
document.addEventListener('visibilitychange',()=>{
  clearTimeout(timer); timer=null;
  if(running) {
    if(document.hidden) {status('Paused · tab hidden');$('stage-note').textContent='TAB HIDDEN · NEW SNAPSHOTS PAUSED';}
    else schedule();
  }
});
window.addEventListener('pagehide',stop);
new ResizeObserver(()=>render(true)).observe(stage);
setInterval(()=>render(),100);
fetch('api/config',{credentials:'same-origin',cache:'no-store'}).then(r=>{if(!r.ok)throw new Error('Access denied. Reopen your private access link.');return r.json();}).then(config=>{serverKey=!!config.serverKeyConfigured;if(serverKey){$('key-hint').textContent='optional · server key configured';$('key').placeholder='Optional key override';$('key-status').textContent='Secure server key configured. No key needed here; it stays on the server.';$('key-status').classList.add('configured');}}).catch(e=>fail(e.message));
