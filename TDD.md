# Observed test-first checkpoints

## Slow recognition — capture binding, cooperative replay, independent results

All timings below are local Chromium fixtures, not real-provider or user-device
measurements. Starting revision: `b70f154`; no credentials, provider requests,
push, deployment, or restart.

- **Root cause 1:** `detect()` drew/encoded a new snapshot, then tried the regular
  throttled/busy sampler to obtain its frame ID. At ~12Hz and 1.4s responses this
  often returned null (`capture-unavailable`). Reusing an old ID after drawing new
  pixels was also not a safe association. The new browser regression observed a
  null capture among three warmed responses before the fix. Afterward all warmed
  images matched their submitted pixel-frame JPEG byte-for-byte. Recognition now
  uses a recent (<350ms), exact already-submitted canvas and its original capture
  timestamp, or takes an independent snapshot immediately if none is available.
  It never waits for worker readiness/busy state. Request-start cadence and round
  trip remain separate from pixel capture age.
- **Root cause 2:** synchronous historical LK replay monopolized the only worker.
  One frame remained in flight, so the UI could not submit intervening pixels;
  subsequent capture gaps exceeded the existing 200ms evidence-gap bound. A real
  OpenCV fixture with 12Hz sampling, a 1.4s seed delay, and 20ms added per replay
  transition processed **zero frames during replay** before the fix. Cooperative
  transitions now yield worker tasks; the fixture processed **8 frames during
  ~640–657ms replay**, accepted the seed, displayed a fresh track, and had no
  `frame-gap` losses. Replay catches up to the actual latest pixels before commit.
- **Root cause 3:** `count`/`results` used the 350ms live geometry list instead of
  semantic capture results. Valid 1.4s replies were invisible without a tracker.
  `count` now counts thresholded last-capture semantic positives, capped by the
  existing 4s capture TTL. `tracked-count` separately counts current measured
  geometry; `age` shows last semantic capture age/Expired. Text explicitly says
  captured recognition is not a current location. A uniform 12Hz stream and a
  16s-loading worker both show semantic positives with zero live boxes, survive
  worker failure, clear on a negative response, and expire at 4s. This test was
  also rerun RED against the preceding commit with a verified playing fixture:
  round trip 1.40–1.41s, capture age 2.1s, but count 0.
- Worker failure suppresses previously stored geometry without deleting semantics
  or invalidating a newer capture's in-flight recognition. The existing six-object
  mixed/partial-texture regression and worker-failure lifecycle tests remain intact.
- No queue/lifetime increases: one frame plus one seed operation in flight;
  synchronous transitions stay indivisible; 2s replay wall budget (including
  yields), 4s/128 frames/48MiB history, 350ms live geometry, 10s frame watchdog,
  60s startup. Deadlines and evictions are rechecked after yields; no gray frames
  are pinned. Reset cancels the old replay owner before any disposed Mat access;
  a real-worker reset during replay reports zero obsolete replies and a new-source
  track only. Partial trial geometry is never published.

Final verification on the completed code:

```sh
INSTABOX_HEADLESS=1 /data/workspace/jev-live/.venv-test/bin/python -W error::ResourceWarning -m unittest discover -s tests -v
# 57 tests passed, 244.150s
node --test tests/*.test.mjs
# 26 tests passed
python3 artifacts/guard_slow_recognition.py
# 10 changed tracked files, no static findings, source/generated SHA256 verified
# Zero credential reads; no live-secret comparison (explicitly prohibited).
git diff --check
# clean
```

The existing ignored `publication_guard.py` and `guard_tracking.py` load real
credentials; neither was executed. A credential-free adaptation applied their
filename/private-host/token/dynamic-execution checks to this change and verified
the generated tracker manifest. The original live-secret comparison remains a
parent publication gate. Logs and the adapted guard are ignored local artifacts:
`artifacts/slow-recognition-python-tests.log`, `slow-recognition-node-tests.log`,
`slow-recognition-publication-scan.json`, and `guard_slow_recognition.py`.

The first full run exposed two existing failure-geometry regressions after
semantics were retained; adding a geometry-only capture cutoff preserved their
original assertions without weakening tests. The subsequent full run above was
clean. One initial uniform-camera fixture did not repaint its canvas and never
reached video.play(); it was corrected to repaint at 12Hz, then replayed against
the old app to establish a valid RED rather than treating startup as the symptom.

Limits: one slow OpenCV transition can still block its worker; motion, occlusion,
low texture, true capture gaps, history eviction or CPU limits can honestly reject
tracking. Cooperative scheduling does not reduce provider latency or make a 1.4s
serial request stream run at 4Hz. Capture history is not a live-position claim.


## Visual Actions — opt-in semantic reactions (local fixtures only)

Each implementation slice was run RED before GREEN and committed incrementally
on `feat/visual-actions`, based on clean `8f0b742`:

