# Observed test-first checkpoints

## Native camera startup independence regression

`tests/test_camera_start.py` uses Chromium's native fake camera (`--use-fake-device-for-media-stream`), not a substituted photo or canvas stream. All recognition responses are fixture data.

- RED: with the actual worker's cold initialization delayed 2 seconds, native preview played but there were **zero recognition requests** during the first 600 ms. Removing the worker-readiness inference gate made that regression GREEN.
- RED: missing/throwing `getVideoPlaybackQuality` generated uncaught browser errors; a frozen-zero counter submitted only one tracking frame. Presented-frame callbacks plus bounded legacy sampling made these GREEN.
- GREEN coverage includes missing/throwing/frozen counters with and without `requestVideoFrameCallback`, frozen-positive legacy counters, Auto serial requests, at least 65 ms between pixel submissions, real worker startup after loading, measured tracking, matching capture/generation seeds, and stop/restart while a worker is still cold.
- Existing regressions were synchronized to the new independent lifecycle: early semantic requests may precede the worker; weak semantics begin only after actual pixel tracks exist. Worker failure removes tracked boxes but preserves independent snapshot results until their capture-time TTL, rather than invalidating a pending semantic response.
- No speculative `video.play()` timeout was added: these browser reproductions reached playing video. They demonstrate failure mechanisms, not the user's unconfirmed device cause.


Each tracer bullet was run RED before its implementation, then re-run GREEN. These are short summaries of tool-observed failures, not invented test output. Final complete output is captured in `artifacts/test-output.txt`.

| Vertical slice | Observed RED checkpoint | GREEN outcome |
|---|---|---|
| HTTP missing-key response | `HTTP app has not been implemented` | clean HTTP 401 JSON |
| Jev request + answer path | expected 200, received 401 | fixed endpoint, documented asset/noul/box shapes and normalized result |
| Input validation | invalid inputs reached fixture upstream / disconnected without response | bounded HTTP 400/413, no upstream call |
| Absence + coordinate gating | absent target produced a detection instead of `[]` | presence and finite valid-coordinate gating |
| Protected prefix + CSRF | protected GET returned 501 instead of 401 | cookie exchange, protected routes, same-origin POST checks |
| Browser UI | no `h1` on empty/unimplemented route | Chromium upload and fake-camera controls pass |
| Letterbox + frame epochs | `projection module not implemented`, `frame state not implemented` | projection and stale-frame core tests pass |
| Documented image minimum | 279-pixel image returned 200 instead of 400 | exact 280-pixel minimum enforced |
| Snapshot resizing | `snapshotSize` was undefined | 960 cap, 280 minimum and extreme-aspect rejection |
| Executable CLI | help did not contain `--port` | runnable configurable CLI |
| Protected unsupported methods | HEAD returned 501 instead of 401 | method guard and non-disclosing config |
| Stripped reverse proxy mount | missing `public_prefix` argument | external redirect/cookie mount independent of internal routes |
| Wrapped timeout | returned 502 instead of 504 | wrapped network timeout classified; HTTP errors closed |
| Camera permission race | Start stayed disabled after targets changed during permission request | pending start is cancelled cleanly |
| Local server key | `Local environment loading is missing` from `test_env_local_key_loads_without_execution_or_overriding_environment` | key-only, non-executing `.env.local` load; existing environment wins; malformed interpolation rejected; missing file harmless |

## Live deployment verification after local key configuration

The private HTTPS deployment reports only `serverKeyConfigured: true`; the browser key input stays empty. Three real Jev requests on a public cat photo returned HTTP 200 in 95–120 ms. A bounded browser run substituting that same public photo for its camera stream completed nine real API requests, with maximum one in flight, mean start interval 253 ms (3.95 starts/sec) at the 4 Hz target, and no browser runtime errors. The measured-rate UI read 4.0 completed detections/sec at the end. This does not exercise the user's camera or predict multiple-target latency. See `artifacts/live-verification.json`, `artifacts/live-rate-verification.json`, and the explicitly labeled screenshot `artifacts/real-jev-rate-test.png`.

Parent full regression execution after integration: 21 Python HTTP/Chromium tests and 4 Node core tests passed, with ResourceWarnings treated as errors. Fixture timing tests observed 254 ms mean starts with 60 ms upstream latency and 408 ms mean starts with 400 ms latency (no extra 250 ms post-response pause). Fixture error retries observed approximately 3 and 6 seconds.

Regression coverage additionally exercises a real local mock HTTP upstream, fresh/expired browser overlays, stop/restart/target-change late replies, one browser request in flight, clear-key action, mobile overflow and browser runtime errors. Production app code contains no test detection data or demo fallback.

Test-harness corrections during verification: payload-limit test sends an oversized declared Content-Length without streaming an unnecessary huge body (avoids a client-side BrokenPipe after early rejection); geometry comparisons use floating-point tolerance; Playwright predicates use function syntax compatible with strict CSP. A real ResourceWarning prompted explicit HTTPError resource closure.
