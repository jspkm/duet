"""On-device text-to-speech via Piper.

Generates WAV audio from text using a local neural TTS model.
No network required. Coach voice for Duet.
"""

import os
import wave
from typing import Callable

from piper.voice import PiperVoice

_voice = None
_VOICES_DIR = os.path.expanduser("~/.local/share/piper-voices")
_MODEL_NAME = os.environ.get("DUET_TTS_VOICE", "en_US-lessac-high")


def _get_voice():
    global _voice
    if _voice is None:
        model_path = os.path.join(_VOICES_DIR, f"{_MODEL_NAME}.onnx")
        if not os.path.exists(model_path):
            raise FileNotFoundError(
                f"Piper voice model not found at {model_path}. "
                f"Download it from https://huggingface.co/rhasspy/piper-voices"
            )
        _voice = PiperVoice.load(model_path)
    return _voice


def speak_text(params: dict, progress_callback: Callable) -> dict:
    """Generate a WAV file from text using Piper TTS.

    Params:
        text: The text to speak
        output_path: Where to write the WAV file

    Returns:
        {"audio_path": str, "duration_seconds": float}
    """
    text = params.get("text", "")
    output_path = params.get("output_path")

    if not text:
        raise ValueError("text is required")
    if not output_path:
        raise ValueError("output_path is required")

    progress_callback({"type": "progress", "stage": "synthesizing", "percent": 30})

    voice = _get_voice()

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with wave.open(output_path, "wb") as wav:
        voice.synthesize_wav(text, wav)

    size = os.path.getsize(output_path)
    duration = size / (voice.config.sample_rate * 2)  # 16-bit mono

    progress_callback({"type": "progress", "stage": "complete", "percent": 100})

    return {
        "audio_path": output_path,
        "duration_seconds": round(duration, 2),
    }
