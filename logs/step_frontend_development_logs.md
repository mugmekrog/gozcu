# Step log — frontend

**Date:** 2026-09-26 · **Scope:** PLAN.md §7.3, built to the wireframe set in
`Sentinel system wireframes.zip` · **State:** 87 tests green, boots and runs on
the real `stage2/` data end to end, production build 74 KB gzipped.

This log is for the four workstream leads. It records what was built, the three
architectural decisions that were mine, and — most importantly — **eleven places
where the wireframes, PLAN and the shipped data disagree**. Those are numbered
W1–W11 in §5. Six are already resolved in code; five need a decision from someone
other than me.

Findings from the agent layer are numbered F1–F6 in
`step_agentic_development_logs.md`; this log uses W to keep the two apart.

---

## 1. What was asked, and what this delivers

The ask was the frontend stage, built to the wireframes. The wireframes specify a
single-workspace application — a tactical map beside an agent-output column, three
views behind a slide-out menu, and a decision modal — and that is what this
delivers, running on the real engine's output rather than on mock data.

Built:

- `web/` — Vite + React 18 + TypeScript + Zustand, no CSS framework, no webfonts,
  nothing fetched from a CDN at runtime.
- **the data seam** — `GoruApi` with two adapters: `FixtureApi` over the real
  pipeline's exported output, and `HttpApi` against the REST surface of PLAN §5.4.
- **the tactical display** — an SVG polar radar in ENU metres: dashed range rings,
  the eight approach roads, all 8 zones at their measured bearings with radius and
  buffer rings, the base, drone-frame plates, vehicle symbols with trails, pin
  identity colours, and a zone pulse on ALERT.
- **the three views** — Harita (map), Hareket (closing-range chart + ranked table),
  Kayıtlar (frames, field-report verdicts, operator decision log).
- **the agent column** — target frame picker, live step list with tool/warning/error
  row types, the brief card with score breakdown, and the copilot input.
- **the decision modal** — both variants, all three stages: camera full width,
  camera narrowed beside the closing-range chart, and a clicked detection's crop
  with its confidence and threat readings.
- **the simulation clock** — play/pause/seek/speed over the real 08:10–15:50 window,
  with frame markers on the timeline axis.
- `web/scripts/export_fixtures.py` — drives the real `Pipeline` and writes what the
  REST endpoints will serve.
- 87 tests, no network, no spend.

Not built, deliberately, because the wireframes contain no such screen and the
backing services do not exist: `/login`, `/intake`, `/audit`, `/settings` (the four
extra routes PLAN §7.3.2 lists), RBAC gating, the WebSocket transport, and the
audit-chain verify button. See §6.

---

## 2. Decision one: the wireframes are the authority, not PLAN §7.3

These two documents describe different products. The wireframes were given to me
as the authority, so they won everywhere they disagreed — but the disagreement is
wide enough that PLAN §7.3 should be rewritten rather than quietly left stale.
Full list in W1.

The short version: PLAN §7.3.1 specifies a **dark** `#0A0F14` deck.gl display with a
diagonal-slash CLEAR glyph, Inter and JetBrains Mono, a left-hand alert queue and
five routes. The wireframes specify a **light** `#F1F5F9` workspace set entirely in
the system monospace, with `▲ ● ■` for the three levels, a right-hand agent column,
and one workspace with three views.

What I kept from PLAN, because the wireframes do not contradict it and it is right:
level encoded by **shape as well as colour** (`risk.test.ts` pins this), ENU metres
as the working frame, no basemap tiles, and the `drop_reason` on every suppressed
box so the UI can explain what it dropped.

---

## 3. Decision two: SVG, not deck.gl

PLAN F0.1 names deck.gl with an `OrthographicView`. I did not use it.

**Apply the deletion test.** deck.gl's leverage is GPU instancing for hundreds of
thousands of primitives, basemap integration, and 3D. The wireframes specify a flat
vector radar — dashed strokes, glyph symbols, text labels, a sweep wedge — with no
basemap, no extrusion and no pitch control. At the shipped data's busiest clock the
display carries **101 vehicles**. A WebGL renderer to draw a hundred triangles is a
pass-through wrapper over what the browser already does, and it would add roughly a
megabyte of runtime to a bundle that has to work with the network off (PLAN F4.3).

