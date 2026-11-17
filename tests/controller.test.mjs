import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {points, readHand, readHead, GestureInput, OneEuro, FACE, PINCH_ON, PINCH_OFF} from '../static/gestures.mjs';
import {Session, StarCatch, CaveGlide, BubblePop, GAMES, rng} from '../static/mini-games.mjs';

// Real MediaPipe output for tests/fixtures/hand-thumb-up.jpg (image coordinates).
const thumbUp=JSON.parse(readFileSync(new URL('./fixtures/hand-thumb-up.landmarks.json',import.meta.url)));

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