| Slice | Observed RED | Verified GREEN |
|---|---|---|
| Pure recognition trigger | engine export undefined | one positive never enters; two enter once; repeated positives do not repeat |
| Grace and cooldown | active count 1 instead of 0 after absence | 1200 ms absence boundary, recovery before boundary, rearm after 2000 ms cooldown |
| Capture freshness | duplicate capture activated (1 instead of 0) | distinct capture ordering, future/late rejection, 2500 ms expiry and streak reset |
| Confidence / priority | non-finite confidence activated all three rules (3 instead of 0) | finite threshold/exact-label gate, first active filter wins, cards coexist |
| Opt-in browser slice | missing master control (0 instead of 1) | explicit enable, pre-enable capture ignored, CSS video filter outlives 350 ms box expiry but not stale semantic evidence |
| Validation / editor / cards | validator undefined; editor absent | bounded 12-rule CRUD, three idempotent presets, untouched targets, textContent-only card rendering, pre-edit capture ignored |
| Optional audio | adapter undefined; permission control disabled | no context on load, explicit gesture + per-rule permission, one 160 ms voice, cancellation invalidates pending resume |
| Bounded history | Clear log control absent | latest 40 timestamped enter/clear events, explicit history clear, reset does not delete rules |
| Card accessibility | active card tabindex None instead of 0 | active bounded region keyboard/pointer-scrollable, no empty-card tab stop |

Additional Chromium regressions cover Stop/source/hidden/target/disable late
replies, 2.5 s action versus 4 s snapshot TTL, delayed actual WebAudio resume
through Stop/hidden/disable, local HTTP gateway normalization into a filter,
unfiltered native drawImage pixels, mobile overflow and reduced motion. The
provider is never called. The native fake camera and semantic answers are fixtures,
not real recognition accuracy or an audible-device test.

Latest focused run: **8 Chromium Visual Actions tests passed**, with
ResourceWarnings treated as errors; **23 Node tests passed** (including existing
core/tracking tests, five action-engine tests and one audio test). A separate
`test_server test_tracking_security test_camera_start` run passed **16 Python
tests** and reported `evalBlocked`, `ready`, `fetchBlocked`, and `version` all true.
Two existing snapshot/idle-browser regressions also passed earlier. Full project
regression/deployment/review remains the parent's acceptance gate.

Harness correction: a late semantic reply immediately schedules the next serial
request, so polling its brief aria-busy=false gap was unreliable. The fixture now
drains the reply promise/microtasks rather than requiring that transient DOM state.
The initial absence recovery test was corrected to 1199 ms (1700 ms was exactly
the 1200 ms expiry boundary), preserving the explicit >=1200 expiry contract.
One early existing browser run emitted a server BrokenPipe while deliberately
aborting the worker asset; later focused/security runs were clean. No deployment,
restart, credential reads, push, or real-provider calls were performed.

## Tracking stability — bounded capture handoff (local, synthetic)

- RED Node history: earliest retained frame was 85 instead of 0 after 101 frames at 30 Hz; byte-budget fixture retained 90 instead of 20.
- RED Chromium: 2.5s seed had zero reported accepted replays; the existing worker override retained only 64 frames. The tracker default was 16.
- GREEN: 128-frame / 48 MiB grayscale hard caps, capture-time eviction at 4s. At 30 Hz, real OpenCV replays accepted captures at 1.5s (46 frames) and 2.5s (76 frames), retaining 4,710,400 and 7,782,400 grayscale bytes respectively at 320². At 4.033s, the old capture is explicitly rejected; current supported tracks are not cleared by a rejected seed.
- Milestone verification: 41 Python and 10 Node tests passed. Baseline: 40 Python and 8 Node. Initial 24-target worker median/p95 48.0/51.7ms; bounded-history run 47.9/53.7ms (fixture timing, not client hardware).


## Tracking stability — adaptive cadence and diagnostics

- RED: deterministic client lacked measured cadence/rate APIs; loss counters were undefined after 300 losses. Chromium measured 12.70 Hz with the old fixed-65ms/20ms polling combination; diagnostics disclosure was absent.
- GREEN: one-frame-in-flight throughput EWMA drives 33–160ms cadence (35% headroom), sampling presented source-bound video frames with the existing bounded legacy fallback. No worker-readiness or busy gate was added to recognition. Native counter regressions now assert the new ≥32ms floor (1ms timer tolerance), not the removed 65ms limit.
- Real app synthetic 30Hz camera, empty semantic responses: 25.19 Hz starts with fast worker; controlled 100ms worker load: 7.14 Hz, measured cadence 136ms. Both observed **zero status mutations**, no mobile overflow, and no target/key content in the disclosure. Cold-start time is included in displayed initial rate, so rolling UI rate can be lower than the warmed start-interval measurement.
- Diagnostics use bounded 180-entry sample/completion windows, numeric allowlists, fixed reason counters and 128 loss events. UI updates are equality guarded, excluded from live status and announcements, and occupy fixed-height wrapping space when opened. No network or persistent telemetry.
- Milestone: full 42 Python + 13 Node tests passed; 24-target frame median/p95 45.7/52.2ms in that run.

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
