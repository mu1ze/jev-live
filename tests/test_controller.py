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
        self.assertEqual(p.evaluate('document.querySelector("#video").style.width'), '', 'other workflows get the normal video layout back')
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
        # The camera picture fills the stage, scaled like the aim (reach 1.25×), so
        # the aim, the drawn landmarks and the hand in the picture line up.
        cover = p.evaluate("""() => { const v=document.querySelector('#video').getBoundingClientRect(), s=document.querySelector('#stage').getBoundingClientRect();
            return {left: v.left - s.left, right: v.right - s.right, top: v.top - s.top, bottom: v.bottom - s.bottom, scale: Math.max(v.width / s.width, v.height / s.height)}; }""")
        self.assertLessEqual(cover['left'], 0.5); self.assertGreaterEqual(cover['right'], -0.5)
        self.assertLessEqual(cover['top'], 0.5); self.assertGreaterEqual(cover['bottom'], -0.5)
        self.assertGreaterEqual(cover['scale'], 1.24)
        # The controls legend lights up the gesture the tracker recognised.
        p.wait_for_function('() => document.querySelector("#controller-legend [data-control=fist]").hasAttribute("data-active")', timeout=10000)
        p.wait_for_function('() => document.querySelector("#game-play").textContent === "Pause"', timeout=10000)
        self.assertEqual(p.locator('#game-announce').inner_text(), 'Star Catch started')
        # The hand leaves the frame: the game pauses instead of losing lives.
        p.evaluate('cancelAnimationFrame(window.photoFrame); window.useHandPhoto=false')
        p.evaluate("""() => { const v=document.querySelector('#video'); const c=document.createElement('canvas'); c.width=640;c.height=480;
            const x=c.getContext('2d'); const draw=()=>{x.fillStyle='#ddd';x.fillRect(0,0,640,480);requestAnimationFrame(draw)}; draw(); v.srcObject=c.captureStream(30); }""")
        p.wait_for_function('() => document.querySelector("#game-play").textContent === "Resume"', timeout=20000)
        self.assertIn('Paused', p.locator('#game-announce').inner_text())

    def test_controls_legend_matches_input_and_game(self):
        p = self.page
        legend = p.locator('#controller-legend li')
        self.assertEqual(legend.count(), 3)
        self.assertIn('Open hand', legend.nth(0).inner_text())
        self.assertIn('Move left / right', legend.nth(0).inner_text())
        self.assertIn('Pinch', legend.nth(1).inner_text())
        p.locator('[data-game="glide"]').click()
        self.assertIn('Move up / down', legend.nth(0).inner_text())
        p.locator('#controller-input').select_option('head')
        self.assertIn('Open mouth', p.locator('#controller-legend').inner_text())
        p.locator('#controller-input').select_option('pointer')
        self.assertEqual(legend.count(), 2)
        self.assertIn('Space', legend.nth(1).inner_text())

    def test_bubble_pop_is_hand_or_touch_and_aims_with_the_finger(self):
        p = self.page
        select = p.locator('#controller-input')
        select.select_option('head')
        p.locator('[data-game="pop"]').click()
        # A head player is moved to their hand, and Head can't be picked here.
        self.assertEqual(select.input_value(), 'hand')
        self.assertTrue(p.locator('#controller-input option[value="head"]').is_disabled())
        self.assertIn('not for Bubble Pop', p.locator('#controller-input option[value="head"]').inner_text())
        self.assertIn('switched to hand', p.locator('#game-announce').inner_text())
        self.assertIn('Index finger', p.locator('#controller-legend li').nth(0).inner_text())
        self.assertIn('index finger', p.locator('#controller-input-help').inner_text())
        self.assertFalse(p.locator('#controller-input option[value="pointer"]').is_disabled())
        # Other games take every input again, with the palm aim.
        p.locator('[data-game="catch"]').click()
        self.assertFalse(p.locator('#controller-input option[value="head"]').is_disabled())
        self.assertEqual(p.locator('#controller-input option[value="head"]').inner_text(), 'Head')
        self.assertIn('Open hand', p.locator('#controller-legend li').nth(0).inner_text())
        select.select_option('head')
        self.assertEqual(select.input_value(), 'head')

    def test_worker_builds_a_second_model_and_the_cpu_fallback(self):
        # MediaPipe clears self.ModuleFactory after each build; the worker must
        # restore it or switching hand→head and the GPU→CPU fallback both fail.
        result = self.page.evaluate("""async () => {
            const w = new Worker('gesture-worker.mjs', {type: 'module'});
            const ask = message => new Promise(resolve => { w.onmessage = e => resolve(e.data); w.onerror = e => resolve({type: 'error'}); setTimeout(() => resolve({type: 'timeout'}), 60000); w.postMessage(message); });
            const replies = [await ask({type: 'load', mode: 'hand'}), await ask({type: 'load', mode: 'face', delegate: 'CPU'})];
            w.terminate();
            return replies.map(r => r.type + ':' + (r.delegate || r.message));
        }""")
        self.assertEqual(result[0][:6], 'ready:')
        self.assertEqual(result[1], 'ready:CPU')

    def test_head_mode_loads_the_face_tracker(self):
        p = self.page
        p.locator('#start').click()
        self.wait_ready('Hand')
        # Switching input while the camera runs reuses the same worker.
        p.locator('#controller-input').select_option('head')
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


