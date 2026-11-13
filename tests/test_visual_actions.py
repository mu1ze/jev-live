"""Visual Actions in real Chromium; semantic answers are local fixtures, not a provider."""
import unittest
import test_server as server_tests
try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sync_playwright=None


@unittest.skipIf(sync_playwright is None,'Install optional playwright to run real browser tests')
class VisualActionBrowserTests(unittest.TestCase):
    def setUp(self):
        self.harness=server_tests.HTTPTests();self.answers={}
        self.server=self.harness.running(transport=lambda req: {'answers': self.answers})
        self.server.__enter__()
        self.pw=sync_playwright().start()
        self.browser=self.pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'])
        self.page=self.browser.new_page(permissions=['camera'],viewport={'width':1280,'height':1000})
        self.errors=[];self.page.on('pageerror',lambda e:self.errors.append(str(e)))
        self.page.route('**/tracking-worker.js',lambda route:route.abort())
        self.page.add_init_script("""
            window.fixtureHidden=false;Object.defineProperty(document,'hidden',{get:()=>window.fixtureHidden});
            const original=window.fetch;window.fixtureFetch=original;
            window.fetch=(url,options)=>String(url).endsWith('api/detect')?new Promise(resolve=>{
                window.reply=(detections,status=200)=>{window.reply=null;resolve(new Response(JSON.stringify({detections}),{status}));};
            }):original(url,options);
        """)
        self.page.goto(f'http://127.0.0.1:{self.harness.port}/')
        self.page.locator('#key').fill('local-fixture-key')
        self.page.locator('#workflow-mode').select_option('actions')

    def tearDown(self):
        self.page.locator('#stop').click()
        if self.page.evaluate('!!window.reply'):self.page.evaluate('window.reply([])')
        self.browser.close();self.pw.stop();self.server.__exit__(None,None,None)
        self.assertEqual(self.errors,[])

    def answer(self,labels=('bottle',),confidence=.9,status=200):
        self.page.wait_for_function('() => !!window.reply')
        self.page.evaluate('args=>window.reply(...args)',[[{'label':label,'confidence':confidence,'box':dict(left=.1,right=.6,top=.2,bottom=.8)} for label in labels],status])
        # Drain the reply's promise/microtasks. Slow responses can schedule the next
        # serial request immediately, so aria-busy=false may be too brief to poll.
        self.page.evaluate('() => new Promise(resolve => setTimeout(resolve, 0))')

    def test_running_workflow_transitions_drain_and_resume_measured_tracking(self):
        from test_tracking import CAMERA
        p=self.page;p.unroute('**/tracking-worker.js')
        p.add_init_script(CAMERA[CAMERA.index('window.dx'):]+"""
            window.callbacks=new Set();window.samplers=new Set();
            const cb=HTMLVideoElement.prototype.requestVideoFrameCallback,cancel=HTMLVideoElement.prototype.cancelVideoFrameCallback;
            HTMLVideoElement.prototype.requestVideoFrameCallback=function(fn){let id=cb.call(this,(...a)=>{callbacks.delete(id);fn(...a)});callbacks.add(id);return id};
            HTMLVideoElement.prototype.cancelVideoFrameCallback=function(id){callbacks.delete(id);return cancel.call(this,id)};
            const interval=window.setInterval,clear=window.clearInterval;
            window.setInterval=(fn,ms,...a)=>{const id=interval(fn,ms,...a);if(ms===20)samplers.add(id);return id};
            window.clearInterval=id=>{samplers.delete(id);return clear(id)};
            window.workers=[];window.framePosts=0;window.seedPosts=0;
            const NativeWorker=Worker;
            window.Worker=class extends NativeWorker {
                constructor(...a){super(...a);this.active=true;workers.push(this)}
                terminate(){this.active=false;return super.terminate()}
                postMessage(m,...a){if(m.type==='frame')framePosts++;if(m.type==='seed')seedPosts++;return super.postMessage(m,...a)}
            };
        """)
        p.reload();p.locator('#key').fill('local-fixture-key');p.locator('#labels').fill('bottle')
        p.evaluate("""() => {
            window.requests={active:0,max:0,starts:0};const fetch=window.fetch;
            window.fetch=(url,...a)=>{
                if(!String(url).endsWith('api/detect'))return fetch(url,...a);
                requests.active++;requests.starts++;requests.max=Math.max(requests.max,requests.active);
                return fetch(url,...a).finally(()=>requests.active--);
            };
        }""")
        p.locator('#start').click();p.wait_for_function('() => !!window.reply')
        p.wait_for_function('() => framePosts>=2')
        p.evaluate('window.cameraSource=document.querySelector("#video").srcObject')
        starts=p.evaluate('requests.starts')
        p.locator('#workflow-mode').select_option('actions')
        self.assertEqual(p.evaluate('workers.filter(w=>w.active).length'),0,'leaving tracking must terminate worker')
        self.assertEqual(p.evaluate('[callbacks.size,samplers.size]'),[0,0])
        posts=p.evaluate('framePosts');p.wait_for_timeout(250)
        self.assertEqual(p.evaluate('framePosts'),posts,'no sampling after transition')
        self.assertEqual(p.evaluate('requests.starts'),starts,'old request owns serial slot')
        self.answer();self.assertEqual(p.locator('#count').inner_text(),'0','old workflow reply rejected')
        p.locator('[data-preset="bottle"]').click();p.locator('#actions-enabled').check()
        self.answer();self.answer();self.answer()
        self.assertEqual(p.locator('#video').get_attribute('data-action-filter'),'cool')
        p.wait_for_function('() => !!window.reply');starts=p.evaluate('requests.starts')
        p.locator('#workflow-mode').select_option('tracking')
        self.assertEqual(p.locator('#video').get_attribute('data-action-filter'),None)
        self.assertEqual(p.locator('.box').count(),0,'no prior geometry on return')
        p.wait_for_function('(previous) => workers.filter(w=>w.active).length===1 && framePosts>previous+2',arg=posts)
        self.assertEqual(p.evaluate('[callbacks.size,samplers.size]'),[1,1],'exactly one resumed sampling loop')
        self.assertEqual(p.evaluate('requests.starts'),starts)
        self.answer();self.assertEqual(p.locator('#count').inner_text(),'0')
        self.answer()
        p.wait_for_function("() => document.querySelectorAll('.box[data-mode=tracked]').length>0",timeout=10000)
        self.assertTrue(p.evaluate('document.querySelector("#video").srcObject===cameraSource'))
        self.assertGreater(p.evaluate('seedPosts'),0)
        # Repeat return to Actions while worker is genuinely tracking.
        p.locator('#workflow-mode').select_option('actions')
        self.assertEqual(p.evaluate('workers.filter(w=>w.active).length'),0)
        self.assertEqual(p.locator('.box').count(),0)
        posts=p.evaluate('framePosts');p.wait_for_timeout(350);self.assertEqual(p.evaluate('framePosts'),posts)
        self.assertTrue(p.evaluate('document.querySelector("#video").srcObject===cameraSource'))
        self.assertEqual(p.evaluate('requests.max'),1)
        self.assertEqual(p.locator('#video').get_attribute('data-action-filter'),None)
        self.assertTrue(p.locator('#actions-enabled').is_checked())
        self.assertEqual(p.locator('#action-rules li').count(),1)

    def test_actions_cold_start_has_only_serial_video_snapshots(self):
        p=self.page
        p.evaluate("""async () => {
            window.overhead={workers:0,reads:0,callbacks:0,samplers:0,current:0,seeds:0,diagnostics:0,draws:0,accepted:[]};
            const NativeWorker=Worker;window.Worker=class extends NativeWorker{constructor(...a){super(...a);overhead.workers++}};
            const read=CanvasRenderingContext2D.prototype.getImageData,draw=CanvasRenderingContext2D.prototype.drawImage;
            CanvasRenderingContext2D.prototype.getImageData=function(...a){overhead.reads++;return read.apply(this,a)};
            CanvasRenderingContext2D.prototype.drawImage=function(...a){if(a[0] instanceof HTMLVideoElement){overhead.draws++;window.lastDraw=performance.now()}return draw.apply(this,a)};
            const cb=HTMLVideoElement.prototype.requestVideoFrameCallback;
            HTMLVideoElement.prototype.requestVideoFrameCallback=function(...a){overhead.callbacks++;return cb.apply(this,a)};
            const interval=window.setInterval;window.setInterval=(fn,ms,...a)=>{if(ms===20)overhead.samplers++;return interval(fn,ms,...a)};
            const {TrackingClient}=await import('/tracking-client.mjs');
            for(const [method,key] of [['current','current'],['seed','seeds'],['diagnostics','diagnostics']]){
                const original=TrackingClient.prototype[method];TrackingClient.prototype[method]=function(...a){overhead[key]++;return original.apply(this,a)};
            }
            const {ActionView}=await import('/action-view.mjs'),accept=ActionView.prototype.accept;
            ActionView.prototype.accept=function(items,captured,...a){overhead.accepted.push(Math.abs(captured-window.lastDraw));return accept.call(this,items,captured,...a)};
        }""")
        requests=[];p.on('request',lambda req:requests.append(req.url))
        p.locator('#labels').fill('bottle');p.locator('[data-preset="bottle"]').click();p.locator('#actions-enabled').check()
        p.locator('#start').click();p.wait_for_function('() => !!window.reply');p.wait_for_timeout(500)
        self.assertEqual(p.evaluate('overhead.draws'),1,'pending semantics must not sample pixels')
        self.answer();self.answer();self.answer();self.answer()
        self.assertEqual(p.locator('#video').get_attribute('data-action-filter'),'cool')
        self.assertEqual(p.locator('.box').count(),0)
        metrics=p.evaluate('overhead')
        self.assertEqual({k:metrics[k] for k in ('workers','reads','callbacks','samplers','current','seeds','diagnostics')},dict.fromkeys(('workers','reads','callbacks','samplers','current','seeds','diagnostics'),0),metrics)
        self.assertTrue(all(delta<20 for delta in metrics['accepted']),metrics)
        self.assertFalse(any(any(asset in url for asset in ('tracking-worker','opencv.js','tracker-classic')) for url in requests),requests)
        self.assertIn('RECOGNITION ONLY',p.locator('#stage-note').inner_text())

    def test_workflow_default_tracking_is_exclusive_and_mobile(self):
        p=self.page
        p.reload();p.locator('#key').fill('local-fixture-key')
        self.assertEqual(p.locator('#workflow-mode').input_value(),'tracking')
        self.assertFalse(p.locator('.visual-actions').is_visible())
        self.assertTrue(p.locator('#tracking-details').is_visible())
        # Even retained opt-in and tab rules cannot execute in tracking workflow.
        p.evaluate("document.querySelector('[data-preset=bottle]').click();document.querySelector('#actions-enabled').checked=true")
        p.locator('#labels').fill('bottle');p.locator('#start').click()
        self.answer();self.answer()
        self.assertEqual(p.locator('#video').get_attribute('data-action-filter'),None)
        p.locator('#workflow-mode').select_option('actions')
        self.assertTrue(p.locator('.visual-actions').is_visible())
        self.assertFalse(p.locator('#tracking-details').is_visible())
        self.assertFalse(p.locator('#box-legend').is_visible())
        self.assertTrue(p.locator('#actions-enabled').is_checked())
        self.assertIn('recognition only',p.locator('#workflow-description').inner_text())
        p.set_viewport_size({'width':390,'height':844})
        self.assertTrue(p.evaluate('document.documentElement.scrollWidth<=innerWidth'))

    def test_both_modes_capture_confirmed_absence_and_return_cycles(self):
        p=self.page
        for mode in ('toggle','present'):
            with self.subTest(mode=mode):
                p.reload();p.locator('#workflow-mode').select_option('actions');p.locator('#key').fill('local-fixture-key');p.locator('#labels').fill('bottle')
                p.locator('#rule-label').fill('bottle');p.locator('#rule-mode').select_option(mode);p.locator('#rule-save').click()
                p.locator('#actions-enabled').check();p.locator('#start').click()
                for _ in range(2):
                    p.wait_for_function('() => !!window.reply');p.wait_for_timeout(1400);self.answer()
                self.assertEqual(p.locator('#video').get_attribute('data-action-filter'),'cool')
                p.evaluate("window.badgeNode=document.querySelector('#target-identifiers p')")
                self.answer();self.answer()
                self.assertEqual(p.locator('#action-events li').count(),1,'sustained positives do not toggle')
                for i in range(3):
                    p.wait_for_function('() => !!window.reply');p.wait_for_timeout(1100);self.answer(())
                    if i<2:self.assertEqual(p.locator('#video').get_attribute('data-action-filter'),'cool')
                self.assertEqual(p.locator('#video').get_attribute('data-action-filter'),'cool' if mode=='toggle' else None)
                self.assertIn('Armed',p.locator('#target-identifiers').inner_text())
                self.answer();self.answer()
                p.wait_for_timeout(120)
                self.assertEqual(p.locator('#video').get_attribute('data-action-filter'),None if mode=='toggle' else 'cool')
                self.assertTrue(p.evaluate("window.badgeNode===document.querySelector('#target-identifiers p')"),'identifier nodes are reconciled, not replaced')
                self.assertEqual(p.locator('#action-events li').count(),2 if mode=='toggle' else 3)
                p.locator('#stop').click()
                if p.evaluate('!!window.reply'):p.evaluate('window.reply([])')

    def test_mode_editor_roundtrip_and_identifiers_without_tracking_or_rules(self):
        p=self.page
        self.assertEqual(p.locator('#rule-mode').count(),1,'mode is an explicit editor choice')
        self.assertEqual(p.locator('#rule-mode').input_value(),'toggle')
        p.locator('#labels').fill('bottle');p.locator('#start').click()
        for _ in range(2):
            p.wait_for_function('() => !!window.reply');p.wait_for_timeout(1400);self.answer()
        badge=p.locator('#target-identifiers')
        self.assertIn('bottle',badge.inner_text());self.assertIn('Confirmed',badge.inner_text())
        self.assertIn('last capture',badge.inner_text());self.assertEqual(p.locator('.box').count(),0)
        self.assertEqual(p.locator('#action-rules li').count(),0)
        p.wait_for_timeout(2700)
        self.assertNotIn('Confirmed',badge.inner_text(),'semantic-only identifiers obey the existing 4s bound')
        p.locator('#rule-label').fill('bottle');p.locator('#rule-mode').select_option('present');p.locator('#rule-save').click()
        self.assertIn('While present',p.locator('#action-rules').inner_text())
        p.locator('#action-rules').get_by_role('button',name='Edit').click()
        self.assertEqual(p.locator('#rule-mode').input_value(),'present')
        p.locator('#rule-mode').select_option('toggle');p.locator('#rule-save').click()
        self.assertIn('Toggle',p.locator('#action-rules').inner_text())
        p.locator('#actions-enabled').check()
        self.answer();self.answer();self.answer()
        self.assertIn('effect ON',badge.inner_text());self.assertIn('remove and return',badge.inner_text())
        p.wait_for_timeout(2700)
        self.assertIn('effect ON',badge.inner_text());self.assertIn('uncertain',badge.inner_text())
        p.set_viewport_size({'width':390,'height':844})
        self.assertTrue(p.evaluate('document.documentElement.scrollWidth<=innerWidth'))

    def test_identifier_confirmation_belongs_to_displayed_capture(self):
        self.page.locator('#labels').fill('bottle')
        badges=self.page.evaluate("""async () => {
            const {ActionView}=await import('/action-view.mjs');
            const view=new ActionView(),items=[{label:'bottle',confidence:.9}];
            const accept=(captured,now)=>view.accept(items,captured,now,view.generation,.7);
            const badge=(captured,now)=>{view.identifiers(items,captured,now);return document.querySelector('#target-identifiers').textContent;};
            accept(100,100);accept(500,500);
            const initial=badge(500,500);
            accept(4000,7000); // Displayable semantic capture, too old for confirmation.
            const delayed=badge(4000,7000);
            accept(7100,7100);const single=badge(7100,7100);
            accept(7200,7200);const confirmed=badge(7200,7200);
            return {initial,delayed,single,confirmed};
        }""")
        self.assertIn('Confirmed',badges['initial'])
        self.assertIn('Recognized',badges['delayed'])
        self.assertNotIn('Confirmed',badges['delayed'])
        self.assertNotIn('Confirmed',badges['single'])
        self.assertIn('Confirmed',badges['confirmed'])

    def test_real_http_fixture_normalization_drives_display_only_actions(self):
        p=self.page
        self.answers.update({'target_0_visible':{'type':'noul','noul':.96},'target_0':{'type':'box','confidence':.92,'box':dict(left=.1,right=.6,top=.2,bottom=.8)}})
        p.evaluate('window.fetch=window.fixtureFetch')
        p.locator('#labels').fill('bottle');p.locator('[data-preset="bottle"]').click()
        p.locator('#actions-enabled').check();p.locator('#start').click()
        p.wait_for_function("() => document.querySelector('#video').dataset.actionFilter==='cool'")
        self.assertEqual(p.locator('#action-events li').count(),1)
        # Canvas draws the native video, not CSS-filtered or letterboxed display pixels.
        self.assertEqual(p.locator('#video').evaluate("v=>{const c=document.createElement('canvas'),x=c.getContext('2d');c.width=32;c.height=32;x.drawImage(v,0,0,32,32);const a=Array.from(x.getImageData(0,0,32,32).data);v.removeAttribute('data-action-filter');x.drawImage(v,0,0,32,32);return JSON.stringify(a)===JSON.stringify(Array.from(x.getImageData(0,0,32,32).data));}"),True)
        p.locator('#stop').click()
        p.wait_for_function("() => document.querySelector('#results').getAttribute('aria-busy')==='false'")

    def test_action_capture_ttl_is_stricter_than_snapshot_box_ttl(self):
        p=self.page
        p.locator('#labels').fill('bottle');p.locator('[data-preset="bottle"]').click()
        p.locator('#actions-enabled').check();p.locator('#start').click();self.answer()
        p.wait_for_function('() => !!window.reply');p.wait_for_timeout(2550)
        self.answer()
        self.assertEqual(p.locator('#video').get_attribute('data-action-filter'),None)
        self.answer();self.assertEqual(p.locator('#video').get_attribute('data-action-filter'),None,'late result did not count toward the new streak')
        self.answer()
        p.wait_for_function("() => document.querySelector('#video').dataset.actionFilter==='cool'")

    def test_serial_1400ms_semantics_activate_without_live_boxes(self):
        p=self.page
        p.locator('#labels').fill('bottle');p.locator('[data-preset="bottle"]').click()
        p.locator('#actions-enabled').check();p.locator('#start').click()
        for _ in range(2):
            p.wait_for_function('() => !!window.reply')
            p.wait_for_timeout(1400)
            self.answer()
        p.wait_for_function("() => document.querySelector('#video').dataset.actionFilter==='cool'",timeout=1000)
        self.assertEqual(p.locator('.box').count(),0,'slow recognition cannot display stale geometry')
        self.assertEqual(p.locator('#action-events li').count(),1)
        # No next answer is uncertainty, not proof of absence (new Toggle contract).
        p.wait_for_timeout(2700)
        self.assertEqual(p.locator('#video').get_attribute('data-action-filter'),'cool')
        self.assertIn('uncertain',p.locator('#target-identifiers').inner_text())

    def test_delayed_audio_unlock_cannot_rearm_after_lifecycle_reset(self):
        p=self.page
        p.add_init_script("""
            window.fixtureToneStarts=0;
            const Native=window.AudioContext, start=OscillatorNode.prototype.start;
            window.AudioContext=class extends Native {
                resume(){return super.resume().then(()=>new Promise(resolve=>window.releaseAudio=resolve));}
            };
            OscillatorNode.prototype.start=function(...args){window.fixtureToneStarts++;return start.apply(this,args);};
        """)
        for reset in ('stop','hidden','disable'):
            with self.subTest(reset=reset):
                p.reload();p.locator('#workflow-mode').select_option('actions');p.locator('#key').fill('local-fixture-key');p.locator('#labels').fill('bottle')
                p.locator('#rule-label').fill('bottle');p.locator('#rule-sound').check();p.locator('#rule-save').click()
                p.locator('#actions-enabled').check();p.locator('#start').click();self.answer()
                p.locator('#actions-sound').check();p.wait_for_function('() => !!window.releaseAudio')
                self.answer();p.wait_for_function('() => !!window.reply')
                if reset=='hidden':p.evaluate("window.fixtureHidden=true;document.dispatchEvent(new Event('visibilitychange'))")
                elif reset=='disable':p.locator('#actions-enabled').uncheck()
                else:p.locator('#stop').click()
                p.evaluate('window.releaseAudio()')
                self.assertEqual(p.evaluate('window.fixtureToneStarts'),0)
                self.answer() # obsolete pending capture
                if reset=='hidden':p.evaluate("window.fixtureHidden=false;document.dispatchEvent(new Event('visibilitychange'))")
                elif reset=='disable':p.locator('#actions-enabled').check()
                else:p.locator('#start').click()
                # A fresh visual entry after the reset must not use the late unlock.
                self.answer();self.answer();self.answer()
                self.assertEqual(p.evaluate('window.fixtureToneStarts'),0)
                p.locator('#stop').click()

    def test_deleting_active_rule_logs_clear_and_removes_filter(self):
        p=self.page
        p.locator('#labels').fill('bottle');p.locator('[data-preset="bottle"]').click()
        p.locator('#actions-enabled').check();p.locator('#start').click()
        self.answer();self.answer()
        p.wait_for_function("() => document.querySelector('#video').dataset.actionFilter==='cool'")
        p.wait_for_function('() => !!window.reply')
        p.locator('#action-rules').get_by_role('button',name='Delete').click()
        self.assertEqual(p.locator('#video').get_attribute('data-action-filter'),None)
        self.assertEqual(p.locator('#photo').get_attribute('data-action-filter'),None)
        self.assertEqual(p.locator('#action-rules li').count(),0)
        events=p.locator('#action-events li').all_text_contents()
        self.assertEqual(len(events),2,'deleting an active rule records its clear event')
        self.assertIn('bottle → cleared (settings or source reset)',events[0])
        self.assertIn('bottle → Underwater / cool activated',events[1])
        self.answer() # deletion also invalidates the in-flight capture
        self.assertEqual(p.locator('#video').get_attribute('data-action-filter'),None)
        self.assertEqual(p.locator('#action-events li').count(),2)

    def test_bounded_event_log_reset_and_rule_budget(self):
        p=self.page
        self.assertEqual(p.locator('#clear-action-events').count(),1,'local history has an explicit clear control')
        p.locator('#labels').fill('bottle')
        for i in range(12):
            p.locator('#rule-label').fill('bottle');p.locator('#rule-save').click()
        p.locator('#rule-label').fill('bottle');p.locator('#rule-save').click()
        self.assertEqual(p.locator('#action-rules li').count(),12)
        self.assertTrue(p.locator('#rule-error').is_visible())
        p.locator('#actions-enabled').check();p.locator('#start').click()
        for cycle in range(3):
            if cycle:self.answer() # pre-reset capture is never reused
            self.answer();self.answer()
            p.wait_for_function("() => document.querySelector('#video').hasAttribute('data-action-filter')")
            self.assertLessEqual(p.locator('#action-events li').count(),40)
            self.assertEqual(p.locator('#action-events li time').count(),p.locator('#action-events li').count())
            p.wait_for_function('() => !!window.reply')
            p.locator('#reset-actions').click()
            self.assertEqual(p.locator('#video').get_attribute('data-action-filter'),None)
        self.assertEqual(p.locator('#action-events li').count(),40)
        p.locator('#clear-action-events').click();self.assertEqual(p.locator('#action-events li').count(),0)
        self.assertEqual(p.locator('#action-rules li').count(),12,'reset/history clear never delete rules')

    def test_lifecycle_clears_effects_and_rejects_old_replies(self):
        p=self.page
        for mode,change in __import__('itertools').product(('toggle','present'),('hidden','targets','confidence','disable','stop','source','edit','reset')):
            with self.subTest(mode=mode,change=change):
                p.reload();p.locator('#workflow-mode').select_option('actions');p.locator('#key').fill('local-fixture-key');p.locator('#labels').fill('bottle')
                p.locator('#rule-label').fill('bottle');p.locator('#rule-mode').select_option(mode);p.locator('#rule-save').click()
                p.locator('#actions-enabled').check();p.locator('#start').click()
                self.answer();self.answer()
                p.wait_for_function("() => document.querySelector('#video').dataset.actionFilter==='cool'")
                p.wait_for_function('() => !!window.reply')
                if change=='hidden':p.evaluate("window.fixtureHidden=true;document.dispatchEvent(new Event('visibilitychange'))")
                elif change=='targets':p.locator('#labels').fill('wallet')
                elif change=='confidence':p.locator('#confidence').fill('0.8')
                elif change=='disable':p.locator('#actions-enabled').uncheck()
                elif change=='stop':p.locator('#stop').click()
                elif change=='edit':p.locator('#action-rules').get_by_role('button',name='Edit').click()
                elif change=='reset':p.locator('#reset-actions').click()
                else:
                    raw=__import__('base64').b64decode(self.harness.payload()['image'])
                    p.locator('#upload').set_input_files({'name':'fixture.png','mimeType':'image/png','buffer':raw})
                self.assertEqual(p.locator('#video').get_attribute('data-action-filter'),None)
                self.answer()
                self.assertEqual(p.locator('#video').get_attribute('data-action-filter'),None,'late old-source reply cannot activate')
                self.assertEqual(p.locator('#photo').get_attribute('data-action-filter'),None)
                if change=='confidence':
                    self.answer()
                    self.assertEqual(p.locator('#video').get_attribute('data-action-filter'),None,'old-threshold capture cannot contribute to the fresh streak')
                    self.answer()
                    p.wait_for_function("() => document.querySelector('#video').dataset.actionFilter==='cool'")
                p.locator('#stop').click()

    def test_optional_sound_is_gesture_gated_and_cancelled_on_stop(self):
        p=self.page
        self.assertTrue(p.locator('#actions-sound').is_enabled(),'sound can be explicitly permitted')
        p.add_init_script("""
            window.audioFixture={contexts:0,starts:0,stops:0};
            const Native=window.AudioContext;
            window.AudioContext=class extends Native {constructor(){super();window.audioFixture.contexts++;}};
            const start=OscillatorNode.prototype.start, stop=OscillatorNode.prototype.stop;
            OscillatorNode.prototype.start=function(...args){window.audioFixture.starts++;return start.apply(this,args);};
            OscillatorNode.prototype.stop=function(...args){window.audioFixture.stops++;return stop.apply(this,args);};
        """)
        p.reload();p.locator('#workflow-mode').select_option('actions');p.locator('#key').fill('local-fixture-key');p.locator('#labels').fill('bottle')
        self.assertEqual(p.evaluate('window.audioFixture.contexts'),0)
        p.locator('#rule-label').fill('bottle');p.locator('#rule-sound').check();p.locator('#rule-save').click()
        p.locator('#actions-enabled').check();p.locator('#start').click();self.answer();self.answer()
        self.assertEqual(p.evaluate('window.audioFixture.starts'),0,'per-rule sound is insufficient without global permission')
        p.locator('#actions-sound').check()
        p.wait_for_function("() => document.querySelector('#actions-sound-hint').textContent.includes('ready')")
        p.locator('#stop').click()
        if p.evaluate('!!window.reply'):p.evaluate('window.reply([])')
        p.wait_for_function("() => document.querySelector('#results').getAttribute('aria-busy')==='false'")
        p.locator('#start').click();self.answer();self.answer()
        self.assertEqual(p.evaluate('window.audioFixture.starts'),1)
        p.locator('#stop').click();self.assertGreaterEqual(p.evaluate('window.audioFixture.stops'),1)
        p.locator('#actions-sound').uncheck()
        if p.evaluate('!!window.reply'):p.evaluate('window.reply([])')
        p.wait_for_function("() => document.querySelector('#results').getAttribute('aria-busy')==='false'")
        p.locator('#start').click();self.answer();self.answer()
        self.assertEqual(p.evaluate('window.audioFixture.starts'),1)

    def test_rule_editor_plain_text_cards_and_safe_presets(self):
        p=self.page
        self.assertEqual(p.locator('#rule-form').count(),1,'accessible rule editor exists')
        for preset in ('bottle','wallet','lighter','bottle'):
            p.locator(f'[data-preset="{preset}"]').click()
        self.assertEqual(p.locator('#action-rules li').count(),3,'preset buttons are idempotent')
        self.assertEqual(p.locator('#labels').input_value(),'coffee mug, person')
        p.locator('#labels').fill('bottle, wallet, lighter')
        p.locator('#rule-label').fill('wallet')
        p.locator('#rule-kind').select_option('card')
        literal='<img src=x onerror=alert(1)> wallet found'
        p.locator('#rule-text').fill(literal);p.locator('#rule-save').click()
        self.assertEqual(p.locator('#action-rules li').count(),4)
        p.locator('#actions-enabled').check();p.locator('#start').click()
        self.answer(('bottle','wallet','lighter'));self.answer(('bottle','wallet','lighter'))
        p.wait_for_function("() => document.querySelector('#action-cards')?.textContent.includes('wallet found')")
        self.assertEqual(p.locator('#action-cards').inner_text(),literal)
        self.assertEqual(p.locator('#action-cards').get_attribute('tabindex'),'0','bounded card region is keyboard-scrollable when active')
        self.assertEqual(p.locator('#action-cards').evaluate('n=>getComputedStyle(n).pointerEvents'),'auto','overflowing cards can be scrolled on touch/pointer devices')
        self.assertEqual(p.locator('#action-cards img').count(),0,'card text is never HTML')
        self.assertEqual(p.locator('#video').get_attribute('data-action-filter'),'cool','first rule wins')
        self.assertEqual(p.locator('#action-cards').evaluate('n=>getComputedStyle(n).filter'),'none')
        p.wait_for_function('() => !!window.reply')
        p.locator('#action-rules li').last.get_by_role('button',name='Edit').click()
        p.locator('#rule-text').fill('Edited local card');p.locator('#rule-save').click()
        self.assertEqual(p.locator('#action-cards').inner_text(),'','editing resets every active effect immediately')
        self.answer(('wallet',)) # pre-edit capture ignored
        self.answer(('wallet',));self.assertEqual(p.locator('#action-cards').inner_text(),'')
        self.answer(('wallet',))
        p.wait_for_function("() => document.querySelector('#action-cards').textContent==='Edited local card'")
        p.locator('#action-rules li').last.get_by_role('button',name='Delete').click()
        self.assertEqual(p.locator('#action-cards').inner_text(),'')
        self.assertEqual(p.locator('#action-rules li').count(),3)
        p.set_viewport_size({'width':390,'height':844})
        self.assertTrue(p.evaluate('document.documentElement.scrollWidth<=innerWidth'))
        p.emulate_media(reduced_motion='reduce')
        self.assertEqual(p.locator('#action-cards').evaluate('n=>getComputedStyle(n).animationName'),'none')

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
        p.wait_for_timeout(2700)
        self.assertEqual(p.locator('#video').get_attribute('data-action-filter'),'cool','errors/no replies do not turn a latched toggle off')
        self.assertEqual(p.evaluate('localStorage.length+sessionStorage.length'),0)
