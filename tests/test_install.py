"""Home-screen install and notification plumbing: manifest, service worker, icon."""
import json
import unittest

import test_server


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.harness = test_server.HTTPTests()

    def test_manifest_worker_and_icon_are_served_to_authorized_sessions(self):
        with self.harness.running():
            status, headers, body = self.harness.request('GET', '/manifest.webmanifest')
            self.assertEqual((status, headers['Content-Type']), (200, 'application/manifest+json'))
            manifest = json.loads(body)
            self.assertEqual((manifest['start_url'], manifest['scope'], manifest['display']), ('/', '/', 'standalone'))
            status, headers, body = self.harness.request('GET', '/sw.js')
            self.assertEqual((status, headers['Content-Type']), (200, 'text/javascript'))
            self.assertIn(b'notificationclick', body)
            self.assertNotIn(b"addEventListener('fetch'", body, 'the worker never intercepts requests')
            self.assertEqual(self.harness.request('GET', '/icon.svg')[1]['Content-Type'], 'image/svg+xml')

    def test_home_screen_app_reopens_with_the_access_link(self):
        token = 'ab' * 16
        with self.harness.running(access_token=token):
            self.assertEqual(self.harness.request('GET', '/manifest.webmanifest')[0], 401, 'never served without a session')
            status, headers, _ = self.harness.request('GET', f'/?access={token}')
            cookie = headers['Set-Cookie'].split(';')[0]
            status, _, body = self.harness.request('GET', '/manifest.webmanifest', headers={'Cookie': cookie})
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body)['start_url'], f'/?access={token}')


if __name__ == '__main__':
    unittest.main()
