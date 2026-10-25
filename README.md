# Jev Live

A dependency-free Python HTTP gateway and vanilla browser dashboard combining **Jev recognition with browser-local pixel tracking**. Jev 1.14.0 localizes requested targets; a dedicated OpenCV worker follows measured movement between responses. No simulated detections are shipped in the app. Test fixtures exist only under `tests/`.

## Run

Requires Python 3.10+ and a current browser. The gateway has no pip/npm runtime dependencies. A pinned, same-origin OpenCV 4.13.0 browser runtime is included with its license and provenance; it loads only after Start camera.

```sh
git clone https://github.com/mu1ze/jev-live.git
cd jev-live
python3 server.py --port 8788
```

Open `http://127.0.0.1:8788/` **on the computer running the server**, or use your trusted HTTPS reverse proxy for a cloud deployment. The server always binds **127.0.0.1**, never a public interface. A cloud machine cannot access your laptop's camera directly: `getUserMedia` runs in the browser on your device. Remote camera access requires HTTPS. Upload works as a fallback.

1. Configure `JEV_API_KEY` in `.env.local` next to `server.py`, then start/restart the server. The browser confirms **Secure server key configured**; leave its key field blank. A browser-entered key is an optional override and stays in memory only. **Do not send keys in chat.**
2. Enter 1–24 unique comma-separated target descriptions, each at most 80 characters.
3. Click **Start camera** to request permission and begin inference. No camera or image upload starts on page load. Alternatively choose a JPEG/PNG and click **Analyze image** for one request. File selection alone only creates a local preview.
4. **Stop** releases camera tracks, stops new requests, invalidates pending results, and clears boxes. **Clear** also empties the key field.

Optional server configuration:

- `JEV_API_KEY`: server-side key; UI key becomes optional and can override it. The configuration endpoint returns only a boolean, never the key.
- `APP_ACCESS_TOKEN`: strongly recommended for **any reverse-proxy deployment**, especially when a server key is configured. Restricts HTML, assets and API endpoints.
- `PORT`: default `8788`; command-line `--port` overrides it.
- `APP_PREFIX` / `--prefix`: internal route prefix **only if your proxy preserves the mount path**.
- `PUBLIC_PREFIX` / `--public-prefix`: browser-facing mount path, used for auth redirects and cookie path. Defaults to the internal prefix.

The server loads only `JEV_API_KEY` from `.env.local` alongside `server.py`; other dotenv entries are ignored. Existing process environment takes precedence. Plain `JEV_API_KEY=value` and single/double quoted values are supported, optionally prefixed by `export`. No shell execution or variable interpolation is performed. Keep `.env.local` out of version control and restrict it to mode `600`. This file is not exposed by the HTTP server. A server restart is required after changing it. Access tokens and other settings still come from the process supervisor/environment.

## Tailscale / reverse proxy at `/jev-live/`

For a proxy that **strips** `/jev-live` before forwarding to port 8788 (Tailscale Serve path mounts do this):

```sh
python3 server.py --port 8788 --public-prefix /jev-live
```

Leave `--prefix` empty. Mount the app at the browser path `/jev-live/`, including the trailing slash. Existing root services can remain unchanged. All browser asset and API URLs are relative, so they resolve under this mount. No Tailscale configuration or system services are modified by this project.

If a proxy instead **preserves** the path, use `--prefix /jev-live`; a separate public prefix is unnecessary.

When `APP_ACCESS_TOKEN` is set, open your private URL:

```text
https://YOUR-PRIVATE-HOST/jev-live/?access=YOUR_ACCESS_TOKEN
```

The app uses constant-time token comparison, issues an 8-hour HttpOnly `SameSite=Strict` signed session cookie, and redirects to `/jev-live/` **without the query string**. Cookies receive `Secure` behind the trusted HTTPS proxy. Sessions expire after eight hours or a server restart. Treat access links as secrets: browser history and the proxy can see the initial URL. The app never logs request paths, query strings, request bodies, upstream errors, or keys; configure your reverse proxy not to log secret query strings either. Do not paste access links into public channels.

### Trusted forwarding and CSRF

All POSTs require an exact matching `Origin`; no CORS is enabled. Direct local HTTP requires an Origin matching the local `Host` (`localhost`, `127.0.0.1` or `::1`). A loopback reverse proxy may set `X-Forwarded-Proto: https` and preserve external `Host`, or set external `X-Forwarded-Host`. HTTPS Origin must match that host exactly. Cross-site fetch metadata is rejected. The only trusted forwarding peer is loopback; your proxy **must overwrite/remove client-supplied forwarding headers**. This is a local/private application, not a hardened multitenant public API; local processes are in the trust boundary. Serve it on its own trusted origin or alongside only trusted apps.

## Behavior and billing

