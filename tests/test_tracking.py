"""Synthetic textured pixels, real app, worker, gateway and Chromium; no live API."""
import json
import pathlib
import time
import unittest
import test_server
from playwright.sync_api import sync_playwright
ROOT=pathlib.Path(__file__).resolve().parents[1]
CAMERA="""
window.fixtureHidden=false;Object.defineProperty(document,'hidden',{get:()=>window.fixtureHidden});
window.dx=0;window.removed=false;window.freeze=false;
const c=document.createElement('canvas');c.width=640;c.height=360;const ctx=c.getContext('2d');
const texture=document.createElement('canvas');texture.width=100;texture.height=100;const tc=texture.getContext('2d');
let n=42;for(let y=0;y<100;y+=3)for(let x=0;x<100;x+=3){n=(n*1664525+1013904223)>>>0;tc.fillStyle=`rgb(${n%256},${(n>>>8)%256},${(n>>>16)%256})`;tc.fillRect(x,y,3,3)}
function draw(){if(!window.freeze){ctx.fillStyle='#222';ctx.fillRect(0,0,640,360);if(!window.removed){ctx.drawImage(texture,60+window.dx,70);ctx.drawImage(texture,440-window.dx,190)}}}
draw();setInterval(draw,30);navigator.mediaDevices.getUserMedia=async()=>c.captureStream(30);
"""

