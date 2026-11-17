import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {points, readHand, readHead, readHeadPose, GestureInput, OneEuro, FACE, PINCH_ON, PINCH_OFF, JAW_ON, HEAD_SPAN, HAND_REACH, controls, activeControl} from '../static/gestures.mjs';
import {Session, StarCatch, CaveGlide, BubblePop, GAMES, rng} from '../static/mini-games.mjs';

// Real MediaPipe output for tests/fixtures/hand-thumb-up.jpg (image coordinates).
const thumbUp=JSON.parse(readFileSync(new URL('./fixtures/hand-thumb-up.landmarks.json',import.meta.url)));
// The same photo's metric 3D points (worldLandmarks), from the real model.
const thumbUpWorld=Float32Array.from(JSON.parse(readFileSync(new URL('./fixtures/hand-thumb-up.world.json',import.meta.url))));

// Synthetic right hand in IMAGE coordinates (un-mirrored), palm centred at cx,cy.
function hand({cx=.5,cy=.55,curl=false,pinch=false}={}) {
  const p=Array.from({length:21},()=>({x:cx,y:cy}));
  p[0]={x:cx,y:cy+.15};
  const columns=[-.06,-.02,.02,.06];
  [[5,6,7,8],[9,10,11,12],[13,14,15,16],[17,18,19,20]].forEach((finger,i)=>{
    const x=cx+columns[i];
    p[finger[0]]={x,y:cy-.02};p[finger[1]]={x,y:cy-.07};
    if(curl){p[finger[2]]={x,y:cy-.03};p[finger[3]]={x,y:cy+.02};}
    else {p[finger[2]]={x,y:cy-.11};p[finger[3]]={x,y:cy-.15};}
  });
  p[1]={x:cx-.08,y:cy+.1};p[2]={x:cx-.11,y:cy+.05};p[3]={x:cx-.13,y:cy};p[4]=pinch?{x:p[8].x+.01,y:p[8].y+.01}:{x:cx-.15,y:cy-.04};
  return Float32Array.from(p.flatMap(q=>[q.x,q.y,0]));
}
// Synthetic face subset (FACE order) in IMAGE coordinates. yaw shifts the nose
// toward the image right; mouth opens the lips; tilt lowers one eye.
function face({yaw=0,pitch=0,mouth=0,tilt=0}={}) {
  const p=[];
  p[FACE.nose]={x:.5+yaw*.08,y:.5+pitch*.08};
  p[FACE.eyeA]={x:.44,y:.42};p[FACE.eyeB]={x:.56,y:.42+tilt};
  p[FACE.cheekA]={x:.4,y:.5};p[FACE.cheekB]={x:.6,y:.5};
  p[FACE.forehead]={x:.5,y:.3};p[FACE.chin]={x:.5,y:.7};
  p[FACE.lipTop]={x:.5,y:.6};p[FACE.lipBottom]={x:.5,y:.6+mouth};
  return Float32Array.from(p.flatMap(q=>[q.x,q.y,0]));
}

test('landmarks are mirrored into the selfie view the player sees',()=>{
  const [p]=points(Float32Array.from([.2,.3,.1]));
  assert.deepEqual([+p.x.toFixed(3),+p.y.toFixed(3)],[.8,.3]);
});

test('hand poses: open, fist, pinch, and the real thumbs-up photo',()=>{
  assert.equal(readHand(points(hand())).pose,'open');
  assert.equal(readHand(points(hand({curl:true}))).pose,'fist');
  assert.ok(readHand(points(hand({pinch:true}))).pinch<PINCH_ON);
  assert.ok(readHand(points(hand())).pinch>PINCH_OFF);
  const real=readHand(points(thumbUp));
  assert.equal(real.pose,'fist','curled fingers with the thumb up count as a fist');
  assert.ok(real.palm.x>.3&&real.palm.x<.7&&real.palm.y>.4&&real.palm.y<.8);
});

