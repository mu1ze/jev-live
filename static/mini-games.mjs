// Gesture mini-games. Game logic is deterministic (seeded RNG, explicit dt) and
// independent of the DOM; draw() only needs a 2D canvas context.
//
// World units: height is 1, width is `aspect`. Input x/y are 0…1 of the view.

export function rng(seed=1) {
  let a=seed>>>0||1;
  return ()=>{a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};
}
const clamp=(v,lo,hi)=>Math.min(hi,Math.max(lo,v));
const ACCENT='#c5ed96', TEXT='#eef2eb', MUTED='#a1afa5', DANGER='#ffb0a0', GOLD='#ffd36e', SKY='#8fd3ff';

class Game {
  constructor(seed) {this.random=rng(seed);this.aspect=16/9;this.reset();}
  reset() {this.score=0;this.lives=3;this.time=0;this.over=false;this.items=[];this.bursts=[];this.events=[];}
  resize(aspect) {this.aspect=clamp(aspect,.5,3);}
  emit(type) {this.events.push(type);}
  burst(x,y,color,text) {this.bursts.push({x,y,color,text,age:0});}
  hurt() {
    if(this.invulnerable>0)return;
    this.lives--;this.invulnerable=1.2;this.emit('hurt');
    if(this.lives<=0){this.over=true;this.emit('over');}
  }
  tick(dt) {
    this.time+=dt;this.invulnerable=Math.max(0,(this.invulnerable||0)-dt);
    for(const b of this.bursts)b.age+=dt;
    this.bursts=this.bursts.filter(b=>b.age<.8);
  }
  hud() {return {score:this.score,right:'♥'.repeat(Math.max(0,this.lives))};}
  drawBursts(ctx,s) {
    ctx.textAlign='center';ctx.font=`600 ${Math.round(s*.045)}px system-ui,sans-serif`;
    for(const b of this.bursts) {
      ctx.globalAlpha=1-b.age/.8;ctx.fillStyle=b.color;
      ctx.fillText(b.text,b.x*s,(b.y-b.age*.12)*s);
    }
    ctx.globalAlpha=1;
  }
}

// ---- Star Catch: steer a basket left/right. Stars +1, gems +5, rocks cost a life.
export class StarCatch extends Game {
  static id='catch';static title='Star Catch';
  static help='Move left and right to catch stars and gems. Dodge the rocks.';
  static axes='x';
  reset() {super.reset();this.basket=.5*this.aspect;this.spawnIn=.6;this.streak=0;}
  update(dt,input) {
    this.tick(dt);
    const target=input.x*this.aspect, width=.2;
    this.basket+=(target-this.basket)*Math.min(1,dt*18);
    this.basket=clamp(this.basket,width/2,this.aspect-width/2);
    this.spawnIn-=dt;
    if(this.spawnIn<=0) {
      const roll=this.random(), kind=roll<.08?'gem':roll<.27?'rock':'star';
      this.items.push({kind,x:.06+this.random()*(this.aspect-.12),y:-.05,r:kind==='rock'?.04:.032,v:(.32+Math.min(.55,this.time*.012))*(kind==='gem'?1.35:1)*(.85+this.random()*.3),spin:this.random()*6});
      this.spawnIn=Math.max(.32,.95-this.time*.012);
    }
    const catchY=.88;
    for(const item of this.items) {
      item.y+=item.v*dt;item.spin+=dt*2;
      if(!item.done&&item.y+item.r>=catchY&&item.y-item.r<=catchY+.03&&Math.abs(item.x-this.basket)<width/2+item.r*.6) {
        item.done=true;
        if(item.kind==='rock'){this.streak=0;this.hurt();this.burst(item.x,catchY,DANGER,'ouch');}
        else {
          const points=item.kind==='gem'?5:1;this.streak++;
          const bonus=this.streak%10===0?5:0;this.score+=points+bonus;
          this.emit(item.kind==='gem'||bonus?'bonus':'score');this.burst(item.x,catchY-.04,item.kind==='gem'?SKY:GOLD,`+${points+bonus}`);
        }
      }
      if(!item.done&&item.y-item.r>1&&item.kind!=='rock')this.streak=0;
    }
    this.items=this.items.filter(i=>!i.done&&i.y-i.r<=1.05);
  }
  hud() {return {score:this.score,right:`${'♥'.repeat(Math.max(0,this.lives))}${this.streak>=3?`  streak ${this.streak}`:''}`};}
  draw(ctx,s) {
    for(const item of this.items) {
      const x=item.x*s,y=item.y*s,r=item.r*s;
      ctx.save();ctx.translate(x,y);ctx.rotate(item.spin);
      if(item.kind==='star'){ctx.fillStyle=GOLD;star(ctx,r,5);}
      else if(item.kind==='gem'){ctx.fillStyle=SKY;ctx.beginPath();ctx.moveTo(0,-r*1.2);ctx.lineTo(r,0);ctx.lineTo(0,r*1.2);ctx.lineTo(-r,0);ctx.closePath();ctx.fill();}
      else {ctx.fillStyle='#7c7f78';ctx.beginPath();for(let i=0;i<7;i++){const a=i/7*Math.PI*2,k=r*(.8+.2*Math.sin(i*2.7));ctx.lineTo(Math.cos(a)*k,Math.sin(a)*k);}ctx.closePath();ctx.fill();}
      ctx.restore();
    }
    const blink=this.invulnerable>0&&Math.floor(this.time*12)%2;
    ctx.globalAlpha=blink?.35:1;ctx.fillStyle=ACCENT;
    roundRect(ctx,(this.basket-.1)*s,.88*s,.2*s,.045*s,.015*s);ctx.fill();
    ctx.globalAlpha=1;this.drawBursts(ctx,s);
  }
}