- Smooth native video preview runs independently of requests. Detection does **not** run at video frame rate.
- Camera boxes use unique track IDs and measured pixel motion, not coordinate interpolation. Local sampling targets roughly 15 Hz independently of serial Jev requests, with one worker frame in flight and no unbounded queue. Tracked boxes survive weak/missing Jev results only while current visual evidence supports them. Snapshot-only fallback is explicitly labeled if tracking cannot initialize; still-image analysis remains snapshot-only.
- Changed-only DOM updates, stable-width telemetry and one reusable capture canvas remain. The earlier eight-result snapshot-rendering benchmark (8/7 box additions/removals reduced to 1/0) describes the snapshot architecture, not a performance or accuracy claim for tracking.
- Default target: **4 Hz** (250 ms capture-to-capture minimum). Choices: Auto (continuous serial), 4 Hz, 2 Hz, 1 Hz, or economy 0.2 Hz. A request slower than the target interval is followed immediately by the next; there is no extra fixed pause. One browser request remains in flight at a time. Actual completed detections/sec is measured separately from the selected target; latency, target count and provider limits may lower it. API/network errors trigger exponential retry backoff starting at 3 seconds (maximum 30 seconds). Hidden tabs pause new snapshots and resume when visible.
- Up to 24 targets means up to 48 questions per request: one `noul` presence question and one `box` question per target. More targets, larger images and faster cadence cost more. Multiple browser tabs can issue independent requests.
- Snapshots are JPEG at quality 0.82, normally downscaled to a maximum 640-pixel edge. Small images are enlarged to the documented 280-pixel minimum side, without changing aspect ratio; extreme aspect ratios that cannot fit the 1568-pixel maximum are rejected.
- A single Box question always returns a box, even for an absent object. The gateway suppresses boxes with presence below **0.70**, malformed answer types, non-finite values, invalid confidence or coordinates outside `[0,1]`, and inverted/zero-area edges.
- Recognition confidence is **min(presence, box confidence)**. The 70–100% slider gates new tracking seeds and snapshot display. An already supported visual track can remain through weaker recognition; its caption shows the last accepted recognition confidence, not an invented tracking probability.
- All boxes use `object-fit: contain` letterbox-aware geometry. Semantic responses and snapshot-only boxes expire **4 seconds after capture**. Tracking seeds initialize at the captured pixels and replay retained frames to the present; expired/unavailable captures are rejected instead of pasted onto the current video. Live visual tracks require semantic revalidation within **10 seconds**, lose immediately when pixel evidence fails, and clear on frame gaps over 200 ms or watchdog stalls. No velocity extrapolation or cosmetic box animation is used.
- Stop/restart, target edits, key edits, file changes, hidden tabs and worker errors clear/invalidate tracks. Epoch IDs prevent late responses from reviving stale overlays. Transient Jev request errors may preserve a currently supported visual track only until bounded semantic expiry. Editing targets while camera permission is pending cancels that pending start.
- Stop prevents new requests, but **cannot revoke a frame already sent or cancel billing for a request already being processed**. A pending request is allowed to settle before another is sent, including across restart.

## Expanded target capacity

The UI, gateway and worker support up to **24 distinct named targets** with one discovered instance per description. Boundary tests accept 24 and reject 25 without an upstream call, and the text field accommodates 24 maximum-length descriptions. A deterministic Chromium worker fixture retained all 24 IDs while alternating object motion; observed update cost on this VM was about 50 ms median / 59 ms p95. These are synthetic pixel measurements, not evidence that Jev recognizes 24 real objects correctly or that every device sustains the target rate. More requested targets increase recognition work and billing even when absent; lower the recognition cadence if needed. Local tracking is independent of recognition cadence.

## Tracking runtime and security

OpenCV assets are pinned under `static/trackingvendor/`; licenses, source URLs and SHA-256 hashes are included. The official single-file runtime is approximately 11 MB uncompressed and may take a few seconds to initialize. There is no runtime CDN dependency. Frames stay in bounded browser/worker memory except for the existing explicitly requested Jev snapshots; no tracker frames are uploaded.

The main document retains `script-src 'self'` without `unsafe-eval`. Only the exact authenticated `tracking-worker.js` response receives a separate worker policy allowing the runtime's required JavaScript/WebAssembly compilation. That worker has `connect-src 'none'` and cannot create child workers. Real Chromium tests verify that worker fetch is blocked while the runtime initializes and main-page evaluation remains blocked. The source/compiled classic tracker pair is generated by `python3 build_tracker.py`; regenerate after editing `static/tracker.mjs` and commit the paired provenance manifest.

Tests additionally exercise opposing moving pixel textures in the real app with a mocked Jev transport, retained IDs through weak recognition, loss/removal, delayed capture replay, revalidation expiry, hidden/source/target/stop resets and worker/camera stalls. These are synthetic pixel tests—not proof of real camera accuracy. Legacy snapshot-only browser regressions deliberately block the worker to verify the fallback independently.

