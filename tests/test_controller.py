"""Controller workflow in real Chromium with the real on-device MediaPipe models."""
import base64
import hashlib
import json
import unittest
from pathlib import Path

import test_server as server_tests
try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sync_playwright = None

ROOT = Path(__file__).resolve().parents[1]
HAND = base64.b64encode((ROOT / 'tests/fixtures/hand-thumb-up.jpg').read_bytes()).decode()

# Replace the camera with a canvas showing a fixture photo, so the real tracker
# sees a real hand. Records requested constraints and every network request.
CAMERA_FIXTURE = """
    window.cameraRequests=[];
    window.useHandPhoto=false;
    const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia=async constraints=>{
        window.cameraRequests.push(constraints);
        if(!window.useHandPhoto)return original(constraints);
        const canvas=document.createElement('canvas');canvas.width=640;canvas.height=480;
        const ctx=canvas.getContext('2d'), bytes=Uint8Array.from(atob(window.handPhoto),c=>c.charCodeAt(0));
        const image=await createImageBitmap(new Blob([bytes],{type:'image/jpeg'}));
        const draw=()=>{ctx.fillStyle='#ddd';ctx.fillRect(0,0,640,480);ctx.drawImage(image,(640-480*image.width/image.height)/2,0,480*image.width/image.height,480);window.photoFrame=requestAnimationFrame(draw);};
        draw();
        return canvas.captureStream(30);
    };
"""


@unittest.skipIf(sync_playwright is None, 'Install optional playwright to run real browser tests')
class ControllerBrowserTests(unittest.TestCase):
    def setUp(self):
        self.harness = server_tests.HTTPTests()
        self.server = self.harness.running(transport=lambda req: self.fail('controller must never call the detection provider'))
        self.server.__enter__()
        self.pw = sync_playwright().start()
        self.browser = self.pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'])
        self.page = self.browser.new_page(permissions=['camera'], viewport={'width': 1280, 'height': 1000})
        self.errors = []
        self.page.on('pageerror', lambda e: self.errors.append(str(e)))
        self.requests = []
        self.page.on('request', lambda req: self.requests.append(req.url))
        self.page.add_init_script(CAMERA_FIXTURE + f'window.handPhoto="{HAND}";if(!sessionStorage.getItem("keepBest"))localStorage.clear();')
        self.page.goto(f'http://127.0.0.1:{self.harness.port}/')
        self.page.locator('#workflow-mode').select_option('controller')

    def tearDown(self):
        self.page.locator('#stop').click()
        self.browser.close(); self.pw.stop(); self.server.__exit__(None, None, None)
        self.assertEqual(self.errors, [])

    def wait_ready(self, kind='Hand'):
        self.page.wait_for_function(f'() => document.querySelector("#controller-state").textContent.includes("{kind} tracker ready")', timeout=60000)

    def test_controller_needs_no_key_uses_front_camera_and_sends_nothing(self):
        p = self.page
        self.assertTrue(p.locator('#controller-panel').is_visible())
        for hidden in ('#key', '#labels', '#confidence', '#upload', '.telemetry', '#results', '.visual-actions'):
            self.assertFalse(p.locator(hidden).first.is_visible(), hidden)
        self.assertEqual(p.locator('#key').input_value(), '')
        p.locator('#start').click()
        self.wait_ready()
        self.assertEqual(p.evaluate('cameraRequests[0].video.facingMode'), 'user')
        self.assertTrue(p.locator('#game-canvas').is_visible())
        self.assertEqual(p.evaluate('getComputedStyle(document.querySelector("#video")).transform'), 'matrix(-1, 0, 0, 1, 0, 0)', 'selfie view is mirrored')
        self.assertIn('NOTHING SENT', p.locator('#source-label').inner_text())
        # The tracker keeps processing camera frames (fake camera: nobody in view).
        p.wait_for_function('() => /· [1-9]\\d* fps/.test(document.querySelector("#controller-state").textContent)', timeout=30000)
        self.assertIn('Show one hand', p.locator('#controller-readout').inner_text())
        self.assertFalse(any('api/detect' in url or 'tracking-worker' in url or 'opencv' in url for url in self.requests))
        self.assertTrue(all(url.startswith(f'http://127.0.0.1:{self.harness.port}/') or url.startswith(('blob:', 'data:')) for url in self.requests), [u for u in self.requests if '127.0.0.1' not in u])
        # Leaving the controller releases the front camera and restores detection controls.
        p.evaluate('window.stream0=document.querySelector("#video").srcObject')
        p.locator('#workflow-mode').select_option('tracking')
        self.assertTrue(p.evaluate('stream0.getTracks().every(t => t.readyState === "ended")'))
        self.assertFalse(p.locator('#controller-panel').is_visible())
        self.assertFalse(p.locator('#game-canvas').is_visible())
        self.assertTrue(p.locator('#key').is_visible())
        self.assertIn('Start camera', p.locator('#status').inner_text())

    def test_real_hand_gesture_starts_the_game(self):
        p = self.page
        p.evaluate('window.useHandPhoto=true')
        p.locator('#start').click()
        self.wait_ready()
        # The photo shows a thumbs-up: fingers curled = fist = press.
        p.wait_for_function('() => document.querySelector("#controller-readout").textContent.includes("Hand seen")', timeout=60000)
        readout = p.locator('#controller-readout').inner_text()
        self.assertIn('PRESSED', readout)
        self.assertIn('fist', readout)
        p.wait_for_function('() => document.querySelector("#game-play").textContent === "Pause"', timeout=10000)
        self.assertEqual(p.locator('#game-announce').inner_text(), 'Star Catch started')
        # The hand leaves the frame: the game pauses instead of losing lives.
        p.evaluate('cancelAnimationFrame(window.photoFrame); window.useHandPhoto=false')
        p.evaluate("""() => { const v=document.querySelector('#video'); const c=document.createElement('canvas'); c.width=640;c.height=480;
            const x=c.getContext('2d'); const draw=()=>{x.fillStyle='#ddd';x.fillRect(0,0,640,480);requestAnimationFrame(draw)}; draw(); v.srcObject=c.captureStream(30); }""")
        p.wait_for_function('() => document.querySelector("#game-play").textContent === "Resume"', timeout=20000)
        self.assertIn('Paused', p.locator('#game-announce').inner_text())

    def test_head_mode_loads_the_face_tracker(self):
        p = self.page
        p.locator('#controller-input').select_option('head')
        p.locator('#start').click()
        self.wait_ready('Face')
        p.wait_for_function('() => /· [1-9]\\d* fps/.test(document.querySelector("#controller-state").textContent)', timeout=30000)
        self.assertIn('Face the camera', p.locator('#controller-readout').inner_text())
        self.assertTrue(p.locator('#controller-recenter').is_enabled())

    def test_touch_mouse_keys_play_without_a_camera(self):
        p = self.page
        p.locator('#controller-input').select_option('pointer')
        self.assertTrue(p.locator('#controller-recenter').is_disabled())
        self.assertEqual(p.evaluate('cameraRequests.length'), 0)
        box = p.locator('#game-canvas').bounding_box()
        p.mouse.click(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2)
        p.wait_for_function('() => document.querySelector("#game-play").textContent === "Pause"')
        p.locator('#game-play').click()
        self.assertEqual(p.locator('#game-play').inner_text(), 'Resume')
        p.locator('#game-play').click()
        p.locator('#game-canvas').press('Space')
        # Switch to Bubble Pop and play with keys only: arrows move, Space presses.
        p.locator('[data-game="pop"]').click()
        self.assertEqual(p.locator('[data-game="pop"]').get_attribute('aria-pressed'), 'true')
        self.assertIn('45 seconds', p.locator('#game-help').inner_text())
        self.assertEqual(p.locator('#game-play').inner_text(), 'Play')
        p.locator('#game-canvas').focus()
        p.keyboard.press('Space')
        p.wait_for_function('() => document.querySelector("#game-play").textContent === "Pause"')
        p.keyboard.down('ArrowLeft'); p.wait_for_timeout(400); p.keyboard.up('ArrowLeft')
        self.assertEqual(p.evaluate('scrollY'), 0, 'game keys do not scroll the page')
        self.assertEqual(p.evaluate('cameraRequests.length'), 0, 'no camera needed for touch / mouse / keys')
        self.assertTrue(p.locator('#game-score').inner_text().startswith('Score '))

    def test_best_score_is_kept_on_this_device(self):
        p = self.page
        p.evaluate("sessionStorage.setItem('keepBest','1'); localStorage.setItem('jev-live.controller.v1', JSON.stringify({version:1,best:{catch:12}}))")
        p.reload()
        p.locator('#workflow-mode').select_option('controller')
        self.assertEqual(p.locator('#game-score').inner_text(), 'Score 0 · Best 12')