// ---- Cave Glide: raise and lower a glider through gaps. Orbs in gaps are bonus.
export class CaveGlide extends Game {
  static id='glide';static title='Cave Glide';
  static help='Move up and down to fly through the gaps. Grab orbs for bonus points.';
  static axes='y';
  reset() {super.reset();this.y=.5;this.gates=[];this.nextGate=.9;this.lastGap=.5;}
  speed() {return .42+Math.min(.5,this.time*.008);}
  update(dt,input) {
    this.tick(dt);
    this.y+=(clamp(input.y,.04,.96)-this.y)*Math.min(1,dt*12);
    const x=.22*this.aspect, r=.028, speed=this.speed();
    this.nextGate-=speed*dt;
    if(this.nextGate<=0) {
      const gap=Math.max(.24,.44-this.time*.004);
      const center=clamp(this.lastGap+(this.random()-.5)*.6,gap/2+.05,1-gap/2-.05);this.lastGap=center;
      this.gates.push({x:this.aspect+.05,gap,center,w:.07,passed:false,orb:this.random()<.35});
      this.nextGate=Math.max(.42,.7-this.time*.004);
    }
    for(const g of this.gates) {
      g.x-=speed*dt;
      const overlapX=x+r>g.x-g.w/2&&x-r<g.x+g.w/2;
      if(overlapX&&(this.y-r<g.center-g.gap/2||this.y+r>g.center+g.gap/2)&&!g.hit){g.hit=true;this.hurt();this.burst(x,this.y,DANGER,'bump');}
      if(g.orb&&Math.hypot(g.x-x,g.center-this.y)<r+.03){g.orb=false;this.score+=3;this.emit('bonus');this.burst(g.x,g.center,SKY,'+3');}
      if(!g.passed&&g.x+g.w/2<x-r){g.passed=true;if(!g.hit){this.score++;this.emit('score');}}
    }
    this.gates=this.gates.filter(g=>g.x+g.w>-.1);
  }
  draw(ctx,s) {
    for(const g of this.gates) {
      ctx.fillStyle=g.hit?'#6b4c47':'#3c5a3a';
      const left=(g.x-g.w/2)*s,width=g.w*s;
      roundRect(ctx,left,-10,width,(g.center-g.gap/2)*s+10,6);ctx.fill();
      roundRect(ctx,left,(g.center+g.gap/2)*s,width,s,6);ctx.fill();
      ctx.fillStyle=ACCENT;ctx.fillRect(left,(g.center-g.gap/2)*s-3,width,3);ctx.fillRect(left,(g.center+g.gap/2)*s,width,3);
      if(g.orb){ctx.fillStyle=SKY;ctx.beginPath();ctx.arc(g.x*s,g.center*s,.022*s,0,Math.PI*2);ctx.fill();}
    }
    const x=.22*this.aspect*s,y=this.y*s,r=.04*s, blink=this.invulnerable>0&&Math.floor(this.time*12)%2;
    ctx.globalAlpha=blink?.35:1;ctx.fillStyle=GOLD;
    ctx.beginPath();ctx.moveTo(x+r*1.3,y);ctx.lineTo(x-r,y-r*.8);ctx.lineTo(x-r*.5,y);ctx.lineTo(x-r,y+r*.8);ctx.closePath();ctx.fill();
    ctx.globalAlpha=1;this.drawBursts(ctx,s);
  }
}

