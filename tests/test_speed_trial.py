"""Bounded opt-in recognition-rate trial, native synthetic camera, fixture upstream."""
import time
import unittest
import test_server
from playwright.sync_api import sync_playwright


class SpeedTrialTests(unittest.TestCase):
    def test_100hz_target_is_opt_in_serial_and_restores_4hz_after_two_minutes(self):
        harness=test_server.HTTPTests()
        starts=[];active=0;maximum=0
        def upstream(req):
            nonlocal active,maximum
            active+=1;maximum=max(maximum,active);starts.append(time.monotonic())
            time.sleep(.08);active-=1
            return {'answers':{}}
        with harness.running(transport=upstream),sync_playwright() as pw:
            browser=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'])
            try:
                page=browser.new_page();base=f'http://127.0.0.1:{harness.port}/'
                page.goto(base)
                self.assertEqual(page.locator('#cadence').input_value(),'250')
                page.goto(base+'?experiment=100hz')
                self.assertEqual(page.locator('#cadence').input_value(),'10')
                self.assertEqual(starts,[])
                page.clock.install()
                page.locator('#key').fill('fixture-only');page.locator('#start').click()
                page.wait_for_function("() => document.querySelector('#source-label').textContent==='LIVE CAMERA'")
                page.wait_for_timeout(1200)
                self.assertGreaterEqual(len(starts),6)
                self.assertEqual(maximum,1)
                intervals=[b-a for a,b in zip(starts,starts[1:])]
                self.assertTrue(all(x>=.075 for x in intervals))
                self.assertTrue(page.locator('#speed-trial-note').is_visible())
                # Drain real transport before advancing the virtual clock past abort timers.
                page.evaluate("Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'))")
                page.wait_for_timeout(200)
                page.clock.fast_forward(120001)
                self.assertEqual(page.locator('#cadence').input_value(),'250')
                self.assertIn('ended',page.locator('#speed-trial-note').inner_text())
                page.locator('#stop').click();page.wait_for_timeout(150)
                count=len(starts);page.wait_for_timeout(300);self.assertEqual(len(starts),count)
                print('100Hz fixture target: serial 80ms transport, achieved',round(1/(sum(intervals)/len(intervals)),2),'starts/sec; maxInFlight=',maximum,flush=True)
            finally:browser.close()

    def test_stop_and_manual_rate_changes_cancel_the_trial(self):
        harness=test_server.HTTPTests()
        with harness.running(transport=lambda req:{'answers':{}}),sync_playwright() as pw:
            browser=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'])
            try:
                page=browser.new_page();page.goto(f'http://127.0.0.1:{harness.port}/?experiment=100hz')
                self.assertEqual(page.locator('#cadence').input_value(),'10')
                page.clock.install();page.locator('#key').fill('fixture-only');page.locator('#start').click()
                page.wait_for_function("() => document.querySelector('#source-label').textContent==='LIVE CAMERA'")
                page.locator('#cadence').select_option('1000')
                page.clock.fast_forward(120001)
                self.assertEqual(page.locator('#cadence').input_value(),'1000')
                page.locator('#cadence').select_option('10')
                page.locator('#stop').click()
                self.assertEqual(page.locator('#cadence').input_value(),'250')
                page.wait_for_timeout(150)
            finally:browser.close()
