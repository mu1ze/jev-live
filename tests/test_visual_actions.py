"""Visual Actions in real Chromium; semantic answers are local fixtures, not a provider."""
import unittest
import test_server as server_tests
from playwright.sync_api import sync_playwright


class VisualActionBrowserTests(unittest.TestCase):
    def setUp(self):
        self.harness=server_tests.HTTPTests()
        self.server=self.harness.running(transport=lambda req: {'answers': {}})
        self.server.__enter__()
        self.pw=sync_playwright().start()
        self.browser=self.pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'])
        self.page=self.browser.new_page(permissions=['camera'],viewport={'width':1280,'height':1000})
        self.errors=[];self.page.on('pageerror',lambda e:self.errors.append(str(e)))
        self.page.route('**/tracking-worker.js',lambda route:route.abort())
        self.page.add_init_script("""
            window.fixtureHidden=false;Object.defineProperty(document,'hidden',{get:()=>window.fixtureHidden});
            const original=window.fetch;
            window.fetch=(url,options)=>String(url).endsWith('api/detect')?new Promise(resolve=>{
                window.reply=(detections,status=200)=>{window.reply=null;resolve(new Response(JSON.stringify({detections}),{status}));};
            }):original(url,options);
        """)
        self.page.goto(f'http://127.0.0.1:{self.harness.port}/')
        self.page.locator('#key').fill('local-fixture-key')

    def tearDown(self):
        self.page.locator('#stop').click()
        if self.page.evaluate('!!window.reply'):self.page.evaluate('window.reply([])')
        self.browser.close();self.pw.stop();self.server.__exit__(None,None,None)
        self.assertEqual(self.errors,[])

    def answer(self,labels=('bottle',),confidence=.9,status=200):
        self.page.wait_for_function('() => !!window.reply')
        self.page.evaluate('args=>window.reply(...args)',[[{'label':label,'confidence':confidence,'box':dict(left=.1,right=.6,top=.2,bottom=.8)} for label in labels],status])
        self.page.wait_for_function("() => document.querySelector('#results').getAttribute('aria-busy')==='false'")

    def test_opt_in_filter_uses_only_fresh_semantics_and_survives_box_expiry(self):
        p=self.page
        self.assertEqual(p.locator('#actions-enabled').count(),1,'Visual Actions opt-in control exists')
        self.assertFalse(p.locator('#actions-enabled').is_checked())
        self.assertFalse(p.locator('#actions-sound').is_checked())
        p.locator('[data-preset="bottle"]').click()
        self.assertEqual(p.locator('#labels').input_value(),'coffee mug, person','preset cannot replace targets')
        self.assertIn('Target not configured',p.locator('#action-rules').inner_text())
        p.locator('#labels').fill('bottle');p.locator('#start').click()
        p.wait_for_function('() => !!window.reply')
        p.locator('#actions-enabled').check()
        self.answer() # captured before opt-in: must not count
        self.answer();self.assertEqual(p.locator('#video').get_attribute('data-action-filter'),None)
        self.answer()
        p.wait_for_function("() => document.querySelector('#video').dataset.actionFilter==='cool'")
        self.assertEqual(p.locator('#action-events li').count(),1)
        p.wait_for_timeout(450)
        self.assertEqual(p.locator('.box').count(),0,'350ms geometry expires independently')
        self.assertEqual(p.locator('#video').get_attribute('data-action-filter'),'cool')
        self.assertNotEqual(p.locator('#video').evaluate('n=>getComputedStyle(n).filter'),'none')
        self.assertEqual(p.locator('#stage').evaluate('n=>getComputedStyle(n).filter'),'none')
        self.assertEqual(p.locator('#video').evaluate('n=>getComputedStyle(n).objectFit'),'contain')
        self.answer(status=503) # error is not a negative; no new recognition evidence
        self.assertEqual(p.locator('#video').get_attribute('data-action-filter'),'cool')
        p.wait_for_function("() => !document.querySelector('#video').hasAttribute('data-action-filter')",timeout=3500)
        self.assertEqual(p.evaluate('localStorage.length+sessionStorage.length'),0)
