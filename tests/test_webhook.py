"""Webhook relay: only the configured request is sent, and never to local addresses."""
import importlib.util
import ipaddress
import json
import socket
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import test_server

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('jev_webhook_tests', ROOT / 'webhook.py')
webhook = importlib.util.module_from_spec(spec)
spec.loader.exec_module(webhook)


class Receiver:
    """Local stand-in for a webhook endpoint (Home Assistant, IFTTT, …)."""

    def __init__(self, status=200, location=None):
        owner = self
        self.hits = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def handle_any(self):
                size = int(self.headers.get('Content-Length') or 0)
                owner.hits.append({'method': self.command, 'path': self.path, 'host': self.headers['Host'],
                                   'type': self.headers.get('Content-Type'), 'body': self.rfile.read(size).decode()})
                self.send_response(status)
                if location:
                    self.send_header('Location', location)
                self.send_header('Content-Length', '2')
                self.end_headers()
                self.wfile.write(b'ok')

            do_GET = do_POST = do_PUT = handle_any

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.server.shutdown()
        self.server.server_close()


def fixed_resolver(address, calls=None):
    def resolve(host, port, type=0):
        if calls is not None:
            calls.append(host)
        family = socket.AF_INET6 if ':' in address else socket.AF_INET
        return [(family, socket.SOCK_STREAM, 6, '', (address, port))]
    return resolve


class AddressPolicyTests(unittest.TestCase):
    def test_local_and_metadata_addresses_are_always_refused(self):
        for raw in ('127.0.0.1', '::1', '::ffff:127.0.0.1', '169.254.169.254', 'fe80::1', '0.0.0.0', '224.0.0.1', '240.0.0.1'):
            for allow_private in (False, True):
                self.assertFalse(webhook.address_allowed(ipaddress.ip_address(raw), allow_private), raw)

    def test_lan_and_tailnet_need_explicit_opt_in(self):
        for raw in ('10.0.0.5', '192.168.1.20', '172.16.0.9', '100.101.102.103', 'fd00::1'):
            self.assertFalse(webhook.address_allowed(ipaddress.ip_address(raw), False), raw)
            self.assertTrue(webhook.address_allowed(ipaddress.ip_address(raw), True), raw)
        for raw in ('1.1.1.1', '2606:4700:4700::1111'):
            self.assertTrue(webhook.address_allowed(ipaddress.ip_address(raw), False), raw)

    def test_url_shape(self):
        for bad in ('ftp://a.com/', 'https://user:pw@a.com/', 'https:///x', 'javascript:alert(1)', 'https://a.com/ x', 'https://a.com:99999/', '', 'h' * 2001):
            with self.assertRaises(webhook.WebhookError, msg=bad):
                webhook.parse_target(bad)
        self.assertEqual(webhook.parse_target('http://hooks.test:8123/api/webhook/abc?x=1'), ('http', 'hooks.test', 8123, '/api/webhook/abc?x=1'))


