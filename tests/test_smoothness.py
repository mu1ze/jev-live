"""Main-thread smoothness in both workflows: real Chromium/app/gateway, fixture answers only."""
import threading
import time
import unittest

import test_server
from test_tracking import CAMERA
from playwright.sync_api import sync_playwright

ANSWER = {'answers': {'target_0_visible': {'type': 'noul', 'noul': .96},
                      'target_0': {'type': 'box', 'confidence': .9,
                                   'box': dict(left=60/640, right=160/640, top=70/360, bottom=170/360)}}}
PROBE = """
window.probe={polls:0,syncEncodes:0,asyncEncodes:0,frames:0};
const interval=window.setInterval;
window.setInterval=function(fn,ms,...rest){if(ms===20)probe.polls++;return interval.call(this,fn,ms,...rest)};
const dataURL=HTMLCanvasElement.prototype.toDataURL;
HTMLCanvasElement.prototype.toDataURL=function(...a){probe.syncEncodes++;return dataURL.apply(this,a)};
const blob=HTMLCanvasElement.prototype.toBlob;
HTMLCanvasElement.prototype.toBlob=function(cb,...a){probe.asyncEncodes++;
  return blob.call(this,b=>window.holdEncode?window.heldEncodes.push(()=>cb(b)):cb(b),...a)};
window.heldEncodes=[];window.holdEncode=false;
const W=Worker;window.Worker=class extends W{postMessage(m,...r){if(m.type==='frame')probe.frames++;return super.postMessage(m,...r)}};
"""


class SmoothnessTests(unittest.TestCase):
    def setUp(self):
        self.harness = test_server.HTTPTests()
        self.calls = []
        self.lock = threading.Lock()

        def upstream(req):
            with self.lock:
                self.calls.append(time.monotonic())
            return ANSWER
        self.server = self.harness.running(transport=upstream)
        self.server.__enter__()
        self.pw = sync_playwright().start()
        self.browser = self.pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
        self.page = self.browser.new_page()
        self.errors = []
        self.page.on('pageerror', lambda e: self.errors.append(str(e)))
        self.page.add_init_script(CAMERA + PROBE)
        self.page.goto(f'http://127.0.0.1:{self.harness.port}/')
        self.page.locator('#key').fill('fixture-only')
        self.page.locator('#labels').fill('water bottle')

    def tearDown(self):
        self.page.locator('#stop').click()
        self.browser.close()
        self.pw.stop()
        self.server.__exit__(None, None, None)
        self.assertEqual(self.errors, [])

    def test_tracking_samples_from_frame_callbacks_without_polling_or_sync_encode(self):
        p = self.page
        p.locator('#start').click()
        p.wait_for_function("() => !!document.querySelector('.box[data-track-id]')", timeout=20000)
        p.evaluate('probe.frames=0')
        p.wait_for_timeout(2000)
        probe = p.evaluate('probe')
        self.assertEqual(probe['polls'], 0, 'requestVideoFrameCallback makes the 20 ms poll redundant')
        self.assertEqual(probe['syncEncodes'], 0, 'JPEG encoding must not block the main thread')
        self.assertGreater(probe['asyncEncodes'], 2)
        # A 30 fps fake camera with a fast local worker should sustain well above 10 Hz.
        self.assertGreaterEqual(probe['frames'], 20, probe)

    def test_actions_encode_off_thread_and_never_send_a_frame_after_stop(self):
        p = self.page
        p.locator('#workflow-mode').select_option('actions')
        p.locator('#start').click()
        p.wait_for_function('() => probe.asyncEncodes>=2', timeout=10000)
        self.assertEqual(p.evaluate('probe'), {**p.evaluate('probe'), 'polls': 0, 'syncEncodes': 0, 'frames': 0})
        p.wait_for_timeout(300)
        p.evaluate('window.holdEncode=true')
        p.wait_for_function('() => heldEncodes.length===1', timeout=5000)
        with self.lock:
            sent = len(self.calls)
        p.locator('#stop').click()
        p.evaluate('heldEncodes.forEach(release=>release());heldEncodes.length=0;window.holdEncode=false')
        p.wait_for_timeout(500)
        with self.lock:
            self.assertEqual(len(self.calls), sent, 'a frame still encoding at Stop must never be sent')
        self.assertEqual(p.locator('#start').is_enabled(), True)


if __name__ == '__main__':
    unittest.main()
