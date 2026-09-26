# Step log — local Turkish speech-to-text

**Date:** 2026-09-27 · **Scope:** `stt.md`, phases 1–11 · **State:** 171 Python
tests and 149 frontend tests green; the model runs on this machine's GPU and the
full path from microphone to a performed command works end to end.

This log is for the four workstream leads. It records what was built, the design
decisions that were the team's rather than mine, and **nine findings** numbered
S1–S9. Four need a decision from someone other than me, and **S5 is the one to read
first** — it is a measured miss against `stt.md`'s own latency target, and it
follows directly from a choice the team made with the tradeoff on the table.

Findings from the earlier stages are `F1–F6` (agent layer) and `W1–W11`
(frontend); this log uses `S` to keep the three apart.

---

## 1. What was asked, and what this delivers

The ask was a local Turkish speech-to-text pipeline feeding the existing agent, an
icon and page for it, and an animation covering the processing latency.

`stt.md` is written for a different application than the one in this repository —
a Python desktop app holding the microphone through `sounddevice` — so the shape
had to be decided before anything could be built. Four questions went back; the
answers are in §2 and they are the reason this looks the way it does.

Built:

- `libs/goru_core/config.py` — `stt:` and `voice:` blocks, typed and frozen like
  every other threshold, plus an `agents.voice` call config.
- `services/api/app/stt/` — audio decode, the resident model, the provider seam
  with **two** adapters, the transcript manager, the domain normaliser, and the
  service that owns all of it.
- `services/api/app/voice/` — the command registry and the LLM router.
- `services/api/app/api/stt_server.py` — a loopback FastAPI service, the first HTTP
  service in this repository and deliberately **not** `rest.py`.
- `contracts/voice_commands.json` — the command contract, read by both sides.
- `web/src/voice/` — capture, endpointing, the WAV encoder, the speech seam with
  two adapters, and the command executor.
- `web/src/components/` — `VoiceDock`, `LevelBars`, `VoiceConfirm`.
- `web/src/views/VoiceView.tsx` — **SESLE KONTROL**, the fourth view, with a 🎙 icon
  in the GÖRÜNÜM menu.
- four CLI commands: `stt-probe`, `stt-file`, `voice-route`, `serve-stt`.
- 48 Python tests and 62 frontend tests, none of which need a GPU, a model or a
  network.

Not built: the 100-command benchmark of phase 12, by decision (§2.4), and the
future-work list at the end of `stt.md` — wake word, partial transcripts, barge-in,
TTS. The architecture keeps all of those optional, which was the point of phase 7.

---

## 2. The four decisions that were the team's

Each of these was put with its alternatives and its costs. Recording them because
three of them are the reason later findings read the way they do.

### 2.1 The browser owns the microphone

`stt.md` phase 2 assumes `sounddevice` in the Python process. This is a browser
application, so capture is `getUserMedia` plus an `AudioWorklet`, and the finished
utterance is POSTed to a local service as 16 kHz mono PCM.

The alternative — the service holding the device — was declined for three reasons
that would each have surfaced later: the permission prompt is the browser's to
show, a level meter can only be drawn from samples the page actually has, and the
whole thing would stop working the moment the display was opened from a second
machine.

### 2.2 Speech is admin-level

Every command in the registry is reachable by voice, including `record_decision`,
which writes an operator decision into the record. **I argued against this** — it
puts a speech model on the human-decision path, which is the one thing PLAN's
"nothing is automated beyond the warning" reserves for a person — and the team's
answer was that voice should be able to do anything the operator can, with the
agent's behaviour to be revisited around that later.

So it is built that way, with one safeguard left standing: `record_decision` comes
back from the router flagged `requires_confirmation`, and the display asks before
performing it. `voice.confirm_audit_commands: false` in `goru.yaml` removes even
that. See **S6**.

### 2.3 Every transcript is routed by the LLM

