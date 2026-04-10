"""Pre-warm models so first use isn't slow.

Downloads and loads WhisperX (base + large-v3-turbo), wav2vec2 alignment,
pyannote diarization, and Piper TTS voice models. Reports progress.
"""

import os
from typing import Callable


def warmup_models(params: dict, progress_callback: Callable) -> dict:
    """Pre-download and cache all required models.

    Returns {"ready": true, "models": [...loaded model names...]}
    """
    loaded = []

    # 1. Whisper base (fast, for conversation turns)
    progress_callback({"type": "progress", "stage": "Downloading speech model (fast)...", "percent": 10})
    try:
        from duet_sidecar.speech_analyzer import _get_whisper_model_fast
        _get_whisper_model_fast()
        loaded.append("whisper-base")
    except Exception as e:
        progress_callback({"type": "progress", "stage": f"whisper-base failed: {e}", "percent": 15})

    # 2. Whisper large-v3-turbo (full analysis)
    progress_callback({"type": "progress", "stage": "Downloading speech model (full)...", "percent": 25})
    try:
        from duet_sidecar.speech_analyzer import _get_whisper_model
        _get_whisper_model()
        loaded.append("whisper-large-v3-turbo")
    except Exception as e:
        progress_callback({"type": "progress", "stage": f"whisper-turbo failed: {e}", "percent": 35})

    # 3. Alignment model
    progress_callback({"type": "progress", "stage": "Downloading alignment model...", "percent": 50})
    try:
        from duet_sidecar.speech_analyzer import _get_align_model
        _get_align_model("en")
        loaded.append("wav2vec2-alignment")
    except Exception as e:
        progress_callback({"type": "progress", "stage": f"alignment failed: {e}", "percent": 55})

    # 4. Diarization (needs HF token)
    progress_callback({"type": "progress", "stage": "Downloading speaker detection model...", "percent": 65})
    try:
        from duet_sidecar.speech_analyzer import _get_diarize_model
        _get_diarize_model()
        loaded.append("pyannote-diarization")
    except Exception as e:
        progress_callback({"type": "progress", "stage": f"diarization skipped: {e}", "percent": 70})

    # 5. Speaker embedding (for voice enrollment)
    progress_callback({"type": "progress", "stage": "Downloading voice recognition model...", "percent": 75})
    try:
        from duet_sidecar.voice import _get_embedding_model
        _get_embedding_model()
        loaded.append("pyannote-embedding")
    except Exception as e:
        progress_callback({"type": "progress", "stage": f"embedding skipped: {e}", "percent": 80})

    # 6. Piper TTS
    progress_callback({"type": "progress", "stage": "Checking coach voice model...", "percent": 90})
    try:
        from duet_sidecar.tts import _get_voice
        _get_voice()
        loaded.append("piper-tts")
    except Exception as e:
        progress_callback({"type": "progress", "stage": f"tts skipped: {e}", "percent": 95})

    progress_callback({"type": "progress", "stage": "Ready!", "percent": 100})

    return {
        "ready": True,
        "models": loaded,
    }