test('hand input: palm steers, pinch/fist press with one edge, hysteresis holds',()=>{
  const g=new GestureInput('hand');
  let s=g.update(hand({cx:.5}),0);
  assert.equal(s.present,true);assert.equal(s.action,false);
  assert.ok(Math.abs(s.x-.5)<.02);
  // The player's hand moves to THEIR left = image right = screen left.
  for(let t=1;t<20;t++)s=g.update(hand({cx:.7}),t*33);
  assert.ok(s.x<.3,`moved to ${s.x}`);
  s=g.update(hand({cx:.7,pinch:true}),700);
  assert.equal(s.pressed,true);assert.equal(s.action,true);
  s=g.update(hand({cx:.7,pinch:true}),733);
  assert.equal(s.pressed,false,'a held pinch is one press');assert.equal(s.action,true);
  s=g.update(hand({cx:.7,curl:true}),766);
  assert.equal(s.action,true,'a fist also holds the button');
  s=g.update(hand({cx:.7}),800);
  assert.equal(s.released,true);assert.equal(s.action,false);
});

test('hand input: short dropouts keep state, long ones release and mark absent',()=>{
  const g=new GestureInput('hand');
  g.update(hand({pinch:true}),0);
  assert.equal(g.update(null,200).present,true);
  const s=g.update(null,500);
  assert.equal(s.present,false);assert.equal(s.action,false);assert.equal(s.released,true);
});

test('recenter makes the current hand position the middle of the screen',()=>{
  const g=new GestureInput('hand');
  g.recenter();
  let s;for(let t=0;t<20;t++)s=g.update(hand({cx:.3,cy:.3}),t*33);
  assert.ok(Math.abs(s.x-.5)<.02&&Math.abs(s.y-.5)<.02,`${s.x},${s.y}`);
});

test('head input: calibrates straight ahead, turning or tilting steers, mouth presses',()=>{
  const g=new GestureInput('head');
  let s;for(let t=0;t<8;t++)s=g.update(face({yaw:.3}),t*33);
  assert.ok(Math.abs(s.x-.5)<.03,'a slightly turned resting pose becomes centre');
  // Turning to the player's left moves the nose toward image right.
  for(let t=8;t<30;t++)s=g.update(face({yaw:1.3}),t*33);
  assert.ok(s.x<.25,`left turn → ${s.x}`);
  for(let t=30;t<60;t++)s=g.update(face({yaw:-.7}),t*33);
  assert.ok(s.x>.75,`right turn → ${s.x}`);
  const h=readHead(points(face({tilt:.06})));
  assert.ok(h.roll<0,'image-right eye lower = head tilted to the player’s left');
  s=g.update(face({mouth:.05}),3000);
  assert.equal(s.pressed,true);assert.equal(s.pose,'mouth open');
  s=g.update(face({mouth:.028}),3033);
  assert.equal(s.action,true,'partly closing stays pressed (hysteresis)');
  s=g.update(face({mouth:0}),3066);
  assert.equal(s.released,true);
});

test('one-euro filter is smooth when still and catches up when moving',()=>{
  const f=new OneEuro();
  let v=f.filter(0,0);
  for(let t=1;t<=10;t++)v=f.filter(t%2?.02:-.02,t*33);
  assert.ok(Math.abs(v)<.02,'jitter is damped');
  for(let t=11;t<=40;t++)v=f.filter(1,t*33);
  assert.ok(v>.95,'a real move arrives within a second');
});

const idle={present:true,x:.5,y:.5,action:false,pressed:false};
const press={...idle,action:true,pressed:true};
function run(session,frames,input=idle) {const events=[];for(let i=0;i<frames;i++)events.push(...session.update(1/60,typeof input==='function'?input(i):input));return events;}