No deterministic matcher in front of it. The alternative offered was
pattern-matching the known command set offline and for free, with the model as the
fall-through; the team chose to route everything through the model to handle
phrasing nobody anticipated.

What the decision costs is measured in **S5** and it is the most significant finding
in this log.

### 2.4 No 100-command benchmark this pass

Phase 12 is deferred. I cannot produce Turkish speech — this machine has en-US
voices only — so a benchmark would have needed either real recordings from the team
or TTS clips whose cleanliness would have flattered the numbers. The intent layer
and the normaliser are covered by text-level tests instead, which need no audio at
all. See **S9** for what exists to run when recordings do.

---

## 3. Findings

### S1. This machine is not the machine `stt.md` describes. **Resolved, with measurements.**

`stt.md` specifies an RTX 4070 with 12 GB. The only GPU here is an **RTX 2060 with
6144 MiB**. The published model is 3.09 GB of float16 weights, so the headroom
question is real.

Measured, both precisions, same three Turkish clips, identical and correct
transcriptions:

| | model load | VRAM peak | latency (~1 s clip) |
|---|---|---|---|
| `float16` | **6.1 s** | **4001 MiB** | **391 ms** |
| `int8_float16` | 11.4 s | 2073 MiB | 412 ms |

`float16` wins on every axis and still leaves 2.1 GB spare, and it is the only
configuration the model's author smoke-tested (`training_summary.json`:
`compute_type: float16, status: passed`). So it is the default, and
`int8_float16` is documented as the fallback for when something else wants the
VRAM — Chrome's compositor takes a few hundred MB while the display is open.

`resolve_placement` also checks the card against the chosen precision at load time
and downgrades with a note rather than failing, so a smaller GPU degrades instead
of erroring.

### S2. The model needed no conversion, and it reports its own accuracy. **Useful, not actionable.**

`stt.md` phase 1.2 implies a `ct2-transformers-converter` step. There is none:
`oguzhangokboru/whisper-large-v3-tr` ships as a CTranslate2 float16 export
(`model.bin`, `config.json`, `vocabulary.json`) and `faster-whisper` loads it
directly.

Its `training_summary.json` also carries the author's own held-out figures, which
are worth having on the slide given §2.4:

```
WER  8.80 %      CER  2.52 %
8 000 validation rows / 8.84 h
trained on Common Voice 25.0 TR + issai/Turkish_Speech_Corpus, 272.4 h
LoRA fine-tune of openai/whisper-large-v3, merged before export
```

**Attribute it as the author's number, not ours.** We have measured that it
transcribes Turkish correctly on a handful of clips; we have not measured WER.

### S3. SESLE KONTROL is a screen the wireframes do not contain. **Needs a decision.**

The wireframes specify one workspace with three views. This adds a fourth, with a
🎙 icon in the GÖRÜNÜM menu, which is the same class of divergence the frontend log
records in its §6 — except that log's decision was *not* to invent screens the
wireframes lack.

I built it because the ask named it, and because speech needs somewhere the operator
can see **what the system heard**: a misheard command is the failure mode, and
recognising one means comparing what was said with what was understood. Every row
in DUYULANLAR shows the model's raw text, the normalised transcript, each rewrite the
normaliser made, and what the command did.

**Either the wireframes should gain this screen, or W1's rewrite of PLAN §7.3 should
cover it.** Right now a reader of either document would not know it exists.

The microphone itself is in the agent column, not on that page, and that is a
requirement rather than a preference: *"kayıtlar sayfasına geç"* changes the view, so
a microphone owned by the voice screen would be torn down by the command it had just
performed.

### S4. The real domain vocabulary is our own identifiers, not `stt.md`'s examples. **Resolved.**

`stt.md` phase 9 lists GitHub, Docker, CUDA, LangGraph. Those are not what this
system fails on. It fails on `T0132`, `img_000860`, `Z03`, `R137` and `13:50`, and no
acoustic model returns any of them in that form — an operator says *"te sıfır yüz
otuz iki"* and Whisper writes exactly that.

