# Duet

Great communicators know their stuff. Duet helps you become one by coaching how you say it and how well you know it.

Record your meetings. Hear where you stumbled. Practice speaking and subject matter until you don't with Duet's expert coaching.

## How it works

1. **Meet your coach** — Duet's voice coach introduces itself, learns about you, and captures your voice for speaker recognition. All by voice, no buttons.
2. **Record sessions** — record meetings or calls. Duet transcribes on-device, identifies your voice, and flags disfluencies (fillers, hedging, long pauses) in your speech only.
3. **Practice points** — hear your weak moments played back with coaching advice, then record yourself saying it cleanly. Duet evaluates your attempt.
4. **Talk to Coach** — anytime practice sessions where the coach asks questions, listens for fillers, points them out, and asks you to try again.
5. **Track progress** — dashboard shows filler improvement vs. your baseline from the first session.
6. **Upload documents** — subject area material used as ground truth for expertise coaching.

## Architecture

Tauri v2 desktop app (macOS, Windows planned). Everything runs on-device except coaching text generation (Claude API).

```
Tauri (Rust backend)
  ├── SQLite (local storage, everything on-device)
  ├── Sidecar management (Python process)
  └── Claude API client (coaching, drill evaluation)

Python Sidecar
  ├── WhisperX (on-device transcription, word timestamps, speaker diarization)
  ├── Piper TTS (on-device coach voice)
  ├── pyannote (speaker embedding for voice enrollment + matching)
  ├── Document parsing (PDF, Word, text)
  └── Audio clip extraction (ffmpeg)

React + Vite (frontend)
  └── Design system: Deep Teal, Satoshi/DM Sans/JetBrains Mono
```

All recordings and documents stay on your device. Transcription and speaker recognition run entirely on-device. Only transcript text is sent to Claude for coaching.

## Setup

Prerequisites: Rust, Node.js/Bun, Python 3.11+, ffmpeg

```bash
# Clone
git clone https://github.com/jspkm/duet.git
cd duet

# Frontend deps
bun install

# Python sidecar deps
cd sidecar && pip install -e ".[dev]" && cd ..

# API key (create a .env file)
echo 'ANTHROPIC_API_KEY=your-key' > .env

# HuggingFace token for speaker diarization + voice enrollment
# Create token at https://huggingface.co/settings/tokens then accept terms at:
#   https://huggingface.co/pyannote/speaker-diarization-community-1
#   https://huggingface.co/pyannote/segmentation-3.0
#   https://huggingface.co/pyannote/embedding
echo 'HF_TOKEN=your-hf-token' >> .env

# Run (first launch downloads ~3 GB of speech models)
bun run duet
```

Get your API key at [console.anthropic.com](https://console.anthropic.com). Transcription is fully on-device, no API key needed.

## Design

Design system defined in [DESIGN.md](DESIGN.md). Industrial warmth aesthetic with Deep Teal (#2A7D6E) accent. Audio waveforms as visual motif.

## License

MIT