test('session: press to start, losing the player pauses, finding them resumes',()=>{
  const s=new Session('catch',7);s.resize(16/9);
  run(s,10);assert.equal(s.state,'ready','nothing starts without a press');
  s.update(1/60,{...press,present:false});assert.equal(s.state,'ready','no press while unseen');
  s.update(1/60,press);assert.equal(s.state,'playing');
  run(s,30,{...idle,present:false});assert.equal(s.state,'paused');assert.equal(s.reason,'lost');
  const t=s.game.time;run(s,30,{...idle,present:false});assert.equal(s.game.time,t,'paused games do not advance');
  run(s,60);assert.equal(s.state,'playing','resumes after a short countdown');
  s.pause();run(s,60);assert.equal(s.state,'paused','manual pause waits for a press');
  s.update(1/60,press);assert.equal(s.state,'playing');
});

test('star catch: stars score, rocks cost lives, three rocks end the game',()=>{
  const g=new StarCatch(1);g.resize(1.5);
  g.spawnIn=99;g.items=[{kind:'star',x:g.basket,y:.8,r:.032,v:.4,spin:0}];
  for(let i=0;i<30;i++)g.update(1/60,{...idle,x:g.basket/g.aspect});
  assert.equal(g.score,1);assert.deepEqual(g.events.filter(e=>e==='score'),['score']);
  for(let hit=0;hit<3;hit++) {
    g.invulnerable=0;g.items=[{kind:'rock',x:g.basket,y:.8,r:.04,v:.4,spin:0}];
    for(let i=0;i<30;i++)g.update(1/60,{...idle,x:g.basket/g.aspect});
  }
  assert.equal(g.lives,0);assert.equal(g.over,true);
  const dodge=new StarCatch(1);dodge.resize(1.5);dodge.spawnIn=99;
  dodge.items=[{kind:'rock',x:.2,y:.8,r:.04,v:.4,spin:0}];
  for(let i=0;i<60;i++)dodge.update(1/60,{...idle,x:.95});
  assert.equal(dodge.lives,3,'moving away dodges the rock');
});

test('cave glide: flying through a gap scores, hitting a wall hurts',()=>{
  const g=new CaveGlide(2);g.resize(1.6);g.nextGate=99;
  g.gates=[{x:.22*1.6+.2,gap:.4,center:.3,w:.07,passed:false,orb:true}];
  for(let i=0;i<120;i++)g.update(1/60,{...idle,y:.3});
  assert.equal(g.lives,3);assert.equal(g.score,4,'gate +1 and orb +3');
  g.gates=[{x:.22*1.6+.2,gap:.3,center:.2,w:.07,passed:false,orb:false}];
  for(let i=0;i<120;i++)g.update(1/60,{...idle,y:.85});
  assert.equal(g.lives,2);assert.equal(g.score,4,'a gate you crashed into scores nothing');
});

test('bubble pop: press over a bubble pops it, gold and spiky change the score, time ends it',()=>{
  const g=new BubblePop(3);g.resize(1);g.spawnIn=99;
  g.items=[{kind:'plain',r:.08,x:.3,y:.5,v:0,phase:0},{kind:'gold',r:.08,x:.7,y:.5,v:0,phase:0},{kind:'spiky',r:.08,x:.5,y:.2,v:0,phase:0}];
  g.update(1/60,{...press,x:.3,y:.5});assert.equal(g.score,1);
  g.update(1/60,{...idle,x:.7,y:.5});assert.equal(g.score,1,'hovering alone does not pop');
  g.update(1/60,{...press,x:.7,y:.5});assert.equal(g.score,4);
  g.update(1/60,{...press,x:.5,y:.2});assert.equal(g.score,2);
  g.update(1/60,{...press,x:.05,y:.95});assert.deepEqual(g.events.at(-1),'miss');
  g.left=.01;g.update(1/60,idle);assert.equal(g.over,true);
});