So `transcripts.py` converts spoken Turkish numbers to digits and folds the four id
shapes into canonical spelling. Three things about it worth knowing:

- **Turkish is agglutinative**, so the number words arrive inflected — *elliye*,
  *yüze*, *on üçe*. Matching bare stems missed almost every real utterance; there is
  now a suffix-aware matcher, and the suffix is carried onto the digits so
  *"saati on üç elliye al"* becomes *"saati 13:50'ye al"* and still reads as a
  sentence.
- **A number run has three readings** and context picks: after *saat* it is a clock
  (*on üç elli* → `13:50`), a run of bare digit words is an id read aloud
  (*sıfır sıfır beş* → `005`), and anything else is a quantity (*üç yüz* → `300`).
- **It abstains rather than guessing.** A span is only rewritten when it resolves to
  a real id shape. `stt.md`'s own closing rule for this phase is that correction must
  never change what the operator meant, and a normaliser that guesses breaks it.

Every rewrite is recorded on the transcript and shown on screen, so an operator who
sees the wrong vehicle light up can see why.

### S5. LLM routing costs about 5 seconds per command. **Needs a decision.**

This is the consequence of §2.3, measured against the real gateway:

| utterance | command | latency | cost |
|---|---|---|---|
| "kayıtlar sayfasına geç" | `set_view(logs)` | 5 616 ms | $0.0019 |
| "img_000860 karesini seç" | `select_frame` | 4 793 ms | $0.0019 |
| "tehdidi onayla ve bildir" | `record_decision` | 4 660 ms | $0.0019 |
| "T0029 neden iki kez durdu" | `ask_copilot` | 4 770 ms | $0.0019 |
| the same command again | `set_view(logs)` | **cached, free** | $0.0000 |

Transcription is **391–1 012 ms**. So end of speech to action is roughly
**5–6.5 seconds**.

`stt.md`'s own target is:

```
Target STT latency:            < 1 second      ← met (391 ms–1.0 s)
Target speech-end → agent:     1–2 seconds     ← missed, at 5–6.5 s
```

The STT half comfortably meets its target. The routing half is what misses, and it
is not something tuning fixes: it is one gateway round trip, already at the smallest
call config of the four (`reasoning_effort: low`, 1 200 tokens against the assessor's
4 000), with the response cache in front of it.

Cost is not the problem — $0.0019 a command is about 7 800 commands inside the
remaining budget, and a repeated command replays free.

**The decision:** accept ~5 s for the flexibility, or put a deterministic Turkish
matcher in front of the model for the dozen known command shapes and keep the model
as the fall-through. The second would make *"kayıtlar sayfasına geç"* instant, free
and work with the network off, at the cost of a matcher to maintain. The seam is
already in the right place — `VoiceRouter.route` is the only caller — so this is a
contained change, not a rework. I recommend it, and it was declined once with less
data than this table.

### S6. Voice can record an operator decision. **Built as decided; the safeguard is one config flag.**

Per §2.2. What is actually in place:

- `record_decision` has `effect: "audit"` in the contract and comes back
  `requires_confirmation: true`;
- the display raises a focus-trapped `alertdialog` showing **what was heard** as well
  as what will be recorded, because a misheard sentence is the failure it guards;
- **`Vazgeç` takes focus**, not the button that writes;
- an unanswered prompt expires after `voice.confirm_timeout_s` and records nothing;
- the note on the stored decision says it came from speech;
- `record_decision` refuses outright when no frame is selected — an audit event needs
  a subject and inventing one is the worst thing this command could do.

Four tests pin the gate from both sides, including that nothing is written before the
operator agrees. `voice.confirm_audit_commands: false` removes the dialog.

