"""Audio transcription via faster-whisper.

Transcribes audio files on-device. No audio leaves the machine.
Streams progress events back to the Tauri host via the progress callback.
"""

from pathlib import Path
from typing import Callable

from faster_whisper import WhisperModel


# Model is loaded once and reused across calls
_model: WhisperModel | None = None
_model_size: str = ""


def _get_model(model_size: str = "base") -> WhisperModel:
    global _model, _model_size
    if _model is None or _model_size != model_size:
        _model = WhisperModel(model_size, device="auto", compute_type="auto")
        _model_size = model_size
    return _model


def transcribe(params: dict, progress_callback: Callable) -> dict:
    """Transcribe an audio file and return timestamped segments.

    Params:
        file_path: Path to the audio file
        model_size: Whisper model size (tiny, base, small, medium, large-v3)
        language: Optional language code (auto-detected if omitted)

    Returns:
        {
            "segments": [{"start": float, "end": float, "text": str}],
            "language": str,
            "language_probability": float,
            "duration": float
        }
    """
    file_path = params.get("file_path")
    if not file_path:
        raise ValueError("file_path is required")

    path = Path(file_path)
    if not path.exists():
        raise FileNotFoundError(f"Audio file not found: {file_path}")

    model_size = params.get("model_size", "base")
    language = params.get("language", None)

    progress_callback({"type": "progress", "stage": "loading_model", "percent": 0})

    model = _get_model(model_size)

    progress_callback({"type": "progress", "stage": "transcribing", "percent": 5})

    segments_iter, info = model.transcribe(
        str(path),
        language=language,
        beam_size=5,
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=500),
    )

    segments = []
    duration = info.duration
    for segment in segments_iter:
        segments.append({
            "start": round(segment.start, 2),
            "end": round(segment.end, 2),
            "text": segment.text.strip(),
        })

        if duration > 0:
            percent = min(95, int((segment.end / duration) * 100))
            progress_callback({
                "type": "progress",
                "stage": "transcribing",
                "percent": percent,
            })

    progress_callback({"type": "progress", "stage": "complete", "percent": 100})

    return {
        "segments": segments,
        "language": info.language,
        "language_probability": round(info.language_probability, 3),
        "duration": round(duration, 2),
    }