test('games are deterministic for a seed and survive long random play',()=>{
  for(const Game of GAMES) {
    const play=seed=>{const s=new Session(Game.id,seed);s.resize(1.7);s.update(1/60,press);const r=rng(seed);
      for(let i=0;i<60*90&&s.state!=='over';i++)s.update(1/60,{present:true,x:r(),y:r(),action:false,pressed:r()<.05});
      return [s.state,s.game.score,s.game.time.toFixed(3)];};
    assert.deepEqual(play(11),play(11),Game.id);
    const [,score]=play(11);assert.ok(Number.isFinite(score)&&score>=0,Game.id);
  }
});

test('controls guide: every input lists steer and press, described for the game',()=>{
  for(const mode of ['hand','head','pointer']) {
    const list=controls(mode,'x');
    assert.equal(list[0].id,'steer',mode);
    assert.ok(list.every(c=>c.icon&&c.gesture&&c.does),mode);
    assert.equal(new Set(list.map(c=>c.id)).size,list.length,'ids are unique');
  }
  assert.equal(controls('hand','x')[0].does,'Move left / right');
  assert.equal(controls('hand','y')[0].does,'Move up / down');
  assert.equal(controls('head','y')[0].gesture,'Nod up / down');
  assert.equal(controls('hand','xy','Pop · start')[1].does,'Pop · start');
});

test('active control follows what the tracker sees',()=>{
  assert.equal(activeControl('hand',{present:false}),'');
  assert.equal(activeControl('hand',null),'');
  const g=new GestureInput('hand');
  assert.equal(activeControl('hand',g.update(hand(),0)),'steer');
  assert.equal(activeControl('hand',g.update(hand({pinch:true}),33)),'pinch');
  const fist=new GestureInput('hand');
  assert.equal(activeControl('hand',fist.update(thumbUp,0)),'fist','the real thumbs-up photo lights the fist control');
  const head=new GestureInput('head');
  assert.equal(activeControl('head',head.update(face({mouth:.05}),0)),'mouth');
  assert.equal(activeControl('pointer',{present:true,action:true}),'press');
});

// 3D hand in metres, palm facing the camera, then tilted back so the image
// foreshortens it (fingers look short) while its real shape is unchanged.
function worldHand({pinch=false,curl=false}={}) {
  const p=Array.from({length:21},()=>({x:0,y:0,z:0}));
  [-.03,-.01,.01,.03].forEach((x,i)=>{
    const f=[5,9,13,17].map(k=>k+0)[i];
    p[f]={x,y:-.08,z:0};p[f+1]={x,y:-.11,z:0};
    p[f+2]=curl?{x,y:-.09,z:-.02}:{x,y:-.135,z:0};p[f+3]=curl?{x,y:-.065,z:-.02}:{x,y:-.155,z:0};
  });
  p[1]={x:-.03,y:-.02,z:0};p[2]={x:-.05,y:-.04,z:0};p[3]={x:-.065,y:-.06,z:0};
  p[4]=pinch?{x:p[8].x+.006,y:p[8].y+.004,z:.004}:{x:-.08,y:-.08,z:0};
  return Float32Array.from(p.flatMap(q=>[q.x,q.y,q.z]));
}
function tiltImage(flat,k=.45) {const out=Float32Array.from(flat);for(let i=1;i<out.length;i+=3)out[i]=.55+(out[i]-.55)*k;return out;}