**Worth a second opinion from whoever owns the audit chain (S4 of the security
stream, unbuilt):** an audit event whose provenance is a speech model is a different
thing from one whose provenance is a click, and the payload currently records only
that it was spoken. If the hash chain should carry the transcript and the confidence,
that is a contract change and now is the time.

### S7. Two bugs the endpoint tests found in my own code. **Fixed.**

Both were silent and both would have shown up as "the microphone doesn't work
properly" rather than as an error.

1. **The noise floor outran the speech it was measuring.** The adaptive floor kept
   updating while it waited for onset, so a sustained word dragged the threshold up
   behind itself and onset was never confirmed — the microphone would simply never
   hear a slow, loud speaker. The estimate now takes only frames *below* the onset
   threshold: only silence tells you what silence sounds like.
2. **Trailing silence counted as speech.** `speechMs` included the hangover frames,
   so a 160 ms cough plus the 500 ms silence that closed it cleared a 250 ms minimum
   and got sent to the GPU. Held duration and speech duration are now separate: the
   15 s cap measures held audio, the minimum measures speech.

### S8. The command contract is one file, read by both sides. **Resolved, and it needs to stay that way.**

`contracts/voice_commands.json` is the authority. The Python router turns it into the
tool schemas it offers the model; the browser turns it into the executor's table. Each
side has a test asserting its own half covers exactly the names in the file.

This exists because the drift failure is silent: a registry written twice lets the
model emit a command nothing performs, and the operator watches a transcript scroll
past with no action and no error. **Anyone adding a command adds it to that file
first**, and both test suites will tell them which side they forgot.

### S9. What exists for the benchmark, and what is missing. **Needs recordings.**

Per §2.4 there is no WER figure of ours. What is in place to produce one:

- every transcription writes a row to `data/processed/stt_runs.jsonl` — audio
  duration, STT latency, real-time factor, transcript length, VRAM, the VAD speech
  ratio, and the error code when it failed (phase 11, complete);
- `python app/cli.py stt-file <path.wav>` transcribes one clip and prints all of it;
- the intent layer is covered by text-level tests that need no audio.

Missing is the audio. Roughly 100 clips of the real vocabulary — frame ids, track
ids, zone names, view names — recorded on the microphone the demo will use, in the
room it will run in. **Two people and twenty minutes**, and then the numbers in S5's
table can be joined by an accuracy figure that is ours. Until then, quote S2's WER as
the author's.

---

## 4. The animation, and why it is what it is

The ask was an animation covering the processing latency. It draws the microphone's
**actual RMS**, not a decorative loop, because the one question an operator has while
holding a button is whether the thing is hearing them — and a spinner answers that
identically for a live microphone and a dead one.

Two constraints from `tokens.css`, obeyed rather than worked around:

> "colour means risk. Nothing else in the interface is allowed to be coloured, so a
> red pixel anywhere is always a threat."

So the bars are ink. Every other product in the world draws a live microphone in red;
here red means a vehicle is a threat. And `--radius: 0`, so they are square columns
on the monospace grid rather than rounded pills.

The bars are a history — 28 columns, oldest left, about 1.4 s — so a glance shows the
shape of what was just said. `prefers-reduced-motion` keeps the heights and drops the
transition, because the height is the information; that is the frontend log's own rule
about the ALERT pulse degrading to a solid ring rather than disappearing.

**Cost.** Raw frames arrive every 2.7 ms at 48 kHz, around 370 a second. Those are
throttled to ~20 store writes a second carrying each window's peak, and the bars are
drawn by writing a CSS custom property per column straight to the DOM rather than
re-rendering 28 React children twenty times a second. Speech state also lives in its
**own** store: `useAppStore` exists as one store because the clock, map and modal share
state, but a level meter read by two components must not re-render the radar.

After speech ends the display moves through named states — `çözümleniyor` while
Whisper runs, `komut anlaşılıyor` while the router does — so the 5 seconds in S5 are
accounted for on screen rather than looking like a hang.