**Measured, not assumed.** `live.perf.test.ts` walks the whole exercise window and
times the per-tick derivation that feeds the map:

| | measured |
|---|---|
| median per tick | **0.291 ms** |
| p90 per tick | **0.669 ms** |
| busiest clock | 13:50, **101 vehicles** |
| clock tick budget | 66 ms (≈15 store writes/s) |

So the map's data pass uses under 1 % of its frame budget. The static layers —
rings, roads, zones, base — are memoised on the scale alone, so React skips that
whole subtree on every tick; only vehicles and frame plates re-render.

If a later stage needs 2.5D extruded prisms or a basemap, deck.gl becomes the right
answer and `radar/` is where it goes: the layers already take a `Projection` object
rather than doing their own arithmetic, so the projection is the seam.

---

## 4. Decision three: two adapters, because the backend does not exist yet

`services/api/app/api/rest.py` has not been built. The options were to mock the
data by hand or to drive the real engine, and mocking 226 tracks and 137 reports
would bake in numbers that disagree with the engine now and disagree again when the
API lands.

So `web/scripts/export_fixtures.py` calls `Pipeline.analyse_all()` and
`ImageAssessorPolicy.fallback()` and writes what the REST endpoints will serve. It
imports the backend's public surface and modifies nothing.

```
screens ──► GoruApi (port.ts) ──► FixtureApi   static export of the real engine
                  │                HttpApi     REST per PLAN §5.4
                  │
            domain/  risk · polar · tracks · live · brief · format
```

Both adapters are real and both are exercised by tests, so the seam is a contract
rather than a guess. Switching the whole app to the live API is one environment
variable and touches no screen:

```bash
VITE_API_BASE_URL=http://localhost:8000 npm run dev
```

**Payload budget.** Boot reads four files, then one file per opened frame:

| | size | when |
|---|---|---|
| `dataset.json` | 16 KB | boot |
| `tracks.json` | 128 KB | boot |
| `reports.json` | 49 KB | boot |
| `alerts.json` | 147 KB | boot |
| `frames/<id>.json` | 130 KB median, 145 KB max | on open, cached |
| `frames/<id>.jpg` | 230 KB typical | only when the camera opens |

340 KB of JSON at boot, ≈100 KB over the wire compressed. App code is **74 KB
gzipped** (29 KB app + 45 KB React) plus **6.3 KB** of CSS, against the 300 KB
budget. Track histories ship as three parallel number arrays rather than 5 650
point objects, which is what keeps the per-tick pass allocation-light.

---

## 5. Findings — where the wireframes, PLAN and the data disagree

### W1. The wireframes and PLAN §7.3 specify different UIs. **Needs a decision.**

Measured against the two documents, not inferred:

| | PLAN §7.3 | Wireframes (shipped) |
|---|---|---|
| Ground | `#0A0F14` dark | `#F1F5F9` light |
| WATCH | `#EB8E3D` | `#F5B753` |
| CLEAR | `⟋` slash, `#A6F2FF` | `■` square, `#1981E6` |
| Type | Inter + JetBrains Mono | system monospace only |
| Renderer | deck.gl `OrthographicView` | flat SVG radar |
| Zone form | 2.5D extruded hex prisms, pitch toggle | flat rings + buffer ring |
| Rings | every 1 km to 10 km, 3.2 km brighter | 1 km to the scale, switch 3/5/8/12 km |
| Layout | queue left, inspector right, agent top-right | agent column right, no queue |
| Routes | `/login` `/ops` `/intake` `/audit` `/settings` | one workspace, 3 views |
| Assessment | continuous per-vehicle | per-frame, operator presses Değerlendir |
| Language | English | Turkish |