test('hand shape comes from 3D points: a tilted open hand stays open, a 3D pinch presses',()=>{
  // Fingertips touching, seen with the hand tilted back: the hand looks short
  // in the image but the side-by-side fingertip gap does not, so the image-only
  // ratio misses the pinch. The 3D shape does not.
  const touching=hand({pinch:true});touching[12]=touching[24]+.03;touching[13]=touching[25];
  const tilted=tiltImage(touching,.3);
  assert.ok(readHand(points(tilted)).pinch>PINCH_OFF,'image-only reading misses the tilted pinch');
  assert.ok(readHand(points(tilted),points(worldHand({pinch:true}))).pinch<PINCH_ON);
  assert.equal(readHand(points(tiltImage(hand())),points(worldHand())).pose,'open');
  assert.ok(readHand(points(tilted),points(worldHand({pinch:true}))).pinch<PINCH_ON);
  assert.ok(readHand(points(tilted),points(worldHand())).pinch>PINCH_OFF);
  assert.equal(readHand(points(hand()),points(worldHand({curl:true}))).pose,'fist');
  const real=readHand(points(thumbUp),points(thumbUpWorld));
  assert.equal(real.pose,'fist','the real thumbs-up is a fist in 3D too');
  const g=new GestureInput('hand');
  const s=g.update(tilted,0,worldHand({pinch:true}));
  assert.equal(s.pressed,true);assert.equal(s.pose,'pinch');
});

test('the aim sits on the hand as drawn: same mapping as the camera picture',()=>{
  const g=new GestureInput('hand');
  g.setView(1.2,1); // camera covers the stage, cropped left and right
  let s;for(let t=0;t<30;t++)s=g.update(hand({cx:.4,cy:.5}),t*33);
  const palm=readHand(g.state.raw).palm, drawn=g.handMap(palm);
  assert.ok(Math.abs(s.x-drawn.x)<.005&&Math.abs(s.y-drawn.y)<.005,`aim ${s.x},${s.y} vs hand ${drawn.x},${drawn.y}`);
  assert.ok(Math.abs(drawn.x-(.5+(palm.x-.5)*HAND_REACH*1.2))<1e-9);
  // A hand in the middle of the camera aims at the middle of the screen.
  assert.deepEqual(g.handMap({x:.5,y:.5}),{x:.5,y:.5});
  // Recenter moves the mapping (and so the drawn camera) with the hand.
  g.recenter();g.update(hand({cx:.4,cy:.5}),2000);
  const c=g.handMap(readHand(g.state.raw).palm);
  assert.ok(Math.abs(c.x-.5)<1e-9&&Math.abs(c.y-.5)<1e-9);
});

test('smoothing keeps up with a moving hand and settles quickly when it stops',()=>{
  const f=new OneEuro();let lag=0,n=0,settle=null;
  for(let i=0;i<=60;i++) {
    const t=i*33, v=t<400?.2+.6*t/400:.8, o=f.filter(v,t);
    if(t>66&&t<400){lag+=v-o;n++;}
    if(t>=400&&settle===null&&Math.abs(o-.8)<.01)settle=t-400;
  }
  assert.ok(lag/n<.03,`trails by ${(lag/n).toFixed(3)} of the screen`);
  assert.ok(settle!==null&&settle<=70,`settles in ${settle} ms`);
});

test('a press is aimed where the hand was before the gesture moved it',()=>{
  const g=new GestureInput('hand');
  let s;for(let t=0;t<20;t++)s=g.update(hand({cx:.5}),t*33);
  const before=s.x;
  // Closing a fist shifts the tracked palm sideways in the same frame.
  s=g.update(hand({cx:.56,curl:true}),20*33);
  assert.equal(s.pressed,true);
  assert.ok(Math.abs(s.x-before)<.005,`pressed at ${s.x}, hand was at ${before}`);
  s=g.update(hand({cx:.56,curl:true}),21*33);
  assert.ok(Math.abs(s.x-before)<.005,'the aim holds still right after the press');
  for(let t=22;t<40;t++)s=g.update(hand({cx:.56,curl:true}),t*33);
  assert.ok(s.x<before-.05,'then follows the hand again');
});

test('head: a resting tilt is calibrated away instead of pulling the aim sideways',()=>{
  const g=new GestureInput('head');
  let s;for(let t=0;t<30;t++)s=g.update(face({tilt:.05}),t*33);
  assert.ok(Math.abs(s.x-.5)<.03,`resting tilt aims at ${s.x}`);
  for(let t=30;t<60;t++)s=g.update(face({tilt:-.03}),t*33);
  assert.ok(s.x>.6,'tilting the other way from rest still steers');
});

