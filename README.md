# Duet

Your personal speech and expertise coach. Duet records your meetings, analyzes how you speak, and helps you actually get better through practice drills and targeted study.

## What it does

**Speech Coach** (works from day one, zero setup)
- Records your meetings and detects disfluencies: filler words, repetitions, restarts, long pauses
- Plays back the exact moments where your delivery was weak
- Coaches you on how to say it better, then records your re-delivery
- Tracks your improvement over time

**Knowledge Coach** (grows with you)
- Upload internal documents as your knowledge base
- Duet compares what you said against what the documents say
- Identifies knowledge gaps and builds a study plan
- Organize everything into subjects

## How it works

1. **Start a session** before or during a meeting
2. Duet sends audio to AssemblyAI for transcription and disfluency detection
3. Claude analyzes flagged moments and generates coaching
4. **Practice drills** play your weak moments back and let you try again (max 3 attempts per moment)
5. **Dashboard** tracks your progress: filler counts, disfluency trends, speaking pace

## Architecture

Tauri v2 desktop app (macOS, Windows planned).

```
Tauri (Rust backend)
  ├── SQLite (local storage, everything on-device)
  ├── Sidecar management (Python process)
  └── Claude API client (coaching)

Python Sidecar
  ├── AssemblyAI (transcription + disfluency detection)
  ├── Document parsing (PDF, Word, text)
  └── Audio clip extraction (ffmpeg)

React + Vite (frontend)
  └── Design system: Deep Teal, Satoshi/DM Sans/JetBrains Mono
```

All recordings and documents stay on your device. Only transcript text is sent to AI APIs for analysis.

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

# API keys (create a .env file)
echo 'ASSEMBLYAI_API_KEY=your-key' > .env
echo 'ANTHROPIC_API_KEY=your-key' >> .env

# Run
cargo tauri dev
```

Get API keys at [assemblyai.com](https://www.assemblyai.com) and [console.anthropic.com](https://console.anthropic.com).

## Design

Design system defined in [DESIGN.md](DESIGN.md). Industrial warmth aesthetic with Deep Teal (#2A7D6E) accent. Audio waveforms as visual motif.

## License

MIT
