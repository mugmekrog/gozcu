# Gözcü — zone-proximity early warning

Stage-2 hackathon build. Ingests a drone day-output (40 images + metadata, 226
vehicle tracks, 137 field reports, 8 protected zones + base), geo-references
pre-computed detections, matches them to tracks, derives kinematics over each
track's 2-hour history, cross-checks the field reports, and produces an
**attention assessment per vehicle**: what needs attention, why, and on which
evidence.

The assessment is produced by an **LLM agent over a deterministic evidence
layer**. A human reviewer sees everything on a tactical display, inspects the
evidence chain, and acknowledges or dismisses. Nothing is automated beyond the
warning.

> **Facts are deterministic; judgement is the agent's.** Geometry, matching and
> kinematics are plain testable code and are never invented by a model. The agent
> may raise a warning level, never lower one — that floor is structural, not
> prompted.

## Read these first

| Document | What it is |
|---|---|
| [PLAN.md](PLAN.md) | The full plan: data, contracts, algorithms, four workstreams, demo script. Every number in it was measured from the shipped data. |
| [logs/step_agentic_development_logs.md](logs/step_agentic_development_logs.md) | Agent layer + deterministic engine. Findings **F1–F6**. |
| [logs/step_frontend_development_logs.md](logs/step_frontend_development_logs.md) | Tactical display and review UI. Findings **W1–W11**. |
| [logs/step_stt_development_logs.md](logs/step_stt_development_logs.md) | Local Turkish speech-to-text and voice control. Findings **S1–S9**. |
| [web/README.md](web/README.md) | How to run the frontend. |

Both step logs end with a *decisions needed* list. Those are the open items.

## Layout

```
goru.yaml                 every threshold that influences a decision, in one file
libs/goru_core/           config, geodesy, frozen schemas, timeline, provenance
services/api/app/
  ingest/ perception/     loading + validation, detection post-processing
  fusion/ kinematics/     detection↔track matching, reports, velocity
  risk/                   zone assessment, the deterministic warning baseline
  agents/ llm/            the agent layer, gateway port and adapters
  pipeline.py             wiring: dataset in, evidence and alerts out
  cli.py                  runs all of it
  stt/ voice/              local Turkish speech-to-text, and what a transcript may do
  api/stt_server.py        the loopback speech service the display calls
web/                      React tactical display (see web/README.md)
contracts/                voice_commands.json: what speech may do, read by both sides
stage2/                   organizer files, read-only
bounding_boxes.csv        our Stage-1 detector's output, read-only
tests/                    195 Python tests
logs/                     step logs, one per stage
```

## Running it

**Backend** — Python 3.11+ (3.12 recommended). Name the interpreter explicitly:
on macOS a bare `python3` can be the system 3.9, which cannot install `scipy>=1.14`.

```bash
python3.12 -m venv .venv                               # or python3.11 / python3.13
source .venv/bin/activate                              # Windows: .venv\Scripts\activate
python -m pip install -r requirements.txt
python -m pytest -q                                    # 195 tests, ~5 s, no network

python services/api/app/cli.py data-report             # reproduce every measured number
python services/api/app/cli.py detections img_000860   # the 474 → 5 funnel, with reasons
python services/api/app/cli.py assess img_000860       # agent verdict (spends ~1 cent)
python services/api/app/cli.py budget                  # spend vs the $15 cap
```

The CLI finds `goru.yaml` at the repo root on its own, so it runs from any
directory; pass `--config path/to/goru.yaml` to use a different file.

**Speech** — optional, needs a CUDA GPU and a 3.1 GB model download:

```bash
.venv/Scripts/python -m pip install -r requirements-stt.txt
cd services/api
python app/cli.py stt-probe                            # does the model load here?
python app/cli.py stt-file command.wav                 # transcribe one clip
python app/cli.py voice-route "kayitlar sayfasina gec" # transcript -> command
python app/cli.py serve-stt                            # the service the display calls
```

**Frontend** — Node 20 (with the venv active):

```bash
python web/scripts/export_fixtures.py                  # real pipeline output → web/public/fixtures
cd web && npm install && npm run dev                   # read the URL it prints
npm test                                               # 234 tests, no network
```

The map under the radar is OpenStreetMap, already baked into `web/public/basemap/ankara.json`
and committed, so nothing is fetched at runtime. To re-bake it (needs the network once;
raw Overpass responses are cached in `data/processed/osm/`):

```bash
python web/scripts/export_basemap.py                   # --refresh to re-download
```

The frontend runs on static fixtures by default so it works with the network off.
Set `VITE_API_BASE_URL` to point it at the live REST API instead.

For voice control, point it at the speech service as well — without this the
microphone is disabled and says why, which is the shipped default:

```bash
cd web && echo "VITE_STT_URL=http://127.0.0.1:8800" > .env.local && npm run dev
```

**Docker Compose** starts the API, the speech service, and the frontend together:

```bash
docker compose up --build
curl http://127.0.0.1:8800/stt/status
```

The speech container uses CPU when Docker has no NVIDIA GPU access. For GPU
inference on a host with the NVIDIA Container Toolkit, run
`docker compose -f docker-compose.yml -f docker-compose.gpu.yml up --build`.
Its first start downloads the Turkish Whisper model into the persistent
`stt-model-cache` volume; the frontend waits for the speech service to finish
starting. The production preview uses
`docker compose -f docker-compose.prod.yml up --build` (add the same GPU override
when available). Check that `/stt/status` reports `"ready": true` before using
dictation. If the first model download is rate-limited by Hugging Face, retry
after the limit clears or export `HF_TOKEN` in your shell and restart `stt`.
Do not put that token in the committed `.env` file.

## Secrets

`.env` is **committed** in this repo by team decision, so a fresh clone can run the
agent layer without anyone passing keys around. `.env.example` documents the same
variables.

`GLM_API_KEY` is the organizers' shared gateway key with a **$15 lifetime budget
that never resets** — a leaked key is a spent key, and it cannot be topped up. Two
consequences to keep in mind:

- **Before this repo is ever made public**, rotate the key with the organizers.
  Deleting the file will not remove it from git history; every clone and fork
  already has it.
- Anyone with read access to this repo can spend the budget. Check what is left
  with `python services/api/app/cli.py budget` — the gateway's own `/key/info` is the
  authoritative figure, and the ledger prefers it over its local estimate.

The three `GORU_*_PASSWORD` values are still the `change-me-*` placeholders. Set
them for real before auth is built (that stream has not started).

## Status

| Stage | State |
|---|---|
| Deterministic engine | built, 135 tests |
| Agent layer | built — assessor, report parser, reviewer copilot, guardrails, budget ledger |
| Frontend | built, 149 tests |
| Speech-to-text + voice control | built — `whisper-large-v3-tr` on the GPU, admin-level Turkish commands, 48 Python + 62 web tests. Four open decisions in the step log, **S5 first**. |
| REST + WebSocket API | **not built** — `web/src/api/http.ts` specifies what it must serve |
| Auth, RBAC, audit hash chain | **not built** |
| Simulation clock (server side) | **not built** — the frontend runs its own over the fixed dataset |