def engine_available(name):
    if sync_playwright is None:
        return False
    try:
        with sync_playwright() as pw:
            browser = getattr(pw, name).launch(headless=True)
            browser.close()
            return True
    except Exception:
        return False


class ControllerEngineTests(unittest.TestCase):
    """The tracker worker must load in Firefox and Safari's engine too, each
    building both models in one worker, and track a real hand photo where the
    browser has WebGL in workers. Playwright's Linux WebKit has none (Safari
    17+ does), so there it checks loading only, on the CPU fallback."""
    def check(self, engine):
        if not engine_available(engine):
            self.skipTest(f'Install Playwright {engine} (and its system libraries) to run this check')
        harness = server_tests.HTTPTests()
        with harness.running(), sync_playwright() as pw:
            browser = getattr(pw, engine).launch(headless=True)
            page = browser.new_page()
            page.goto(f'http://127.0.0.1:{harness.port}/')
            replies = page.evaluate("""async photo => {
                const w = new Worker('gesture-worker.mjs', {type: 'module'});
                const ask = (message, transfer) => new Promise(resolve => { w.onmessage = e => resolve(e.data); w.onerror = () => resolve({type: 'worker error'}); setTimeout(() => resolve({type: 'timeout'}), 60000); w.postMessage(message, transfer || []); });
                const replies = [(await ask({type: 'load', mode: 'hand'})).type, (await ask({type: 'load', mode: 'face'})).type];
                const bytes = Uint8Array.from(atob(photo), c => c.charCodeAt(0));
                const bitmap = await createImageBitmap(new Blob([bytes], {type: 'image/jpeg'}));
                const result = await ask({type: 'frame', id: 1, mode: 'hand', bitmap, timestamp: 1}, [bitmap]);
                // MediaPipe needs WebGL inside the worker to read frames, even on CPU.
                replies.push(result.points && result.world ? 'hand found' : /GLctx/.test(result.message || '') ? 'no worker WebGL' : 'no hand: ' + result.type + ' ' + (result.message || ''));
                w.terminate();
                return replies;
            }""", HAND)
            browser.close()
        self.assertEqual(replies[:2], ['ready', 'ready'])
        if replies[2] == 'no worker WebGL':
            self.assertEqual(engine, 'webkit', 'only Linux WebKit lacks WebGL in workers (Safari 17+ has it)')
        else:
            self.assertEqual(replies[2], 'hand found')

    def test_trackers_load_in_firefox(self):
        self.check('firefox')

    def test_trackers_load_in_webkit(self):
        self.check('webkit')


class ControllerServingTests(unittest.TestCase):
    def test_worker_csp_and_vendored_runtime(self):
        harness = server_tests.HTTPTests()
        with harness.running():
            status, headers, _ = harness.request('GET', '/gesture-worker.mjs')
            self.assertEqual(status, 200)
            policy = headers['Content-Security-Policy']
            self.assertIn("connect-src 'self'", policy, 'the worker can only fetch this app: telemetry is blocked')
            self.assertIn("worker-src 'self'", policy, "Firefox checks a module worker's own imports against worker-src")
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
