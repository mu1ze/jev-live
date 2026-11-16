import {parseHex, bluetoothUuid} from './custom-actions.mjs';

// Device integrations for custom-action steps. Every method resolves to '' on
// success or a short, human reason it could not run (shown in the event log),
// so an unsupported browser never throws into the recognition loop.
export class DeviceActions {
  constructor() {
    this.bluetooth=null;this.serialPort=null;this.serialWriter=null;this.midi=null;this.wake=null;this.wakeWanted=false;this.recordings=new Map();
  }
  support() {
    return {
      notifications:typeof Notification!=='undefined',
      bluetooth:!!navigator.bluetooth,
      serial:!!navigator.serial,
      midi:!!navigator.requestMIDIAccess,
      vibrate:typeof navigator.vibrate==='function',
      share:typeof navigator.share==='function',
      wakelock:!!navigator.wakeLock,
      record:typeof MediaRecorder!=='undefined',
      ios:/iP(hone|ad|od)/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1),
      standalone:matchMedia?.('(display-mode: standalone)').matches||navigator.standalone===true,
    };
  }

  // ---- Notifications ----
  notificationState() { return typeof Notification==='undefined'?'unsupported':Notification.permission; }
  registerWorker() {
    if(!('serviceWorker' in navigator))return Promise.resolve(null);
    return navigator.serviceWorker.register('sw.js').catch(()=>null);
  }
  // Must be called straight from a click/submit: browsers ignore prompts without a gesture.
  requestNotifications() {
    if(typeof Notification==='undefined')return Promise.resolve('unsupported');
    let request;
    if(Notification.permission==='default') {
      try {request=new Promise(resolve=>{const r=Notification.requestPermission(resolve);if(r?.then)r.then(resolve,()=>resolve(Notification.permission));});}
      catch {request=Promise.resolve(Notification.permission);}
    } else request=Promise.resolve(Notification.permission);
    this.registerWorker();
    return request;
  }
  async notify(title,body,tag,silent) {
    const state=this.notificationState();
    if(state==='unsupported')return this.support().ios?'iPhone/iPad only allow notifications in the home-screen app: Share → Add to Home Screen, then open it from the icon':'this browser has no notifications';
    if(state==='denied')return 'blocked for this site · allow notifications in the browser’s site settings';
    if(state!=='granted')return 'not allowed yet · tap “Allow notifications”';
    const options={body,tag,silent,icon:'icon.svg',badge:'icon.svg'};
    try {
      const registration=await navigator.serviceWorker?.getRegistration();
      if(registration?.active) {await registration.showNotification(title,options);return '';}
    } catch { /* fall back to the page constructor */ }
    try {new Notification(title,options);return '';}
    catch {
      // Android Chrome forbids the constructor; a service worker is required.
      try {
        await this.registerWorker();
        const registration=await navigator.serviceWorker.ready;
        await registration.showNotification(title,options);return '';
      } catch {return 'this browser could not show the notification';}
    }
  }

  // ---- Alerts ----
  vibrate(pattern) {
    if(typeof navigator.vibrate!=='function')return 'this device has no vibration API (iPhone and desktops cannot vibrate from a page)';
    return navigator.vibrate(pattern.split(',').map(n=>Number(n.trim())))?'':'vibration was blocked · tap the page once, then it can vibrate';
  }

  // ---- Apps & sharing ----
  async copy(text) {
    try {await navigator.clipboard.writeText(text);return '';}
    catch {return 'clipboard blocked · keep this tab focused (Safari also needs a tap)';}
  }
  async share(text) {
    if(typeof navigator.share!=='function')return (await this.copy(text))||'share sheet not available here · text copied instead';
    try {await navigator.share({text});return '';}
    catch(error) {return error?.name==='AbortError'?'share cancelled':'share sheet could not open';}
  }

  // ---- Camera ----
  frameSource() {
    const video=document.getElementById('video'), photo=document.getElementById('photo');
    if(video.srcObject&&video.readyState>=2&&video.videoWidth)return [video,video.videoWidth,video.videoHeight];
    if(!photo.hidden&&photo.complete&&photo.naturalWidth)return [photo,photo.naturalWidth,photo.naturalHeight];
    return null;
  }
  async snapshot(label) {
    const source=this.frameSource();
    if(!source)return 'no camera frame or image to save';
    const [node,width,height]=source, canvas=document.createElement('canvas');
    canvas.width=width;canvas.height=height;canvas.getContext('2d').drawImage(node,0,0,width,height);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.92));
    if(!blob)return 'could not encode the photo';
    download(blob,`jev-${slug(label)}-${stamp()}.jpg`);return '';
  }
  record(seconds,label,key) {
    const stream=document.getElementById('video').srcObject;
    if(typeof MediaRecorder==='undefined')return Promise.resolve('this browser cannot record video');
    if(!stream?.active)return Promise.resolve('camera is off · start the camera to record');
    if(this.recordings.has(key))return Promise.resolve('already recording for this step');
    const type=['video/mp4;codecs=avc1','video/mp4','video/webm;codecs=vp9','video/webm'].find(t=>MediaRecorder.isTypeSupported?.(t))||'';
    let recorder;
    try {recorder=new MediaRecorder(stream,type?{mimeType:type}:undefined);} catch {return Promise.resolve('this browser cannot record this camera');}
    const chunks=[];
    return new Promise(resolve=>{
      recorder.ondataavailable=event=>{if(event.data?.size)chunks.push(event.data);};
      recorder.onstop=()=>{
        clearTimeout(timer);this.recordings.delete(key);
        if(!chunks.length){resolve('recording stopped before any video was captured');return;}
        const mime=recorder.mimeType||type||'video/webm';
        download(new Blob(chunks,{type:mime}),`jev-${slug(label)}-${stamp()}.${mime.includes('mp4')?'mp4':'webm'}`);resolve('');
      };
      const timer=setTimeout(()=>{if(recorder.state!=='inactive')recorder.stop();},seconds*1000);
      this.recordings.set(key,recorder);
      recorder.start(1000);
    });
  }
  stopRecordings() { for(const recorder of this.recordings.values())if(recorder.state!=='inactive')recorder.stop(); }

  // ---- Screen ----
  async keepAwake(wanted) {
    this.wakeWanted=wanted;
    if(!navigator.wakeLock)return wanted?'keep-awake not supported in this browser':'';
    if(wanted&&!this.wake) {
      try {
        const lock=await navigator.wakeLock.request('screen');
        if(!this.wakeWanted){lock.release();return '';}
        this.wake=lock;lock.addEventListener('release',()=>{if(this.wake===lock)this.wake=null;});
      } catch {return 'the screen wake lock was refused';}
    }
    if(!wanted&&this.wake){const lock=this.wake;this.wake=null;lock.release().catch(()=>{});}
    return '';
  }

  // ---- Hardware (Chromium: Web Bluetooth, Web Serial; most browsers: Web MIDI) ----
  async pairBluetooth(services) {
    if(!navigator.bluetooth)return {error:'Web Bluetooth needs Chrome or Edge on desktop/Android'};
    try {
      const device=await navigator.bluetooth.requestDevice({acceptAllDevices:true,optionalServices:services.map(bluetoothUuid)});
      if(this.bluetooth?.gatt?.connected)this.bluetooth.gatt.disconnect();
      this.bluetooth=device;return {name:device.name||'Unnamed device'};
    } catch(error) {return {error:error?.name==='NotFoundError'?'no device chosen':'pairing failed'};}
  }
  async bluetoothWrite(service,characteristic,hex) {
    if(!this.bluetooth)return 'pair a Bluetooth device first (Device connections)';
    try {
      const server=this.bluetooth.gatt.connected?this.bluetooth.gatt:await this.bluetooth.gatt.connect();
      const target=await (await server.getPrimaryService(bluetoothUuid(service))).getCharacteristic(bluetoothUuid(characteristic));
      const data=new Uint8Array(parseHex(hex));
      if(target.properties?.writeWithoutResponse&&target.writeValueWithoutResponse)await target.writeValueWithoutResponse(data);
      else if(target.writeValueWithResponse)await target.writeValueWithResponse(data);
      else await target.writeValue(data);
      return '';
    } catch(error) {return error?.name==='SecurityError'?'that service was not allowed · pair again after saving the action':'could not write to the device · is it in range and is the UUID right?';}
  }
  async pairSerial(baudRate) {
    if(!navigator.serial)return {error:'Web Serial needs Chrome or Edge on a desktop'};
    try {
      const port=await navigator.serial.requestPort();
      await this.closeSerial();
      await port.open({baudRate});
      this.serialPort=port;this.serialWriter=port.writable.getWriter();
      const info=port.getInfo?.()||{};
      return {name:info.usbProductId?`USB ${info.usbVendorId.toString(16)}:${info.usbProductId.toString(16)}`:'serial port'};
    } catch(error) {return {error:error?.name==='NotFoundError'?'no port chosen':'could not open the port · is another app using it?'};}
  }
  async closeSerial() {
    const port=this.serialPort, writer=this.serialWriter;this.serialPort=this.serialWriter=null;
    try {writer?.releaseLock();await port?.close();} catch { /* already closed */ }
  }
  async serialWrite(text) {
    if(!this.serialWriter)return 'connect a serial device first (Device connections)';
    try {await this.serialWriter.write(new TextEncoder().encode(text));return '';}
    catch {this.closeSerial();return 'the serial device disconnected';}
  }
  async enableMidi() {
    if(!navigator.requestMIDIAccess)return {error:'Web MIDI is not available in this browser'};
    try {this.midi=await navigator.requestMIDIAccess();return {outputs:[...this.midi.outputs.values()].map(o=>o.name||'MIDI output')};}
    catch {return {error:'MIDI access was refused'};}
  }
  midiSend(hex) {
    if(!this.midi)return 'enable MIDI first (Device connections)';
    const outputs=[...this.midi.outputs.values()];
    if(!outputs.length)return 'no MIDI outputs found';
    try {for(const output of outputs)output.send(parseHex(hex));return '';} catch {return 'MIDI message was rejected';}
  }
}

function slug(label) { return String(label).replace(/[^\p{L}\p{N}]+/gu,'-').replace(/^-|-$/g,'').slice(0,40)||'capture'; }
function stamp() { return new Date().toISOString().replace(/[:.]/g,'-').slice(0,19); }
function download(blob,name) {
  const link=document.createElement('a'), url=URL.createObjectURL(blob);
  link.href=url;link.download=name;link.hidden=true;document.body.append(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),30000);
}