class TrackingTests(unittest.TestCase):
    def test_delayed_real_worker_hides_stale_tracks_then_recovers(self):
        harness=test_server.HTTPTests()
        with harness.running(),sync_playwright() as pw:
            browser=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
            try:
                page=browser.new_page()
                # Test transport seam: actual OpenCV worker blocked for 800ms on frame 2.
                script=(ROOT/'static/tracking-worker.js').read_text().replace(
                    "if(m.type==='frame') {",
                    "if(m.type==='frame') {if(m.frameId===2){const end=performance.now()+800;while(performance.now()<end){}}")
                page.route('**/tracking-worker.js',lambda route:route.fulfill(body=script,content_type='text/javascript'))
                page.goto(f'http://127.0.0.1:{harness.port}/')
                result=page.evaluate("""async () => {
                    const {TrackingClient}=await import('/tracking-client.mjs');
                    const sleep=ms=>new Promise(r=>setTimeout(r,ms));
                    const c=new TrackingClient(()=>{});c.start();
                    try {
                        while(!c.ready)await sleep(10);
                        const canvas=document.createElement('canvas');canvas.width=320;canvas.height=320;
                        const ctx=canvas.getContext('2d'),im=ctx.createImageData(320,320);let s=42;
                        for(let i=0;i<im.data.length;i+=4){s=(s*1664525+1013904223)>>>0;im.data[i]=s&255;im.data[i+1]=s>>>8&255;im.data[i+2]=s>>>16&255;im.data[i+3]=255}ctx.putImageData(im,0,0);
                        const detection=[{label:'fixture',confidence:.9,box:{left:.2,top:.2,right:.8,bottom:.8}}];
                        const push=()=>c.push(canvas,ctx,performance.now());
                        const wait=async()=>{while(c.busy)await sleep(10)};
                        const first=push();await wait();c.seed(first,detection,0);await sleep(50);
                        const before=c.current(performance.now()).length;
                        const started=performance.now();push();await sleep(450);
                        const during={visible:c.current(performance.now()).length,ready:c.ready,busy:c.busy,extra:push()};
                        await wait();const elapsed=performance.now()-started;
                        const fresh=push();await wait();c.seed(fresh,detection,0);await sleep(50);
                        const recovered={visible:c.current(performance.now()).length,ready:c.ready,busy:c.busy,state:c.state};
                        const failure=await new Promise(resolve=>{c.worker.onmessage=e=>resolve(e.data);c.worker.postMessage({type:'frame',generation:c.generation,frameId:4,width:0,height:0,pixels:new ArrayBuffer(0)})});
                        return {before,during,elapsed,recovered,failure};
                    } finally {c.close()}
                }""")
                self.assertEqual(result['before'],1)
                self.assertEqual(result['during'],dict(visible=0,ready=True,busy=True,extra=None))
                self.assertGreaterEqual(result['elapsed'],800)
                self.assertEqual(result['recovered']['visible'],1)
                self.assertTrue(result['recovered']['ready'])
                self.assertFalse(result['recovered']['busy'])
                self.assertEqual(result['failure']['code'],'frame-processing-error')
                self.assertNotIn('message',result['failure'])
                print('Controlled real-worker 800ms stall:',result,flush=True)
            finally:
                browser.close()

    def test_loss_diagnostics_keep_only_latest_128_events(self):
        harness=test_server.HTTPTests()
        with harness.running(),sync_playwright() as pw:
            browser=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
            try:
                page=browser.new_page()
                page.route('**/tracker.mjs',lambda route:route.fulfill(path=str(ROOT/'static/tracker.mjs'),content_type='text/javascript'))
                page.goto(f'http://127.0.0.1:{harness.port}/')
                events=page.evaluate("""async () => {
                    const {PixelTracker}=await import('/tracker.mjs');
                    const tracker=new PixelTracker(null,320,320);
                    for(let i=0;i<300;i++)tracker.lose({id:`track-${i}`},'pixel-evidence-lost',i);
                    return tracker.events;
                }""")
                self.assertEqual(len(events),128)
                self.assertEqual(events[0]['frameId'],172)
                self.assertEqual(events[-1]['frameId'],299)
            finally:
                browser.close()

    def test_loading_state_describes_initialization_not_active_fallback(self):
        harness=test_server.HTTPTests()
        with harness.running(),sync_playwright() as pw:
            browser=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
            try:
                page=browser.new_page();page.goto(f'http://127.0.0.1:{harness.port}/')
                states=page.evaluate("""async () => {
                    const {TrackingClient}=await import('/tracking-client.mjs');
                    const tracker=new TrackingClient(()=>{}),initial=tracker.state;
                    tracker.start();const loading=tracker.state;tracker.close();
                    return [initial,loading];
                }""")
                for state in states:
                    self.assertIn('initializ',state)
                    self.assertNotIn('fallback',state)
            finally:
                browser.close()

    def test_worker_rejects_thin_uniform_targets_on_textured_background(self):
        harness=test_server.HTTPTests()
        with harness.running(transport=lambda req:{'answers':{}}),sync_playwright() as pw:
            browser=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
            try:
                page=browser.new_page();page.goto(f'http://127.0.0.1:{harness.port}/')
                results=page.evaluate("""async () => {
                    const w=new Worker('tracking-worker.js');
                    await new Promise(r=>w.onmessage=e=>{if(e.data.type==='ready')r()});
                    const command=m=>new Promise(resolve=>{w.onmessage=e=>resolve(e.data);w.postMessage(m)});
                    const canvas=document.createElement('canvas');canvas.width=320;canvas.height=320;
                    const ctx=canvas.getContext('2d'),bg=document.createElement('canvas');bg.width=320;bg.height=320;
                    const bc=bg.getContext('2d');let s=42;
                    for(let y=0;y<320;y+=2)for(let x=0;x<320;x+=2){s=(s*1664525+1013904223)>>>0;bc.fillStyle=`rgb(${s&255},${s>>>8&255},${s>>>16&255})`;bc.fillRect(x,y,2,2)}
                    const results=[];
                    try {
                        for(const width of [1,2,4,8,15]) {
                            w.postMessage({type:'reset'});
                            const frame=async (id,visible)=>{
                                ctx.drawImage(bg,0,0);
                                if(visible){ctx.fillStyle='#888';ctx.fillRect(100,100,width,40)}
                                return command({type:'frame',generation:1,frameId:id,timestamp:id*67,width:320,height:320,pixels:ctx.getImageData(0,0,320,320).data.buffer});
                            };
                            await frame(0,true);
                            // Only the initial true box enters the worker; updates carry pixels alone.
                            const seed=await command({type:'seed',generation:1,frameId:0,detections:[{label:'thin',confidence:.9,box:[100/320,100/320,width/320,40/320]}]});
                            const removed=[];for(let id=1;id<=3;id++)removed.push(await frame(id,false));
                            results.push({width,seed,removed});
                        }
                        return results;
                    } finally {w.terminate()}
                }""")
                for result in results:
                    with self.subTest(width=result['width']):
                        self.assertEqual(result['seed']['type'],'seed')
                        self.assertEqual(result['seed']['tracks'],[],f"width {result['width']} seeded background features")
                        for frame in result['removed']:
                            self.assertEqual(frame['type'],'frame')
                            self.assertEqual(frame['tracks'],[],f"width {result['width']} left phantom tracks")
            finally:
                browser.close()

    def test_worker_capture_replay_revalidation_identity_and_loss(self):
        harness=test_server.HTTPTests()
        with harness.running(transport=lambda req:{'answers':{}}),sync_playwright() as pw:
            browser=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
            page=browser.new_page();page.goto(f'http://127.0.0.1:{harness.port}/')
            result=page.evaluate("""async () => {
                const w=new Worker('tracking-worker.js');await new Promise(r=>w.onmessage=e=>{if(e.data.type==='ready')r()});
                const command=m=>new Promise(resolve=>{w.onmessage=e=>resolve(e.data);w.postMessage(m)});
                const canvas=document.createElement('canvas');canvas.width=320;canvas.height=320;const ctx=canvas.getContext('2d');
                const tile=document.createElement('canvas');tile.width=100;tile.height=100;const tc=tile.getContext('2d');let s=42;
                for(let y=0;y<100;y+=3)for(let x=0;x<100;x+=3){s=(s*1664525+1013904223)>>>0;tc.fillStyle=`rgb(${s%256},${s>>>8&255},${s>>>16&255})`;tc.fillRect(x,y,3,3)}
                const frame=async (id,visible=true,time=id*67,dx=id*2)=>{ctx.fillStyle='#222';ctx.fillRect(0,0,320,320);if(visible)ctx.drawImage(tile,40+dx,80);return command({type:'frame',generation:1,frameId:id,timestamp:time,width:320,height:320,pixels:ctx.getImageData(0,0,320,320).data.buffer})};
                const seed=id=>command({type:'seed',generation:1,frameId:id,detections:[{label:'lighter',confidence:.9,box:[(40+id*2)/320,80/320,100/320,100/320]}]});
                await frame(0);for(let i=1;i<=8;i++)await frame(i);
                const late=await seed(0),identity=late.tracks[0].id;
                for(let i=9;i<=12;i++)await frame(i);
                const associated=await seed(8);
                const lost=await frame(13,false);
                const old=await seed(8);
                for(let i=14;i<=80;i++)await frame(i,false);
                const evicted=await seed(0);
                w.postMessage({type:'reset'});await frame(0);await seed(0);
                const gap=await frame(1,true,500,0);
                const seedAfterGap=await seed(0);
                w.postMessage({type:'reset'});
                const expiredBeforeReplay=await seed(0);
                await frame(0);
                await seed(0);
                let aged,aliveBeforeExpiry;
                for(let i=1;i<=152;i++){aged=await frame(i,true,i*67,0);if(i===149)aliveBeforeExpiry=aged;}
                const proof=await command({type:'proof'});
                w.terminate();return {late,associated,lost,old,evicted,identity,proof,gap,seedAfterGap,expiredBeforeReplay,aged,aliveBeforeExpiry};
            }""")
            self.assertAlmostEqual(result['late']['tracks'][0]['box'][0],56/320,delta=.003)
            self.assertAlmostEqual(result['associated']['tracks'][0]['box'][0],64/320,delta=.003)
            self.assertEqual(result['associated']['tracks'][0]['id'],result['identity'])
            self.assertEqual(len(result['associated']['tracks']),1)
            for key in ('lost','old','evicted','gap','seedAfterGap','expiredBeforeReplay','aged'):self.assertEqual(result[key]['tracks'],[])
            self.assertEqual(len(result['aliveBeforeExpiry']['tracks']),1)
            self.assertTrue(result['proof']['fetchBlocked'])
            print('Worker replay x=',result['late']['tracks'][0]['box'][0], 'associated x=',result['associated']['tracks'][0]['box'][0], 'same ID=',result['identity'],flush=True)
            browser.close()

    def test_live_reset_hidden_stall_source_target_and_worker_failure(self):
        harness=test_server.HTTPTests()
        def upstream(req):
            return {'answers':{'target_0_visible':{'type':'noul','noul':.96},'target_0':{'type':'box','confidence':.9,'box':dict(left=60/640,right=160/640,top=70/360,bottom=170/360)}}}
        with harness.running(transport=upstream),sync_playwright() as pw:
            browser=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
            for action in ('hidden','target','source','stop','stall','worker-error','worker-stall'):
                with self.subTest(action=action):
                    page=browser.new_page();page.add_init_script(CAMERA+"window.workers=[];const NativeWorker=Worker;window.Worker=class extends NativeWorker{constructor(...args){super(...args);workers.push(this)}};")
                    page.goto(f'http://127.0.0.1:{harness.port}/');page.locator('#key').fill('fixture-only');page.locator('#labels').fill('water bottle');page.locator('#cadence').select_option('5000');page.locator('#start').click()
                    page.wait_for_function("() => !!document.querySelector('.box[data-track-id]')")
                    if action=='hidden':page.evaluate("window.fixtureHidden=true;document.dispatchEvent(new Event('visibilitychange'))")
                    elif action=='target':page.locator('#labels').fill('person')
                    elif action=='source':page.locator('#upload').set_input_files({'name':'fixture.png','mimeType':'image/png','buffer':__import__('base64').b64decode(harness.payload()['image'])})
                    elif action=='stop':page.locator('#stop').click()
                    elif action=='stall':page.evaluate('window.freeze=true')
                    elif action=='worker-stall':page.evaluate('workers[0].onmessage=null')
                    else:page.evaluate("workers[0].dispatchEvent(new ErrorEvent('error'))")
                    if action=='worker-error':
                        page.wait_for_function("() => !document.querySelector('.box[data-track-id]')",timeout=1000)
                        # Worker failure must not discard independent, still-fresh
                        # snapshot recognition. It expires at its capture TTL.
                        if page.locator('.box').count():self.assertIn('snapshot',page.locator('.box').inner_text())
                        page.wait_for_function("() => !document.querySelector('.box')",timeout=4500)
                    else:
                        page.wait_for_function("() => !document.querySelector('.box')",timeout=1000)
                    page.wait_for_timeout(150);self.assertEqual(page.locator('.box').count(),0)
                    if action in ('worker-error','worker-stall'):
                        page.wait_for_function("() => document.querySelector('#stage-note').textContent.includes('SNAPSHOT FALLBACK')",timeout=12000)
                        self.assertIn('WORKER-RUNTIME-ERROR' if action=='worker-error' else 'FRAME-TIMEOUT',page.locator('#stage-note').inner_text())
                    page.locator('#stop').click();page.wait_for_timeout(100);page.close()
            browser.close()

    def test_pixels_move_independently_and_weak_semantics_preserve_ids(self):
        harness=test_server.HTTPTests();calls=[];weak=False
        def upstream(req):
            calls.append(time.monotonic());time.sleep(.12)
            answers={}
            for i,(x,y) in enumerate(((60,70),(440,190))):
                answers[f'target_{i}_visible']={'type':'noul','noul':.96}
                answers[f'target_{i}']={'type':'box','confidence':.1 if weak else .9,'box':dict(left=x/640,right=(x+100)/640,top=y/360,bottom=(y+100)/360)}
            return {'answers':answers}
        with harness.running(transport=upstream),sync_playwright() as pw:
            browser=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
            page=browser.new_page();page.add_init_script(CAMERA)
            requests=[];page.on('request',lambda r:requests.append((r.method,r.url)))
            page.goto(f'http://127.0.0.1:{harness.port}/');page.wait_for_timeout(100)
            self.assertFalse(any('opencv' in url or 'worker' in url for _,url in requests))
            page.locator('#key').fill('fixture-only');page.locator('#labels').fill('chapstick, wallet');page.locator('#cadence').select_option('1000');page.locator('#start').click()
            page.wait_for_function("() => document.querySelectorAll('.box[data-track-id]').length===2",timeout=20000)
            # Early recognition during cold loading has no worker frame to seed.
            # Weaken semantics only after the first actual measured tracks exist.
            weak=True
            page.evaluate("window.nodes=[...document.querySelectorAll('.box')];window.positions=nodes.map(n=>parseFloat(n.style.left))")
            # Only image pixels move; no updated coordinates enter the tracker.
            for step in range(1,13):page.evaluate('(x)=>window.dx=x',step*2);page.wait_for_timeout(75)
            page.wait_for_timeout(150)
            result=page.evaluate("() => ({same:nodes.every(n=>n.isConnected),delta:nodes.map((n,i)=>parseFloat(n.style.left)-positions[i]),labels:nodes.map(n=>n.textContent)})")
            self.assertTrue(result['same']);self.assertGreater(result['delta'][0],15);self.assertLess(result['delta'][1],-15)
            self.assertTrue(all('tracking' in s.lower() for s in result['labels']))
            self.assertGreaterEqual(len(calls),2)
            (ROOT/'artifacts').mkdir(exist_ok=True);page.screenshot(path=str(ROOT/'artifacts/tracking-moving-pixels.png'))
            print('Real app opposing-pixel fixture:',result,'gateway calls:',len(calls),flush=True)
            page.evaluate('window.removed=true')
            page.wait_for_function("() => !document.querySelector('.box')",timeout=1500)
            page.locator('#stop').click();page.wait_for_timeout(200)
            self.assertTrue(all(url.startswith(f'http://127.0.0.1:{harness.port}/') for _,url in requests))
            self.assertTrue(all(method=='GET' or url.endswith('/api/detect') for method,url in requests))
            browser.close()
