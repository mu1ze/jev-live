"""Loopback-only Jev camera gateway. No third-party runtime dependencies."""
import base64
import binascii
import json
import re
import struct
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


MAX_BODY = 2 * 1024 * 1024


def load_local_key(path, environ):
    """Load only JEV_API_KEY; never execute or interpolate dotenv contents."""
    from pathlib import Path
    path = Path(path)
    if environ.get('JEV_API_KEY') or not path.exists():
        return
    if path.stat().st_size > 65536:
        raise ValueError('Local environment file exceeds the supported size.')
    for line in path.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if line.startswith('export '):
            line = line[7:].strip()
        name, separator, value = line.partition('=')
        if not separator or name.strip() != 'JEV_API_KEY':
            continue
        value = value.strip()
        if value[:1] in ('\"', "'") and value[-1:] == value[:1] and len(value) >= 2:
            value = value[1:-1]
        else:
            value = value.split(' #', 1)[0].rstrip()
        if not re.fullmatch(r'[\x21-\x7e]{1,512}', value) or any(c in value for c in '$`\\\\'):
            raise ValueError('JEV_API_KEY in the local environment file is invalid.')
        environ['JEV_API_KEY'] = value
        return


def validate_image(encoded, fmt):
    if fmt not in ('jpg', 'jpeg', 'png') or not isinstance(encoded, str):
        raise ValueError()
    raw = base64.b64decode(encoded, validate=True)
    width = height = 0
    if fmt == 'png':
        if raw[:8] != b'\x89PNG\r\n\x1a\n':
            raise ValueError()
        offset, seen_data, ended = 8, False, False
        while offset + 12 <= len(raw):
            size = struct.unpack('>I', raw[offset:offset+4])[0]
            kind = raw[offset+4:offset+8]
            end = offset + 8 + size
            data = raw[offset+8:end]
            if end + 4 > len(raw) or zlib.crc32(kind + data) != struct.unpack('>I', raw[end:end+4])[0]:
                raise ValueError()
            if offset == 8:
                if kind != b'IHDR' or size != 13:
                    raise ValueError()
                width, height = struct.unpack('>II', data[:8])
            if kind == b'IDAT':
                seen_data = True
            offset = end + 4
            if kind == b'IEND':
                ended = offset == len(raw)
                break
        if not seen_data or not ended:
            raise ValueError()
    else:
        if not raw.startswith(b'\xff\xd8') or not raw.endswith(b'\xff\xd9'):
            raise ValueError()
        offset = 2
        while offset + 4 < len(raw):
            if raw[offset] != 255:
                raise ValueError()
            marker = raw[offset+1]
            if marker == 255:
                offset += 1
                continue
            size = int.from_bytes(raw[offset+2:offset+4], 'big')
            if size < 2 or offset + 2 + size > len(raw):
                raise ValueError()
            if marker in (0xC0, 0xC1, 0xC2):
                height, width = struct.unpack('>HH', raw[offset+5:offset+9])
            if marker == 0xDA:
                break
            offset += size + 2
    if not (280 <= width <= 1568 and 280 <= height <= 1568):
        raise ValueError()


UPSTREAM_HOST = 'api.typesafe.ai'
UPSTREAM_PATH = '/v1/systemone'
UPSTREAM_LIMIT = 262144


class UpstreamStatusError(Exception):
    """Non-200 upstream reply; its body is never surfaced."""


class UpstreamPool:
    """Bounded keep-alive pool for the single fixed upstream.

    urllib sends ``Connection: close`` so every detection used to pay a fresh
    TCP + TLS handshake. Reusing a warm connection removes that from each
    serial request. Redirects are never followed (http.client has no redirect
    support). A request is retried once only when a *reused* idle connection
    turns out to have been closed by the peer before any reply byte arrived.
    """

    RETRYABLE = (ConnectionResetError, BrokenPipeError)

    def __init__(self, factory, size=4, idle_seconds=20.0):
        import threading
        self.factory, self.size, self.idle_seconds = factory, size, idle_seconds
        self.lock = threading.Lock()
        self.free = []
        self.opened = 0

    def _acquire(self):
        import time
        with self.lock:
            while self.free:
                conn, released = self.free.pop()
                if time.monotonic() - released < self.idle_seconds:
                    return conn, True
                conn.close()
            self.opened += 1
        return self.factory(), False

    def _release(self, conn):
        import time
        with self.lock:
            if len(self.free) < self.size:
                self.free.append((conn, time.monotonic()))
                return
        conn.close()

    def close(self):
        with self.lock:
            free, self.free = self.free, []
        for conn, _ in free:
            conn.close()

    def post(self, body, headers):
        import http.client
        for attempt in (0, 1):
            conn, reused = self._acquire()
            try:
                conn.request('POST', UPSTREAM_PATH, body=body, headers=headers)
                response = conn.getresponse()
            except (http.client.RemoteDisconnected, *self.RETRYABLE):
                conn.close()
                if reused and attempt == 0:
                    continue
                raise
            except BaseException:
                conn.close()
                raise
            try:
                if response.status != 200:
                    raise UpstreamStatusError()
                raw = response.read(UPSTREAM_LIMIT + 1)
                if len(raw) > UPSTREAM_LIMIT:
                    raise ValueError()
            except BaseException:
                conn.close()
                raise
            # Only a fully consumed keep-alive reply leaves the socket reusable.
            if response.will_close or not response.isclosed():
                conn.close()
            else:
                self._release(conn)
            return json.loads(raw)


