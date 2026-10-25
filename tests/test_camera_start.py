"""Native Chromium fake-camera regressions; fixture answers, no live provider."""
import pathlib
import time
import unittest

import test_server
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
FLAGS = ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']
OBSERVE = """
window.workerReady=false;window.pixelFrames=[];window.seeds=[];
const NativeWorker=Worker;
window.Worker=class extends NativeWorker {
    constructor(...args){super(...args);this.addEventListener('message',e=>{if(e.data.type==='ready')window.workerReady=true});}
    postMessage(m,...args){
        if(m.type==='frame')window.pixelFrames.push({id:m.frameId,generation:m.generation,time:m.timestamp,at:performance.now(),bytes:m.pixels.byteLength});
        if(m.type==='seed')window.seeds.push({generation:m.generation,id:m.frameId});
        return super.postMessage(m,...args);
    }
};
"""


class CameraStartTests(unittest.TestCase):
    def test_native_camera_missing_or_frozen_decoded_counter_keeps_recognizing(self):
        for mode in ('missing', 'frozen', 'throws', 'legacy-missing', 'legacy-frozen', 'legacy-throws', 'legacy-positive'):
            with self.subTest(mode=mode):
                harness = test_server.HTTPTests()
                calls = []
                active = 0
                maximum = 0
                def upstream(req):
                    nonlocal active, maximum
                    active += 1
                    maximum = max(maximum, active)
                    calls.append(time.monotonic())
                    time.sleep(.08)
                    active -= 1
                    return {'answers': {}}
                with harness.running(transport=upstream), sync_playwright() as pw:
                    browser = pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=FLAGS)
                    try:
                        page = browser.new_page(permissions=['camera'])
                        errors = []
                        page.on('pageerror', lambda e: errors.append(str(e)))
                        override = {'missing': 'undefined', 'frozen': '()=>({totalVideoFrames:0})', 'positive': '()=>({totalVideoFrames:1})',
                                    'throws': '()=>{throw new TypeError("fixture unsupported");}'}[mode.removeprefix('legacy-')]
                        page.add_init_script(OBSERVE + 'HTMLVideoElement.prototype.getVideoPlaybackQuality=' + override + ';')
                        if mode.startswith('legacy-'):
                            page.add_init_script('HTMLVideoElement.prototype.requestVideoFrameCallback=undefined;')
                        page.goto(f'http://127.0.0.1:{harness.port}/')
                        page.locator('#key').fill('fixture-only')
                        page.locator('#cadence').select_option('0')
                        page.locator('#start').click()
                        page.wait_for_function('() => window.workerReady', timeout=15000)
                        page.wait_for_timeout(1000)
                        self.assertFalse(errors)
                        self.assertGreaterEqual(len(calls), 4, 'Optional frame counters cannot gate recognition')
                        pixels = page.evaluate('window.pixelFrames')
                        self.assertGreaterEqual(len(pixels), 5)
                        self.assertTrue(all(b['time']-a['time'] >= 32 for a, b in zip(pixels, pixels[1:])), pixels)
                        self.assertEqual(maximum, 1)
                        page.locator('#stop').click()
                        page.wait_for_timeout(150)
                    finally:
                        browser.close()

    def test_native_preview_and_recognition_do_not_wait_for_worker_loading(self):
        harness = test_server.HTTPTests()
        calls = []
        def upstream(req):
            calls.append(time.monotonic())
            return {'answers': {'target_0_visible': {'type': 'noul', 'noul': .99},
                                'target_0': {'type': 'box', 'confidence': .95,
                                             'box': dict(left=.1, top=.1, right=.9, bottom=.9)}}}
        with harness.running(transport=upstream), sync_playwright() as pw:
            browser = pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=FLAGS)
            try:
                page = browser.new_page(permissions=['camera'])
                page.add_init_script(OBSERVE)
                # The actual OpenCV worker still initializes, but on a slow cold path.
                worker = (ROOT/'static/tracking-worker.js').read_text()
                page.route('**/tracking-worker.js', lambda route: route.fulfill(
                    body='const coldUntil=performance.now()+2000;while(performance.now()<coldUntil){};\n'+worker,
                    content_type='text/javascript'))
                page.goto(f'http://127.0.0.1:{harness.port}/')
                page.locator('#key').fill('fixture-only')
                page.locator('#start').click()
                page.wait_for_function("() => document.querySelector('#status').textContent==='Camera live'", timeout=1500)
                page.wait_for_timeout(600)
                self.assertFalse(page.evaluate('window.workerReady'))
                self.assertGreaterEqual(len(calls), 2, 'Recognition must run while the pixel worker is loading')
                page.wait_for_function('() => window.workerReady && window.pixelFrames.length>=3', timeout=15000)
                pixels = page.evaluate('window.pixelFrames')
                self.assertTrue(all(f['bytes'] > 0 and f['at']-f['time'] < 100 for f in pixels))
                self.assertEqual(len({f['id'] for f in pixels}), len(pixels))
                page.wait_for_function("() => !!document.querySelector('.box[data-track-id]')", timeout=10000)
                self.assertTrue(page.evaluate('window.seeds.every(s=>window.pixelFrames.some(f=>f.id===s.id && f.generation===s.generation))'))
                # A new camera source while the old worker is still cold must
                # terminate that worker and never seed its generation later.
                page.locator('#stop').click()
                page.locator('#start').click()
                page.wait_for_timeout(100)
                page.evaluate('window.oldSource=document.querySelector("#video").srcObject')
                page.locator('#stop').click()
                self.assertTrue(page.evaluate('window.oldSource.getTracks().every(t=>t.readyState==="ended")'))
                page.evaluate('window.pixelFrames=[];window.seeds=[];window.workerReady=false')
                page.locator('#start').click()
                page.wait_for_function("() => window.workerReady && !!document.querySelector('.box[data-track-id]')", timeout=15000)
                self.assertEqual(len(page.evaluate('[...new Set(window.pixelFrames.map(f=>f.generation))]')), 1)
                self.assertTrue(page.evaluate('window.seeds.every(s=>window.pixelFrames.some(f=>f.id===s.id && f.generation===s.generation))'))
                page.locator('#stop').click()
                page.wait_for_timeout(150)
            finally:
                browser.close()