**PLAN §7.3.1 and §7.3.2 should be rewritten against the wireframes**, or the
wireframes revised — right now a reader of PLAN would build the wrong thing. The
four missing routes are the substantive part of the decision, not the palette; see
§6.

### W2. Turkish is the product language. **Resolved.**

The wireframes are entirely in Turkish, the brief is Turkish, and the operator is
Turkish. Every string lives in `src/domain/strings.ts` rather than scattered
through components — not as i18n scaffolding, but so the vocabulary stays
consistent: the button that says *Değerlendir* produces a step list headed
*Değerlendir* and a log row that reads the same. Numbers are formatted `tr-TR`, so
`1,57 km` with a decimal comma, through `src/domain/format.ts`.

### W3. The wireframes' zone names and positions are illustrative; the real ones differ. **Real data wins.**

The wireframe radar places its zones at 2.6–5.6 km with Turkish-diacritic names
invented for the mock:

| Wireframe | Real (`zones.json`) |
|---|---|
| Kuzeydoğu Tepesi @ 5.4 km | **Kuzeydogu Kavsagi @ 3 198 m** |
| Güneydoğu Sanayi @ 5.6 km | **Guneydogu Yerlesimi @ 3 198 m** |
| Güneybatı Köy @ 5.0 km | **Guneybati Yolu @ 3 198 m** |
| Kuzeybatı Orman @ 3.2 km | **Kuzeybati Yolu @ 3 198 m** |
| Doğu Yolu @ 2.6 km | **Dogu Yolu @ 3 204 m** |

I render the real ones, ASCII-folded exactly as the file spells them, because
report text is matched against those strings (PLAN §2.4) and a display that
renamed them would not line up with a citation. `fixtures.test.ts` asserts all
eight land in 3 192–3 204 m at 45° steps, reproducing PLAN §2.4.

**Visual consequence worth knowing:** all eight zones sit on *one ring*, so the map
looks more regular than the wireframe's scattered mock. That is what the data says.

### W4. Timestamps were being labelled in UTC. **Found and fixed — affects the backend too.**

The source timestamps are UTC and the exercise ran at `Europe/Istanbul` (+03).
Formatting them directly labelled the first image **07:10** where the brief and
PLAN §2.1 both call it **10:10** — every frame, every report, every log row off by
three hours. Fixed in the export by converting through `cfg.tz`, and pinned by a
test asserting the frame hours span 10–15 and that the first frame reads `10:10`.

**This will recur in `rest.py`.** The same `ImageMeta.capture_ts` values will be
serialised by the REST layer, and whoever writes it has to make the same
conversion — or agree that the API serves UTC and the frontend converts. Worth two
minutes at the next sync.

### W5. Python and JavaScript disagreed on rounding a score. **Found and fixed — affects the backend too.**

`int(round(x))` in Python rounds halves **to even**; `Math.round` in JavaScript
rounds them **up**. Alert `A-img_004388-T0132` has priority 0.205, which Python
scored **20** and the frontend's own check computed as **21**.

Two changes closed it: the export now rounds half-up explicitly, and the score is
derived from the *shipped* (4-decimal) priority rather than from full precision, so
the figure on screen is always exactly `Math.round(priority * 100)` of the number
in the same payload. A test asserts that over all 149 alerts.

**Anyone serving `priority` from `rest.py` needs the same rule**, or the same alert
will score differently depending on which adapter the UI is on.

### W6. Seven of the 149 alerts carry a detection id in `track_id`. **Handled; needs a contract note.**

`RuleEngine.untracked_detection_level` raises a WATCH on a detection that matched
no track but sits inside a zone buffer. Those alerts have `track_id` set to a
*det_id* — `img_008333#001` — so anything that looks the id up among the track
states finds nothing. There is no speed, heading or ETA behind them either,
because nothing was matched.

Handled: `Alert.track_id` is documented in `src/domain/types.ts`, the score
breakdown for these says in words that the figure is a constant and why, and a test
asserts all seven have null kinematics and a non-empty note.

**PLAN §5.1 should say this.** Either document that `Alert.track_id` may be a
det_id, or add a `subject_type: track|detection` field. As written the contract
implies it is always a track.

