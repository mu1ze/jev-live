"""Capacity acceptance: real gateway, UI and pixel worker with fixture semantics."""
import json
import unittest
import test_server


class CapacityTests(unittest.TestCase):
    def test_worker_tracks_24_independent_pixel_targets(self):
        from playwright.sync_api import sync_playwright
        harness = test_server.HTTPTests()
        with harness.running(), sync_playwright() as pw:
            browser = pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
            page = browser.new_page()
            page.goto(f'http://127.0.0.1:{harness.port}/')
            result = page.evaluate("""async () => {
                const w=new Worker('tracking-worker.js');
                await new Promise(resolve=>w.onmessage=e=>{if(e.data.type==='ready')resolve()});
                const command=m=>new Promise(resolve=>{w.onmessage=e=>resolve(e.data);w.postMessage(m)});
                const c=document.createElement('canvas');c.width=640;c.height=480;
                const ctx=c.getContext('2d'),tile=document.createElement('canvas');tile.width=48;tile.height=48;
                const tx=tile.getContext('2d');let state=42;
                for(let y=0;y<48;y+=2)for(let x=0;x<48;x+=2){state=(state*1664525+1013904223)>>>0;tx.fillStyle=`rgb(${state&255},${state>>>8&255},${state>>>16&255})`;tx.fillRect(x,y,2,2)}
                const seeds=Array.from({length:24},(_,i)=>({label:`item ${i}`,confidence:.92,box:[(i%8*80+16)/640,(Math.floor(i/8)*160+40)/480,48/640,48/480]}));
                const frame=async id=>{ctx.fillStyle='#222';ctx.fillRect(0,0,640,480);for(let i=0;i<24;i++)ctx.drawImage(tile,i%8*80+16+(i%2?-1:1)*id*.5,Math.floor(i/8)*160+40);const t=performance.now();const r=await command({type:'frame',generation:1,frameId:id,timestamp:id*67,width:640,height:480,pixels:ctx.getImageData(0,0,640,480).data.buffer});return {...r,elapsed:performance.now()-t};};
                await frame(0);const initial=await command({type:'seed',generation:1,frameId:0,detections:seeds});
                const runs=[];for(let id=1;id<=30;id++)runs.push(await frame(id));
                const full=await command({type:'seed',generation:1,frameId:30,detections:[{label:'extra target',confidence:.9,box:[.1,.1,.1,.1]}]});
                const times=runs.map(r=>r.elapsed).sort((a,b)=>a-b);
                w.terminate();return {initial:initial.tracks,runs:runs.map(r=>r.tracks),full:full.tracks,medianMs:times[15],p95Ms:times[28]};
            }""")
            self.assertEqual(len(result['initial']),24)
            ids = [t['id'] for t in result['initial']]
            for tracks in result['runs']:
                self.assertEqual([t['id'] for t in tracks],ids)
            self.assertEqual([t['id'] for t in result['full']],ids)
            for i, track in enumerate(result['runs'][-1]):
                delta = track['box'][0] - result['initial'][i]['box'][0]
                self.assertGreater(delta * (-1 if i % 2 else 1), .015)
            print('24-target synthetic real-worker timing:', {k:result[k] for k in ('medianMs','p95Ms')}, flush=True)
            browser.close()

    def test_ui_accepts_24_max_length_labels_and_rejects_25(self):
        import base64
        from playwright.sync_api import sync_playwright
        harness = test_server.HTTPTests()
        calls = []
        def upstream(req):
            body=json.loads(req.data);calls.append(body)
            return {'answers':{}}
        with harness.running(api_key='fixture-key',transport=upstream), sync_playwright() as pw:
            browser=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
            page=browser.new_page();page.goto(f'http://127.0.0.1:{harness.port}/')
            page.wait_for_function("() => document.querySelector('#key-status').classList.contains('configured')")
            labels=[f'item {i:02d} ' + 'x'*72 for i in range(24)]
            value=', '.join(labels)
            page.locator('#labels').fill(value)
            self.assertEqual(page.locator('#labels').input_value(),value)
            page.locator('#upload').set_input_files({'name':'fixture.png','mimeType':'image/png','buffer':base64.b64decode(harness.payload()['image'])})
            page.wait_for_function("() => !document.querySelector('#analyze').disabled")
            page.locator('#analyze').click()
            page.wait_for_function("() => document.querySelector('#status').textContent==='Image analyzed'")
            self.assertEqual(len(calls),1)
            self.assertEqual(len(calls[0]['questions']),48)
            page.locator('#labels').fill(', '.join(f'item {i}' for i in range(25)))
            page.locator('#analyze').click()
            page.wait_for_function("() => !document.querySelector('#error').hidden")
            self.assertIn('24',page.locator('#error').inner_text())
            self.assertEqual(len(calls),1)
            browser.close()

    def test_gateway_accepts_24_unique_targets_and_rejects_25(self):
        harness = test_server.HTTPTests()
        seen = []
        def upstream(req):
            body = json.loads(req.data)
            seen.append(body)
            answers = {}
            for i in range(len(body['questions']) // 2):
                answers[f'target_{i}_visible'] = {'type':'noul', 'noul':.96}
                answers[f'target_{i}'] = {'type':'box', 'confidence':.92, 'box':dict(left=.1,right=.3,top=.1,bottom=.3)}
            return {'answers':answers}
        with harness.running(transport=upstream):
            for count in (9, 24):
                with self.subTest(count=count):
                    payload = harness.payload()
                    payload['labels'] = [f'item {i}' for i in range(count)]
                    status, _, raw = harness.request('POST', '/api/detect', payload)
                    self.assertEqual(status, 200)
                    self.assertEqual([d['label'] for d in json.loads(raw)['detections']], payload['labels'])
                    self.assertEqual(len(seen[-1]['questions']), count * 2)
            before = len(seen)
            payload = harness.payload()
            payload['labels'] = [f'item {i}' for i in range(25)]
            self.assertEqual(harness.request('POST','/api/detect',payload)[0],400)
            self.assertEqual(len(seen),before)
