# Step log — base-centred threat model, report verification, evidence confidence

**Date:** 2026-09-27 · **Branch:** `faz-0-1-2` (uncommitted) · **Scope:** Faz 0 (fixes),
Faz 1' (threat model), Faz 1 (report resolver), Faz 2 (threat candidates + confidence)
· **State:** 243 Python tests, 235 web tests, typecheck clean, verified live in Docker.

This log is for the workstream leads. It records the team decisions this work rests
on, what changed, what the data showed when measured (including where it proved
my own earlier claims wrong), and the decisions still open.

---

## 1. Team decisions this work implements

| # | Decision | Where it lives |
|---|---|---|
| D1 | **Merkez Us is the protected asset.** The eight zones are *observation sectors*: they name where a vehicle is and which reports apply; they raise nothing. | `base:` in `goru.yaml`, `risk/base.py`, `risk/engine.py` |
| D2 | Threats are classified as **approach** or **surveillance**, each **possible** (WATCH) or **high** (ALERT). | `risk/engine.py`, `risk/threat.py` |
| D3 | **No source is trusted.** `official` grants nothing `third_party` does not; a report counts for what our data confirms. | `fusion/report_resolver.py` |
| D4 | **Human in the loop:** no report or agent lowers a level; friendly claims always go to the human. | `report_cap`, `enforce_floor`, `needs_identity_check` |
| D5 | JEV stays as a **second opinion** only (rework is Faz 3, not done here). | — |
| D6 | Rings: critical 1 km, warning 2 km, observation 3.2 km. Decisions go to JSONL (Faz 4, not done here). | `goru.yaml` |

---

## 2. What changed

### Faz 0 — fixes that showed the operator false information or exposed the budget

- **`POST /agents/ask` crashed on every call** (`Pipeline(cfg, dataset)` — arguments
  swapped, plus two more wrong constructor signatures) and a broad `except` returned
  *"Tüm radar ve iz verileri … doğrulanmıştır"* with HTTP 200. Rewired exactly as
  `cli ask` wires it; the fabricated fallback is gone. The old test passed on the
  fabricated text; the new ones drive the real tools through a `ScriptedGateway`.
- **R018 raised three moving cars to ALERT although our own detection contradicted
  it** ("5 trucks stopped"; the image sees five cars and a van). `report_evidence_cap`
  ignored `consistency` for `official` reports. Superseded entirely by Faz 1.
- **Budget protection:** CORS was `*` with credentials; now an allowlist
  (`GORU_CORS_ORIGINS`, default local display ports). The three spending/writing POSTs
  require `X-Goru-Client` (a foreign page cannot add it without a preflight the
  allowlist refuses); `web/src/api/http.ts` sends it. Compose binds backend and
  frontend to `127.0.0.1`; `GORU_API_PORT` moves the host port (on the dev laptop
  `ApplicationWebServer` holds `0.0.0.0:8080`).
- Live Docker check: loopback-only ports, 403 on all three POSTs without the header,
  no CORS grant to a foreign origin, frontend 200. No LLM call was made.

### Faz 1' — the threat model, centred on the base