### W7. The baseline is amber-heavy: 126 WATCH against 23 ALERT. **Needs the organiser answer (PLAN R2).**

The wireframe's screen 1 assumes *"çoğu ■ güvenli, yalnızca 5 ● ve 1 ▲"* — mostly
safe, a handful of review, one threat. The shipped baseline is the other way round:
across the 40 frames there are **23 ALERT and 126 WATCH**, and at 13:50 the map
carries 101 vehicles of which a large share are amber.

This is driven entirely by `zones.default_radius_m: 250` / `default_buffer_m: 750`,
which are our guesses pending PLAN's open question R2. The display is correct; the
thresholds are the variable. **If the real radii are smaller, the map gets much
calmer and looks like the wireframe.** Not my call to change, but the demo's visual
impression depends on it more than on anything I built.

### W8. The score breakdown did not add up. **Fixed.**

Each of the four terms was rounded independently and `priority` is clamped at 1.0,
so **7 of 149** breakdowns missed their own total by a point. A table whose rows do
not sum to the figure above them invites a reader to distrust both. The drift is now
pushed onto the largest term — the one it came from — and a test asserts the rows
sum exactly for all 149.

### W9. Every brief in the fixtures is rules-based, and says so. **Needs a decision.**

`data/processed/agent_runs.jsonl` holds **one** run (the accidental live call from
F6, for `img_000860`) and there is no `agent_cache/` directory, so there is nothing
to replay. Every brief in the export is therefore
`ImageAssessorPolicy.fallback()` — the deterministic template over the evidence
bundle. That is genuine system output, not sample copy, and the UI labels it
`kural tabanlı` in the brief header with a footnote saying the text was not
generated and no LLM correction was applied.

**Decision needed:** whether to run `assess-all` to populate the cache so the demo
shows real model briefs. This is the same question as item 3 in the agent log's
handover, and the frontend is now the reason to answer it — the brief card has a
`source: llm` path that nothing currently exercises.

### W10. The step list's labels are real; its timings are the frontend's. **Stated in the UI and the code.**

The nine step rows are real stages with real counts read from the frame's own
funnel and match records — the pipeline really did take 425 boxes to 4 and match
them to 4 tracks. But the **timings** in fixture mode are this adapter's measured
fetch and assemble times, not the engine's per-stage costs, because the engine ran
offline and does not report per-stage timing. `HttpApi` streams the server's real
timings instead.

This is documented at the top of `src/api/fixture.ts`. If a judge asks what the
"0,4 sn" beside a step means, that is the honest answer, and the header pill
already says `LLM: kapalı (kural tabanlı)`.

### W11. Four things the screens need that PLAN §5.4 does not serve. **Needs backend agreement.**

Each is marked `NEEDS-BACKEND` in `src/api/http.ts`:

1. **`GET /dataset`** — the screens need zones, the frame index, thresholds and the
   sim window before first paint. PLAN has `GET /zones` only.
2. **`GET /frames/{id}`** — one frame view needs the image, its detections, the
   track states, the zone assessments and the alerts together. PLAN splits this
   across three endpoints, so every frame click costs three round trips for data
   `ImageAnalysis` already assembles in one object.
3. **`POST /frames/{id}/decision`** — the wireframe's decision is per *frame*
   ("this frame is a threat"), while PLAN's ack/dismiss are per *alert*. Something
   has to fan one out to the other; doing it on the server keeps the audit event
   singular.
4. **Streaming assess** — `POST /agents/assess/{image_id}` needs to emit
   newline-delimited step events, not one JSON body. A live call takes 10–15 s
   (PLAN §6.11) and an operator watching a blank panel that long assumes it hung.

---

## 6. Deliberately not built

