import {GestureInput, INPUTS, HAND_LINKS, FACE, controls, activeControl} from './gestures.mjs';
import {GAMES, Session, COLORS, roundRect} from './mini-games.mjs';
import {GestureClient} from './gesture-client.mjs';
import {ActionAudio} from './action-audio.mjs';

const $=id=>document.getElementById(id);
const BEST_KEY='jev-live.controller.v1';
const SOUNDS={score:[880,60,1],bonus:[1175,70,2],hurt:[196,180,1],over:[147,260,2]};
const STALE_MS=700; // no tracker answer for this long counts as "player not seen"
const VFC_QUIET_MS=150; // no new-frame callback for this long → feed frames from the draw loop
const EMOJI='"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
const TIPS={
  hand:'Keep your whole hand in view, about an arm’s length from the camera.',
  head:'Sit facing the camera. Press Recenter if steering drifts.',
  pointer:'Click or tap the game first so it receives your keys.',
};

function loadBest() {
  try {const saved=JSON.parse(localStorage.getItem(BEST_KEY)||'{}');return saved?.version===1&&saved.best&&typeof saved.best==='object'?saved.best:{};}
  catch {return {};}
}
function saveBest(best) {try {localStorage.setItem(BEST_KEY,JSON.stringify({version:1,best}));} catch { /* storage is optional */ }}

// Controller workflow: camera → on-device hand/face landmarks → one controller
// state → mini-game. Frames never leave the device and no API key is used.
export class ControllerView {
  constructor() {
    this.video=$('video');this.stage=$('stage');this.canvas=$('game-canvas');this.ctx=null; // created on first use: other workflows never pay for it
    this.active=false;this.camera=false;this.raf=0;this.last=0;this.lastPanel=0;this.lastResult=0;
    this.mode=$('controller-input').value;this.input=new GestureInput(this.mode);this.pressLatch=false;
    this.tracker={state:'idle',message:''};
    this.pointer={x:.5,y:.5,down:false,pressed:false,keys:new Set()};
    this.session=new Session('catch');this.best=loadBest();this.audio=new ActionAudio();
    this.client=new GestureClient((points,handedness,now,world)=>this.result(points,now,world),(state,message)=>{this.tracker={state,message};this.panel(performance.now(),true);});
    this.legend=$('controller-legend');this.activeId=null;this.using='';
    this.wire();this.selectGame('catch');this.setMode(this.mode);
  }

