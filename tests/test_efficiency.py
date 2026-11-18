"""Efficiency regressions: warm upstream connections and cached static assets."""
import gzip
import http.client
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import test_server

ANSWER = {'answers': {'target_0_visible': {'type': 'noul', 'noul': .91},
                      'target_0': {'type': 'box', 'confidence': .85,
                                   'box': {'left': .1, 'right': .7, 'top': .2, 'bottom': .8}}}}


class MockUpstream:
    """Local plain-HTTP stand-in for the fixed HTTPS upstream (fixture answers only)."""

    def __init__(self, status=200, body=None, close_after=False, keep_alive=True):
        owner = self
        self.connections, self.requests, self.paths = set(), [], []

        class Handler(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1' if keep_alive else 'HTTP/1.0'

            def log_message(self, *args):
                pass

            def do_POST(self):
                owner.connections.add(self.client_address)
                owner.paths.append(self.path)
                owner.requests.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
                raw = body if body is not None else json.dumps(ANSWER).encode()
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(raw)))
                if close_after:
                    self.send_header('Connection', 'close')
                    self.close_connection = True
                self.end_headers()
                self.wfile.write(raw)

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def factory(self):
        return http.client.HTTPConnection('127.0.0.1', self.server.server_address[1], timeout=5)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *args):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()


class Harness(unittest.TestCase):
    # Borrow the shared harness without re-running HTTPTests' own test methods.
    running = test_server.HTTPTests.running
    request = test_server.HTTPTests.request
    payload = test_server.HTTPTests.payload


class UpstreamPoolTests(Harness):
    def test_serial_detections_reuse_one_upstream_connection(self):
        with MockUpstream() as upstream, self.running(upstream_factory=upstream.factory) as app:
            for _ in range(5):
                status, _, raw = self.request('POST', '/api/detect', self.payload())
                self.assertEqual(status, 200)
                self.assertEqual(json.loads(raw)['detections'][0]['label'], 'coffee mug')
            self.assertEqual(len(upstream.requests), 5)
            self.assertEqual(len(upstream.connections), 1, 'serial requests must reuse a warm connection')
            self.assertEqual(app.upstream.opened, 1)
            self.assertEqual(set(upstream.paths), {'/v1/systemone'})
            self.assertEqual(upstream.requests[0]['model'], 'jev-1.14.0')

    def test_peer_closed_connections_are_not_reused(self):
        with MockUpstream(close_after=True) as upstream, self.running(upstream_factory=upstream.factory) as app:
            for _ in range(3):
                self.assertEqual(self.request('POST', '/api/detect', self.payload())[0], 200)
            self.assertEqual(len(upstream.requests), 3, 'no duplicate upstream requests')
            self.assertEqual(app.upstream.opened, 3)

    def test_stale_idle_connection_retries_once_without_duplicate_billing(self):
        with MockUpstream() as upstream, self.running(upstream_factory=upstream.factory) as app:
            self.assertEqual(self.request('POST', '/api/detect', self.payload())[0], 200)
            # Simulate the peer silently dropping the idle pooled socket.
            for conn, _ in app.upstream.free:
                conn.sock.shutdown(2)
            self.assertEqual(self.request('POST', '/api/detect', self.payload())[0], 200)
            self.assertEqual(len(upstream.requests), 2)
            self.assertEqual(app.upstream.opened, 2)

    def test_upstream_status_and_oversize_failures_are_secret_safe_502(self):
        for kwargs in ({'status': 429, 'body': b'test-secret quota detail'},
                       {'body': b'{"answers":{}}' + b' ' * 262144}):
            with self.subTest(**{k: (v if k == 'status' else len(v)) for k, v in kwargs.items()}):
                with MockUpstream(**kwargs) as upstream, self.running(upstream_factory=upstream.factory) as app:
                    status, _, raw = self.request('POST', '/api/detect', self.payload())
                    self.assertEqual(status, 502)
                    self.assertNotIn(b'test-secret', raw)
                    self.assertEqual(app.upstream.free, [], 'failed connections are never pooled')

    def test_unreachable_upstream_is_502_connect_error(self):
        def refused():
            return http.client.HTTPConnection('127.0.0.1', 1, timeout=2)
        with self.running(upstream_factory=refused):
            status, _, raw = self.request('POST', '/api/detect', self.payload())
            self.assertEqual(status, 502)
            self.assertIn(b'Could not connect', raw)


class StaticCacheTests(Harness):
    def test_static_assets_revalidate_with_etag_and_304(self):
        with self.running():
            status, headers, body = self.request('GET', '/app.js')
            self.assertEqual(status, 200)
            self.assertEqual(headers['Cache-Control'], 'private, no-cache')
            etag = headers['ETag']
            status, headers, body = self.request('GET', '/app.js', headers={'If-None-Match': etag})
            self.assertEqual((status, body), (304, b''))
            self.assertEqual(headers['ETag'], etag)
            self.assertEqual(self.request('GET', '/app.js', headers={'If-None-Match': '"other"'})[0], 200)
            self.assertEqual(self.request('GET', '/api/config')[1]['Cache-Control'], 'no-store')

    def test_large_vendor_asset_is_gzipped_once_and_identical(self):
        with self.running():
            status, plain_headers, plain = self.request('GET', '/trackingvendor/opencv.js')
            self.assertEqual(status, 200)
            self.assertNotIn('Content-Encoding', plain_headers)
            status, headers, packed = self.request('GET', '/trackingvendor/opencv.js', headers={'Accept-Encoding': 'gzip, deflate'})
            self.assertEqual(headers['Content-Encoding'], 'gzip')
            self.assertEqual(headers['Vary'], 'Accept-Encoding')
            self.assertLess(len(packed), len(plain) // 2)
            self.assertEqual(gzip.decompress(packed), plain)
            self.assertNotEqual(headers['ETag'], plain_headers['ETag'])
            self.assertEqual(self.request('GET', '/trackingvendor/opencv.js', headers={'Accept-Encoding': 'gzip;q=0'})[1].get('Content-Encoding'), None)
            self.assertEqual(self.request('GET', '/trackingvendor/opencv.js', headers={'Accept-Encoding': 'gzip', 'If-None-Match': headers['ETag']})[0], 304)

    def test_protected_assets_still_require_access(self):
        with self.running(access_token='access-secret'):
            self.assertEqual(self.request('GET', '/trackingvendor/opencv.js')[0], 401)


if __name__ == '__main__':
    unittest.main()
