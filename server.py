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


def create_server(port=8788, api_key='', access_token='', prefix='', transport=None, public_prefix=None):
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

    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(30)

        def end_headers(self):
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Referrer-Policy', 'no-referrer')
            worker = urlsplit(self.path).path == prefix + '/tracking-worker.js'
            policy = "default-src 'none'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; connect-src 'none'; worker-src 'none'" if worker else "default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
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
                self.send_header('Set-Cookie', f'jev_session={stamp}.{signature}; Path={public_prefix}/; HttpOnly; SameSite=Strict; Max-Age=28800' + ('; Secure' if self.secure_proxy() else ''))
                self.send_header('Location', public_prefix + '/')
                self.send_header('Cache-Control', 'no-store')
                self.send_header('Content-Length', '0')
                self.end_headers()
                return
            if not self.guard():
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
            static_routes = {'/': ('index.html', 'text/html; charset=utf-8'), '/app.js': ('app.js', 'text/javascript'), '/core.mjs': ('core.mjs', 'text/javascript'), '/style.css': ('style.css', 'text/css')}
            for name in ('tracking-worker.js', 'tracker-classic.js', 'tracking-client.mjs'):
                static_routes['/' + name] = (name, 'text/javascript')
            for name in ('opencv.js', 'LICENSE.opencv', 'COPYRIGHT.opencv', 'asset-manifest.json'):
                static_routes['/trackingvendor/' + name] = ('trackingvendor/' + name, 'text/javascript' if name.endswith('.js') else 'text/plain')
            route = parsed.path[len(prefix):] if parsed.path.startswith(prefix + '/') else None
            if route in static_routes:
                from pathlib import Path
                filename, mime = static_routes[route]
                body = (Path(__file__).parent / 'static' / filename).read_bytes()
                self.send_response(200)
                self.send_header('Content-Type', mime)
                self.send_header('Content-Length', str(len(body)))
                self.send_header('Cache-Control', 'no-store')
                self.end_headers()
                self.wfile.write(body)
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
            if urlsplit(self.path).path != prefix + '/api/detect':
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
            req = Request('https://api.typesafe.ai/v1/systemone', data=json.dumps(payload).encode(), headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json', 'TypeSafe-Danger-Zone-Images': 'true'})
            try:
                if transport:
                    answer = transport(req)  # Test injection; not configurable through HTTP/env.
                else:
                    from urllib.request import build_opener, HTTPRedirectHandler
                    class NoRedirect(HTTPRedirectHandler):
                        def redirect_request(self, *args, **kwargs):
                            return None
                    with build_opener(NoRedirect).open(req, timeout=25) as response:
                        raw = response.read(262145)
                        if len(raw) > 262144:
                            raise ValueError()
                        answer = json.loads(raw)
                if not isinstance(answer.get('answers'), dict):
                    raise ValueError()
            except HTTPError as error:
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
    return ThreadingHTTPServer(('127.0.0.1', port), Handler)


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
    app = create_server(port=args.port, api_key=os.environ.get('JEV_API_KEY', ''), access_token=os.environ.get('APP_ACCESS_TOKEN', ''), prefix=args.prefix, public_prefix=args.public_prefix)
    print(f'Jev Live listening on http://127.0.0.1:{app.server_address[1]} (credentials and request logs disabled)', flush=True)
    try:
        app.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        app.server_close()
