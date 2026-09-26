# Action Plan — Local Turkish Speech-to-Text Integration for LLM Agent App

## 1. Objective

Integrate a local Turkish Speech-to-Text pipeline into the application using an NVIDIA RTX 4070 GPU.

The system will primarily process short spoken commands, typically below 10–15 seconds, and forward the finalized transcript to the existing LLM agent.

Primary STT model:

`oguzhangokboru/whisper-large-v3-tr`

Inference framework:

`faster-whisper / CTranslate2`

Target architecture:

```text
Microphone
    ↓
Audio Capture
    ↓
Voice Activity Detection
    ↓
Speech Buffer
    ↓
Local STT Service
    ↓
Turkish Transcript
    ↓
Transcript Manager
    ↓
LLM Agent
    ↓
Tool / Action Execution
```

The first implementation should prioritize reliability and low complexity instead of true word-by-word streaming.

---

# Phase 1 — Establish the STT Runtime

## Goal

Confirm that the Turkish Whisper model runs correctly on the RTX 4070 before integrating it into the application.

## Tasks

### 1.1 Create a dedicated Python environment

Recommended:

```bash
python -m venv .venv
```

Activate the environment and install:

```bash
pip install faster-whisper
pip install sounddevice
pip install numpy
pip install scipy
```

Install the required CUDA-compatible dependencies according to the installed CTranslate2/faster-whisper version.

---

### 1.2 Load the model once

The model must remain resident in GPU memory while the application is running.

Example:

```python
from faster_whisper import WhisperModel

model = WhisperModel(
    "oguzhangokboru/whisper-large-v3-tr",
    device="cuda",
    compute_type="float16"
)
```

If VRAM pressure becomes a problem:

```python
compute_type="int8_float16"
```

should be tested.

Do not reload the model for every speech command.

---

### 1.3 Create a basic file-based transcription test

Input:

```text
test.wav
```

Output:

```text
"yarın saat üçte toplantı oluştur"
```

Initial inference configuration:

```python
segments, info = model.transcribe(
    "test.wav",
    language="tr",
    beam_size=1
)

text = " ".join(segment.text.strip() for segment in segments)
```

---

### 1.4 Measure baseline performance

Collect:

```text
Model load time
GPU VRAM usage
10-second audio inference latency
15-second audio inference latency
Transcription accuracy
```

Create a small benchmark set of approximately 20–50 Turkish commands.

Examples:

```text
"Yarın saat üçte toplantı oluştur."

"Dosyayı masaüstüne kaydet."

"Yeni bir proje oluştur."

"Tarayıcıyı aç ve GitHub'a git."

"Bugünkü görevlerimi göster."
```

### Exit Criteria

Proceed only when:

```text
Model runs reliably on CUDA
No GPU out-of-memory errors occur
15-second commands are transcribed reliably
Inference latency is acceptable
```

---

# Phase 2 — Implement Microphone Audio Capture

## Goal

Capture user speech directly from the application's microphone.

Recommended format:

```text
Sample rate: 16 kHz
Channels: Mono
Sample format: PCM / float32 or int16
```

Whisper should receive normalized 16 kHz mono audio whenever possible.

---

## 2.1 Build an Audio Capture module

Suggested component:

```text
audio_capture.py
```

Responsibilities:

```text
Select microphone
Start recording
Read audio frames
Normalize audio
Push frames into an audio queue
Stop recording
```

Example conceptual interface:

```python
class AudioCapture:

    def start(self):
        ...

    def stop(self):
        ...

    def read_chunk(self):
        ...
```

Avoid tightly coupling microphone logic to the STT model.

---

# Phase 3 — Add Voice Activity Detection

## Goal

Automatically detect when the user starts and stops speaking.

Recommended:

```text
Silero VAD
```

The STT model should not constantly process silence.

Target behavior:

```text
silence
silence
speech detected
speech
speech
speech
silence
silence
utterance finalized
```

---

## 3.1 Define speech boundaries

Initial parameters can be approximately:

```text
speech-start confirmation:
100–200 ms

speech-end silence:
400–700 ms

maximum utterance duration:
15 seconds
```

The exact thresholds should later be tuned using real user recordings.

---

## 3.2 Maintain a speech buffer

Architecture:

```text
Microphone
    ↓
Audio Frames
    ↓
VAD
    ↓
Speech Buffer
```

While speech is active:

```python
speech_buffer.append(audio_chunk)
```

When speech ends:

