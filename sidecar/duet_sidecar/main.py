"""Duet sidecar entry point.

Reads JSON commands from stdin, dispatches to handlers, writes JSON responses to stdout.
Progress events are written as intermediate JSON lines (type: "progress").
"""

import json
import os
import sys
import traceback
import warnings

# Suppress all warnings to prevent non-JSON output on stdout/stderr
# that would break the sidecar JSON protocol.
warnings.filterwarnings("ignore")
os.environ["PYTHONWARNINGS"] = "ignore"
os.environ["TOKENIZERS_PARALLELISM"] = "false"

# Redirect stderr to devnull so library warnings don't corrupt the JSON stream
import io
sys.stderr = io.TextIOWrapper(open(os.devnull, "wb"), write_through=True)

from dotenv import load_dotenv

# Load .env from project root (two levels up from sidecar/)
load_dotenv(os.path.join(os.path.dirname(__file__), "..", "..", ".env"))

from duet_sidecar.transcription import transcribe
from duet_sidecar.nlp_analysis import analyze_delivery
from duet_sidecar.doc_parser import parse_document
from duet_sidecar.coach import generate_coaching, evaluate_drill, coach_conversation_turn, generate_first_impression
from duet_sidecar.clip_extractor import extract_clips
from duet_sidecar.speech_analyzer import analyze_speech, analyze_words, transcribe_fast
from duet_sidecar.tts import speak_text
from duet_sidecar.voice import extract_embedding, match_speaker


HANDLERS = {
    "transcribe": transcribe,              # Whisper (fallback / offline)
    "analyze_delivery": analyze_delivery,  # NLP regex (fallback)
    "analyze_speech": analyze_speech,      # WhisperX (on-device transcription + analysis)
    "analyze_words": analyze_words,        # Build analysis from pre-accumulated words (incremental mode)
    "transcribe_fast": transcribe_fast,    # Fast transcription for conversation turns (whisper base)
    "parse_document": parse_document,
    "generate_coaching": generate_coaching,
    "evaluate_drill": evaluate_drill,
    "extract_clips": extract_clips,
    "coach_conversation_turn": coach_conversation_turn,  # Claude adaptive conversation
    "generate_first_impression": generate_first_impression,  # Coach's First Impression card
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