class ControllerServingTests(unittest.TestCase):
    def test_worker_csp_and_vendored_runtime(self):
        harness = server_tests.HTTPTests()
        with harness.running():
            status, headers, _ = harness.request('GET', '/gesture-worker.mjs')
            self.assertEqual(status, 200)
            policy = headers['Content-Security-Policy']
            self.assertIn("connect-src 'self'", policy, 'the worker can only fetch this app: telemetry is blocked')
            self.assertIn("'wasm-unsafe-eval'", policy)
            self.assertNotIn("'unsafe-eval'", policy.replace("'wasm-unsafe-eval'", ''))
            page_policy = harness.request('GET', '/')[1]['Content-Security-Policy']
            self.assertNotIn('wasm-unsafe-eval', page_policy, 'the page itself never runs wasm')
            manifest = json.loads((ROOT / 'static/gesturevendor/asset-manifest.json').read_text())
            for asset in manifest['assets']:
                body = (ROOT / 'static/gesturevendor' / asset['file']).read_bytes()
                self.assertEqual(hashlib.sha256(body).hexdigest(), asset['sha256'], asset['file'])
                status, headers, data = harness.request('GET', '/gesturevendor/' + asset['file'], headers={'Accept-Encoding': 'gzip'})
                self.assertEqual(status, 200, asset['file'])
            self.assertEqual(harness.request('GET', '/gesturevendor/vision_wasm_module_internal.wasm')[1]['Content-Type'], 'application/wasm')
            self.assertEqual(harness.request('GET', '/gesturevendor/hand_landmarker.task', headers={'Accept-Encoding': 'gzip'})[1].get('Content-Encoding'), 'gzip')
            self.assertEqual(harness.request('GET', '/gesturevendor/vision_bundle.mjs.map')[0], 404)
        with harness.running(access_token='b' * 32):
            self.assertEqual(harness.request('GET', '/gesturevendor/hand_landmarker.task')[0], 401)


if __name__ == '__main__':
    unittest.main()