---

## 5. Architecture

```
browser                                   loopback service (port 8800)
─────────────────────────────────────     ─────────────────────────────────────
getUserMedia + AudioWorklet
  │  Float32 blocks, every 2.7 ms
  ├─► EndpointDetector ──► LevelBars      (energy VAD: when to stop recording)
  │                                        
  └─► 16 kHz mono PCM WAV ──────POST──►  decode_wav
                                            │
                                          SpeechToTextService  (one worker, one lock)
                                            ├─► LocalWhisperProvider
                                            │     faster-whisper + Silero
                                            │     whisper-large-v3-tr, float16, CUDA
                                            └─► TranscriptManager
                                                  clean · normalise ids · refuse
                                            │
                                          VoiceRouter ──► AgentRunner ──► GLM
                                            │              (cache · budget · audit)
                                            ▼
      RoutedCommand ◄────────────────── one registry command
        │
        ├─ requires_confirmation ──► VoiceConfirm ──► operator says yes
        │
        └─► performCommand ──► useAppStore  (the same actions a click reaches)
```

The two VADs do different jobs and both are needed. The browser's decides *when to
stop recording*, which Silero cannot do because the audio has not been sent yet.
Silero on the server decides *whether what arrived was speech at all*, which is the
backstop for the browser's energy heuristic letting noise through — a false trigger
there costs nothing worse than a `NO_SPEECH` refusal.

---

## 6. Failure handling (phase 10)

Every path returns a transcript **or** a refusal carrying a code; nothing raises at
the caller. That is phase 10's requirement expressed as a type — the display cannot
forget to handle "speech is unavailable" when the only way to get a transcript is to
check which of the two arrived.

| Code | When | What the operator sees |
|---|---|---|
| `STT_DISABLED` | `stt.enabled: false` | switched off in config |
| `STT_UNAVAILABLE` | no service reachable | how to start it |
| `CUDA_UNAVAILABLE` | no GPU, or cuDNN missing | set `stt.device: cpu` |
| `GPU_OUT_OF_MEMORY` | VRAM exhausted | set `int8_float16` |
| `MODEL_UNAVAILABLE` | weights not cached | — |
| `AUDIO_INVALID` | not a PCM WAV | — |
| `AUDIO_TOO_LONG` | past 15 s | say it more briefly |
| `AUDIO_TOO_SHORT` | under 250 ms | — |
| `NO_SPEECH` | Silero found none, or a hallucinated stock phrase | only noise heard |
| `EMPTY_TRANSCRIPT` | no words | say it again |
| `WORKER_CRASHED` | unexpected | — |
| `ROUTER_UNAVAILABLE` | gateway down | **the words, so it can be done by hand** |
| `PERMISSION_DENIED` etc. | the microphone | browser permissions |

Three of these are worth singling out:

- **Long audio is refused, never truncated.** Truncating would hand the agent the
  first two thirds of a sentence, which reads as a complete instruction — the most
  dangerous possible failure for a system where speech can record a decision.
- **Whisper's hallucinations are filtered.** On silence the Turkish fine-tunes emit
  stock phrases (*"Altyazı M.K."*, *"Abone olmayı unutmayın"*). Those are `NO_SPEECH`,
  not commands.
- **A GPU OOM marks the model unready**, so the next utterance reloads rather than
  compounding the failure.

---

## 7. How to run it

```bash
# once: the speech extras (~300 MB) and, on first use, a 3.1 GB model download
.venv/Scripts/python -m pip install -r requirements-stt.txt

# does it load on this machine, and at what cost
cd services/api && python app/cli.py stt-probe

# one file, with every measurement
python app/cli.py stt-file ../../path/to/command.wav

# one transcript to a command, without a microphone (spends ~$0.002)
python app/cli.py voice-route "kayitlar sayfasina gec"

# the service the display talks to
python app/cli.py serve-stt
```

Then point the display at it:

```bash
cd web && echo "VITE_STT_URL=http://127.0.0.1:8800" > .env.local && npm run dev
```

Without `VITE_STT_URL` the display boots exactly as before with the microphone
disabled and a line saying how to start the service. That is the shipped default, and
it is the same courtesy AJANA SOR already extends when there is no gateway.

Hotkeys: **V** push to talk (again to send), **S** the SESLE KONTROL view, **Esc**
unwinds the confirmation, then the microphone, then the modal.

---

## 8. Tests

| File | Covers |
|---|---|
| `tests/test_stt.py` (48) | audio at any rate, refusals with codes, the normaliser's three readings and its abstention, the 15 s cap not truncating, hallucination filtering, OOM marking the model unready, the registry contract, routing, the confirm flag, the audit line, an unreachable gateway still returning the words |
| `web/src/voice/endpoint.test.ts` (15) | calibration, onset, a cough rejected, a mid-sentence pause not splitting an utterance, the cap, the frozen floor, a noisy room, the level curve |
| `web/src/voice/commands.test.ts` (25) | **the contract matches the executor exactly**, every handler, ids that do not exist refused, no decision without a frame |
| `web/src/voice/wav.test.ts` (12) | the PCM header field by field, clamping, resampling |
| `web/src/voice/voice.integration.test.tsx` (11) | the dock in the shell, the microphone disabled with a reason, the fourth view, **the confirmation gate from both sides** |

171 Python tests (123 + 48) and 149 frontend tests (87 + 62). No test needs a GPU, a
model download, a network or a cent of budget — that is what the two scripted
adapters are for. The frontend bundle went from 74 KB to **85 KB gzipped**, against a
300 KB budget.

One refactor: the fake `GoruApi` was lifted out of `App.test.tsx` into
`web/src/test/fake-api.ts` so the speech tests drive the same app through the same
adapter. `App.test.tsx`'s seven tests are unchanged and still pass.

---

## 9. Handover

**Everyone — the four open decisions:**

1. **S5** — accept ~5 s per command, or put a deterministic matcher in front of the
   router. This is the one that changes how the demo feels.
2. **S3** — SESLE KONTROL has no wireframe. Add one, or fold it into W1's rewrite of
   PLAN §7.3.
3. **S6** — whether an audit event caused by speech should carry the transcript and
   the confidence. Contract change if so, and better now than after the hash chain.
4. **S9** — record ~100 Turkish clips, or ship quoting the model author's WER (S2)
   and say whose number it is.

**Backend.** `stt_server.py` is a second HTTP service on its own port; it does not
touch `rest.py` and does not presume anything about it. When `rest.py` lands, the
question is whether speech folds into it or stays separate — separate has the
advantage that the microphone service can be restarted without dropping the display.
`app.state` wiring in `create_app` is the whole integration surface.

**Perception & Agent.** The router is a fourth agent in everything but name. It uses
`AgentRunner`, so it shares the cache, the budget ledger and `agent_runs.jsonl`, and
its spend appears under `by_purpose["voice"]`. One wart: `AgentRun.kind` is a frozen
contract with no `voice` member, so routing runs are logged as `kind: "copilot"` and
are told apart by their `run_id` prefix. **Adding `voice` to that literal is a
one-line contract change and would make the ledger honest** — I did not make it
because §5.1 is frozen.

**Frontend.** `web/src/voice/` is self-contained; `commands.ts` is the only file that
touches the store, through an injected context, which is why it is testable without
one. The executor reaches the same store actions a click does, so speech cannot get
the display into a state a hand could not.

**Security.** Read S6. Also: the service binds loopback only, `stt.host` is where
someone has to say otherwise explicitly, and there is no auth on it — same as
everything else in this repo, but this one holds a microphone stream and can record a
decision, so it is the first service where that matters. `stt.cors_origins` is
restricted to the dev server's origins rather than `*`.
