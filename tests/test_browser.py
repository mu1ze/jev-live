"""Real Chromium tests. All upstream answers here are explicit test fixtures."""
import json
import unittest

import test_server as server_tests
try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sync_playwright = None

@unittest.skipIf(sync_playwright is None, 'Install optional playwright to run real browser tests')
class BrowserTests(unittest.TestCase):
    def test_target_rate_uses_capture_start_interval_with_serial_requests(self):
        import time
        for latency in (.06, .40):
            with self.subTest(fixture_latency=latency):
                harness=server_tests.HTTPTests()
                starts=[]; active=0; maximum=0
                def fixture(req):
                    nonlocal active, maximum
                    active+=1; maximum=max(maximum,active); starts.append(time.monotonic())
                    time.sleep(latency)
                    active-=1
                    return {'answers': {}}
                with harness.running(transport=fixture), sync_playwright() as pw:
                    browser=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'])
                    page=browser.new_page(permissions=['camera'])
                    page.goto(f'http://127.0.0.1:{harness.port}/')
                    self.assertEqual(page.locator('#cadence').input_value(),'250')
                    self.assertEqual(page.locator('#cadence option').evaluate_all('(items)=>items.map(x=>x.value)'),['0','250','500','1000','5000'])
                    page.locator('#key').fill('fixture-secret');page.locator('#start').click()
                    deadline=time.monotonic()+5
                    while len(starts)<5 and time.monotonic()<deadline: page.wait_for_timeout(50)
                    self.assertEqual(page.locator('#rate').count(),1,'Expose measured completed detections/sec separately')
                    measured=float(page.locator('#rate').inner_text().split()[0])
                    self.assertGreater(measured,1)
                    self.assertLess(measured,5)
                    if latency>.25: self.assertLess(measured,3)
                    page.locator('#stop').click()
                    self.assertEqual(page.locator('#rate').inner_text(),'0.0 /s')
                    self.assertGreaterEqual(len(starts),5)
                    intervals=[b-a for a,b in zip(starts,starts[1:5])]
                    mean=sum(intervals)/len(intervals)
                    print(f'fixture latency={latency:.2f}s start intervals={intervals}, mean={mean:.3f}s',flush=True)
                    self.assertGreater(mean,max(.25,latency)-.04)
                    self.assertLess(mean,max(.25,latency)+.14)
                    self.assertEqual(maximum,1)
                    page.wait_for_timeout(int(latency*1000)+100)
                    browser.close()

    def test_auto_errors_back_off_exponentially(self):
        import time
        harness=server_tests.HTTPTests(); starts=[]
        def fixture(req):
            starts.append(time.monotonic())
            raise RuntimeError('fixture failure, not a production API')
        with harness.running(transport=fixture), sync_playwright() as pw:
            browser=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'])
            page=browser.new_page(permissions=['camera'])
            page.goto(f'http://127.0.0.1:{harness.port}/');page.locator('#key').fill('fixture-secret')
            page.locator('#cadence').select_option('0');page.locator('#start').click()
            page.wait_for_timeout(800)
            self.assertEqual(len(starts),1,'Auto must not hammer a failing upstream')
            deadline=time.monotonic()+11
            while len(starts)<3 and time.monotonic()<deadline: page.wait_for_timeout(100)
            page.locator('#stop').click();page.wait_for_timeout(100)
            self.assertEqual(len(starts),3)
            gaps=[b-a for a,b in zip(starts,starts[1:])]
            print(f'fixture API error retry intervals={gaps}',flush=True)
            self.assertGreaterEqual(gaps[0],2.95);self.assertGreaterEqual(gaps[1],5.95)
            browser.close()

    def test_hidden_tab_pauses_and_visible_resumes_auto_without_camera_restart(self):
        import time
        harness=server_tests.HTTPTests(); calls=[]
        def fixture(req):
            calls.append(time.monotonic());time.sleep(.1)
            return {'answers': {}}
        with harness.running(transport=fixture), sync_playwright() as pw:
            browser=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'])
            page=browser.new_page(permissions=['camera'])
            # Deterministic visibility fixture: still runs the actual browser event path.
            page.add_init_script("window.fixtureHidden=false;Object.defineProperty(document,'hidden',{get:()=>window.fixtureHidden});")
            page.goto(f'http://127.0.0.1:{harness.port}/');page.locator('#key').fill('fixture-secret')
            page.locator('#cadence').select_option('0');page.locator('#start').click()
            page.wait_for_timeout(500)
            self.assertGreaterEqual(len(calls),2,'Auto should run continuous serial requests')
            page.evaluate("window.fixtureHidden=true;document.dispatchEvent(new Event('visibilitychange'))")
            count=len(calls);page.wait_for_timeout(600)
            self.assertEqual(len(calls),count,'Hidden pages must not send more snapshots')
            page.evaluate("window.fixtureHidden=false;document.dispatchEvent(new Event('visibilitychange'))")
            page.wait_for_timeout(500)
            self.assertGreater(len(calls),count)
            page.locator('#stop').click();page.wait_for_timeout(200)
            count=len(calls)
            page.evaluate("document.dispatchEvent(new Event('visibilitychange'))")
            page.wait_for_timeout(300);self.assertEqual(len(calls),count)
            browser.close()

    def test_server_key_is_explicitly_optional_and_never_exposed(self):
        harness=server_tests.HTTPTests(); calls=[]
        def fixture(req):
            calls.append(req.get_header('Authorization'))
            return {'answers': {}}
        with harness.running(api_key='fixture-server-only-secret',transport=fixture), sync_playwright() as pw:
            browser=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'])
            page=browser.new_page(permissions=['camera']);page.goto(f'http://127.0.0.1:{harness.port}/')
            page.wait_for_function("() => document.querySelector('#key-hint').textContent.includes('configured')")
            self.assertIn('optional',page.locator('#key-hint').inner_text().lower())
            self.assertIn('secure',page.locator('#key-status').inner_text().lower())
            self.assertNotIn('fixture-server-only-secret',page.content())
            self.assertEqual(page.locator('#key').input_value(),'')
            self.assertEqual(calls,[])
            page.locator('#start').click();page.wait_for_timeout(400);page.locator('#stop').click()
            self.assertTrue(calls)
            self.assertEqual(calls[0],'Bearer fixture-server-only-secret')
            browser.close()

    def test_stop_restart_keeps_old_request_serial_and_discards_its_boxes(self):
        import threading
        harness=server_tests.HTTPTests(); release=threading.Event(); entered=threading.Event()
        calls=[];active=0;maximum=0
        def fixture(req):
            nonlocal active, maximum
            active+=1;maximum=max(maximum,active);calls.append(req)
            entered.set();release.wait(3)
            active-=1
            return {'answers': {'target_0_visible': {'type':'noul','noul':.96},'target_0':{'type':'box','box':{'left':.1,'right':.7,'top':.2,'bottom':.8},'confidence':.88}}}
        with harness.running(transport=fixture), sync_playwright() as pw:
            browser=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'])
            page=browser.new_page(permissions=['camera']);page.goto(f'http://127.0.0.1:{harness.port}/')
            page.locator('#key').fill('fixture-secret');page.locator('#start').click()
            page.wait_for_function("() => document.querySelector('#status').textContent === 'Asking Jev…'")
            self.assertTrue(entered.wait(2))
            page.locator('#stop').click();page.locator('#start').click()
            page.wait_for_function("() => document.querySelector('video').srcObject !== null")
            page.wait_for_timeout(350)
            self.assertEqual(len(calls),1)
            self.assertEqual(page.locator('#boxes .box').count(),0)
            release.set()
            page.wait_for_function("() => document.querySelector('#count').textContent === '1'")
            page.locator('#stop').click()
            self.assertGreaterEqual(len(calls),2)
            self.assertEqual(maximum,1)
            browser.close()

    def test_network_failure_also_respects_auto_backoff(self):
        import time
        harness=server_tests.HTTPTests(); starts=[]
        with harness.running(transport=lambda req: {'answers': {}}), sync_playwright() as pw:
            browser=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'])
            page=browser.new_page(permissions=['camera'])
            def failed_network(route):
                starts.append(time.monotonic());route.abort('failed')
            page.route('**/api/detect',failed_network)
            page.goto(f'http://127.0.0.1:{harness.port}/');page.locator('#key').fill('fixture-secret')
            page.locator('#cadence').select_option('0');page.locator('#start').click()
            page.locator('#error').wait_for(state='visible')
            page.wait_for_timeout(600);self.assertEqual(len(starts),1)
            deadline=time.monotonic()+4
            while len(starts)<2 and time.monotonic()<deadline:page.wait_for_timeout(100)
            page.locator('#stop').click()
            self.assertEqual(len(starts),2)
            self.assertGreaterEqual(starts[1]-starts[0],2.95)
            browser.close()

    def test_late_replies_target_changes_errors_and_single_inflight(self):
        import threading
        harness=server_tests.HTTPTests(); release=threading.Event(); entered=threading.Event(); calls=[]
        def fixture(req):
            calls.append(json.loads(req.data));entered.set()
            release.wait(3)
            if len(calls)==3: raise RuntimeError('fixture-secret')
            return {'answers': {'target_0_visible': {'type':'noul','noul':.96},'target_0':{'type':'box','box':{'left':.1,'right':.7,'top':.2,'bottom':.8},'confidence':.88}}}
        with harness.running(transport=fixture), sync_playwright() as pw:
            browser=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'])
            page=browser.new_page(permissions=['camera']); page.goto(f'http://127.0.0.1:{harness.port}/')
            page.locator('#key').fill('fixture-secret');page.locator('#labels').fill('mug');page.locator('#start').click()
            page.wait_for_function("() => document.querySelector('#status').textContent === 'Asking Jev…'")
            self.assertTrue(entered.wait(2))
            page.locator('#stop').click();page.locator('#start').click()
            page.locator('#labels').fill('person')
            self.assertEqual(len(calls),1)
            release.set()
            page.wait_for_timeout(400)
            self.assertEqual(page.locator('#boxes .box').count(),0)
            page.locator('#stop').click()
            raw=__import__('base64').b64decode(harness.payload()['image'])
            page.locator('#upload').set_input_files({'name':'fixture.png','mimeType':'image/png','buffer':raw})
            page.locator('#analyze').click();page.wait_for_function("() => document.querySelector('#count').textContent === '1'")
            self.assertIn('person',page.locator('.box-label').inner_text())
            page.locator('#analyze').click();page.locator('#error').wait_for(state='visible')
            self.assertEqual(page.locator('#boxes .box').count(),0)
            self.assertNotIn('fixture-secret',page.locator('#error').inner_text())
            page.locator('#clear-key').click();self.assertEqual(page.locator('#key').input_value(),'')
            browser.close()

    def test_editing_targets_during_camera_permission_does_not_stick(self):
        harness=server_tests.HTTPTests()
        with harness.running(), sync_playwright() as pw:
            browser=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'])
            page=browser.new_page(permissions=['camera'])
            page.add_init_script("const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=async options=>{await new Promise(r=>setTimeout(r,500));return original(options);};")
            page.goto(f'http://127.0.0.1:{harness.port}/');page.locator('#key').fill('fixture-secret');page.locator('#start').click();page.locator('#labels').fill('person')
            page.wait_for_timeout(650)
            self.assertTrue(page.locator('#start').is_enabled())
            self.assertIsNone(page.locator('video').evaluate('(v)=>v.srcObject'))
            browser.close()

    def test_uploaded_image_analysis_requires_explicit_camera_stop(self):
        harness=server_tests.HTTPTests(); requests=[]
        with harness.running(transport=lambda req: {'answers': {}}), sync_playwright() as pw:
            browser=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'])
            page=browser.new_page(permissions=['camera'])
            page.on('request',lambda req: requests.append(req.post_data_json) if req.url.endswith('/api/detect') else None)
            page.goto(f'http://127.0.0.1:{harness.port}/');page.locator('#key').fill('fixture-secret')
            raw=__import__('base64').b64decode(harness.payload()['image'])
            page.locator('#upload').set_input_files({'name':'selected-fixture.png','mimeType':'image/png','buffer':raw})
            page.wait_for_function("() => document.querySelector('#status').textContent === 'Image ready'")
            selected_image=page.locator('#photo').evaluate("photo=>{const c=document.createElement('canvas');c.width=photo.naturalWidth;c.height=photo.naturalHeight;c.getContext('2d').drawImage(photo,0,0);return c.toDataURL('image/jpeg',.82).split(',')[1];}")
            page.locator('#cadence').select_option('1000');page.locator('#start').click()
            page.wait_for_function("() => document.querySelector('#status').textContent === 'Camera live' && document.querySelector('#video').srcObject !== null")
            page.evaluate("window.fixtureTracks=document.querySelector('#video').srcObject.getTracks()")
            self.assertTrue(page.evaluate("window.fixtureTracks.every(t=>t.readyState==='live')"))
            self.assertTrue(page.locator('#photo').is_hidden())
            with self.subTest(behavior='Analyze disabled between camera requests'):
                self.assertTrue(page.locator('#analyze').is_disabled())
            count=len(requests)
            page.locator('#analyze').dispatch_event('click')
            page.wait_for_timeout(150)
            with self.subTest(behavior='programmatic Analyze sends no old image'):
                self.assertEqual(len(requests),count)
            after_guard=len(requests)
            page.wait_for_timeout(1100)
            with self.subTest(behavior='programmatic Analyze preserves camera scheduling'):
                self.assertGreater(len(requests),after_guard)
                self.assertTrue(all(req['image']!=selected_image for req in requests))
                self.assertTrue(page.evaluate("window.fixtureTracks.every(t=>t.readyState==='live')"))
            page.locator('#stop').click()
            page.wait_for_function("() => !document.querySelector('#analyze').disabled")
            self.assertTrue(page.evaluate("window.fixtureTracks.every(t=>t.readyState==='ended')"))
            self.assertIsNone(page.locator('#video').evaluate('v=>v.srcObject'))
            self.assertTrue(page.locator('#video').is_hidden())
            self.assertTrue(page.locator('#photo').is_visible())
            self.assertEqual(page.locator('#filename').inner_text(),'selected-fixture.png')
            with self.subTest(behavior='Stop restores selected image source label'):
                self.assertEqual(page.locator('#source-label').inner_text(),'STILL IMAGE')
            count=len(requests)
            page.locator('#analyze').click()
            page.wait_for_function("() => document.querySelector('#status').textContent === 'Image analyzed'")
            self.assertEqual(len(requests),count+1)
            self.assertEqual(requests[-1]['image'],selected_image)
            self.assertEqual(requests[-1]['format'],'jpg')
            page.wait_for_timeout(1100)
            self.assertEqual(len(requests),count+1,'Still-image analysis must not restart camera scheduling')
            browser.close()

    def test_idle_upload_and_camera_controls(self):
        harness = server_tests.HTTPTests()
        requests = []
        def fixture(req):
            requests.append(json.loads(req.data))
            return {'answers': {'target_0_visible': {'type': 'noul', 'noul': .96}, 'target_0': {'type': 'box', 'box': {'left': .1, 'right': .7, 'top': .2, 'bottom': .8}, 'confidence': .88}}}
        with harness.running(transport=fixture, prefix='/jev-live'), sync_playwright() as pw:
            browser = pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'])
            context = browser.new_context(permissions=['camera'])
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.goto(f'http://127.0.0.1:{harness.port}/jev-live/')
            self.assertEqual(page.locator('h1').inner_text(), 'See what’s in frame.')
            self.assertEqual(len(requests), 0)
            self.assertIsNone(page.locator('video').evaluate('(v) => v.srcObject'))
            page.locator('#key').fill('fixture-secret')
            page.locator('#labels').fill('coffee mug')
            raw = __import__('base64').b64decode(harness.payload()['image'])
            page.locator('#upload').set_input_files({'name': 'fixture.png', 'mimeType': 'image/png', 'buffer': raw})
            page.locator('#analyze').click()
            page.wait_for_function("() => document.querySelector('#count').textContent === '1'")
            self.assertEqual(len(requests), 1)
            self.assertEqual(page.locator('#boxes .box').count(), 1)
            page.set_viewport_size({'width':390,'height':844})
            self.assertTrue(page.evaluate('document.documentElement.scrollWidth <= innerWidth'))
            page.set_viewport_size({'width':1280,'height':900})
            page.locator('#confidence').fill('0.95'); page.locator('#confidence').dispatch_event('input')
            self.assertEqual(page.locator('#boxes .box').count(),0)
            page.locator('#confidence').fill('0.7'); page.locator('#confidence').dispatch_event('input')
            page.wait_for_function("() => document.querySelector('#count').textContent === '1'")
            page.wait_for_function("() => document.querySelector('#age').textContent === 'Expired'",timeout=6000)
            self.assertEqual(page.locator('#boxes .box').count(),0)
            self.assertEqual(page.evaluate('localStorage.length + sessionStorage.length'), 0)
            page.locator('#stop').click()
            self.assertEqual(page.locator('#boxes .box').count(), 0)
            page.locator('#start').click()
            page.wait_for_function("() => document.querySelector('video').srcObject !== null")
            page.wait_for_function("() => document.querySelector('#count').textContent === '1'")
            page.locator('#stop').click()
            self.assertIsNone(page.locator('video').evaluate('(v) => v.srcObject'))
            self.assertEqual(page.locator('#boxes .box').count(), 0)
            self.assertEqual(errors, [])
            browser.close()

if __name__ == '__main__':
    unittest.main()
