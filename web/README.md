# web — Gözcü harita ve inceleme arayüzü

Built to the wireframe set in `Sentinel system wireframes.zip`, which is the
authority for this UI. Where PLAN §7.3 disagrees with the wireframes, the
wireframes win; every divergence is recorded in
`logs/step_frontend_development_logs.md`.

## Running it

Two commands, from the **repo root**:

```bash
# 1. Generate the fixtures from the real pipeline (~2 s, needs the Python venv).
#    Windows: use .venv/Scripts/python instead of .venv/bin/python.
.venv/bin/python web/scripts/export_fixtures.py

# 2. Start the dev server.
npm --prefix web install && npm --prefix web run dev
```

Vite prints the URL it bound to. It is normally <http://localhost:5173>, but if
that port is taken it picks the next free one — read the line it prints.

`--no-images` on the export skips copying the 40 drone JPEGs (9 MB). Everything
still works; the camera view shows a placeholder and says why.

## Checks

```bash
npm run typecheck   # tsc, no emit
npm test            # 88 tests, no network
npm run build       # production bundle
```

## Pointing it at the live API

The app talks to one interface, `GoruApi` in `src/api/port.ts`. Local Vite
development uses `HttpApi` against `http://127.0.0.1:8080` by default. Set a
different base URL if the backend uses another port:

```bash
VITE_API_BASE_URL=http://127.0.0.1:8081 npm run dev
```

`src/api/http.ts` marks the four places where PLAN's REST surface does not yet
cover what the screens need, each tagged `NEEDS-BACKEND`.

`AJANA SOR` accepts questions and evaluation requests. In fixture mode it uses
the agent service at `http://127.0.0.1:8080`; set `VITE_AGENT_API_BASE_URL` if
the service runs elsewhere. The input stays available and shows a connection
error when the service is down.

## Layout

```
src/
├── api/         the data seam: port + fixture and http adapters
├── domain/      pure logic — risk bands, polar projection, track sampling,
│                brief assembly, formatting, the Turkish string table
├── store/       Zustand state and the manual time cursor
├── radar/       the SVG tactical display, one file per layer
├── components/  panels and controls
├── views/       Harita / Kayıtlar
└── styles/      tokens.css is the single source of visual truth
```

Nothing is fetched from a CDN at runtime and the type is the system monospace, so
the demo works with the network off (PLAN §F4.3).

## Harita kontrolleri

Fare tekerleği veya `+ / −` düğmeleri haritayı 2–16 km aralığında yakınlaştırır.
Otomobil kare, minibüs üçgen, kamyon yıldız, otobüs yuvarlakla gösterilir.
Mavi güvenli, sarı şüpheli, kırmızı tehlike düzeyidir. Gri işaretler henüz
görüntü karesinde sınıflandırılmamış izlerdir. Zaman çizelgesi elle sürüklenir;
kare işaretleri yalnızca çekim zamanını gösterir. Bir aracı seçince iz kaydı,
varış süresi ve varsa uyarıyı inceleme düğmesi açılır.

## Kısayollar

| Key | Action |
|---|---|
| `←` `→` | step the clock 5 minutes (`Shift` for 30) |
| `Esc` | close the modal, then the camera, then the selection |
