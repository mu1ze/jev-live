"""Real OpenCV worker, synthetic pixels only. No provider or user footage."""
import json
import pathlib
import unittest
import test_server
from playwright.sync_api import sync_playwright
ROOT = pathlib.Path(__file__).resolve().parents[1]

class StabilityTests(unittest.TestCase):
    def run_fixture(self, script):
        harness = test_server.HTTPTests()
        with harness.running(), sync_playwright() as pw:
            browser = pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
            try:
                page = browser.new_page()
                page.goto(f'http://127.0.0.1:{harness.port}/')
                return page.evaluate(script)
            finally:
                browser.close()

    def test_delayed_capture_replays_beyond_16_frames_and_reports_expiry(self):
        result = self.run_fixture("""async () => {
            const w=new Worker('tracking-worker.js');
            await new Promise(r=>w.onmessage=e=>{if(e.data.type==='ready')r()});
            const command=m=>new Promise(resolve=>{w.onmessage=e=>resolve(e.data);w.postMessage(m)});
            const c=document.createElement('canvas');c.width=320;c.height=320;const ctx=c.getContext('2d');
            const tile=document.createElement('canvas');tile.width=80;tile.height=80;const tx=tile.getContext('2d');let s=42;
            for(let y=0;y<80;y+=2)for(let x=0;x<80;x+=2){s=(s*1664525+1013904223)>>>0;tx.fillStyle=`rgb(${s&255},${s>>>8&255},${s>>>16&255})`;tx.fillRect(x,y,2,2)}
            const frame=async id=>{ctx.fillStyle='#222';ctx.fillRect(0,0,320,320);ctx.drawImage(tile,40+id*.5,100);return command({type:'frame',generation:1,frameId:id,timestamp:id*100/3,width:320,height:320,pixels:ctx.getImageData(0,0,320,320).data.buffer})};
            const seed=()=>command({type:'seed',generation:1,frameId:0,detections:[{label:'fixture',confidence:.9,box:[40/320,100/320,.25,.25]}]});
            try {
                await frame(0);for(let i=1;i<=45;i++)await frame(i);const at1500=await seed();
                for(let i=46;i<=75;i++)await frame(i);const at2500=await seed();
                for(let i=76;i<=121;i++)await frame(i);const expired=await seed();
                return {at1500,at2500,expired};
            } finally {w.terminate()}
        }""")
        self.assertEqual(len(result['at1500']['tracks']), 1)
        self.assertEqual(len(result['at2500']['tracks']), 1)
        self.assertEqual(len(result['at2500'].get('seedResult', {}).get('accepted', [])), 1, '2.5s capture must replay, not merely leave an earlier track alive')
        self.assertAlmostEqual(result['at2500']['tracks'][0]['box'][0], 77.5/320, delta=.005)
        self.assertEqual(result['expired']['diagnostics']['rejects']['capture-frame-expired'], 1)
        self.assertLessEqual(result['at2500']['diagnostics']['historyBytes'], 48*1024*1024)
        print('Delayed-seed real-worker:', json.dumps({k: {'tracks': len(v['tracks']), 'diagnostics': v['diagnostics']} for k,v in result.items()}), flush=True)