// ---- Bubble Pop: point at bubbles and "press" to pop them before time runs out.
export class BubblePop extends Game {
  static id='pop';static title='Bubble Pop';
  static help='Point at a bubble and press to pop it. Gold is +3, spiky is −2. 45 seconds.';
  static axes='xy';static duration=45;
  reset() {super.reset();this.lives=0;this.left=BubblePop.duration;this.spawnIn=.2;this.cursor={x:.5*this.aspect,y:.5};}
  update(dt,input) {
    this.tick(dt);this.left=Math.max(0,this.left-dt);
    this.cursor={x:input.x*this.aspect,y:input.y};
    this.spawnIn-=dt;
    if(this.spawnIn<=0) {
      const roll=this.random(), kind=roll<.1?'gold':roll<.22?'spiky':'plain', r=.05+this.random()*.04;
      this.items.push({kind,r,x:r+this.random()*(this.aspect-2*r),y:1+r,v:.1+this.random()*.12+Math.min(.12,this.time*.003),phase:this.random()*6});
      this.spawnIn=Math.max(.35,.8-this.time*.01);
    }
    for(const b of this.items){b.y-=b.v*dt;b.phase+=dt*2;b.dx=Math.sin(b.phase)*.012;}
    if(input.pressed) {
      const hit=[...this.items].reverse().find(b=>Math.hypot(b.x+b.dx-this.cursor.x,b.y-this.cursor.y)<b.r+.02);
      if(hit) {
        hit.done=true;
        const points=hit.kind==='gold'?3:hit.kind==='spiky'?-2:1;this.score=Math.max(0,this.score+points);
        this.emit(points<0?'hurt':points>1?'bonus':'score');this.burst(hit.x,hit.y,points<0?DANGER:points>1?GOLD:SKY,points>0?`+${points}`:`${points}`);
      } else this.emit('miss');
    }
    this.items=this.items.filter(b=>!b.done&&b.y+b.r>-.05);
    if(this.left<=0&&!this.over){this.over=true;this.emit('over');}
  }
  hud() {return {score:this.score,right:`${Math.ceil(this.left)} s`};}
  draw(ctx,s) {
    for(const b of this.items) {
      const x=(b.x+(b.dx||0))*s,y=b.y*s,r=b.r*s;
      ctx.lineWidth=Math.max(2,s*.005);
      ctx.strokeStyle=b.kind==='gold'?GOLD:b.kind==='spiky'?DANGER:SKY;ctx.fillStyle=b.kind==='gold'?'#ffd36e33':b.kind==='spiky'?'#ffb0a026':'#8fd3ff1f';
      ctx.beginPath();
      if(b.kind==='spiky')for(let i=0;i<24;i++){const a=i/24*Math.PI*2,k=i%2?r:r*1.18;ctx.lineTo(x+Math.cos(a)*k,y+Math.sin(a)*k);}
      else ctx.arc(x,y,r,0,Math.PI*2);
      ctx.closePath();ctx.fill();ctx.stroke();
      ctx.fillStyle='#ffffff55';ctx.beginPath();ctx.arc(x-r*.35,y-r*.35,r*.18,0,Math.PI*2);ctx.fill();
    }
    this.drawBursts(ctx,s);
  }
}

export const GAMES=[StarCatch,CaveGlide,BubblePop];
export const gameById=id=>GAMES.find(g=>g.id===id)||GAMES[0];

// Ready → playing → (paused) → over. Gestures alone can drive every state:
// press to start or restart; losing track of the player pauses, and finding
// them again resumes after a short countdown.
export class Session {
  constructor(id='catch',seed=Date.now()) {this.seed=seed;this.select(id);}
  select(id) {this.Game=gameById(id);this.game=new this.Game(this.seed);if(this.aspect)this.game.resize(this.aspect);this.state='ready';this.reason='';this.countdown=0;this.lostFor=0;this.events=[];return this;}
  resize(aspect) {this.aspect=aspect;this.game.resize(aspect);}
  start() {this.seed=(this.seed+1)>>>0;this.game=new this.Game(this.seed);this.game.resize(this.aspect||this.game.aspect);this.state='playing';this.reason='';this.countdown=0;}
  pause(reason='paused') {if(this.state==='playing'){this.state='paused';this.reason=reason;this.countdown=0;}}
  resume() {if(this.state==='paused'){this.state='playing';this.reason='';}}
  update(dt,input) {
    dt=clamp(dt,0,.05);this.events=[];
    if(this.state==='ready'||this.state==='over') {if(input.present&&input.pressed)this.start();return this.events;}
    if(this.state==='paused') {
      if(this.reason==='lost'&&input.present) {
        this.countdown+=dt;
        if(this.countdown>=.8)this.resume();
      } else if(this.reason!=='lost'&&input.present&&input.pressed)this.resume();
      return this.events;
    }
    if(!input.present){this.lostFor+=dt;if(this.lostFor>.35)this.pause('lost');return this.events;}
    this.lostFor=0;
    this.game.update(dt,input);this.events=this.game.events.splice(0);
    if(this.game.over)this.state='over';
    return this.events;
  }
}

export function star(ctx,r,points) {
  ctx.beginPath();
  for(let i=0;i<points*2;i++){const a=i/points*Math.PI-Math.PI/2,k=i%2?r*.45:r;ctx.lineTo(Math.cos(a)*k,Math.sin(a)*k);}
  ctx.closePath();ctx.fill();
}
export function roundRect(ctx,x,y,w,h,r) {
  ctx.beginPath();ctx.moveTo(x+r,y);ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath();
}
export const COLORS={ACCENT,TEXT,MUTED,DANGER,GOLD,SKY};
