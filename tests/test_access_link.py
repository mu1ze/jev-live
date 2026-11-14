"""An access link clicked from another site (chat, email) must log in, in real Chromium."""
import unittest

import test_server
from playwright.sync_api import sync_playwright


class AccessLinkTests(unittest.TestCase):
    def test_access_link_clicked_from_another_site_logs_in(self):
        harness = test_server.HTTPTests()
        with harness.running(access_token='fixture-access-token'), sync_playwright() as pw:
            browser = pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
            try:
                link = f'http://127.0.0.1:{harness.port}/?access=fixture-access-token'
                page = browser.new_page()
                page.route('https://example.org/', lambda route: route.fulfill(
                    body=f'<a id="open" href="{link}">open</a>', content_type='text/html'))
                page.goto('https://example.org/')
                page.click('#open')
                page.wait_for_load_state()
                self.assertEqual(page.url, f'http://127.0.0.1:{harness.port}/', 'token removed from the address bar')
                page.locator('h1').wait_for(timeout=5000)
                page.wait_for_timeout(300)
                self.assertTrue(page.locator('#error').is_hidden(), page.locator('#error').inner_text())
                # A later visit from another site keeps the session (top-level GET).
                page.goto('https://example.org/')
                page.route('https://example.org/', lambda route: route.fulfill(
                    body=f'<a id="open" href="http://127.0.0.1:{harness.port}/">open</a>', content_type='text/html'))
                page.reload()
                page.click('#open')
                page.locator('h1').wait_for(timeout=5000)
            finally:
                browser.close()


if __name__ == '__main__':
    unittest.main()