// Real model output for MediaPipe's portrait test photo (upright, smiling).
const portrait=JSON.parse(readFileSync(new URL('./fixtures/face-portrait.pose.json',import.meta.url)));
// Synthetic head pose: yaw + = toward the mirrored screen's right, pitch + = down.
function pose({yaw=0,pitch=0,jaw=0}={}) {
  const m=new Float32Array(17);m[0]=1;m[5]=1;m[15]=1;
  m[8]=-Math.sin(yaw)*Math.cos(pitch);m[9]=-Math.sin(pitch);m[10]=Math.cos(yaw)*Math.cos(pitch);m[16]=jaw;
  return m;
}
const rad=d=>d*Math.PI/180;

test('head pose from the real model: frontal face reads straight, mirroring flips the turn, a smile is not a press',()=>{
  const up=readHeadPose(portrait.upright), mirrored=readHeadPose(portrait.uprightMirrored);
  assert.ok(Math.abs(up.yaw)<rad(5)&&Math.abs(up.pitch)<rad(8),`${up.yaw},${up.pitch}`);
  assert.ok(Math.sign(up.yaw)===-Math.sign(mirrored.yaw),'mirroring the photo flips the turn');
  assert.ok(up.jaw<JAW_ON&&mirrored.jaw<JAW_ON,'smiling with teeth showing does not press');
  assert.ok(Math.abs(readHeadPose(portrait.rotated).yaw)<rad(12),'a sideways (rolled) face is not read as a turn');
});

test('head: opening the mouth presses without moving the aim',()=>{
  const g=new GestureInput('head');
  let s;for(let t=0;t<10;t++)s=g.update(face(),t*33,pose({yaw:rad(6),pitch:rad(-4)}));
  for(let t=10;t<30;t++)s=g.update(face(),t*33,pose({yaw:rad(6),pitch:rad(-4)}));
  const x=s.x,y=s.y;
  // Mouth wide open: lips apart and the chin drops in the image; the head's
  // rotation is unchanged.
  const open=face({mouth:.06});open[6*3+1]+=.05;
  for(let t=30;t<45;t++)s=g.update(open,t*33,pose({yaw:rad(6),pitch:rad(-4),jaw:.6}));
  assert.equal(s.action,true);
  assert.ok(Math.abs(s.x-x)<.01&&Math.abs(s.y-y)<.01,`aim moved from ${x},${y} to ${s.x},${s.y}`);
  // Even without the 3D pose, the landmark fallback ignores the chin and lips.
  const f=new GestureInput('head');let r;
  for(let t=0;t<30;t++)r=f.update(face(),t*33);
  const before=r.y;for(let t=30;t<45;t++)r=f.update(open,t*33);
  assert.equal(r.action,true);assert.ok(Math.abs(r.y-before)<.01,`fallback nod moved ${before}→${r.y}`);
});

test('head: a small nod moves the aim most of the way up or down',()=>{
  const g=new GestureInput('head');
  let s;for(let t=0;t<10;t++)s=g.update(face(),t*33,pose({pitch:rad(5)}));
  for(let t=10;t<40;t++)s=g.update(face(),t*33,pose({pitch:rad(5+8)}));
  assert.ok(s.y>.8,`8° down → ${s.y}`);
  for(let t=40;t<70;t++)s=g.update(face(),t*33,pose({pitch:rad(5-8)}));
  assert.ok(s.y<.2,`8° up → ${s.y}`);
  for(let t=70;t<100;t++)s=g.update(face(),t*33,pose({yaw:rad(12),pitch:rad(5)}));
  assert.ok(s.x>.75&&Math.abs(s.y-.5)<.05,`12° turn right → ${s.x},${s.y}`);
  assert.ok(Math.abs(rad(8)/HEAD_SPAN.pitch-.333)<.01,'8° nod = a third of the screen');
});
