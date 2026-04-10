"""Duet sidecar entry point.

Reads JSON commands from stdin, dispatches to handlers, writes JSON responses to stdout.
Progress events are written as intermediate JSON lines (type: "progress").
"""

import json
import os
import sys
import traceback

from dotenv import load_dotenv

# Load .env from project root (two levels up from sidecar/)
load_dotenv(os.path.join(os.path.dirname(__file__), "..", "..", ".env"))

from duet_sidecar.transcription import transcribe
from duet_sidecar.nlp_analysis import analyze_delivery
from duet_sidecar.doc_parser import parse_document
from duet_sidecar.coach import generate_coaching, evaluate_drill
from duet_sidecar.clip_extractor import extract_clips
from duet_sidecar.speech_analyzer import analyze_speech, analyze_words
from duet_sidecar.tts import speak_text
from duet_sidecar.voice import extract_embedding, match_speaker


HANDLERS = {
    "transcribe": transcribe,              # Whisper (fallback / offline)
    "analyze_delivery": analyze_delivery,  # NLP regex (fallback)
    "analyze_speech": analyze_speech,      # WhisperX (on-device transcription + analysis)
    "analyze_words": analyze_words,        # Build analysis from pre-accumulated words (incremental mode)
    "parse_document": parse_document,
    "generate_coaching": generate_coaching,
    "evaluate_drill": evaluate_drill,
    "extract_clips": extract_clips,
    "speak_text": speak_text,              # Piper TTS (on-device text-to-speech)
    "extract_embedding": extract_embedding, # pyannote speaker embedding for voice enrollment
    "match_speaker": match_speaker,        # Cosine-compare voiceprint against diarized speakers
}


def send(data: dict) -> None:
    """Write a JSON line to stdout and flush."""
    print(json.dumps(data), flush=True)


def main() -> None:
    """Main loop: read JSON commands from stdin, dispatch, respond."""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
        except json.JSONDecodeError as e:
            send({"type": "error", "message": f"Invalid JSON: {e}"})
            continue

        command = request.get("command")
        handler = HANDLERS.get(command)

        if handler is None:
            send({"type": "error", "message": f"Unknown command: {command}"})
            continue

        try:
            result = handler(request.get("params", {}), progress_callback=send)
            send({"type": "result", "command": command, "data": result})
        except Exception as e:
            send({
                "type": "error",
                "command": command,
                "message": str(e),
                "traceback": traceback.format_exc(),
            })


if __name__ == "__main__":
    main()