def default_upstream_connection():
    import http.client
    # Certificate verification uses the default trusted context.
    return http.client.HTTPSConnection(UPSTREAM_HOST, timeout=25)


class StaticCache:
    """In-memory static assets with strong ETags and optional gzip.

    Assets are re-read only when their mtime/size change. Responses are
    ``private, no-cache``: browsers revalidate every use (304, no body), so a
    restart of the tracking worker no longer re-downloads 11 MB of OpenCV.
    """

    # Wasm and model files shrink by 25–70% too; they are compressed once, then cached.
    COMPRESSIBLE = ('text/', 'application/json', 'application/wasm', 'application/octet-stream')

    def __init__(self, root):
        import threading
        self.root, self.entries, self.lock = root, {}, threading.Lock()

    def get(self, filename, mime):
        import gzip
        import hashlib
        path = self.root / filename
        stat = path.stat()
        stamp = (stat.st_mtime_ns, stat.st_size)
        with self.lock:
            entry = self.entries.get(filename)
            if entry and entry['stamp'] == stamp:
                return entry
        body = path.read_bytes()
        tag = hashlib.sha256(body).hexdigest()[:24]
        entry = {'stamp': stamp, 'body': body, 'etag': f'"{tag}"', 'gzip': None, 'gzip_etag': f'"{tag}-gz"'}
        if len(body) > 1024 and mime.startswith(self.COMPRESSIBLE):
            packed = gzip.compress(body, 6, mtime=0)
            if len(packed) < len(body) * 0.9:
                entry['gzip'] = packed
        with self.lock:
            self.entries[filename] = entry
        return entry


GESTURE_VENDOR = {
    'vision_bundle.mjs': 'text/javascript',
    'vision_wasm_module_internal.js': 'text/javascript',
    'vision_wasm_module_internal.wasm': 'application/wasm',
    'hand_landmarker.task': 'application/octet-stream',
    'face_landmarker.task': 'application/octet-stream',
    'LICENSE.mediapipe': 'text/plain',
    'asset-manifest.json': 'application/json',
}


def accepts_gzip(header):
    for part in (header or '').split(','):
        name, _, params = part.strip().partition(';')
        if name.strip().lower() in ('gzip', '*'):
            q = params.strip()
            return not (q.startswith('q=') and q[2:].strip() in ('0', '0.0', '0.00', '0.000'))
    return False