- `kinematics/behaviour.py` — `behaviour_profile()` reads the **whole two-hour record**
  (the brief: "hız ve yönü kaydın tamamından okuyun"): closing on the base over 30/60/120
  min, heading, closest approach and how far out it came in from, bearing sweep, range
  spread, stop spells (same definition as the display's `stopsOf`).
- `risk/base.py` — the base as a target through the existing vectorised geometry;
  `sector_of()`; `ring_of()`.
- `risk/engine.py` — rewritten. Signals: `inside_critical`, `imminent_entry`,
  `sustained_approach`, `closing_path` (approach); `circling`, `probe`, `loiter`
  (surveillance). Strong signal or both families → ALERT/high; one signal →
  WATCH/possible. The priority terms now come from the engine (`PriorityTerm`).
- Bundle carries `base`, `behaviour`, `sector`, `category`, `likelihood`, `signals`;
  prompts rewritten to the base model.

### Faz 1 — every report checked against our data

- `fusion/reports.py` — the parser is an explicit table of the **32 templates** the 137
  reports are written in; **137/137 classified** (was 37 `unknown` + 7 located tips
  misfiled as yesterday's rumours + 2 "usually ~4 vehicles" read as sightings of 4).
  Claims now carry `motion`, `still_for_min`, `friendly`, `usual_count`, `tip`.
- `fusion/report_resolver.py` (new, replaces `evaluate_consistency`,
  `report_evidence_cap`, `match_reports_to_tracks`): relevance by the image's footprint
  and **120-min** window; type and count against detections within 50 m; motion against
  the described vehicle's own track at the report's time; sector claims against what the
  image saw. Verdict: `verified | contradicted | unverifiable | context`, with a
  **scenario** for the human on every doubt. `report_cap()` = never raise (one line to change).

### Faz 2 — threat candidates with an evidence-built confidence

- `risk/threat.py` — `ThreatCandidate`: category, likelihood, and a confidence that is
  the exact sum of labelled terms (strong signal 0.30 / signal 0.15, both families 0.15,
  clear detection 0.15 / detection 0.08, heavy 0.10, verified report 0.15, contradicted
  friendly claim 0.15; max 1.0, never clipped). Flags: `not_detected`,
  `contradicted_friendly_claim`, `friendly_claim_unconfirmed_identity`.
- `cli.py threat-report` — the day's picture in one command.

---

## 3. Measured on the shipped data

| | Before (zone model) | After (base model) |
|---|---|---|
| Levels over 226 vehicles | 23 ALERT · 119 WATCH · 84 CLEAR | 33 ALERT · 121 WATCH · 72 CLEAR |
| WATCH only for sitting in a road's buffer | 59 | 0 |
| Vehicle 7.6 → 1.6 km from the base in 30 min (T0192) | CLEAR | ALERT, "2.6 dk to the critical ring" |
| Vehicles orbiting the base at ~1.6 km (T0146, T0035, T0179, T0047…) | not recognised | ALERT, circling 227–278° |
| Reports that ever moved a level | yes (R018 → 3 ALERTs, R056 → ALERT) | none (tested: removing all reports changes no level) |
| Located reports | "agrees" on empty scenes 72 of 79 | 30 verified · 39 contradicted · 3 unverifiable |
| … by source | — | official 22 ✓ / 24 ✗ · third-party 8 ✓ / 15 ✗ |
| Friendly claims | 11 recognised | 18 recognised: 10 verified type/motion, 5 contradicted, 3 unverifiable — all to the human |

---

## 4. Findings

**T1. A report's coordinates are its vehicle's position at the image's capture, not at
the report's time.** 33 of 72 lie within 2 m of a track at capture, 1 of 72 within 2 m
of a track at report time; each report is filed up to 120 min before its image. The
brief's worked example compares the same way. *This corrects my own earlier review,*
which measured linkage at report time and reported "4 of 51 reports reach the right
vehicle"; the old system's position matching was right and its 15/30-min window was
the defect.

**T2. Every located report belongs to exactly one image** (footprint + 150 m, within
120 min before capture). The brief's "süzün" instruction is exact on this data.

**T3. "No track at the spot" is not "no vehicle".** R101 ("7 trucks stopped") has no
track within 1.2 km at report time, yet three trucks stand within 50 m at capture —
parked vehicles may have no record (brief). Type/count therefore use detections.

**T4. A record that starts near the base and drives away is a departure, not a probe.**
T0009's closest point is its first fix; the probe signal requires coming in from
outside the critical ring (`came_in_from_m`).

**T5. `official` is wrong about as often as it is right** (22 verified / 24
contradicted). D3 is supported by the data, not just by policy.

**T6. My earlier claim "R083 names a car where the vehicle is a truck" was incomplete** —
it looked at the nearest track only; two tracks and a car detection sit at that spot.
The resolver checks all vehicles within 50 m.

---

## 5. Bugs found on the way (all fixed, each caught by a test)

1. Scripted edits turned `\b` into a backspace character twice (the parser's singular-noun
   rule and the weather rule `sis\b`). Caught by the template tests.
2. The display's score breakdown **recomputed the engine's formula against a zone**; after
   the model change the screen showed the distance to Bati Yerlesimi (1662 m) under the
   base-derived score, and a "push the drift onto the largest term" step hid it. The
   engine now hands over its terms; the export only labels them and raises on any drift
   beyond rounding.
3. The numeric-drift guardrail applied every unit conversion to every number: a 240 s
   time-to-CPA read as km/h (864) vouched for an invented "900 m". Conversions are now
   per quantity (distance m/km, duration s/min, speed m/s–km/h).
4. Four web tests pinned the old zone-model counts; updated to the measured new ones.

---

## 6. Open decisions

1. **Loiter threshold.** Vehicles here spend most of their record stopped (median 18 of
   24 steps), so "stopped ≥ 30 min within 3 km" is weak evidence. Measured:

   | loiter_min / dwell_radius | ALERT | WATCH | CLEAR |
   |---|---|---|---|
   | 30 / 3000 (current) | 33 | 121 | 72 |
   | 60 / 3000 | 30 | 116 | 80 |
   | 90 / 2000 | 30 | 91 | 105 |

2. **Verified reports and levels.** `report_cap()` never raises; a verified report adds
   0.15 confidence instead. Change one line to let it put a vehicle on WATCH.
3. **Context volume.** Sector rumours/outages repeat in every image of their sector within
   2 h (190 of 305 report appearances). Trim to the latest per sector?
4. **Faz 3:** JEV criteria still say "stationary → CLEAR" (harmless under the floor, wrong
   under D2); assessor output should carry category/likelihood; 40-image pass after the
   bundle is frozen.
5. **Faz 4:** UI strings still say "Bölgeye giriş"; zone circles should become sectors and
   base rings; threat cards, scenario panel, JSONL decisions.
6. PLAN.md revision 4 and README (metrics, "REST not built", test counts).

---

## 7. How to verify

```bash
.venv/Scripts/python -m pytest -q                                  # 243 tests
.venv/Scripts/python services/api/app/cli.py threat-report --top 30
.venv/Scripts/python web/scripts/export_fixtures.py && (cd web && npx vitest run)   # 235
GORU_API_PORT=8081 docker compose up -d --no-deps --build backend frontend
```

New test files: `test_behaviour.py`, `test_threat_model.py`, `test_report_resolver.py`,
`test_threat_confidence.py`; rewritten: the rule tests in `test_engine.py`, the REST
ask/security tests, the report parser tests.
