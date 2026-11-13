import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
const path=new URL('../static/action-audio.mjs',import.meta.url);
const mod=existsSync(path)?await import(path):{};
test('sound requires explicit unlock, is short and single-voice, and reset invalidates pending resume',async()=>{
  assert.equal(typeof mod.ActionAudio,'function','bounded WebAudio adapter exists');
  let created=0,started=0,stops=[], disconnected=0, release;
  const context={currentTime:10,state:'running',destination:{},resume:()=>Promise.resolve(),
    createOscillator:()=>({frequency:{value:0},connect(){},disconnect(){disconnected++;},start(){started++;},stop(at){stops.push(at);}}),
    createGain:()=>({gain:{setValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){},disconnect(){}})};
  const a=new mod.ActionAudio(()=>{created++;return context;});
  assert.equal(created,0,'no AudioContext on load');
  a.play();assert.equal(started,0);
  await a.allow(true);a.play();a.play();assert.equal(started,1,'never pile up tones');
  assert.equal(stops[0],10.16,'strictly bounded tone');
  a.cancel();assert.ok(disconnected>0);
  await a.allow(false);a.play();assert.equal(started,1);
  context.resume=()=>new Promise(resolve=>release=resolve);
  const waiting=a.allow(true);a.cancel();release();await waiting;
  a.play();assert.equal(started,1,'late resume cannot sound after Stop/reset');
  const waiting2=a.allow(true);await a.allow(false);release();await waiting2;
  a.play();assert.equal(started,1,'late resume cannot sound after opt-out');
});
