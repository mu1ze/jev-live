import test from 'node:test';
import assert from 'node:assert/strict';
import {validStep,validAction,stepsOf,fillTemplate,loadSaved,save,STORAGE_KEY} from '../static/custom-actions.mjs';
import {validRule,VisualActions} from '../static/visual-actions.mjs';
const hook={kind:'webhook',on:'on',method:'POST',url:'https://hooks.example.com/x',text:'{"label":"{{label}}"}'};
const memory=()=>{const map=new Map();return {getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,String(v)),removeItem:k=>map.delete(k),map};};

test('steps carry exactly the fields their kind needs',()=>{
  for(const step of [{kind:'warm'},{kind:'chime',on:'off'},{kind:'card',text:'hi'},{kind:'notify',on:'off',text:'gone'},{kind:'shortcut',text:'Lights'},{kind:'link',url:'tel:+1'},hook,{...hook,method:'GET',text:''}])
    assert.equal(validStep(step),true,JSON.stringify(step));
  for(const step of [{kind:'warm',on:'on'},{kind:'card',text:' '},{kind:'card',text:'x',url:'https://a.com/'},{kind:'link',url:'javascript:alert(1)'},{kind:'link',url:'https://a.com/',on:'on'},
    {kind:'shortcut',text:'a\nb'},{...hook,url:'tel:+1'},{...hook,url:'https://u:p@a.com/'},{...hook,method:'DELETE'},{...hook,text:'x'.repeat(1001)},{...hook,on:'later'},{kind:'eval',text:'x'},null])
    assert.equal(validStep(step),false,JSON.stringify(step));
});
test('actions have a name and one to ten valid steps',()=>{
  const action={id:'action-1',name:'Leaving home',steps:[{kind:'warm'},hook]};
  assert.equal(validAction(action),true);
  for(const bad of [{id:'x'},{name:''},{name:' a'},{name:'x'.repeat(61)},{steps:[]},{steps:Array(11).fill({kind:'warm'})},{steps:[{kind:'card',text:''}]}])
    assert.equal(validAction({...action,...bad}),false,JSON.stringify(bad));
});
test('built-in rules become one step; legacy sound becomes a chime; custom rules use their action',()=>{
  const actions=[{id:'action-1',name:'A',steps:[{kind:'money'},hook]}];
  assert.deepEqual(stepsOf({kind:'card',text:'hi',sound:true},actions),[{kind:'card',text:'hi'},{kind:'chime'}]);
  assert.deepEqual(stepsOf({kind:'link',url:'tel:+1',text:'',sound:false},actions),[{kind:'link',url:'tel:+1'}]);
  assert.equal(stepsOf({kind:'custom',action:'action-1'},actions)[1],hook);
  assert.deepEqual(stepsOf({kind:'custom',action:'action-9'},actions),[]);
  const rule={id:'r',label:'bottle',kind:'custom',action:'action-1',mode:'toggle',text:'',sound:false};
  assert.equal(validRule(rule),true);assert.equal(validRule({...rule,action:'x'}),false);assert.equal(validRule({id:'r',label:'b',kind:'warm',text:'',sound:false,action:'action-1'}),false);
  const e=new VisualActions([{...rule,id:'n',kind:'notify',text:'x',action:undefined},rule],r=>stepsOf(r,actions));
  e.accept([{label:'bottle',confidence:.9}],0,0);
  assert.equal(e.accept([{label:'bottle',confidence:.9}],1000,1000).filter,'money','a custom action’s filter step applies');
});
test('templates fill only known placeholders and stay valid JSON',()=>{
  const values={label:'mug "big"\n',event:'on',time:'T',rule:'R'};
  assert.deepEqual(JSON.parse(fillTemplate('{"l":"{{label}}","e":"{{ event }}","x":"{{key}}"}',values)),{l:'mug "big"\n',e:'on',x:'{{key}}'});
  assert.equal(fillTemplate('{{label}} turned {{event}}',values),'mug "big"\n turned on');
});
test('saved state drops invalid or orphaned entries and continues counters',()=>{
  const storage=memory();
  const actions=[{id:'action-4',name:'A',steps:[hook]},{id:'action-5',name:'bad',steps:[{kind:'link',url:'javascript:x'}]}];
  const rules=[{id:'rule-7',label:'keys',kind:'custom',action:'action-4',mode:'toggle',text:'',sound:false},{id:'rule-8',label:'keys',kind:'custom',action:'action-5',mode:'toggle',text:'',sound:false},{id:'rule-2',label:'<b>',kind:'warm',text:'',sound:false}];
  save(storage,{remember:true,rules,actions,nextId:1,nextAction:1});
  const loaded=loadSaved(storage,validRule);
  assert.deepEqual(loaded.actions.map(a=>a.id),['action-4']);assert.deepEqual(loaded.rules.map(r=>r.id),['rule-7']);
  assert.equal(loaded.nextId,8);assert.equal(loaded.nextAction,5);
  storage.setItem(STORAGE_KEY,'{not json');assert.equal(loadSaved(storage,validRule),null);
  save(storage,{remember:false});assert.deepEqual(loadSaved(storage,validRule),{remember:false});
  assert.equal(loadSaved({getItem(){throw new Error('blocked');}},validRule),null);
});
test('every catalog step validates its own fields and refuses unsafe values',async()=>{
  const {CATALOG,headerPairs,bluetoothUuid,parseHex,validCss}=await import('../static/custom-actions.mjs');
  const good=[{kind:'filter',css:'grayscale(1) contrast(140%) hue-rotate(90deg)'},{kind:'wakelock'},{kind:'tone',on:'on',freq:880,ms:200,repeat:3},{kind:'vibrate',pattern:'200, 100,200'},
    {kind:'snapshot'},{kind:'record',seconds:10},{kind:'copy',text:'{{label}}'},{kind:'share',text:'hi'},{kind:'serial',text:'ON',ending:'\r\n'},{kind:'midi',hex:'90 3c 7f'},
    {kind:'bluetooth',service:'0xffe0',characteristic:'0000ffe1-0000-1000-8000-00805f9b34fb',hex:'a001ff'},{kind:'wait',seconds:.5},{...hook,headers:'Authorization: Bearer x\nX-Id: 1'}];
  for(const step of good)assert.equal(validStep(step),true,JSON.stringify(step));
  const bad=[{kind:'filter',css:'url(https://evil/x.svg#f)'},{kind:'filter',css:'blur(2px);background:red'},{kind:'tone',freq:20000,ms:200,repeat:3},{kind:'tone',freq:'880',ms:200,repeat:3},
    {kind:'record',seconds:600},{kind:'wait',seconds:0},{kind:'vibrate',pattern:'a,b'},{kind:'midi',hex:'f0 7e 7f f7'},{kind:'midi',hex:'3c 7f'},{kind:'bluetooth',service:'ffe0x',characteristic:'0xffe1',hex:'01'},
    {kind:'serial',text:'x',ending:'\t'},{kind:'share',text:'x',on:'on'},{kind:'wakelock',on:'on'},{...hook,headers:'Bad Header: x'},{...hook,headers:'X-A: 1\rInjected: 2'},{kind:'__proto__'},{kind:'toString'}];
  for(const step of bad)assert.equal(validStep(step),false,JSON.stringify(step));
  assert.ok(Object.keys(CATALOG).length>=22);
  assert.deepEqual(headerPairs('Authorization: Bearer abc\nX-Empty:'),[['Authorization','Bearer abc'],['X-Empty','']]);
  assert.equal(bluetoothUuid('0xFFE0'),0xffe0);assert.equal(bluetoothUuid('0000FFE1-0000-1000-8000-00805F9B34FB'),'0000ffe1-0000-1000-8000-00805f9b34fb');
  assert.deepEqual(parseHex('a0 01ff'),[0xa0,1,0xff]);assert.equal(validCss('invert(100%)'),true);
});