```python
utterance = finalize_buffer()
```

Then send the utterance to the STT worker.

---

# Phase 4 — Create an Independent STT Service

## Goal

Separate speech recognition from the main application.

Recommended structure:

```text
app/
│
├── audio/
│   ├── capture.py
│   ├── vad.py
│   └── buffer.py
│
├── stt/
│   ├── service.py
│   ├── model.py
│   └── schemas.py
│
├── agent/
│   └── ...
│
└── main.py
```

The STT model should be initialized only once.

---

## 4.1 STT service interface

Example:

```python
class SpeechToTextService:

    def __init__(self):
        self.model = load_model()

    def transcribe(self, audio):
        ...
```

Expected response:

```python
{
    "text": "yarın saat üçte toplantı oluştur",
    "language": "tr",
    "duration": 3.4,
    "final": True
}
```

---

## 4.2 Run STT separately from the UI thread

Do not execute Whisper inference directly inside the main GUI/event loop.

Use one of:

```text
Worker thread
Worker process
Async job queue
Local WebSocket service
Local HTTP service
```

Recommended initial implementation:

```text
Main App
   ↓
Queue
   ↓
STT Worker Process
   ↓
Result Queue
```

This prevents the UI from freezing during inference.

---

# Phase 5 — Introduce a Transcript Manager

## Goal

Create a clean boundary between STT and the LLM agent.

The LLM agent should not directly consume raw STT events.

Architecture:

```text
STT
 ↓
Transcript Manager
 ↓
Agent
```

Responsibilities:

```text
Clean whitespace
Reject empty transcripts
Reject very low-confidence output if necessary
Normalize punctuation
Maintain final/partial state
Attach metadata
Forward finalized commands
```

Example:

```python
{
    "id": "speech_00142",
    "text": "yarın saat üçte toplantı oluştur",
    "language": "tr",
    "final": True,
    "timestamp": 1780000000
}
```

---

# Phase 6 — Connect STT to the LLM Agent

## Goal

Send only finalized user utterances to the agent.

Correct flow:

```text
Speech detected
      ↓
Audio buffered
      ↓
Speech ends
      ↓
Whisper transcription
      ↓
Final transcript
      ↓
Agent invocation
```

Example:

```python
result = stt_service.transcribe(audio)

if result["final"] and result["text"]:
    response = agent.invoke(
        {
            "user_input": result["text"]
        }
    )
```

The agent must behave exactly as if the transcript had been typed manually by the user.

---

# Phase 7 — Add an STT Provider Abstraction

## Goal

Prevent the application from depending permanently on one STT implementation.

Define:

```python
class STTProvider:

    def transcribe(self, audio):
        raise NotImplementedError
```

Implementation:

```python
class LocalWhisperProvider(STTProvider):
    ...
```

Future implementations may include:

```text
DeepgramProvider
GoogleSTTProvider
AzureSTTProvider
OpenAITranscriptionProvider
```

Then configuration can control the provider:

```yaml
stt:
  provider: local_whisper
```

This is important because the app can later move from:

```text
Local RTX 4070
```

to:

```text
Cloud STT
```

without modifying the LLM agent.

---

# Phase 8 — Add Command Mode Optimizations

Because the system handles short commands rather than long dictation, optimize specifically for this behavior.

Recommended starting configuration:

```text
language = "tr"
beam_size = 1
condition_on_previous_text = False
max_audio_duration = 15 seconds
```

Since every command is mostly independent, previous transcription context may not be necessary.

Test both:

```python
condition_on_previous_text=False
```

and:

```python
condition_on_previous_text=True
```

before making the final choice.

---

# Phase 9 — Handle Domain-Specific Vocabulary

The app may contain vocabulary that generic STT models frequently misunderstand.

Examples:

```text
GitHub
Docker
CUDA
LangGraph
Python
STM32
MATLAB
Arduino
```

Maintain a domain vocabulary list.

Example:

```python
DOMAIN_TERMS = [
    "GitHub",
    "Docker",
    "CUDA",
    "LangGraph",
    "Python",
    "STM32"
]
```

Potential improvements:

```text
Initial prompt / vocabulary hints
Transcript normalization
Post-processing dictionary
LLM-based typo correction
```

However, do not allow transcript correction to change the user's intended meaning.

---

# Phase 10 — Add Failure Handling

The STT pipeline should fail safely.

Handle:

```text
No microphone
Microphone disconnected
CUDA unavailable
GPU out of memory
Whisper model unavailable
Empty speech
Excessive background noise
Audio longer than 15 seconds
STT worker crash
```

