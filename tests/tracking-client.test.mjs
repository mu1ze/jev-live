import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

// Control transport/time only; execute the actual client without browser timing jitter.
function harness() {
  let now=100, next=0;const timers=new Map(),workers=[];
  class Worker {
    constructor(){this.messages=[];workers.push(this);}
    postMessage(m){this.messages.push(m);}
    terminate(){this.terminated=true;}
    reply(data){this.onmessage({data});}
  }
  const scope={Worker,URL,performance:{now:()=>now},setTimeout:(fn,ms)=>{const id=++next;timers.set(id,{fn,at:now+ms});return id;},clearTimeout:id=>timers.delete(id)};
  const source=readFileSync(new URL('../static/tracking-client.mjs',import.meta.url),'utf8').replace('export class TrackingClient','class TrackingClient').replace('import.meta.url',JSON.stringify('http://localhost/tracking-client.mjs'));
  vm.runInNewContext(source+'\nglobalThis.TrackingClient=TrackingClient;',scope);
  const changes=[],client=new scope.TrackingClient(reason=>changes.push(reason));client.start();
  return {client,worker:workers[0],changes,advance(ms){now+=ms;for(const [id,t] of timers)if(t.at<=now){timers.delete(id);t.fn();}},now:()=>now,push(){return client.push({width:32,height:32},{getImageData:()=>({data:new Uint8ClampedArray(4096)})},now);}};
}

test('adaptive cadence uses measured turnaround, recovers headroom, and remains bounded',()=>{
  const h=harness(),c=h.client,w=h.worker;w.reply({type:'ready'});
  assert.ok(c.sampleInterval()<40,'fast worker should allow about 30Hz');
  for(let i=0;i<10;i++){h.push();h.advance(100);w.reply({type:'frame',generation:c.generation,tracks:[],processingMs:90});}
  assert.ok(c.sampleInterval()>=120&&c.sampleInterval()<=160);
  for(let i=0;i<30;i++){h.push();h.advance(5);w.reply({type:'frame',generation:c.generation,tracks:[],processingMs:4});}
  assert.ok(c.sampleInterval()<40,'headroom must recover without source restart');
  const before=c.sampleInterval();w.reply({type:'frame',generation:-1,tracks:[],processingMs:9000});
  assert.equal(c.sampleInterval(),before);c.close();
});
test('diagnostics are bounded actual rates and allowlisted numbers, not target or payload text',()=>{
  const h=harness(),c=h.client,w=h.worker;w.reply({type:'ready'});
  for(let i=0;i<200;i++){
    h.push();h.advance(40);w.reply({type:'frame',generation:c.generation,tracks:[],processingMs:6,diagnostics:{historyFrames:120,historyBytes:123,historyMs:3966,rejects:{'capture-frame-expired':4,'secret-url':100},losses:{'pixel-evidence-lost':2},pixels:'secret',label:'secret'}});
  }
  const d=c.diagnostics(h.now());
  assert.ok(d.sampleHz>24&&d.sampleHz<=25.1);assert.ok(d.completionHz>24&&d.completionHz<=25.1);
  assert.equal(d.processingMs,6);assert.equal(d.rejects['capture-frame-expired'],4);
  assert.equal(d.losses['pixel-evidence-lost'],2);assert.doesNotMatch(JSON.stringify(d),/secret|url|label|pixels/);
  const capture=h.push();h.advance(4000);c.seed(capture,[],0);
  assert.equal(c.diagnostics(h.now()).rejects['capture-too-old'],1);
  c.reset();assert.equal(c.diagnostics(h.now()).sampleHz,0);c.close();
});

test('cold start can become ready after 16 seconds but remains bounded at 60 seconds',()=>{
  const h=harness();h.advance(16000);
  assert.equal(h.client.worker,h.worker,'slow download/runtime must get more than 15 seconds');
  assert.match(h.client.state,/initializ/);assert.doesNotMatch(h.client.state,/fallback/);
  h.worker.reply({type:'ready'});assert.equal(h.client.ready,true);
  h.advance(60000);assert.equal(h.client.ready,true);h.client.close();
  const stuck=harness();stuck.advance(60001);
  assert.equal(stuck.client.worker,null);assert.equal(stuck.client.failureCode,'initialization-timeout');
});

test('failure diagnostics distinguish phase and safe error categories without echoing payloads',()=>{
  const load=harness();load.worker.onerror({message:'NetworkError secret=https://private/?token=fixture-secret',lineno:7,colno:3});
  assert.equal(load.client.failureCode,'worker-load-error');
  assert.match(load.client.state,/network.*line 7:3/);assert.doesNotMatch(load.client.state,/private|fixture-secret/);
  const runtime=harness();runtime.worker.reply({type:'ready'});
  runtime.worker.onerror({message:'out of memory fixture-secret',lineno:9,colno:1});
  assert.equal(runtime.client.failureCode,'worker-runtime-error');assert.match(runtime.client.state,/memory/);
  const replay=harness();replay.worker.reply({type:'ready'});
  replay.worker.reply({type:'failure',generation:replay.client.generation,code:'seed-replay-error',detail:'RangeError'});
  assert.equal(replay.client.failureCode,'seed-replay-error');assert.match(replay.client.state,/RangeError/);
  const stuck=harness();stuck.worker.reply({type:'ready'});stuck.push();stuck.advance(10001);stuck.client.current(stuck.now());
  assert.equal(stuck.client.failureCode,'frame-timeout');assert.equal(stuck.worker.terminated,true);
  const decode=harness();decode.worker.onmessageerror();assert.equal(decode.client.failureCode,'worker-message-error');
});

test('source reset ignores old replies and freshness still rejects 4-second seeds',()=>{
  const h=harness(),c=h.client;h.worker.reply({type:'ready'});const capture=h.push();c.reset();
  h.worker.reply({type:'frame',generation:capture.generation,measured:h.now(),tracks:[{id:'old'}]});
  assert.equal(c.current(h.now()).length,0);
  h.worker.reply({type:'failure',generation:capture.generation,code:'frame-processing-error'});
  assert.equal(c.ready,true,'old-source failure must not poison new source');
  const fresh=h.push(),count=h.worker.messages.length;h.advance(4000);c.seed(fresh,[],0);
  assert.equal(h.worker.messages.length,count);c.close();
});

test('slow responsive frame hides stale evidence without killing worker or queueing frames',()=>{
  const h=harness(),c=h.client,w=h.worker;w.reply({type:'ready'});
  const first=h.push();
  w.reply({type:'frame',generation:c.generation,measured:h.now(),tracks:[{id:'one',label:'fixture',confidence:.9,box:[0,0,.5,.5]}]});
  assert.equal(c.current(h.now()).length,1);
  h.advance(70);h.push();const queued=w.messages.length;
  h.advance(400);
  assert.equal(c.current(h.now()).length,0,'stale boxes must disappear');
  assert.equal(c.ready,true,'350ms visual expiry must not terminate a responsive worker');
  assert.equal(c.busy,true);assert.equal(h.push(),null);assert.equal(w.messages.length,queued);
  h.advance(400);w.reply({type:'frame',generation:c.generation,measured:first.timestamp+70,tracks:[{id:'one',label:'fixture',confidence:.9,box:[0,0,.5,.5]}]});
  assert.equal(c.current(h.now()).length,0,'late evidence must stay hidden');
  const fresh=h.push();w.reply({type:'frame',generation:c.generation,measured:fresh.timestamp,tracks:[{id:'two',label:'fixture',confidence:.9,box:[.1,0,.5,.5]}]});
  assert.equal(c.current(h.now()).length,1);assert.equal(w.terminated,undefined);c.close();
});