| Thing | Why |
|---|---|
| `/login` and role badges | No wireframe screen. Needs `POST /auth/login`. |
| `/intake` validation table | No wireframe screen. The export already carries `validation_issues` (0 errors, 7 warnings), so the data side is ready. |
| `/audit` + verify-chain | No wireframe screen, and the hash chain is not built. |
| `/settings` thresholds | No wireframe screen. `dataset.thresholds` is already served read-only. |
| RBAC gating of controls | No auth to gate against. |
| WebSocket transport | The sim clock runs client-side over the full dataset, which is what the wireframe's timeline implies. `HttpApi` is where `/ws/stream` goes when it exists. |

**Decisions are currently in-memory.** `FixtureApi.record` keeps the operator
decision log in the page, so it survives view switches but not a reload. That is
the honest limit of a static adapter — durable decisions need the audit endpoint.

One more gap worth naming: the wireframe's frame picker shows *"4 kare"*. The real
dataset has **40**, so the dropdown carries 40 entries and the timeline carries 40
diamonds. The layout absorbs it, but it is denser than the mock.

---

## 7. Bugs the tests found in my own code

Recording these because two were silent.

1. **ETA was being scraped out of a reason string.** The motion table parsed
   `"ETA 1.3 min to ..."` with a regex off `Alert.reasons[0]`, which would have
   silently gone blank the first time anyone reworded a rule message. The zone
   assessment's real figures (`eta_entry_s`, `dist_now_m`, `cpa_m`,
   `approach_conf`, class) are now denormalised onto the alert, so the flattened
   cross-frame list is self-sufficient and no screen parses prose.
2. **A stale frame could overwrite a newer one.** Clicking two frames quickly let
   the slower fetch land last, showing frame A's brief under frame B's heading.
   `openFrame` now drops a response whose frame is no longer selected.
3. **The modal could reopen itself.** The effect that raises a warning keyed off
   the assessment phase, so any re-render after a dismissal re-raised it. It is now
   keyed on the frame id, recorded in a ref and reset only when a new run starts.
4. **The perf guard was flaky.** Asserting on the *maximum* tick failed only when
   the rest of the suite ran alongside it — 3.06 ms against a 3 ms budget, from GC,
   not from the code. It now warms up and asserts the p90 and median, which is what
   actually catches an accidental O(n²).

---

## 8. Accessibility and projector readiness

| Property | How |
|---|---|
| Level never by colour alone | `▲ ● ■` shapes plus colour; `risk.test.ts` asserts the three risky bands differ in both shape and glyph |
| "Not yet assessed" ≠ "safe" | A small hollow dot, deliberately not one of the three risk shapes; asserted in `risk.test.ts` |
| Amber text contrast | `#F5B753` fails as text, so every amber label uses `--risk-review-ink` `#9A6212`; the filled badge takes `--risk-review-deep` on its own fill |
| Keyboard | Every map symbol, zone, frame plate and detection box is a focusable control with Enter/Space; the modal traps focus and restores it on close |
| Screen reader | The radar is one labelled `img` naming the base, scale and vehicle count; tables use `<th scope>`; the selected frame is announced on a live region |
| Reduced motion | The sweep stops and the skeleton stops pulsing; **the ALERT zone pulse degrades to a solid ring rather than disappearing**, because it is a warning, not decoration |
| Pin colours | Paul Tol's qualitative six, colour-blind safe and deliberately unlike the three risk hues, so a pinned vehicle never reads as a risk level |
| Responsive | 1440 / 1024 / 768 / 320; the agent column moves below the map at 1100 px, the modal stacks, the toolbar drops the legend before the filters |

Not yet done: **the projector test on the venue screen (PLAN F4.1) needs real
hardware.** The type scale is the wireframes' own, which is dense — 10–12 px for
most chrome. That is right for an operator at a desk and I would expect it to be
the first thing to change after seeing it at 1080p from three metres.

---

## 9. How to run it

```bash
# 1. Fixtures from the real pipeline (~1.5 s). From the repo root:
.venv/Scripts/python web/scripts/export_fixtures.py
#    --no-images skips the 40 drone JPEGs (9 MB); the camera then says so.

# 2. The app:
cd web && npm install && npm run dev
```

Vite prints the URL it bound to — normally <http://localhost:5173>, but it takes
the next free port if that one is busy, so read the line it prints.

