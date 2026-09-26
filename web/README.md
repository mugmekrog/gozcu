# web — Sentinel tactical display and review UI

Built to the wireframe set in `Sentinel system wireframes.zip`, which is the
authority for this UI. Where PLAN §7.3 disagrees with the wireframes, the
wireframes win; every divergence is recorded in
`logs/step_frontend_development_logs.md`.

## Running it

Two commands, from the **repo root**:

```bash
# 1. Generate the fixtures from the real pipeline (~2 s, needs the Python venv).
.venv/Scripts/python web/scripts/export_fixtures.py

# 2. Start the dev server.
cd web && npm install && npm run dev
```

Vite prints the URL it bound to. It is normally <http://localhost:5173>, but if
that port is taken it picks the next free one — read the line it prints.

`--no-images` on the export skips copying the 40 drone JPEGs (9 MB). Everything
still works; the camera view shows a placeholder and says why.

## Checks

```bash
npm run typecheck   # tsc, no emit
npm test            # 149 tests, no network
npm run build       # production bundle
```

## Pointing it at the live API

The app talks to one interface, `GoruApi` in `src/api/port.ts`. With no
configuration it uses `FixtureApi` over the static export. Set a base URL and it
uses `HttpApi` against the REST surface of PLAN §5.4 instead, with no change to
any screen:

```bash
VITE_API_BASE_URL=http://localhost:8000 npm run dev
```

`src/api/http.ts` marks the four places where PLAN's REST surface does not yet
cover what the screens need, each tagged `NEEDS-BACKEND`.

## Voice control

The microphone is in the agent column and works from every view; **SESLE KONTROL**
(the fourth entry in the GÖRÜNÜM menu, or `S`) is where you see what was heard.

It needs the local speech service running — see the speech section of the root
README. Point the display at it with a Vite variable:

```bash
echo "VITE_STT_URL=http://127.0.0.1:8800" > .env.local
npm run dev
```

Without it the app boots exactly as before with the microphone disabled and a line
saying how to start the service, the same way AJANA SOR behaves with no gateway.

`V` pushes to talk and again sends; the utterance also ends itself after about half
a second of silence, or at 15 seconds. Speech is **admin-level** — it can reach every
command in `contracts/voice_commands.json`, including the one that records an
operator decision, and that one asks first. The reasoning and the open decisions are
in `logs/step_stt_development_logs.md`.

## Layout

```
src/
├── api/         the data seam: port + fixture and http adapters
├── voice/       capture, endpointing, the speech seam, the command executor
├── domain/      pure logic — risk bands, polar projection, track sampling,
│                brief assembly, formatting, the Turkish string table
├── store/       Zustand state, the simulation clock, and the speech session
├── radar/       the SVG tactical display, one file per layer
├── components/  panels and controls
├── views/       Harita / Hareket / Kayıtlar / Sesle kontrol
├── test/        the fake data seam the shell tests share
└── styles/      tokens.css is the single source of visual truth
```

Nothing is fetched from a CDN at runtime and the type is the system monospace, so
the demo works with the network off (PLAN §F4.3).

## Demo hotkeys

| Key | Action |
|---|---|
| `Space` | play / pause |
| `←` `→` | step the clock 5 minutes (`Shift` for 30) |
| `M` `H` `K` | Harita / Hareket / Kayıtlar |
| `D` | evaluate the selected frame |
| `Esc` | close the modal, then the camera, then the selection |