def load_webhook_module():
    import importlib.util
    from pathlib import Path
    spec = importlib.util.spec_from_file_location('jev_webhook', Path(__file__).resolve().parent / 'webhook.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def create_server(port=8788, api_key='', access_token='', prefix='', transport=None, public_prefix=None, upstream_factory=None, webhook_relay=None, webhook_allow_private=False):
    import hashlib
    import hmac
    import secrets
    import time
    from http.cookies import SimpleCookie
    from urllib.parse import urlsplit, parse_qs
    prefix = '/' + prefix.strip('/') if prefix.strip('/') else ''
    public_prefix = prefix if public_prefix is None else ('/' + public_prefix.strip('/') if public_prefix.strip('/') else '')
    if any(not re.fullmatch(r'(?:/[A-Za-z0-9_-]+)*', value) for value in (prefix, public_prefix)):
        raise ValueError('Mount prefixes must contain simple path segments.')
    signing_key = secrets.token_bytes(32)
    from pathlib import Path
    static_cache = StaticCache(Path(__file__).parent / 'static')
    # Test callers may inject a plain-HTTP connection factory; never via HTTP/env/CLI.
    upstream = UpstreamPool(upstream_factory or default_upstream_connection)
    webhook = load_webhook_module()
    # Tests may inject a relay with their own resolver/address policy; never via HTTP.
    webhooks = webhook_relay or webhook.WebhookRelay(allow_private=webhook_allow_private)

    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(30)

        def end_headers(self):
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Referrer-Policy', 'no-referrer')
            path = urlsplit(self.path).path
            worker = path == prefix + '/tracking-worker.js'
            # The gesture worker may fetch only this app's own runtime and model files.
            gesture = path == prefix + '/gesture-worker.mjs'
            policy = "default-src 'none'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'none'; worker-src 'none'" if worker else "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'none'" if gesture else "default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
            self.send_header('Content-Security-Policy', policy)
            self.send_header('Permissions-Policy', 'camera=(self), microphone=()')
            super().end_headers()

        def secure_proxy(self):
            return self.client_address[0] in ('127.0.0.1', '::1') and self.headers.get('X-Forwarded-Proto') == 'https'

        def authorized(self):
            if not access_token:
                return True
            try:
                cookies = SimpleCookie(self.headers.get('Cookie', ''))
                value = cookies['jev_session'].value
                stamp, sig = value.split('.')
                expected = hmac.new(signing_key, stamp.encode(), hashlib.sha256).hexdigest()
                return 0 <= time.time() - int(stamp) < 28800 and hmac.compare_digest(sig, expected)
            except (KeyError, ValueError):
                return False

        def guard(self):
            if not self.authorized():
                self.send_json(401, {'error': 'Access denied. Open your private access link.'})
                return False
            return True

        def do_GET(self):
            parsed = urlsplit(self.path)
            if access_token and 'access' in parse_qs(parsed.query, keep_blank_values=True):
                supplied = parse_qs(parsed.query, keep_blank_values=True)['access']
                if len(supplied) != 1 or not hmac.compare_digest(supplied[0].encode(), access_token.encode()):
                    self.send_json(401, {'error': 'Access denied.'})
                    return
                stamp = str(int(time.time()))
                signature = hmac.new(signing_key, stamp.encode(), hashlib.sha256).hexdigest()
                self.send_response(303)
                self.send_header('Set-Cookie', f'jev_session={stamp}.{signature}; Path={public_prefix}/; HttpOnly; SameSite=Lax; Max-Age=28800' + ('; Secure' if self.secure_proxy() else ''))
                self.send_header('Location', public_prefix + '/')
                self.send_header('Cache-Control', 'no-store')
                self.send_header('Content-Length', '0')
                self.end_headers()
                return
            if not self.guard():
                return
            if parsed.path == prefix + '/manifest.webmanifest':
                # Home-screen apps (iOS needs one for notifications) have their own cookie
                # jar, so the start URL carries the access link. Only an authorized
                # session can read this, and it already holds the token.
                start = public_prefix + '/' + ('?access=' + access_token if access_token else '')
                manifest = {'name': 'Jev Live', 'short_name': 'Jev Live', 'start_url': start, 'scope': public_prefix + '/',
                            'display': 'standalone', 'background_color': '#0c120d', 'theme_color': '#0c120d',
                            'icons': [{'src': 'icon.svg', 'sizes': 'any', 'type': 'image/svg+xml', 'purpose': 'any'}]}
                body = json.dumps(manifest).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/manifest+json')
                self.send_header('Content-Length', str(len(body)))
                self.send_header('Cache-Control', 'no-store')
                self.end_headers()
                self.wfile.write(body)
                return
            if parsed.path == prefix + '/api/config':
                self.send_json(200, {'serverKeyConfigured': bool(api_key)})
                return
            if parsed.path == prefix and prefix:
                self.send_response(308)
                self.send_header('Location', public_prefix + '/')
                self.send_header('Content-Length', '0')
                self.end_headers()
                return
            static_routes = {'/': ('index.html', 'text/html; charset=utf-8'), '/app.js': ('app.js', 'text/javascript'), '/core.mjs': ('core.mjs', 'text/javascript'), '/style.css': ('style.css', 'text/css'), '/icon.svg': ('icon.svg', 'image/svg+xml')}
            for name in ('tracking-worker.js', 'tracker-classic.js', 'tracking-client.mjs', 'visual-actions.mjs', 'action-view.mjs', 'action-audio.mjs', 'custom-actions.mjs', 'device-actions.mjs', 'sw.js'):
                static_routes['/' + name] = (name, 'text/javascript')
            for name in ('opencv.js', 'LICENSE.opencv', 'COPYRIGHT.opencv', 'asset-manifest.json'):
                static_routes['/trackingvendor/' + name] = ('trackingvendor/' + name, 'text/javascript' if name.endswith('.js') else 'text/plain')
            for name in ('gesture-worker.mjs', 'gestures.mjs', 'mini-games.mjs', 'controller-view.mjs', 'gesture-client.mjs'):
                static_routes['/' + name] = (name, 'text/javascript')
            for name, mime in GESTURE_VENDOR.items():
                static_routes['/gesturevendor/' + name] = ('gesturevendor/' + name, mime)
            route = parsed.path[len(prefix):] if parsed.path.startswith(prefix + '/') else None
            if route in static_routes:
                filename, mime = static_routes[route]
                entry = static_cache.get(filename, mime)
                packed = entry['gzip'] is not None and accepts_gzip(self.headers.get('Accept-Encoding'))
                body, etag = (entry['gzip'], entry['gzip_etag']) if packed else (entry['body'], entry['etag'])
                matches = [tag.strip().removeprefix('W/') for tag in self.headers.get('If-None-Match', '').split(',')]
                fresh = etag in matches or '*' in matches
                self.send_response(304 if fresh else 200)
                self.send_header('Content-Type', mime)
                self.send_header('ETag', etag)
                self.send_header('Cache-Control', 'private, no-cache')
                if entry['gzip'] is not None:
                    self.send_header('Vary', 'Accept-Encoding')
                if packed:
                    self.send_header('Content-Encoding', 'gzip')
                if fresh:
                    self.end_headers()
                    return
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                try:
                    self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError):
                    self.close_connection = True  # e.g. worker terminated mid-download
                return
            self.send_json(404, {'error': 'Not found.'})

        def do_HEAD(self):
            if self.guard():
                self.send_json(405, {'error': 'Method not allowed.'})

        do_OPTIONS = do_PUT = do_DELETE = do_PATCH = do_HEAD

        def log_message(self, *args):
            pass  # Request paths, credentials and query strings are never logged.

        def send_json(self, status, data):
            body = json.dumps(data).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            if self.command != 'HEAD':
                self.wfile.write(body)

        def do_POST(self):
            if not self.guard():
                return
            path = urlsplit(self.path).path
            if path not in (prefix + '/api/detect', prefix + '/api/webhook'):
                self.send_json(404, {'error': 'Not found.'})
                return
            host = self.headers.get('Host', '')
            local_host = urlsplit('http://' + host).hostname in ('localhost', '127.0.0.1', '::1')
            expected = 'http://' + host if local_host else None
            if self.secure_proxy():
                expected = 'https://' + self.headers.get('X-Forwarded-Host', host)
            if not expected or self.headers.get('Origin') != expected or self.headers.get('Sec-Fetch-Site') == 'cross-site':
                self.send_json(403, {'error': 'Same-origin requests only.'})
                return
            if path == prefix + '/api/webhook':
                self.relay_webhook()
                return
            from urllib.request import Request
            from urllib.error import HTTPError, URLError
            import uuid
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if size > MAX_BODY:
                    self.send_json(413, {'error': 'Request exceeds 2 MiB.'})
                    return
                if size < 1 or self.headers.get('Transfer-Encoding') or self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
                    raise ValueError()
                body = json.loads(self.rfile.read(size))
                if not isinstance(body, dict):
                    raise ValueError()
                key = body.get('key') or api_key
                if not key:
                    self.send_json(401, {'error': 'An API key is required.'})
                    return
                if not isinstance(key, str) or not re.fullmatch(r'[\x21-\x7e]{1,512}', key):
                    raise ValueError()
                labels = body.get('labels')
                if not isinstance(labels, list) or not 1 <= len(labels) <= 24:
                    raise ValueError()
                if any(not isinstance(label, str) or not re.fullmatch(r"[\w][\w .,'()/-]{0,79}", label) for label in labels) or len(set(labels)) != len(labels):
                    raise ValueError()
                validate_image(body.get('image'), body.get('format'))
            except (ValueError, TypeError, KeyError, binascii.Error, struct.error):
                self.send_json(400, {'error': 'Invalid image, labels, key or JSON payload.'})
                return
            ref = str(uuid.uuid4())
            questions = {}
            for i, label in enumerate(body['labels']):
                questions[f'target_{i}_visible'] = {'type': 'noul', 'instructions': f'Is there a {label} in `photo`?'}
                questions[f'target_{i}'] = {'type': 'box', 'instructions': f'the {label} in `photo`'}
            payload = {'model': 'jev-1.14.0', 'state': {'photo': ref}, 'assets': {ref: {'type': 'image', 'format': body['format'], 'data_base64': body['image']}}, 'questions': questions}
            data = json.dumps(payload).encode()
            headers = {'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json', 'TypeSafe-Danger-Zone-Images': 'true'}
            try:
                if transport:
                    # Test injection; not configurable through HTTP/env.
                    answer = transport(Request(f'https://{UPSTREAM_HOST}{UPSTREAM_PATH}', data=data, headers=headers))
                else:
                    answer = upstream.post(data, headers)
                if not isinstance(answer.get('answers'), dict):
                    raise ValueError()
            except (HTTPError, UpstreamStatusError) as error:
                if isinstance(error, HTTPError):
                    error.close()
                self.send_json(502, {'error': 'Jev request failed. Check your key, quota and image.'})
                return
            except URLError as error:
                if isinstance(error.reason, TimeoutError):
                    self.send_json(504, {'error': 'Jev request timed out. Try a slower cadence.'})
                else:
                    self.send_json(502, {'error': 'Could not connect to Jev. Try again later.'})
                return
            except TimeoutError:
                self.send_json(504, {'error': 'Jev request timed out. Try a slower cadence.'})
                return
            except OSError:
                self.send_json(502, {'error': 'Could not connect to Jev. Try again later.'})
                return
            except Exception:
                self.send_json(502, {'error': 'Jev request failed. Check your key, quota and image.'})
                return
            import math
            def unit(value):
                return type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 1
            detections = []
            for i, label in enumerate(body['labels']):
                try:
                    box = answer['answers'][f'target_{i}']
                    visible = answer['answers'][f'target_{i}_visible']
                    presence = visible['noul']
                    edges = box['box']
                    confidence = box['confidence']
                    if box['type'] != 'box' or visible['type'] != 'noul' or not unit(presence) or presence < .7 or not unit(confidence):
                        continue
                    edges = {k: edges[k] for k in ('left', 'right', 'top', 'bottom')}
                    if not all(unit(v) for v in edges.values()) or edges['left'] >= edges['right'] or edges['top'] >= edges['bottom']:
                        continue
                    detections.append({'label': label, 'box': edges, 'confidence': min(presence, confidence), 'presence': presence})
                except (KeyError, TypeError):
                    continue
            self.send_json(200, {'detections': detections})

        def relay_webhook(self):
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 1 <= size <= 16384 or self.headers.get('Transfer-Encoding') or self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
                    raise ValueError()
                body = json.loads(self.rfile.read(size))
                if not isinstance(body, dict) or not {'url', 'method', 'body'} <= set(body) <= {'url', 'method', 'body', 'headers'}:
                    raise ValueError()
            except (ValueError, TypeError):
                self.send_json(400, {'error': 'Invalid webhook request.'})
                return
            try:
                status = webhooks.send(body['url'], body['method'], body['body'], body.get('headers'))
            except webhooks.Error as error:
                self.send_json(error.status, {'error': error.message})
                return
            if 200 <= status < 300:
                self.send_json(200, {'status': status})
            else:
                self.send_json(502, {'error': f'Webhook answered HTTP {status}.', 'status': status})

    class Server(ThreadingHTTPServer):
        def server_close(self):
            super().server_close()
            upstream.close()

    server = Server(('127.0.0.1', port), Handler)
    server.upstream = upstream
    return server


if __name__ == '__main__':
    import argparse
    import os
    from pathlib import Path
    load_local_key(Path(__file__).resolve().parent / '.env.local', os.environ)
    parser = argparse.ArgumentParser(description='Loopback-only live Jev vision dashboard.')
    parser.add_argument('--port', type=int, default=int(os.environ.get('PORT', '8788')))
    parser.add_argument('--prefix', default=os.environ.get('APP_PREFIX', ''), help='Only for prefix-preserving proxies; leave empty when proxy strips /jev-live.')
    parser.add_argument('--public-prefix', default=os.environ.get('PUBLIC_PREFIX'), help='External mount for redirects and cookies when the reverse proxy strips its path prefix.')
    args = parser.parse_args()
    app = create_server(port=args.port, api_key=os.environ.get('JEV_API_KEY', ''), access_token=os.environ.get('APP_ACCESS_TOKEN', ''), prefix=args.prefix, public_prefix=args.public_prefix, webhook_allow_private=os.environ.get('WEBHOOK_ALLOW_PRIVATE') == '1')
    print(f'Jev Live listening on http://127.0.0.1:{app.server_address[1]} (credentials and request logs disabled)', flush=True)
    try:
        app.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        app.server_close()