```bash
npm run typecheck   # tsc --noEmit, clean
npm test            # 87 tests, ~6 s, no network
npm run build       # 74 KB gzipped JS + 6.3 KB CSS
```

Demo hotkeys (PLAN F4.2): `Space` play/pause · `←`/`→` step 5 min (`Shift` 30) ·
`M`/`H`/`K` the three views · `D` evaluate · `Esc` unwind modal, camera, selection.

---

## 10. Test inventory

87 tests, ~6 s, no network, no spend.

| File | Covers |
|---|---|
| `src/domain/risk.test.ts` | banding, shape-not-colour-only, unassessed ≠ safe, which modal a verdict raises |
| `src/domain/polar.test.ts` | projection origin, north-up, zoom, the eight zone bearings round-tripping, ring spacing |
| `src/domain/tracks.test.ts` | interpolation, **no position outside the recorded window**, stop detection, trail windows |
| `src/domain/live.test.ts` | **a vehicle has no level until its own frame's capture time**, filters, draw order, worst-alert-wins |
| `src/domain/format.test.ts` | Turkish decimal comma, em dash for missing vs zero, ETA approximation |
| `src/api/fixtures.test.ts` | the census of PLAN §2.1, the zone ring of §2.4, the 23/126 alert mix, every breakdown summing to its score, the agent floor surviving serialisation, exercise-clock labelling, `R001`–`R137` |
| `src/api/fixture.integration.test.tsx` | the **real** adapter over the **real** export: boot, all 8 zone names on the map, a brief assembled for all 40 frames, frame caching, a real evaluation to the modal |
| `src/App.test.tsx` | the shell through a fake adapter: boot, evaluate, record a decision, empty frame raises no modal, view switching, copilot disabled offline |
| `src/domain/live.perf.test.ts` | the per-tick budget on the real data |

The two that matter most are the no-future-leakage pair. `Timeline.as_of` enforces
it on the backend; the display could undo it by painting a vehicle's eventual level
before the drone took the picture, so `live.test.ts` asserts a vehicle is
unassessed until its own frame's capture minute and `tracks.test.ts` asserts no
position exists outside a track's window.

---

## 11. Handover

**Backend.** `src/api/http.ts` is a written specification of what the frontend
needs — four `NEEDS-BACKEND` markers (W11), and the rest matching PLAN §5.4 as
written. Two things to agree before you write `rest.py`: the timezone rule (W4) and
the rounding rule for `priority` (W5). Both will otherwise produce a UI that shows
different numbers depending on which adapter it is on.

**Perception & Agent.** The brief card has a `source: 'llm'` path that nothing
exercises, because there are no cached runs (W9). If you run `assess-all`, the
export picks the cache up and the card starts showing model text with the
`LLM · <image>` chip instead of `kural tabanlı`; the dissent block and the
`LLM düzeltmesi` row in the score breakdown also light up, and both are currently
untested against real output.

**Security.** Nothing in the UI is gated, because there is no auth to gate on. The
operator name on every decision is hardcoded `nöbetçi-1`. The decision payload
already carries frame, verdict, note, operator and the agent's level and score,
which is the shape an audit event wants.

**Everyone.** `src/domain/` is pure and has no React in it — risk banding, the
polar projection, track sampling, brief assembly, formatting. If you need any of
that logic elsewhere it imports cleanly.

**Decisions needed:**

1. W1 — rewrite PLAN §7.3 against the wireframes, and decide whether `/login`,
   `/intake`, `/audit` and `/settings` are still in scope. They have no wireframe.
2. W6 — document `Alert.track_id` as possibly a det_id, or add a subject-type field.
3. W7 — the zone radius/buffer answer (PLAN R2) changes the display's whole
   character far more than anything in this stage.
4. W9 — run the 40-image live assess pass, or ship the demo rules-only and say so
   on the slide. The UI is honest either way; this decides which story it tells.
5. W11 — the four endpoint shapes, before `rest.py` is written rather than after.
