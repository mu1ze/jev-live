"""Real browser confinement proof; no upstream or camera access."""
import functools
import http.server
import pathlib
import threading
import unittest
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPIKE = ROOT / 'static'
MAIN_CSP = "default-src 'self'; script-src 'self'; worker-src 'self'; connect-src 'self'"
WORKER_CSP = "default-src 'none'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'none'; worker-src 'none'"

class ConfinementTests(unittest.TestCase):
    def test_app_fixed_worker_route_has_distinct_policy(self):
        import test_server
        harness=test_server.HTTPTests()
        with harness.running(prefix='/private'):
            status,headers,_=harness.request('GET','/private/tracking-worker.js')
            self.assertEqual(status,200)
            self.assertEqual(headers['Content-Security-Policy'],WORKER_CSP)
            _,headers,_=harness.request('GET','/private/')
            self.assertNotIn('unsafe-eval',headers['Content-Security-Policy'])
            self.assertEqual(harness.request('GET','/private/trackingvendor/opencv.js')[0],200)
            self.assertEqual(harness.request('GET','/tracking-worker.js')[0],404)
        with harness.running(access_token='fixture-only'):
            self.assertEqual(harness.request('GET','/tracking-worker.js')[0],401)


    def test_classic_worker_runtime_confined_before_integration(self):
        requests=[]
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self,*args): pass
            def do_GET(self):
                requests.append(self.path)
                if self.path=='/': body=b'<script src="/probe.js"></script>'; mime='text/html'
                elif self.path=='/probe.js':
                    body=b"window.proof={};try{eval('1')}catch(e){proof.evalBlocked=true}const w=new Worker('/tracking-worker.js');w.onmessage=e=>Object.assign(proof,e.data);"; mime='text/javascript'
                elif self.path=='/tracking-worker.js':
                    body=b"importScripts('/opencv.js'); cv.onRuntimeInitialized=async()=>{let blocked=false;try{await fetch('/forbidden')}catch(e){blocked=true}postMessage({ready:!!cv.Mat,fetchBlocked:blocked,version:cv.getBuildInformation().includes('4.13.0')})};";mime='text/javascript'
                elif self.path=='/opencv.js': body=(SPIKE/'trackingvendor/opencv.js').read_bytes();mime='text/javascript'
                else: self.send_error(404);return
                self.send_response(200);self.send_header('Content-Type',mime)
                self.send_header('Content-Security-Policy', WORKER_CSP if self.path=='/tracking-worker.js' else MAIN_CSP)
                self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
        server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
        thread=threading.Thread(target=server.serve_forever);thread.start()
        try:
            with sync_playwright() as pw:
                browser=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
                page=browser.new_page();page.goto(f'http://127.0.0.1:{server.server_port}')
                page.wait_for_function('() => window.proof.ready',timeout=20000)
                self.assertEqual(page.evaluate('window.proof'),dict(evalBlocked=True,ready=True,fetchBlocked=True,version=True))
                self.assertNotIn('/forbidden',requests)
                self.assertTrue(all(p in ['/', '/probe.js','/tracking-worker.js','/opencv.js','/favicon.ico'] for p in requests))
                print('Confinement proof:',page.evaluate('window.proof'),'requests:',requests,flush=True)
                browser.close()
        finally:
            server.shutdown();server.server_close();thread.join()