## API and limits

`POST api/detect` accepts JSON:

```json
{"key":"OPTIONAL_IF_ENV_CONFIGURED","labels":["coffee mug"],"format":"jpg","image":"STANDARD_BASE64_NO_DATA_PREFIX"}
```

The server permits only the fixed HTTPS endpoint `https://api.typesafe.ai/v1/systemone`, disables HTTP redirects, and sends:

- `Authorization: Bearer ***`
- `TypeSafe-Danger-Zone-Images: true`
- `model: "jev-1.14.0"`
- one UUID-named image asset `{ "type": "image", "format": "jpg", "data_base64": "…" }`, referenced from `state.photo`
- paired `target_0_visible: {type:"noul",instructions:"Is there a … in `photo`?"}` and `target_0: {type:"box",instructions:"the … in `photo`"}` questions.

Documented answers are `answers.target_0_visible.noul` and `answers.target_0.{box,confidence}`. Noul has no separate confidence field. Response: `{ "detections": [{"label":"…","box":{"left":0.1,"right":0.7,"top":0.2,"bottom":0.8},"confidence":0.85,"presence":0.91}] }`.

Limits: 2 MiB JSON body; 1–24 unique labels; key 1–512 printable non-space ASCII characters; strict base64; PNG/JPEG signatures and structural/dimension checks; dimensions 280–1568 on both sides; 25-second upstream socket timeout; upstream JSON limited to 256 KiB. UI file input limit is 15 MiB and 40 megapixels before canvas resizing. The gateway performs structural image validation, not a full image-codec decode; TypeSafe performs final image decoding. Errors are bounded generic JSON and never include upstream response bodies or exception strings. This is not a generic proxy: client-specified destinations are ignored, and unrecognized routes are rejected.

## Tests

No Jev key is required. Actual HTTP requests exercise an ephemeral loopback server. Upstream dependency injection is available only to Python test callers, never via routes, CLI or environment. A local mock HTTP upstream verifies wire JSON and secret-safe upstream HTTP failures; other fixtures verify documented answer parsing and timeout handling.

```sh
python3 -m unittest discover -s tests -p test_server.py -v
node --test tests/core.test.mjs
```

Optional Chromium/Playwright browser tests (not runtime dependencies):

```sh
python3 -m venv .venv-test
.venv-test/bin/pip install playwright
# Tests default to /usr/bin/chromium; install your system Chromium if absent.
INSTABOX_HEADLESS=1 .venv-test/bin/python -m unittest discover -s tests -v
```

Without Playwright, browser tests are explicitly skipped. Browser tests use fake Chromium camera hardware and fixture upstream answers—not real camera/real Jev inference. They cover idle privacy, upload, live camera start/stop, responsive viewport overflow, confidence filtering, expiry, stale responses, one in-flight request, target edits, errors, key clearing, and camera-permission races. Tests create and shut down their own servers; no persistent application process is left running. `artifacts/desktop.png` and `artifacts/mobile.png` show a **synthetic gray test image with fixture boxes**, not proof of real model accuracy. `artifacts/test-output.txt` contains the final actual test run.

Implementation followed test-first RED→GREEN vertical slices; see `TDD.md` for the observed failure checkpoints.

## Known limitations

The deployed private HTTPS route has been verified with a real key loaded from `.env.local` and an empty browser key field. Three real cat-photo requests completed in 95–120 ms. A bounded browser run feeding the same public photo through a substituted camera stream completed nine real API requests with one request in flight, a 253 ms mean start interval (3.95 starts/sec), and a displayed 4.0 completed detections/sec. These are observed results for one public image and one target, not a guarantee for your camera or multiple targets. Machine-readable results: `artifacts/live-verification.json` and `artifacts/live-rate-verification.json`. `artifacts/real-jev-rate-test.png` shows real model results on that explicitly labeled test stream, not your camera.

Your real device's camera permission and camera accuracy still require checking from your browser. Images/Box are explicitly experimental in TypeSafe documentation; accuracy and response formats may change. **Only one object instance per requested target can be discovered**, not arbitrary duplicate-instance arrays. This is short-term sparse optical flow, not general re-identification: tiny/textureless items, hand occlusion, rotation, blur, articulated movement and crossing objects can lose tracking. New semantic detections are needed for reacquisition. No successful camera test of actual chapstick/lighters/wallets is claimed. A slow inference may expire before it can seed a track. Not suitable for safety-critical decisions.

Source contract: [Images](https://docs.typesafe.ai/images), [Box](https://docs.typesafe.ai/go/box), [Noul](https://docs.typesafe.ai/go/noul).
