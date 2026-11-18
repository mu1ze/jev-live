// Turns hand or face landmarks into one game-controller state. Pure and
// deterministic: no DOM, so it is unit-tested in Node.
//
// Coordinates are MIRRORED (selfie view): x=0 is the left of the screen the
// player sees. Moving your hand or turning your head to your left moves left.

// Order matches FACE_POINTS in gesture-worker.mjs.
export const FACE={nose:0,eyeA:1,eyeB:2,cheekA:3,cheekB:4,forehead:5,chin:6,lipTop:7,lipBottom:8};
export const HAND_LINKS=[[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
export const INPUTS={
  hand:{name:'Hand',move:'Move your open hand',press:'Pinch or make a fist',missing:'Show one hand to the camera'},
  head:{name:'Head',move:'Turn or tilt your head',press:'Open your mouth',missing:'Face the camera'},
  pointer:{name:'Touch / mouse / keys',move:'Move the pointer or use arrow keys',press:'Click, tap or press Space',missing:''},
};

// Mirror flat [x,y,z,…] landmarks into screen coordinates.
export function points(flat) {
  const list=[];
  for(let i=0;i+2<flat.length;i+=3)list.push({x:1-flat[i],y:flat[i+1],z:flat[i+2]});
  return list;
}
const dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
const dist3=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,(a.z||0)-(b.z||0));
const clamp=(v,lo=0,hi=1)=>Math.min(hi,Math.max(lo,v));

// Hand pose from 21 landmarks: palm centre, index finger point, pinch ratio
// and finger extension.
// `world` (MediaPipe's metric 3D points) gives the hand's true shape, so a
// pinch or fist reads the same whether the hand is tilted, turned or near the
// frame edge; without it the image points are used.
export function readHand(p,world=null) {
  const shape=world||p, d=world?dist3:dist;
  const size=d(shape[0],shape[9])||1e-6;
  const extended=[[8,6],[12,10],[16,14],[20,18]].map(([tip,pip])=>d(shape[tip],shape[0])>d(shape[pip],shape[0])*1.12);
  const count=extended.filter(Boolean).length;
  const pinch=d(shape[4],shape[8])/size;
  // Palm centre is steady while the fingers pinch or curl.
  const palm={x:(p[0].x+p[5].x+p[9].x+p[17].x)/4,y:(p[0].y+p[5].y+p[9].y+p[17].y)/4};
  // Just below the index fingertip (part way to the last knuckle).
  const finger={x:p[8].x+(p[7].x-p[8].x)*FINGER_DROP,y:p[8].y+(p[7].y-p[8].y)*FINGER_DROP};
  const pose=count===0?'fist':count>=4?'open':extended[0]&&count===1?'point':extended[0]&&extended[1]&&count===2?'peace':'other';
  // How open the index finger is (thumb gap + reach from the wrist): it falls
  // as the hand pinches or closes, so a press can find where closing began.
  const spread=pinch+d(shape[8],shape[0])/size;
  return {palm,finger,pinch,pose,size,spread};
}

// Head pose from the face subset (fallback when the 3D pose is missing).
// Everything is measured against the eyes, cheeks and nose, never the chin or
// lips, so opening the mouth does not read as a nod. yaw/pitch are roughly
// radians (+ = toward screen right / down in the mirrored view), roll is
// radians, mouth is lip gap / outer-eye distance.
export function readHead(p) {
  const [left,right]=p[FACE.cheekA].x<p[FACE.cheekB].x?[p[FACE.cheekA],p[FACE.cheekB]]:[p[FACE.cheekB],p[FACE.cheekA]];
  const [eyeL,eyeR]=p[FACE.eyeA].x<p[FACE.eyeB].x?[p[FACE.eyeA],p[FACE.eyeB]]:[p[FACE.eyeB],p[FACE.eyeA]];
  const nose=p[FACE.nose], width=(right.x-left.x)||1e-6, eyes=dist(eyeL,eyeR)||1e-6;
  const eyeMid={x:(eyeL.x+eyeR.x)/2,y:(eyeL.y+eyeR.y)/2};
  return {
    yaw:((nose.x-left.x)/width-.5)*1.8,
    pitch:(nose.y-eyeMid.y)/eyes*1.5,
    roll:Math.atan2(eyeR.y-eyeL.y,eyeR.x-eyeL.x),
    mouth:dist(p[FACE.lipTop],p[FACE.lipBottom])/eyes,
    nose,
  };
}

// Head angles from MediaPipe's facial transformation matrix (column-major
// 4×4, camera space: x = image right, y = up, z = toward the camera) plus the
// jawOpen blendshape in pose[16]. The rotation is fitted mostly to the rigid
// parts of the face, so talking or opening the mouth barely moves it.
// yaw + = toward the mirrored screen's right, pitch + = looking down.
export function readHeadPose(pose) {
  const fx=pose[8], fy=pose[9], fz=pose[10]; // where the face points
  return {yaw:Math.atan2(-fx,fz),pitch:Math.atan2(-fy,Math.hypot(fx,fz)),jaw:pose[16]};
}

// One Euro filter: smooth when still, responsive when moving fast. A high
// beta keeps the aim within ~2% of the hand while moving and settles in ~30 ms
// when it stops (the old 0.9 trailed by ~7% and crept for ~130 ms).
export class OneEuro {
  constructor(minCutoff=1,beta=8,dCutoff=1) {Object.assign(this,{minCutoff,beta,dCutoff});this.reset();}
  reset() {this.x=null;this.dx=0;this.t=0;}
  static alpha(cutoff,dt) {const tau=1/(2*Math.PI*cutoff);return 1/(1+tau/dt);}
  filter(value,t) {
    if(this.x===null||t<=this.t){this.x=value;this.t=t;return value;}
    const dt=Math.min(.25,(t-this.t)/1000);this.t=t;
    const dx=(value-this.x)/dt;
    this.dx+=OneEuro.alpha(this.dCutoff,dt)*(dx-this.dx);
    this.x+=OneEuro.alpha(this.minCutoff+this.beta*Math.abs(this.dx),dt)*(value-this.x);
    return this.x;
  }
}

// Thresholds with hysteresis so a held gesture never flickers.
// Pinch is measured in 3D, so it can trigger just before the fingertips touch.
export const PINCH_ON=.36, PINCH_OFF=.5, MOUTH_ON=.25, MOUTH_OFF=.15;
// jawOpen blendshape: a smile showing teeth scores ~0.1–0.25, an open mouth 0.4+.
export const JAW_ON=.35, JAW_OFF=.22;
// Head angles (radians) that sweep the whole screen. Nodding has a smaller
// comfortable range than turning, so it gets a shorter span.
export const HEAD_SPAN={yaw:.7,roll:.8,pitch:.42};
// HAND_REACH: the aim sits on the hand as drawn on screen; a little extra reach
// means the screen edge is reached before the hand leaves the camera.
export const HAND_REACH=1.25;
// Finger aim sits this far from the index tip toward its last knuckle.
export const FINGER_DROP=.4;
const LOST_MS=400;
// A pinch or fist moves the hand's landmarks (the index finger most of all),
// so a press is aimed where the hand was before the gesture began: back past
// every frame where the finger was closing (up to PRESS_SEARCH_MS), and at
// least PRESS_LOOKBACK_MS back. The aim then holds still briefly.
const PRESS_LOOKBACK_MS=90, PRESS_SEARCH_MS=400, PRESS_HOLD_MS=140, CLOSING_STEP=.015;

export class GestureInput {
  constructor(mode='hand') {this.sensitivity=1;this.view={x:1,y:1};this.aim='palm';this.setMode(mode);}
  // What the hand aims with: 'palm' (steady, for steering games) or 'finger'
  // (just below the index tip, for pointing games). A recenter belongs to one
  // aim point, so changing it clears that.
  setAim(aim) {
    aim=aim==='finger'?'finger':'palm';
    if(aim===this.aim)return;
    this.aim=aim;this.fx=new OneEuro();this.fy=new OneEuro();this.history=[];
    if(this.mode==='hand')this.center=null;
  }
  // How the camera frame is scaled onto the screen (see handMap), so the aim
  // lands on the hand as drawn. 1,1 = the frame exactly fills the screen.
  setView(x,y) {this.view={x:x||1,y:y||1};}
  // Camera point (mirrored, 0…1) → screen point (0…1) for hand mode. The
  // controller view draws the camera and landmarks with this same mapping.
  handMap(q) {
    const c=this.center||{x:.5,y:.5}, g=HAND_REACH*this.sensitivity;
    return {x:.5+(q.x-c.x)*g*this.view.x,y:.5+(q.y-c.y)*g*this.view.y};
  }
  setMode(mode) {
    this.mode=mode;this.fx=new OneEuro();this.fy=new OneEuro();
    this.center=null;this.pressed=false;this.lastSeen=-Infinity;this.calibrating=mode==='head'?[]:null;
    this.history=[];this.holdUntil=-Infinity;
    this.state={present:false,x:.5,y:.5,action:false,pressed:false,released:false,pose:'',detail:'',raw:null};
    return this.state;
  }
  recenter() {this.center=null;this.calibrating=[];}
  // Feed one tracker result (null points = nothing found; world = optional
  // metric hand points). Returns the state.
  update(flat,now,world=null) {
    const was=this.pressed, s=this.state;
    s.pressed=s.released=false;
    if(!flat) {
      // Brief dropouts keep the last position; longer ones release the button.
      if(now-this.lastSeen>LOST_MS){s.present=false;this.pressed=false;s.action=false;s.released=was;s.pose='';}
      return s;
    }
    const p=points(flat);this.lastSeen=now;s.present=true;s.raw=p;
    let rx,ry,press,open;
    if(this.mode==='hand') {
      const h=readHand(p,world&&world.length>=63?points(world):null);
      const threshold=this.pressed?PINCH_OFF:PINCH_ON;
      press=h.pinch<threshold||h.pose==='fist';
      s.pose=press?(h.pose==='fist'?'fist':'pinch'):h.pose;
      const at=this.aim==='finger'?h.finger:h.palm;
      open=h.spread;
      if(this.calibrating){this.center={x:at.x,y:at.y};this.calibrating=null;}
      ({x:rx,y:ry}=this.handMap(at));
      s.detail=`pinch ${h.pinch.toFixed(2)} · ${h.pose}`;
    } else {
      const face=readHead(p), pose=world&&world.length>=17?readHeadPose(world):null;
      const h={yaw:pose?pose.yaw:face.yaw,pitch:pose?pose.pitch:face.pitch,roll:face.roll};
      press=pose?pose.jaw>(this.pressed?JAW_OFF:JAW_ON):face.mouth>(this.pressed?MOUTH_OFF:MOUTH_ON);open=null;
      s.pose=press?'mouth open':Math.abs(h.roll)>.3?(h.roll>0?'tilt right':'tilt left'):'';
      // The first few frames define "straight ahead" for this player.
      if(this.calibrating) {
        this.calibrating.push(h);
        if(this.calibrating.length>=6){const n=this.calibrating.length, mean=key=>this.calibrating.reduce((a,v)=>a+v[key],0)/n;this.center={yaw:mean('yaw'),pitch:mean('pitch'),roll:mean('roll')};this.calibrating=null;}
      }
      const c=this.center||h, k=this.sensitivity;
      // Turning and tilting both steer sideways, so either style works. All
      // angles are relative to the calibrated resting pose.
      rx=.5+((h.yaw-c.yaw)/HEAD_SPAN.yaw+(h.roll-c.roll)/HEAD_SPAN.roll)*k;
      ry=.5+(h.pitch-c.pitch)/HEAD_SPAN.pitch*k;
      const deg=v=>`${Math.round(v*180/Math.PI)}°`;
      s.detail=`turn ${deg(h.yaw-c.yaw)} · nod ${deg(h.pitch-c.pitch)} · ${pose?`jaw ${pose.jaw.toFixed(2)}`:`mouth ${face.mouth.toFixed(2)}`}`;
    }
    const fx=clamp(this.fx.filter(clamp(rx,-.2,1.2),now)), fy=clamp(this.fy.filter(clamp(ry,-.2,1.2),now));
    this.history.push({t:now,x:fx,y:fy,open});
    while(this.history.length>2&&now-this.history[1].t>PRESS_SEARCH_MS)this.history.shift();
    this.pressed=press;s.action=press;s.pressed=press&&!was;s.released=!press&&was;
    if(s.pressed) {
      // Aim the press where the hand was before the gesture started to move it.
      const h=this.history;let i=h.length-1,j=i;
      while(i>0&&h[i].open!=null&&h[i-1].open!=null&&h[i-1].open>h[i].open+CLOSING_STEP)i--;
      while(j>0&&now-h[j].t<PRESS_LOOKBACK_MS)j--;
      const before=h[Math.min(i,j)];
      s.x=before.x;s.y=before.y;this.holdUntil=now+PRESS_HOLD_MS;
    } else if(now>=this.holdUntil){s.x=fx;s.y=fy;}
    return s;
  }
}

// What each control does, for the on-screen guide. `axes` is the game's axes
// ('x', 'y' or 'xy') so steering is described the way this game uses it.
const STEER={x:'Move left / right',y:'Move up / down',xy:'Aim'};
export function controls(mode,axes='xy',pressUse='Start · resume',aim='palm') {
  const steer=STEER[axes]||STEER.xy;
  if(mode==='hand')return [
    aim==='finger'?{id:'steer',icon:'☝️',gesture:'Index finger',does:`${steer} · just below the tip`}:{id:'steer',icon:'✋',gesture:'Open hand',does:steer},
    {id:'pinch',icon:'🤏',gesture:'Pinch',does:pressUse},
    {id:'fist',icon:'✊',gesture:'Fist',does:pressUse},
  ];
  if(mode==='head')return [
    {id:'steer',icon:'🙂',gesture:axes==='y'?'Nod up / down':axes==='x'?'Turn or tilt':'Turn, tilt, nod',does:steer},
    {id:'mouth',icon:'😮',gesture:'Open mouth',does:pressUse},
    {id:'recenter',icon:'🎯',gesture:'Recenter button',does:'Reset the middle'},
  ];
  return [
    {id:'steer',icon:'🖱️',gesture:axes==='y'?'Pointer · ↑ ↓ · W S':axes==='x'?'Pointer · ← → · A D':'Pointer · arrows · WASD',does:steer},
    {id:'press',icon:'👆',gesture:'Click · tap · Space',does:pressUse},
  ];
}
// Which control the player is using right now ('' when nobody is seen).
export function activeControl(mode,state) {
  if(!state?.present)return '';
  if(mode==='hand')return state.action?(state.pose==='fist'?'fist':'pinch'):'steer';
  if(mode==='head')return state.action?'mouth':'steer';
  return state.action?'press':'steer';
}