class RelayTests(unittest.TestCase):
    def setUp(self):
        self.harness = test_server.HTTPTests()

    def post(self, body, **headers):
        status, _, data = self.harness.request('POST', '/api/webhook', body, headers)
        return status, json.loads(data)

    def test_relays_exact_request_to_pinned_address_without_redirects(self):
        calls = []
        relay = webhook.WebhookRelay(resolver=fixed_resolver('127.0.0.1', calls), allow=lambda ip: True)
        with Receiver() as hook, self.harness.running(webhook_relay=relay):
            url = f'http://hooks.test:{hook.port}/api/webhook/lights?room=desk'
            status, data = self.post({'url': url, 'method': 'POST', 'body': '{"label": "keys", "event": "on"}'})
            self.assertEqual((status, data), (200, {'status': 200}))
            self.assertEqual(hook.hits, [{'method': 'POST', 'path': '/api/webhook/lights?room=desk', 'host': f'hooks.test:{hook.port}',
                                          'type': 'application/json', 'body': '{"label": "keys", "event": "on"}'}])
            self.assertEqual(calls, ['hooks.test'], 'one lookup; the connection uses the checked address')
            status, _ = self.post({'url': url, 'method': 'PUT', 'body': 'keys seen'})
            self.assertEqual(hook.hits[-1]['type'], 'text/plain; charset=utf-8')
            self.post({'url': url, 'method': 'GET', 'body': 'ignored'})
            self.assertEqual((hook.hits[-1]['method'], hook.hits[-1]['body']), ('GET', ''))
        with Receiver() as target, Receiver(status=302, location=f'http://127.0.0.1:{target.port}/') as hook, self.harness.running(webhook_relay=relay):
            status, data = self.post({'url': f'http://hooks.test:{hook.port}/', 'method': 'POST', 'body': ''})
            self.assertEqual((status, data['error']), (502, 'Webhook answered HTTP 302.'))
            self.assertEqual(target.hits, [], 'redirects are never followed')

    def test_default_relay_refuses_this_machine(self):
        with Receiver() as hook, self.harness.running():
            for host in ('127.0.0.1', 'localhost', '[::1]'):
                status, data = self.post({'url': f'http://{host}:{hook.port}/', 'method': 'POST', 'body': 'x'})
                self.assertEqual(status, 403, host)
                self.assertIn('private or local', data['error'])
            self.assertEqual(hook.hits, [])
        with Receiver() as hook, self.harness.running(webhook_allow_private=True):
            status, _ = self.post({'url': f'http://127.0.0.1:{hook.port}/', 'method': 'POST', 'body': 'x'})
            self.assertEqual(status, 403, 'LAN opt-in never includes loopback')
            self.assertEqual(hook.hits, [])

    def test_rebinding_to_a_local_address_is_refused(self):
        relay = webhook.WebhookRelay(resolver=fixed_resolver('169.254.169.254'))
        with self.harness.running(webhook_relay=relay):
            status, _ = self.post({'url': 'http://metadata.example/latest', 'method': 'GET', 'body': ''})
            self.assertEqual(status, 403)

    def test_same_origin_access_and_payload_checks(self):
        relay = webhook.WebhookRelay(resolver=fixed_resolver('127.0.0.1'), allow=lambda ip: True)
        with Receiver() as hook, self.harness.running(webhook_relay=relay):
            good = {'url': f'http://hooks.test:{hook.port}/', 'method': 'POST', 'body': 'x'}
            self.assertEqual(self.post(good, Origin='https://evil.example')[0], 403)
            for bad in ({**good, 'method': 'DELETE'}, {**good, 'body': 'x' * 4097}, {**good, 'extra': 1},
                        {**good, 'url': 'https://u:p@hooks.test/'}, {**good, 'url': 'file:///etc/passwd'}, {**good, 'body': 5}):
                self.assertEqual(self.post(bad)[0], 400, bad)
            self.assertEqual(hook.hits, [])
        with self.harness.running(access_token='a' * 32, webhook_relay=relay):
            self.assertEqual(self.post(good)[0], 401)

    def test_custom_headers_are_sent_but_framing_headers_are_not(self):
        seen = []
        class Capture(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_POST(self):
                seen.append(dict(self.headers))
                self.rfile.read(int(self.headers.get('Content-Length') or 0))
                self.send_response(200); self.send_header('Content-Length', '0'); self.end_headers()
        server = ThreadingHTTPServer(('127.0.0.1', 0), Capture)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        relay = webhook.WebhookRelay(resolver=fixed_resolver('127.0.0.1'), allow=lambda ip: True)
        try:
            with self.harness.running(webhook_relay=relay):
                url = f'http://hooks.test:{server.server_address[1]}/'
                status, _ = self.post({'url': url, 'method': 'POST', 'body': '{"a":1}', 'headers': [['Authorization', 'Bearer abc'], ['Content-Type', 'application/vnd.x+json']]})
                self.assertEqual(status, 200)
                self.assertEqual((seen[0]['Authorization'], seen[0]['Content-Type']), ('Bearer abc', 'application/vnd.x+json'))
                for bad in ([['Host', 'evil']], [['Content-Length', '1']], [['X-A', 'a\r\nX-B: b']], [['Bad Name', 'x']], [['X-A', '1'], ['x-a', '2']], [['X', 'y']] * 9, 'Authorization: x', [['X']]):
                    self.assertEqual(self.post({'url': url, 'method': 'POST', 'body': '', 'headers': bad})[0], 400, bad)
                self.assertEqual(len(seen), 1)
        finally:
            server.shutdown(); server.server_close()

    def test_rate_limit(self):
        now = [0.0]
        relay = webhook.WebhookRelay(resolver=fixed_resolver('127.0.0.1'), allow=lambda ip: True, clock=lambda: now[0])
        with Receiver() as hook, self.harness.running(webhook_relay=relay):
            body = {'url': f'http://hooks.test:{hook.port}/', 'method': 'POST', 'body': ''}
            for _ in range(webhook.RATE_LIMIT):
                self.assertEqual(self.post(body)[0], 200)
            self.assertEqual(self.post(body)[0], 429)
            now[0] = webhook.RATE_WINDOW + 1
            self.assertEqual(self.post(body)[0], 200)

    def test_unreachable_and_failing_hooks(self):
        relay = webhook.WebhookRelay(resolver=fixed_resolver('127.0.0.1'), allow=lambda ip: True)
        with Receiver(status=500) as hook, self.harness.running(webhook_relay=relay):
            status, data = self.post({'url': f'http://hooks.test:{hook.port}/', 'method': 'POST', 'body': ''})
            self.assertEqual((status, data['status']), (502, 500))
        free = socket.socket(); free.bind(('127.0.0.1', 0)); port = free.getsockname()[1]; free.close()
        with self.harness.running(webhook_relay=relay):
            status, data = self.post({'url': f'http://hooks.test:{port}/', 'method': 'POST', 'body': ''})
            self.assertEqual((status, data['error']), (502, 'Could not reach the webhook.'))


if __name__ == '__main__':
    unittest.main()
