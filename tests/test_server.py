import base64
import contextlib
import http.client
import importlib.util
import json
from pathlib import Path
import threading
import unittest

ROOT = Path(__file__).resolve().parents[1]

class HTTPTests(unittest.TestCase):
    @contextlib.contextmanager
    def running(self, **kwargs):
        self.assertTrue((ROOT / 'server.py').exists(), 'HTTP app has not been implemented')
        spec = importlib.util.spec_from_file_location('jev_server', ROOT / 'server.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        server = module.create_server(port=0, **kwargs)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.port = server.server_address[1]
        try:
            yield server
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=3)
        h = {'Origin': f'http://127.0.0.1:{self.port}', 'Content-Type': 'application/json'}
        h.update(headers or {})
        conn.request(method, path, body=json.dumps(body) if isinstance(body, dict) else body, headers=h)
        res = conn.getresponse()
        data = res.read()
        result = res.status, dict(res.getheaders()), data
        conn.close()
        return result

    def payload(self, size=320):
        import struct, zlib
        def chunk(kind, data):
            return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
        png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress((b'\0' + b'\x80' * (size * 3)) * size)) + chunk(b'IEND', b'')
        return {'key': 'test-secret', 'labels': ['coffee mug'], 'image': base64.b64encode(png).decode(), 'format': 'png'}

    def test_env_local_key_loads_without_execution_or_overriding_environment(self):
        import tempfile
        spec = importlib.util.spec_from_file_location('jev_env_server', ROOT / 'server.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.assertTrue(hasattr(module, 'load_local_key'), 'Local environment loading is missing')
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / '.env.local'
            path.write_text('# private config\nexport JEV_API_KEY="fixture-only-key"\nUNRELATED_SECRET=nope\n')
            env = {}
            module.load_local_key(path, env)
            self.assertEqual(env, {'JEV_API_KEY': 'fixture-only-key'})
            env = {'JEV_API_KEY': 'existing-environment-key'}
            module.load_local_key(path, env)
            self.assertEqual(env['JEV_API_KEY'], 'existing-environment-key')
            path.write_text('JEV_API_KEY=$(do-not-execute)\n')
            with self.assertRaises(ValueError):
                module.load_local_key(path, {})
            path.unlink()
            env = {}
            module.load_local_key(path, env)
            self.assertEqual(env, {})

    def test_documented_request_and_normalized_response(self):
        seen = []
        def upstream(req):
            seen.append(req)
            return {'answers': {'target_0_visible': {'type': 'noul', 'noul': .91}, 'target_0': {'type': 'box', 'box': {'left': .1, 'right': .7, 'top': .2, 'bottom': .8}, 'confidence': .85}}}
        with self.running(transport=upstream):
            status, _, data = self.request('POST', '/api/detect', self.payload())
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(data)['detections'], [{'label': 'coffee mug', 'box': {'left': .1, 'right': .7, 'top': .2, 'bottom': .8}, 'confidence': .85, 'presence': .91}])
        req = seen[0]
        self.assertEqual(req.full_url, 'https://api.typesafe.ai/v1/systemone')
        self.assertEqual(req.get_header('Authorization'), 'Bearer test-secret')
        self.assertEqual(req.get_header('Typesafe-danger-zone-images'), 'true')
        body = json.loads(req.data)
        self.assertEqual(body['model'], 'jev-1.14.0')
        self.assertEqual(body['questions']['target_0_visible']['type'], 'noul')
        self.assertEqual(body['questions']['target_0']['type'], 'box')
        asset = body['assets'][body['state']['photo']]
        self.assertEqual(asset['data_base64'], self.payload()['image'])
        self.assertEqual(asset['format'], 'png')

    def test_invalid_inputs_rejected_without_upstream(self):
        def forbidden(req):
            self.fail('Invalid input reached upstream')
        cases = [{'labels': []}, {'labels': ['x'] * 9}, {'labels': ['bad`label']}, {'labels': ['a' * 81]}, {'image': 'not base64'}, {'image': base64.b64encode(b'not an image').decode()}, {'format': 'gif'}, {'key': 'bad\r\nkey'}, {'labels': 'mug'}]
        with self.running(transport=forbidden):
            for change in cases:
                with self.subTest(change=change):
                    p = self.payload(); p.update(change)
                    self.assertEqual(self.request('POST', '/api/detect', p)[0], 400)
            self.assertEqual(self.request('POST', '/api/detect', '', {'Content-Length': str(2 * 1024 * 1024 + 1)})[0], 413)
            self.assertEqual(self.request('POST', '/api/detect', '{bad')[0], 400)

    def test_absent_invalid_boxes_and_secret_errors(self):
        answer = {'answers': {'target_0_visible': {'type': 'noul', 'noul': .1}, 'target_0': {'type': 'box', 'box': {'left': .1, 'right': .7, 'top': .2, 'bottom': .8}, 'confidence': .99}}}
        def upstream(req):
            return answer
        with self.running(transport=upstream):
            self.assertEqual(json.loads(self.request('POST', '/api/detect', self.payload())[2])['detections'], [])
            answer['answers']['target_0_visible']['noul'] = .95
            for value in [float('nan'), float('inf'), -.1, 1.1, True, '0.2', .9]:
                answer['answers']['target_0']['box']['left'] = value
                self.assertEqual(json.loads(self.request('POST', '/api/detect', self.payload())[2])['detections'], [])
        def broken(req):
            raise TimeoutError('test-secret private upstream detail')
        with self.running(transport=broken):
            status, _, data = self.request('POST', '/api/detect', self.payload())
            self.assertEqual(status, 504)
            self.assertNotIn(b'test-secret', data)
            self.assertLess(len(data), 200)

    def test_auth_prefix_cookie_and_csrf(self):
        with self.running(access_token='test-access-secret', prefix='/jev-live'):
            for path in ['/jev-live/', '/jev-live/app.js', '/jev-live/api/config']:
                self.assertEqual(self.request('GET', path)[0], 401)
            status, headers, data = self.request('GET', '/jev-live/?access=wrong')
            self.assertEqual(status, 401)
            status, headers, _ = self.request('GET', '/jev-live/?access=test-access-secret')
            self.assertEqual(status, 303)
            self.assertEqual(headers['Location'], '/jev-live/')
            self.assertIn('HttpOnly', headers['Set-Cookie'])
            self.assertIn('SameSite=Strict', headers['Set-Cookie'])
            self.assertIn('Path=/jev-live/', headers['Set-Cookie'])
            cookie = headers['Set-Cookie'].split(';')[0]
            self.assertEqual(self.request('GET', '/jev-live/api/config', headers={'Cookie': cookie})[0], 200)
            for origin in ['https://evil.example', 'null', '']:
                self.assertEqual(self.request('POST', '/jev-live/api/detect', {}, {'Cookie': cookie, 'Origin': origin})[0], 403)
            self.assertEqual(self.request('POST', '/jev-live/api/detect', {}, {'Cookie': cookie, 'Origin': 'https://camera.example', 'Host': 'camera.example', 'X-Forwarded-Proto': 'https'})[0], 401)
            self.assertEqual(self.request('POST', '/jev-live/nope', {}, {'Cookie': cookie})[0], 404)

    def test_documented_image_minimum_is_enforced(self):
        with self.running(transport=lambda req: {'answers': {}}):
            self.assertEqual(self.request('POST', '/api/detect', self.payload(279))[0], 400)
            self.assertEqual(self.request('POST', '/api/detect', self.payload(280))[0], 200)

    def test_cli_is_runnable_with_configurable_port(self):
        import subprocess
        result = subprocess.run(['python3', str(ROOT / 'server.py'), '--help'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0)
        self.assertIn('--port', result.stdout)
        self.assertIn('--prefix', result.stdout)

    def test_all_methods_protected_and_env_key_not_exposed(self):
        with self.running(access_token='access-secret', api_key='env-secret'):
            for method in ['HEAD', 'OPTIONS', 'PUT', 'DELETE', 'PATCH']:
                self.assertEqual(self.request(method, '/api/config')[0], 401)
        with self.running(api_key='env-secret', transport=lambda req: {'answers': {}}):
            status, _, raw = self.request('GET', '/api/config')
            self.assertEqual(json.loads(raw), {'serverKeyConfigured': True})
            self.assertNotIn(b'env-secret', raw)
            payload=self.payload(); payload.pop('key')
            self.assertEqual(self.request('POST', '/api/detect', payload)[0], 200)

    def test_local_mock_upstream_http_failure_is_secret_safe(self):
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        from urllib.request import Request, urlopen
        seen=[]
        class MockUpstream(BaseHTTPRequestHandler):
            def log_message(self,*args): pass
            def do_POST(self):
                seen.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
                self.send_response(429);self.end_headers();self.wfile.write(b'test-secret quota detail')
        upstream=ThreadingHTTPServer(('127.0.0.1',0),MockUpstream)
        thread=threading.Thread(target=upstream.serve_forever,daemon=True);thread.start()
        def fixture_transport(req):
            local=Request(f'http://127.0.0.1:{upstream.server_address[1]}/fixture-only',data=req.data,headers=dict(req.headers))
            with urlopen(local,timeout=2) as response: return json.load(response)
        try:
            with self.running(transport=fixture_transport):
                status,_,raw=self.request('POST','/api/detect',self.payload())
                self.assertEqual(status,502);self.assertNotIn(b'test-secret',raw)
                self.assertEqual(seen[0]['model'],'jev-1.14.0')
        finally:
            upstream.shutdown();upstream.server_close();thread.join()

    def test_stripped_reverse_proxy_auth_redirect_preserves_public_mount(self):
        with self.running(access_token='access-secret', public_prefix='/jev-live'):
            status, headers, _ = self.request('GET', '/?access=access-secret', headers={'X-Forwarded-Proto':'https'})
            self.assertEqual(status,303)
            self.assertEqual(headers['Location'],'/jev-live/')
            self.assertIn('Path=/jev-live/',headers['Set-Cookie'])
            self.assertIn('Secure',headers['Set-Cookie'])
            cookie=headers['Set-Cookie'].split(';')[0]
            self.assertEqual(self.request('GET','/',headers={'Cookie':cookie})[0],200)

    def test_upstream_http_errors_are_closed_and_wrapped_timeouts_are_504(self):
        import io
        from urllib.error import HTTPError, URLError
        resource=io.BytesIO(b'test-secret')
        def fail_http(req): raise HTTPError(req.full_url,429,'test-secret',{},resource)
        with self.running(transport=fail_http):
            self.assertEqual(self.request('POST','/api/detect',self.payload())[0],502)
            self.assertTrue(resource.closed)
        def fail_timeout(req): raise URLError(TimeoutError('test-secret'))
        with self.running(transport=fail_timeout):
            self.assertEqual(self.request('POST','/api/detect',self.payload())[0],504)

    def test_missing_key_is_clean_401(self):
        with self.running():
            status, _, data = self.request('POST', '/api/detect', {})
            self.assertEqual(status, 401)
            self.assertEqual(json.loads(data)['error'], 'An API key is required.')

if __name__ == '__main__':
    unittest.main()
