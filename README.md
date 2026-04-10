# Duet

Great communicators know their stuff. Duet helps you become one by coaching how you say it and how well you know it.

Record your meetings. Hear where you stumbled. Practice speaking and subject matter until you don't with Duet's expert coaching.

## How it works

1. **Start a session** before or during a meeting
2. Duet transcribes and detects disfluencies, then generates coaching for each flagged moment
3. **Practice drills** play your weak moments back and let you try again
4. **Upload documents** related to your subject area. Duet uses them as ground truth to coach you toward real expertise, supplemented by related information it finds
5. **Dashboard** tracks your progress over time

## Architecture

Tauri v2 desktop app (macOS, Windows planned).

```
Tauri (Rust backend)
  ├── SQLite (local storage, everything on-device)
  ├── Sidecar management (Python process)
  └── Claude API client (coaching)

Python Sidecar
  ├── WhisperX (on-device transcription + diarization + word timestamps)
  ├── Document parsing (PDF, Word, text)
  └── Audio clip extraction (ffmpeg)

React + Vite (frontend)
  └── Design system: Deep Teal, Satoshi/DM Sans/JetBrains Mono
```

All recordings and documents stay on your device. Transcription runs entirely on-device via Whisper. Only transcript text is sent to Claude for coaching analysis.

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

# Optional: HuggingFace token for speaker diarization
# Accept pyannote terms at https://huggingface.co/pyannote/speaker-diarization-3.1
echo 'HF_TOKEN=your-hf-token' >> .env

# Run (first launch downloads ~3 GB of speech models)
bun run duet
```

Get your API key at [console.anthropic.com](https://console.anthropic.com). Transcription is fully on-device, no API key needed.

## Design

Design system defined in [DESIGN.md](DESIGN.md). Industrial warmth aesthetic with Deep Teal (#2A7D6E) accent. Audio waveforms as visual motif.

## License

MIT
