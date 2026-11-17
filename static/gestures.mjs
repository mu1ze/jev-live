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
const clamp=(v,lo=0,hi=1)=>Math.min(hi,Math.max(lo,v));

// Hand pose from 21 landmarks: palm centre, pinch ratio and finger extension.
export function readHand(p) {
  const size=dist(p[0],p[9])||1e-6;
  const extended=[[8,6],[12,10],[16,14],[20,18]].map(([tip,pip])=>dist(p[tip],p[0])>dist(p[pip],p[0])*1.12);
  const count=extended.filter(Boolean).length;
  const pinch=dist(p[4],p[8])/size;
  // Palm centre is steady while the fingers pinch or curl.
  const palm={x:(p[0].x+p[5].x+p[9].x+p[17].x)/4,y:(p[0].y+p[5].y+p[9].y+p[17].y)/4};
  const pose=count===0?'fist':count>=4?'open':extended[0]&&count===1?'point':extended[0]&&extended[1]&&count===2?'peace':'other';
  return {palm,pinch,pose,size};
}

// Head pose from the face subset: yaw/pitch are ~-1…1 (nose position inside
// the face box), roll is radians, mouth is lip gap / face height.
export function readHead(p) {
  const [left,right]=p[FACE.cheekA].x<p[FACE.cheekB].x?[p[FACE.cheekA],p[FACE.cheekB]]:[p[FACE.cheekB],p[FACE.cheekA]];
  const [eyeL,eyeR]=p[FACE.eyeA].x<p[FACE.eyeB].x?[p[FACE.eyeA],p[FACE.eyeB]]:[p[FACE.eyeB],p[FACE.eyeA]];
  const nose=p[FACE.nose], top=p[FACE.forehead], chin=p[FACE.chin];
  const width=(right.x-left.x)||1e-6, height=(chin.y-top.y)||1e-6;
  return {
    yaw:((nose.x-left.x)/width-.5)*2,
    pitch:((nose.y-top.y)/height-.5)*2,
    roll:Math.atan2(eyeR.y-eyeL.y,eyeR.x-eyeL.x),
    mouth:dist(p[FACE.lipTop],p[FACE.lipBottom])/height,
    nose,
  };
}

// One Euro filter: smooth when still, responsive when moving fast.
export class OneEuro {
  constructor(minCutoff=1.4,beta=.9,dCutoff=1) {Object.assign(this,{minCutoff,beta,dCutoff});this.reset();}
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
export const PINCH_ON=.32, PINCH_OFF=.48, MOUTH_ON=.085, MOUTH_OFF=.055;
const HEAD_GAIN=2.6, HAND_GAIN=1.7, LOST_MS=400;

export class GestureInput {
  constructor(mode='hand') {this.sensitivity=1;this.setMode(mode);}
  setMode(mode) {
    this.mode=mode;this.fx=new OneEuro();this.fy=new OneEuro();
    this.center=null;this.pressed=false;this.lastSeen=-Infinity;this.calibrating=mode==='head'?[]:null;
    this.state={present:false,x:.5,y:.5,action:false,pressed:false,released:false,pose:'',detail:'',raw:null};
    return this.state;
  }
  recenter() {this.center=null;this.calibrating=[];}
  // Feed one tracker result (null points = nothing found). Returns the state.
  update(flat,now) {
    const was=this.pressed, s=this.state;
    s.pressed=s.released=false;
    if(!flat) {
      // Brief dropouts keep the last position; longer ones release the button.
      if(now-this.lastSeen>LOST_MS){s.present=false;this.pressed=false;s.action=false;s.released=was;s.pose='';}
      return s;
    }
    const p=points(flat);this.lastSeen=now;s.present=true;s.raw=p;
    let rx,ry,press;
    if(this.mode==='hand') {
      const h=readHand(p);
      const threshold=this.pressed?PINCH_OFF:PINCH_ON;
      press=h.pinch<threshold||h.pose==='fist';
      s.pose=press?(h.pose==='fist'?'fist':'pinch'):h.pose;
      rx=h.palm.x;ry=h.palm.y;
      if(this.calibrating){this.center={x:rx,y:ry};this.calibrating=null;}
      const c=this.center||{x:.5,y:.5}, gain=HAND_GAIN*this.sensitivity;
      rx=.5+(rx-c.x)*gain;ry=.5+(ry-c.y)*gain;
      s.detail=`pinch ${h.pinch.toFixed(2)} · ${h.pose}`;
    } else {
      const h=readHead(p);
      press=h.mouth>(this.pressed?MOUTH_OFF:MOUTH_ON);
      s.pose=press?'mouth open':Math.abs(h.roll)>.3?(h.roll>0?'tilt right':'tilt left'):'';
      // The first few frames define "straight ahead" for this player.
      if(this.calibrating) {
        this.calibrating.push(h);
        if(this.calibrating.length>=6){const n=this.calibrating.length;this.center={x:this.calibrating.reduce((a,v)=>a+v.yaw,0)/n,y:this.calibrating.reduce((a,v)=>a+v.pitch,0)/n};this.calibrating=null;}
      }
      const c=this.center||{x:h.yaw,y:h.pitch}, gain=HEAD_GAIN*this.sensitivity;
      // Turning and tilting both steer sideways, so either style works.
      rx=.5+((h.yaw-c.x)*.5+h.roll*.6)*gain;ry=.5+(h.pitch-c.y)*.5*gain;
      s.detail=`yaw ${h.yaw.toFixed(2)} · pitch ${h.pitch.toFixed(2)} · mouth ${h.mouth.toFixed(3)}`;
    }
    s.x=clamp(this.fx.filter(clamp(rx,-.2,1.2),now));s.y=clamp(this.fy.filter(clamp(ry,-.2,1.2),now));
    this.pressed=press;s.action=press;s.pressed=press&&!was;s.released=!press&&was;
    return s;
  }
}

// What each control does, for the on-screen guide. `axes` is the game's axes
// ('x', 'y' or 'xy') so steering is described the way this game uses it.
const STEER={x:'Move left / right',y:'Move up / down',xy:'Aim'};
export function controls(mode,axes='xy',pressUse='Start · resume') {
  const steer=STEER[axes]||STEER.xy;
  if(mode==='hand')return [
    {id:'steer',icon:'✋',gesture:'Open hand',does:steer},
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