  wire() {
    document.querySelectorAll('[data-game]').forEach(button=>button.addEventListener('click',()=>this.selectGame(button.dataset.game)));
    $('controller-input').addEventListener('change',()=>this.setMode($('controller-input').value));
    $('controller-sensitivity').addEventListener('input',()=>{this.input.sensitivity=Number($('controller-sensitivity').value);$('controller-sensitivity-value').textContent=`${Number($('controller-sensitivity').value).toFixed(1)}×`;});
    $('controller-recenter').addEventListener('click',()=>{this.input.recenter();this.announce(this.mode==='head'?'Look straight at the screen · recentering':'Hold your hand where it feels natural · recentering');});
    $('game-play').addEventListener('click',()=>this.playButton());
    $('game-sound').addEventListener('change',()=>this.audio.allow($('game-sound').checked));
    $('controller-show-camera').addEventListener('change',()=>this.stage.dataset.controllerCamera=$('controller-show-camera').checked?'shown':'hidden');
    const c=this.canvas;
    c.addEventListener('pointermove',event=>this.point(event));
    c.addEventListener('pointerdown',event=>{this.point(event);if(this.mode!=='pointer')return;c.focus({preventScroll:true});c.setPointerCapture?.(event.pointerId);this.pointer.down=true;this.pointer.pressed=true;event.preventDefault();});
    const up=()=>{this.pointer.down=false;};
    c.addEventListener('pointerup',up);c.addEventListener('pointercancel',up);
    c.addEventListener('keydown',event=>{
      if(this.mode!=='pointer')return;
      const key=event.key===' '?'Space':event.key;
      if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','a','d','w','s','Space','Enter'].includes(key)) {
        event.preventDefault();
        if((key==='Space'||key==='Enter')&&!event.repeat){this.pointer.down=true;this.pointer.pressed=true;}
        this.pointer.keys.add(key);
      }
    });
    c.addEventListener('keyup',event=>{const key=event.key===' '?'Space':event.key;this.pointer.keys.delete(key);if(key==='Space'||key==='Enter')this.pointer.down=false;});
    c.addEventListener('blur',()=>{this.pointer.keys.clear();this.pointer.down=false;});
    document.addEventListener('visibilitychange',()=>{if(document.hidden)this.session.pause('paused');});
  }
  point(event) {
    if(this.mode!=='pointer')return;
    const rect=this.canvas.getBoundingClientRect();
    this.pointer.x=Math.min(1,Math.max(0,(event.clientX-rect.left)/rect.width));
    this.pointer.y=Math.min(1,Math.max(0,(event.clientY-rect.top)/rect.height));
  }

  // ---- Workflow lifecycle (driven by app.js) ----
  activate(on) {
    if(on===this.active)return;
    this.active=on;this.canvas.hidden=!on;
    if(on) {
      this.ctx??=this.canvas.getContext('2d');
      this.stage.dataset.controller='on';this.stage.dataset.controllerCamera=$('controller-show-camera').checked?'shown':'hidden';
      this.last=performance.now();this.raf=requestAnimationFrame(t=>this.frame(t));this.panel(this.last,true);
    } else {
      delete this.stage.dataset.controller;delete this.stage.dataset.controllerCamera;
      cancelAnimationFrame(this.raf);this.raf=0;this.detach();this.session.pause('paused');
      for(const key of ['left','top','width','height','objectFit','inset'])this.video.style[key]='';
      this.videoLayout='';
    }
  }
  attach() {
    this.camera=true;this.watchFrames();
    if(this.mode!=='pointer')this.client.start(this.mode);
  }
  detach() {
    if(this.frameWatch&&this.video.cancelVideoFrameCallback)this.video.cancelVideoFrameCallback(this.frameWatch);
    this.frameWatch=0;this.framePending=false;
    this.camera=false;this.client.close();this.tracker={state:'idle',message:''};
    this.input.setMode(this.mode);this.pressLatch=false;
    if(this.mode!=='pointer')this.session.pause('lost');
  }
  setMode(mode) {
    this.mode=mode;this.input.setMode(mode);this.input.sensitivity=Number($('controller-sensitivity').value);this.pressLatch=false;
    this.canvas.dataset.input=mode;$('controller-recenter').disabled=mode==='pointer';
    $('controller-input-help').textContent=TIPS[mode];
    if(mode==='pointer'){this.client.close();this.tracker={state:'idle',message:''};}
    else if(this.camera)this.client.start(mode);
    this.session.select(this.session.Game.id);
    this.renderLegend();
    this.panel(performance.now(),true);
  }
  selectGame(id) {
    this.session.select(id);
    document.querySelectorAll('[data-game]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.game===this.session.Game.id)));
    $('game-help').textContent=this.session.Game.help;
    this.renderLegend();
    this.panel(performance.now(),true);
  }
  // The controls for this input and game, as a list the panel and canvas share.
  controls() {return controls(this.mode,this.session.Game.axes,this.session.Game.id==='pop'?'Pop · start':'Start · resume');}
  renderLegend() {
    if(!this.legend)return;
    this.legend.replaceChildren(...this.controls().map(c=>{
      const item=document.createElement('li');item.dataset.control=c.id;
      const icon=document.createElement('span');icon.className='legend-icon';icon.textContent=c.icon;icon.setAttribute('aria-hidden','true');
      const text=document.createElement('span');const b=document.createElement('b');b.textContent=c.gesture;const small=document.createElement('small');small.textContent=c.does;
      text.append(b,small);item.append(icon,text);return item;
    }));
    this.activeId=null;
  }
  // Light up the control the player is using now, so they see it register.
  highlight(id) {
    if(id===this.activeId||!this.legend)return;
    this.activeId=id;
    for(const item of this.legend.children)item.toggleAttribute('data-active',item.dataset.control===id);
  }
  playButton() {
    const s=this.session;
    if(s.state==='playing')s.pause('paused');
    else if(s.state==='paused')s.resume();
    else s.start();
    if(this.mode==='pointer')this.canvas.focus({preventScroll:true});
    this.panel(performance.now(),true);
  }

  // ---- Input ----
  result(points,now,world=null) {
    const state=this.input.update(points,now,world);
    this.lastResult=now;
    if(state.pressed)this.pressLatch=true; // consumed by exactly one game frame
    // A camera frame arrived while the tracker was busy: send it right away.
    if(this.framePending)this.sendFrame();
  }
  // Each new camera frame goes to the tracker as soon as it is shown, once.
  // The draw loop runs at screen rate (often 60 Hz) and would send the same
  // 30 Hz camera frame twice, making a fresh frame wait behind a duplicate.
  watchFrames() {
    const video=this.video;
    if(this.frameWatch||!video.requestVideoFrameCallback)return;
    const tick=()=>{this.frameWatch=video.requestVideoFrameCallback(tick);this.lastFrameCallback=performance.now();this.sendFrame();};
    this.frameWatch=video.requestVideoFrameCallback(tick);
  }
  sendFrame() {
    this.framePending=false;
    if(!this.camera||this.mode==='pointer'||document.hidden||this.video.readyState<2||!this.client.ready)return;
    if(this.client.busy){this.framePending=true;return;}
    this.client.push(this.video,performance.now());
  }
  current(now,dt) {
    if(this.mode==='pointer') {
      const p=this.pointer, speed=1.1*dt;
      if(p.keys.has('ArrowLeft')||p.keys.has('a'))p.x=Math.max(0,p.x-speed);
      if(p.keys.has('ArrowRight')||p.keys.has('d'))p.x=Math.min(1,p.x+speed);
      if(p.keys.has('ArrowUp')||p.keys.has('w'))p.y=Math.max(0,p.y-speed);
      if(p.keys.has('ArrowDown')||p.keys.has('s'))p.y=Math.min(1,p.y+speed);
      const pressed=p.pressed;p.pressed=false;
      return {present:true,x:p.x,y:p.y,action:p.down,pressed,pose:p.down?'pressed':'',detail:''};
    }
    const s=this.input.state, pressed=this.pressLatch;this.pressLatch=false;
    const seen=this.camera&&this.client.ready&&s.present&&now-this.lastResult<STALE_MS;
    return {...s,present:seen,pressed:seen&&pressed};
  }

  // ---- Loop ----
  frame(now) {
    if(!this.active)return;
    this.raf=requestAnimationFrame(t=>this.frame(t));
    const dt=Math.max(0,(now-this.last)/1000);this.last=now;
    // Fallback where new-frame callbacks are missing or paused (e.g. a hidden video).
    if(!(now-(this.lastFrameCallback||-Infinity)<VFC_QUIET_MS))this.sendFrame();
    this.resize();
    const input=this.current(now,dt), before=this.session.state;
    const events=this.session.update(dt,input);
    for(const event of events)if(SOUNDS[event])this.audio.beep(...SOUNDS[event]);
    if(this.session.state!==before)this.stateChanged(before);
    this.using=activeControl(this.mode,this.mode==='pointer'||this.camera&&this.client.ready?input:null);
    this.highlight(this.using);
    this.draw(input,now);
    this.panel(now);
  }
  stateChanged(before) {
    const s=this.session, game=s.game, id=s.Game.id;
    if(s.state==='playing'&&before!=='paused')this.announce(`${s.Game.title} started`);
    if(s.state==='over') {
      const record=game.score>(this.best[id]||0);
      if(record){this.best[id]=game.score;saveBest(this.best);}
      this.announce(`Game over · score ${game.score}${record?' · new best!':''}`);
    }
    if(s.state==='paused')this.announce(s.reason==='lost'?`Paused · ${INPUTS[this.mode].missing.toLowerCase()}`:'Paused');
    this.panel(performance.now(),true);
  }
  announce(text) {$('game-announce').textContent=text;}
  resize() {
    const rect=this.stage.getBoundingClientRect(), ratio=Math.min(2,window.devicePixelRatio||1);
    const w=Math.max(1,Math.round(rect.width*ratio)), h=Math.max(1,Math.round(rect.height*ratio));
    if(this.canvas.width!==w||this.canvas.height!==h){this.canvas.width=w;this.canvas.height=h;}
    this.width=rect.width;this.height=rect.height;this.ratio=ratio;
    this.session.resize(rect.width/Math.max(1,rect.height));
    // The camera fills the stage (cover), so the screen and the hand share one space.
    const vw=this.video.videoWidth, vh=this.video.videoHeight;
    if(vw&&vh&&rect.width&&rect.height) {
      const k=Math.max(rect.width/vw,rect.height/vh);
      this.input.setView(vw*k/rect.width,vh*k/rect.height);
    }
    this.layoutVideo();
  }
  // Camera point (mirrored, 0…1) → stage pixels. In hand mode this is exactly
  // the aim's mapping (reach, sensitivity and recenter included), so the aim,
  // the drawn landmarks and the camera picture all line up.
  toScreen(q) {
    if(this.mode==='hand'){const m=this.input.handMap(q);return [m.x*this.width,m.y*this.height];}
    const v=this.input.view;
    return [(.5+(q.x-.5)*v.x)*this.width,(.5+(q.y-.5)*v.y)*this.height];
  }
  // Place the (CSS-mirrored) video element with the same mapping. Only
  // rewritten when it changes: on resize, recenter or a sensitivity change.
  layoutVideo() {
    if(!this.video.videoWidth)return;
    const [left,top]=this.toScreen({x:0,y:0}), [right,bottom]=this.toScreen({x:1,y:1});
    const layout=[left,top,right-left,bottom-top].map(v=>v.toFixed(1)).join();
    if(layout===this.videoLayout)return;
    this.videoLayout=layout;
    Object.assign(this.video.style,{inset:'auto',left:`${left}px`,top:`${top}px`,width:`${right-left}px`,height:`${bottom-top}px`,objectFit:'fill'});
  }

  // ---- Drawing ----
  draw(input,now) {
    const ctx=this.ctx, w=this.width, h=this.height, s=this.session;
    ctx.setTransform(this.ratio,0,0,this.ratio,0,0);ctx.clearRect(0,0,w,h);
    ctx.fillStyle='#0b0f0d73';ctx.fillRect(0,0,w,h);
    if(this.mode!=='pointer'&&this.input.state.raw&&input.present)this.drawLandmarks(ctx);
    s.game.draw(ctx,h);
    this.drawHud(ctx,w,h);
    if(s.state!=='playing')this.drawOverlay(ctx,w,h,now);
    else this.drawLive(ctx,input,w);
    // One-axis games show position with their own piece; pointing games need a cursor.
    if(s.Game.axes==='xy'&&(input.present||this.mode==='pointer'))this.drawCursor(ctx,input,w,h);
  }
  drawLandmarks(ctx) {
    const p=this.input.state.raw, at=q=>this.toScreen(q);
    ctx.strokeStyle='#c5ed9666';ctx.fillStyle='#c5ed96aa';ctx.lineWidth=2;
    if(this.mode==='hand') {
      ctx.beginPath();for(const [a,b] of HAND_LINKS){ctx.moveTo(...at(p[a]));ctx.lineTo(...at(p[b]));}ctx.stroke();
      for(const q of p){const [x,y]=at(q);ctx.beginPath();ctx.arc(x,y,2.5,0,Math.PI*2);ctx.fill();}
    } else {
      for(const key of ['nose','eyeA','eyeB','lipTop','lipBottom']){const [x,y]=at(p[FACE[key]]);ctx.beginPath();ctx.arc(x,y,3,0,Math.PI*2);ctx.fill();}
    }
  }
  drawCursor(ctx,input,w,h) {
    const x=input.x*w, y=input.y*h;
    ctx.lineWidth=3;ctx.strokeStyle=COLORS.ACCENT;ctx.fillStyle=input.action?'#c5ed96cc':'#c5ed9633';
    ctx.beginPath();ctx.arc(x,y,input.action?12:16,0,Math.PI*2);ctx.fill();ctx.stroke();
  }
  drawHud(ctx,w,h) {
    const s=this.session, hud=s.game.hud(), size=Math.max(15,Math.min(26,h*.05));
    ctx.font=`650 ${size}px system-ui,sans-serif`;ctx.textBaseline='top';
    ctx.textAlign='left';ctx.fillStyle=COLORS.TEXT;ctx.fillText(`${hud.score}`,16,14);
    ctx.font=`500 ${size*.6}px system-ui,sans-serif`;ctx.fillStyle=COLORS.MUTED;ctx.fillText(`BEST ${this.best[s.Game.id]||0}`,16,16+size);
    ctx.textAlign='right';ctx.font=`600 ${size*.8}px system-ui,sans-serif`;ctx.fillStyle=COLORS.DANGER;ctx.fillText(hud.right,w-16,16);
    ctx.textBaseline='alphabetic';
  }
  drawOverlay(ctx,w,h,now) {
    const s=this.session, info=INPUTS[this.mode], lines=[];
    let title=s.Game.title;
    if(this.mode!=='pointer'&&!this.camera)lines.push('Start the camera to play with your '+(this.mode==='hand'?'hand':'head'),'or choose “Touch / mouse / keys” to play without it');
    else if(this.mode!=='pointer'&&this.tracker.state==='loading')lines.push(this.tracker.message,'First load downloads the model once');
    else if(this.tracker.state==='failed')lines.push(this.tracker.message,'Choose “Touch / mouse / keys” to play without the camera');
    else if(s.state==='paused'&&s.reason==='lost') {title='Paused';lines.push(this.input.state.present?'Found you · resuming…':info.missing);}
    else if(s.state==='paused'){title='Paused';lines.push(`${info.press} to resume`);}
    else if(s.state==='over'){title=`Game over · ${s.game.score}`;lines.push(s.game.score>=(this.best[s.Game.id]||0)&&s.game.score>0?'New best!':`Best ${this.best[s.Game.id]||0}`,`${info.press} to play again`);}
    else {lines.push(s.Game.help,`${info.move} to steer · ${info.press.toLowerCase()} to start`);if(this.mode!=='pointer'&&!this.input.state.present)lines.push(info.missing);}
    ctx.fillStyle='#0b0f0dc2';ctx.fillRect(0,0,w,h);
    ctx.textAlign='center';ctx.fillStyle=COLORS.ACCENT;
    const size=Math.max(18,Math.min(34,h*.07)), cards=this.controls(), cardH=Math.max(78,Math.min(118,h*.24));
    const showCards=h>=300&&w>=320;
    const top=showCards?Math.max(size+12,h*.5-(size*1.1+lines.length*size*.65+cardH)/2):h*.42;
    ctx.font=`650 ${size}px system-ui,sans-serif`;ctx.fillText(title,w/2,top);
    ctx.font=`450 ${Math.max(12,size*.48)}px system-ui,sans-serif`;ctx.fillStyle=COLORS.TEXT;
    let y=top+size*.9;
    for(const line of lines)y+=wrap(ctx,line,w/2,y,w*.86);
    if(showCards&&y+16+cardH<=h-8)this.drawCards(ctx,cards,w,y+16,cardH);
  }
  // Control cards: icon, gesture and what it does. The one in use lights up,
  // so players can try a pinch (or open their mouth) before starting.
  drawCards(ctx,cards,w,top,cardH) {
    const gap=12, cardW=Math.min(190,(w*.9-gap*(cards.length-1))/cards.length), total=cardW*cards.length+gap*(cards.length-1);
    let x=(w-total)/2;
    ctx.textAlign='center';
    for(const c of cards) {
      const on=c.id===this.using;
      roundRect(ctx,x,top,cardW,cardH,10);
      ctx.fillStyle=on?'#c5ed9633':'#ffffff10';ctx.fill();
      ctx.lineWidth=on?2.5:1;ctx.strokeStyle=on?COLORS.ACCENT:'#ffffff2e';ctx.stroke();
      const icon=Math.min(cardH*.34,34), cx=x+cardW/2;
      ctx.font=`${icon}px ${EMOJI}`;ctx.textBaseline='middle';ctx.fillStyle=COLORS.TEXT;ctx.fillText(c.icon,cx,top+cardH*.3);
      ctx.textBaseline='alphabetic';
      const label=Math.max(11,Math.min(15,cardH*.13));
      ctx.font=`650 ${label}px system-ui,sans-serif`;ctx.fillStyle=on?COLORS.ACCENT:COLORS.TEXT;fit(ctx,c.gesture,cx,top+cardH*.66,cardW-12);
      ctx.font=`450 ${label*.88}px system-ui,sans-serif`;ctx.fillStyle=COLORS.MUTED;fit(ctx,c.does,cx,top+cardH*.66+label*1.35,cardW-12);
      x+=cardW+gap;
    }
  }
  // While playing: a small pill at the top shows what the tracker sees and
  // whether the button is pressed.
  drawLive(ctx,input,w) {
    if(this.mode==='pointer')return; // the pointer is its own feedback
    const c=this.controls().find(item=>item.id===this.using);
    const text=c?`${c.gesture}${input.action?' · PRESS':''}`:INPUTS[this.mode].missing;
    ctx.font='600 13px system-ui,sans-serif';
    const iconW=c?22:0, pw=ctx.measureText(text).width+iconW+26, ph=28, x=(w-pw)/2, y=12;
    roundRect(ctx,x,y,pw,ph,ph/2);
    ctx.fillStyle=input.action?'#c5ed96d9':'#0b0f0dbf';ctx.fill();ctx.lineWidth=1;ctx.strokeStyle=c?COLORS.ACCENT:COLORS.DANGER;ctx.stroke();
    ctx.textBaseline='middle';ctx.textAlign='left';
    if(c){ctx.font=`15px ${EMOJI}`;ctx.fillText(c.icon,x+12,y+ph/2+1);}
    ctx.font='600 13px system-ui,sans-serif';ctx.fillStyle=input.action?'#0b0f0d':c?COLORS.TEXT:COLORS.DANGER;
    ctx.fillText(text,x+13+iconW,y+ph/2+1);
    ctx.textBaseline='alphabetic';
  }

  // ---- Side panel ----
  panel(now,force=false) {
    if(!force&&now-this.lastPanel<250)return;
    this.lastPanel=now;
    const s=this.session, info=INPUTS[this.mode], text=(id,value)=>{if($(id).textContent!==value)$(id).textContent=value;};
    text('game-play',s.state==='playing'?'Pause':s.state==='paused'?'Resume':s.state==='over'?'Play again':'Play');
    text('game-score',`Score ${s.game.score} · Best ${this.best[s.Game.id]||0}`);
    let state;
    if(this.mode==='pointer')state='Touch, mouse or keys · camera not needed';
    else if(!this.camera)state='Camera off · Start camera to use gestures';
    else if(this.tracker.state==='ready')state=`${this.tracker.message} · ${this.client.rate(now).toFixed(0)} fps · ${this.client.stats.latencyMs.toFixed(0)} ms delay`;
    else state=this.tracker.message||'Waiting for camera…';
    text('controller-state',state);
    const g=this.input.state;
    text('controller-readout',this.mode==='pointer'?`${info.move} · ${info.press.toLowerCase()} to press`:!this.camera||this.tracker.state!=='ready'?`${info.move} · ${info.press.toLowerCase()} to press`:g.present?`${info.name} seen · ${g.action?'PRESSED':'not pressed'}${g.pose?` · ${g.pose}`:''} · x ${g.x.toFixed(2)} y ${g.y.toFixed(2)}`:info.missing);
  }
}

function fit(ctx,text,x,y,max) {
  let t=text;
  while(t.length>3&&ctx.measureText(t).width>max)t=t.slice(0,-2)+'…';
  ctx.fillText(t,x,y);
}
function wrap(ctx,text,x,y,max) {
  const words=text.split(' ');let line='';const lines=[];
  for(const word of words){const next=line?`${line} ${word}`:word;if(ctx.measureText(next).width>max&&line){lines.push(line);line=word;}else line=next;}
  lines.push(line);
  const step=parseFloat(ctx.font.match(/(\d+(?:\.\d+)?)px/)?.[1]||'14')*1.35;
  lines.forEach((l,i)=>ctx.fillText(l,x,y+i*step));
  return lines.length*step;
}
export {GAMES};