Example behavior:

```text
CUDA unavailable
       ↓
return STT_UNAVAILABLE
       ↓
App displays:
"Speech recognition is currently unavailable."
```

Do not silently forward empty or invalid text to the agent.

---

# Phase 11 — Add Observability

For every transcription measure:

```text
audio_duration
inference_duration
real_time_factor
transcript_length
GPU memory
STT errors
end-to-end latency
```

Suggested event:

```json
{
  "audio_duration_ms": 4210,
  "stt_latency_ms": 420,
  "agent_latency_ms": 730,
  "total_latency_ms": 1150
}
```

The most important production metric is:

```text
time from end of speech
        ↓
agent starts responding
```

---

# Phase 12 — Benchmark the Full Pipeline

Create approximately 100 realistic Turkish commands.

Include:

```text
Quiet environment
Laptop microphone
Headset microphone
Background music
Background conversation
Fast speech
Slow speech
Different distances from microphone
Technical vocabulary
English words inside Turkish sentences
```

Evaluate:

```text
WER
Command success rate
STT latency
Agent execution success
False VAD activation
Missed speech
```

For this application, command success rate may ultimately be more important than raw WER.

Example:

```text
Reference:

"GitHub reposunu aç"

Prediction:

"GitHub reposunu aç"
```

Perfect.

But:

```text
Reference:

"VS Code'u aç"

Prediction:

"Visual Studio Code'u aç"
```

WER may differ even though the application's intent remains correct.

Therefore also measure:

```text
Intent Preservation Rate
```

---

# Phase 13 — Final Runtime Architecture

Recommended production architecture:

```text
┌──────────────────────────────┐
│          Application         │
│                              │
│   ┌─────────────────────┐    │
│   │ Microphone Capture  │    │
│   └──────────┬──────────┘    │
│              │               │
│   ┌──────────▼──────────┐    │
│   │      Silero VAD     │    │
│   └──────────┬──────────┘    │
│              │               │
│   ┌──────────▼──────────┐    │
│   │    Audio Buffer     │    │
│   └──────────┬──────────┘    │
└──────────────┼───────────────┘
               │
               ▼
┌──────────────────────────────┐
│        STT Worker            │
│                              │
│ RTX 4070                     │
│ faster-whisper               │
│ whisper-large-v3-tr          │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│     Transcript Manager       │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│        LLM Agent             │
│                              │
│ Intent                       │
│ Reasoning                    │
│ Tool Selection               │
└──────────────┬───────────────┘
               │
               ▼
             Tools
```

---

# Recommended Implementation Order

1. Run `whisper-large-v3-tr` successfully on the RTX 4070.
2. Benchmark several 10–15 second WAV files.
3. Implement microphone recording.
4. Add VAD.
5. Build the speech buffer.
6. Move Whisper into a persistent STT worker.
7. Create the Transcript Manager.
8. Connect finalized transcripts to the LLM agent.
9. Add STT provider abstraction.
10. Add logging and latency metrics.
11. Build a 100-command Turkish benchmark.
12. Tune VAD and Whisper parameters using real recordings.
13. Add domain-specific normalization.
14. Perform end-to-end reliability testing.

---

# Initial Success Criteria

The first usable version should achieve:

```text
Maximum command duration:      15 seconds

Model:                         whisper-large-v3-tr

Hardware:                      RTX 4070

Model loaded persistently:     Yes

Input language:                Turkish

Speech detection:              Automatic

Final transcript only → LLM:   Yes

Target STT latency:            < 1 second

Target speech-end → agent:
                               approximately 1–2 seconds

Cloud STT dependency:          None
```

The first milestone should therefore be extremely simple:

```text
Press / speak
     ↓
speech detected
     ↓
speak Turkish command
     ↓
speech ends
     ↓
local Whisper inference
     ↓
text appears
     ↓
same text is submitted to agent
```

Only after this pipeline is stable should partial transcription, interruption handling, wake-word detection, or continuous conversational voice mode be introduced.

# Future Improvements

After the basic command pipeline is stable, optional features can be added:

```text
Wake word detection

Push-to-talk mode

Continuous conversation mode

Partial transcription

Agent interruption / barge-in

Noise suppression

Speaker identification

Automatic microphone selection

Cloud STT fallback

Command confidence checking

Text-to-Speech responses
```

The architecture should keep these features optional so that the initial implementation remains small and testable.