"""Webhook relay for Visual Actions custom steps. Standard library only.

The browser cannot call arbitrary URLs (CSP ``connect-src 'self'`` and CORS), so
an authorized page asks this server to send one small request on its behalf.

Guards:
- http/https only, no credentials in the URL, bounded URL and body sizes.
- The host is resolved once and every resolved address is checked. The
  connection is pinned to the checked address, so DNS cannot swap in another one
  between the check and the connect (rebinding).
- Loopback, link-local (cloud metadata), multicast, unspecified and reserved
  addresses are always refused: they would reach this server or the machine
  it runs on. Private/LAN/CGNAT (tailnet) addresses are refused unless the
  server owner opts in with ``WEBHOOK_ALLOW_PRIVATE=1``.
- Redirects are never followed; only the status code is reported back.
"""
import http.client
import re
import ipaddress
import socket
import ssl
import threading
import time
from urllib.parse import urlsplit

METHODS = ('POST', 'PUT', 'GET')
URL_LIMIT = 2000
BODY_LIMIT = 4096
TIMEOUT = 8
RATE_LIMIT = 20  # requests per RATE_WINDOW seconds, for the whole server
RATE_WINDOW = 60.0
MAX_HEADERS = 8
# Framing, routing and hop-by-hop headers stay under this relay's control.
BLOCKED_HEADERS = {'host', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'upgrade', 'te',
                   'trailer', 'expect', 'proxy-authorization', 'proxy-connection', 'cookie', 'forwarded',
                   'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip'}


class WebhookError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def address_allowed(ip, allow_private):
    if ip.version == 6 and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    if ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_unspecified or ip.is_reserved:
        return False
    if ip.is_global:
        return True
    return allow_private


def parse_target(url):
    if not isinstance(url, str) or not 1 <= len(url) <= URL_LIMIT or any(ord(c) < 33 or ord(c) == 127 for c in url):
        raise WebhookError(400, 'Use a full http:// or https:// webhook URL.')
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        raise WebhookError(400, 'Use a full http:// or https:// webhook URL.')
    if parts.scheme not in ('http', 'https') or not parts.hostname:
        raise WebhookError(400, 'Use a full http:// or https:// webhook URL.')
    if parts.username is not None or parts.password is not None:
        raise WebhookError(400, 'Put credentials in the webhook path or body, not in user:password@.')
    port = port or (443 if parts.scheme == 'https' else 80)
    path = (parts.path or '/') + ('?' + parts.query if parts.query else '')
    return parts.scheme, parts.hostname, port, path


def check_headers(headers):
    """[[name, value], ...] → dict. Lets a step send e.g. Authorization: Bearer … to Home Assistant."""
    if headers is None:
        return {}
    if not isinstance(headers, list) or len(headers) > MAX_HEADERS:
        raise WebhookError(400, f'Use up to {MAX_HEADERS} webhook headers.')
    out = {}
    for pair in headers:
        if not isinstance(pair, list) or len(pair) != 2 or not all(isinstance(x, str) for x in pair):
            raise WebhookError(400, 'Webhook headers must be Name: value lines.')
        name, value = pair
        if not re.fullmatch(r"[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}", name) or len(value) > 2048 or any(ord(c) < 32 and c != '\t' or ord(c) == 127 for c in value):
            raise WebhookError(400, 'Webhook headers must be Name: value lines.')
        if name.lower() in BLOCKED_HEADERS or name.lower() in {k.lower() for k in out}:
            raise WebhookError(400, f'The {name} header cannot be set or repeated.')
        out[name] = value
    return out


class _PinnedHTTP(http.client.HTTPConnection):
    def __init__(self, host, port, address, timeout):
        super().__init__(host, port, timeout=timeout)
        self._address = address

    def connect(self):
        self.sock = socket.create_connection((self._address, self.port), self.timeout)


class _PinnedHTTPS(http.client.HTTPSConnection):
    def __init__(self, host, port, address, timeout):
        super().__init__(host, port, timeout=timeout, context=ssl.create_default_context())
        self._address = address

    def connect(self):
        sock = socket.create_connection((self._address, self.port), self.timeout)
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)


class WebhookRelay:
    Error = WebhookError

    def __init__(self, allow_private=False, resolver=socket.getaddrinfo, allow=None, clock=time.monotonic):
        self.allow = allow or (lambda ip: address_allowed(ip, allow_private))
        self.resolver = resolver
        self.clock = clock
        self.sent = []
        self.lock = threading.Lock()

    def _rate(self):
        with self.lock:
            now = self.clock()
            self.sent = [t for t in self.sent if now - t < RATE_WINDOW]
            if len(self.sent) >= RATE_LIMIT:
                raise WebhookError(429, f'Webhook limit reached ({RATE_LIMIT} per minute). Try again shortly.')
            self.sent.append(now)

    def _resolve(self, host, port):
        try:
            infos = self.resolver(host, port, type=socket.SOCK_STREAM)
        except (OSError, UnicodeError):
            raise WebhookError(502, 'Webhook host could not be resolved.')
        addresses = []
        for info in infos:
            raw = info[4][0].split('%')[0]
            ip = ipaddress.ip_address(raw)
            if not self.allow(ip):
                raise WebhookError(403, 'Webhook address is private or local. The server owner can allow LAN/tailnet hosts with WEBHOOK_ALLOW_PRIVATE=1.')
            addresses.append(raw)
        if not addresses:
            raise WebhookError(502, 'Webhook host could not be resolved.')
        return addresses[0]

    def send(self, url, method, body, headers=None):
        if method not in METHODS:
            raise WebhookError(400, 'Webhook method must be POST, PUT or GET.')
        if not isinstance(body, str) or len(body.encode()) > BODY_LIMIT:
            raise WebhookError(400, f'Webhook body must be text up to {BODY_LIMIT} bytes.')
        extra = check_headers(headers)
        scheme, host, port, path = parse_target(url)
        self._rate()
        address = self._resolve(host, port)
        cls = _PinnedHTTPS if scheme == 'https' else _PinnedHTTP
        conn = cls(host, port, address, TIMEOUT)
        headers = {'User-Agent': 'JevLive-Webhook/1', 'Accept': '*/*'}
        data = None
        if method != 'GET':
            data = body.encode()
            stripped = body.lstrip()
            headers['Content-Type'] = 'application/json' if stripped[:1] in ('{', '[') else 'text/plain; charset=utf-8'
        for name, value in extra.items():  # yours win over the defaults above
            for key in [k for k in headers if k.lower() == name.lower()]:
                del headers[key]
            headers[name] = value
        try:
            conn.request(method, path, body=data, headers=headers)
            response = conn.getresponse()
            response.read(2048)  # discarded: only the status code is reported
            return response.status
        except (TimeoutError, socket.timeout):
            raise WebhookError(504, 'Webhook timed out.')
        except ssl.SSLError:
            raise WebhookError(502, 'Webhook TLS certificate was not accepted.')
        except (OSError, http.client.HTTPException):
            raise WebhookError(502, 'Could not reach the webhook.')
        finally:
            conn.close()
