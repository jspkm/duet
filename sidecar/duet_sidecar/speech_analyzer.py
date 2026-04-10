"""On-device speech analysis via WhisperX.

Whisper large-v3-turbo for transcription, wav2vec2 for word alignment,
pyannote for speaker diarization. Everything runs locally, no API keys needed.
"""

import gc
import os
import sys
from typing import Callable

import torch
import whisperx
from whisperx.diarize import DiarizationPipeline

# Cache loaded models across calls to avoid reloading on every recording.
_models: dict = {}

# Device and compute config.
# CTranslate2 (faster-whisper backend) doesn't support MPS/Metal.
# CPU int8 is still fast on Apple Silicon (~50x realtime on M-series).
_DEVICE = "cpu"
_COMPUTE_TYPE = "int8"
_WHISPER_MODEL = os.environ.get("DUET_WHISPER_MODEL", "large-v3-turbo")
_BATCH_SIZE = 8  # conservative for CPU


def _get_hf_token():
    return os.environ.get("HF_TOKEN") or os.environ.get("DUET_HF_TOKEN") or True


def _get_whisper_model_fast():
    """Small model for short conversational turns. Near-instant on CPU."""
    if "whisper_fast" not in _models:
        _models["whisper_fast"] = whisperx.load_model(
            "base", _DEVICE, compute_type=_COMPUTE_TYPE,
        )
    return _models["whisper_fast"]


def _get_whisper_model():
    if "whisper" not in _models:
        _models["whisper"] = whisperx.load_model(
            _WHISPER_MODEL, _DEVICE, compute_type=_COMPUTE_TYPE,
        )
    return _models["whisper"]


def _get_align_model(language_code: str):
    key = f"align_{language_code}"
    if key not in _models:
        model_a, metadata = whisperx.load_align_model(
            language_code=language_code, device=_DEVICE,
        )
        _models[key] = (model_a, metadata)
    return _models[key]


def _get_diarize_model():
    if "diarize" not in _models:
        _models["diarize"] = DiarizationPipeline(
            token=_get_hf_token(), device=_DEVICE,
        )
    return _models["diarize"]


def analyze_speech(params: dict, progress_callback: Callable) -> dict:
    """Transcribe and analyze speech on-device.

    Params:
        audio_path: Path to audio file (local)
        speaker_labels: Whether to detect different speakers (default: true)

    Returns same shape as before (transcript, disfluencies, flagged_moments, etc.)
    """
    audio_path = params.get("audio_path")
    speaker_labels = params.get("speaker_labels", True)

    if not audio_path:
        raise ValueError("audio_path is required")

    # 1. Load audio
    progress_callback({"type": "progress", "stage": "loading", "percent": 5})
    audio = whisperx.load_audio(audio_path)

    # 2. Transcribe
    progress_callback({"type": "progress", "stage": "transcribing", "percent": 10})
    model = _get_whisper_model()
    result = model.transcribe(audio, batch_size=_BATCH_SIZE)
    language = result.get("language", "en")

    # 3. Align for word-level timestamps
    progress_callback({"type": "progress", "stage": "aligning", "percent": 40})
    model_a, metadata = _get_align_model(language)
    result = whisperx.align(
        result["segments"], model_a, metadata, audio, _DEVICE,
        return_char_alignments=False,
    )

    # 4. Speaker diarization
    if speaker_labels:
        progress_callback({"type": "progress", "stage": "diarizing", "percent": 60})
        try:
            diarize_model = _get_diarize_model()
            diarize_segments = diarize_model(audio)
            result = whisperx.assign_word_speakers(diarize_segments, result)
        except Exception as e:
            # Diarization is best-effort; don't fail the whole pipeline
            progress_callback({
                "type": "progress", "stage": "diarize_warning",
                "message": f"Speaker diarization failed: {e}",
            })

    progress_callback({"type": "progress", "stage": "processing", "percent": 75})

    # Extract segments
    segments = []
    for seg in result.get("segments", []):
        segments.append({
            "start": seg.get("start", 0),
            "end": seg.get("end", 0),
            "text": seg.get("text", ""),
            "speaker": seg.get("speaker"),
        })

    # Extract words with timestamps and speaker labels
    words = []
    for seg in result.get("segments", []):
        for w in seg.get("words", []):
            words.append({
                "start": w.get("start", 0),
                "end": w.get("end", 0),
                "text": w.get("word", ""),
                "speaker": w.get("speaker") or seg.get("speaker"),
            })

    # Calculate duration from audio length
    duration = len(audio) / 16000.0  # whisperx loads at 16kHz
    text = " ".join(seg["text"] for seg in segments)

    progress_callback({"type": "progress", "stage": "analyzing", "percent": 80})

    analysis = _build_analysis(words, segments, duration, progress_callback)
    analysis["transcript"]["text"] = text
    analysis["language"] = language

    progress_callback({"type": "progress", "stage": "complete", "percent": 100})
    return analysis


def transcribe_fast(params: dict, progress_callback: Callable) -> dict:
    """Fast transcription for short clips (conversation turns).

    Uses whisper base model for near-instant transcription.
    No alignment, no diarization. Just text.

    Params:
        audio_path: Path to audio file

    Returns:
        {"text": str, "duration_seconds": float}
    """
    audio_path = params.get("audio_path")
    if not audio_path:
        raise ValueError("audio_path is required")

    audio = whisperx.load_audio(audio_path)
    model = _get_whisper_model_fast()
    result = model.transcribe(audio, batch_size=_BATCH_SIZE)

    text = " ".join(seg.get("text", "") for seg in result.get("segments", []))
    duration = len(audio) / 16000.0

    progress_callback({"type": "progress", "stage": "complete", "percent": 100})

    return {
        "text": text.strip(),
        "duration_seconds": round(duration, 1),
    }


def analyze_words(params: dict, progress_callback: Callable) -> dict:
    """Build disfluency analysis from pre-accumulated words and segments.

    Used for incremental processing: segments are transcribed during recording,
    then this function runs the analysis on the merged word list at the end.

    Params:
        words: List of {start, end, text, speaker}
        segments: List of {start, end, text, speaker}
        duration_seconds: Total duration of the recording
        full_text: Concatenated transcript text

    Returns: Same shape as analyze_speech.
    """
    words = params.get("words", [])
    segments = params.get("segments", [])
    duration = params.get("duration_seconds", 0)
    full_text = params.get("full_text", "")

    progress_callback({"type": "progress", "stage": "analyzing", "percent": 50})

    result = _build_analysis(words, segments, duration, progress_callback)
    result["transcript"]["text"] = full_text
    result["language"] = "en"

    progress_callback({"type": "progress", "stage": "complete", "percent": 100})
    return result


def _build_analysis(words, segments, duration, progress_callback):
    """Shared logic: disfluency detection, flagged moments, metrics."""
    filler_words = {"um", "uh", "er", "erm", "ah", "hmm", "mhm", "like", "you know", "i mean"}
    fillers = []
    repetitions = []
    restarts = []
    all_disfluencies = []

    for i, w in enumerate(words):
        word_lower = w["text"].lower().strip(".,!?")

        if word_lower in filler_words:
            entry = {"start": w["start"], "end": w["end"], "text": w["text"]}
            fillers.append(entry)
            all_disfluencies.append({**entry, "type": "filler"})

        if i > 0 and word_lower == words[i-1]["text"].lower().strip(".,!?"):
            entry = {"start": words[i-1]["start"], "end": w["end"], "text": f"{words[i-1]['text']} {w['text']}"}
            repetitions.append(entry)
            all_disfluencies.append({**entry, "type": "repetition"})

        if w["text"].endswith("-"):
            entry = {"start": w["start"], "end": w["end"], "text": w["text"]}
            restarts.append(entry)
            all_disfluencies.append({**entry, "type": "restart"})

    speaker_stats = {}
    for w in words:
        spk = w.get("speaker") or "unknown"
        speaker_stats[spk] = speaker_stats.get(spk, 0) + 1
    speakers = [{"speaker": k, "word_count": v} for k, v in speaker_stats.items()]

    progress_callback({"type": "progress", "stage": "building_moments", "percent": 85})

    flagged_moments = []

    if all_disfluencies:
        current_cluster = [all_disfluencies[0]]
        for d in all_disfluencies[1:]:
            if d["start"] - current_cluster[-1]["end"] < 10:
                current_cluster.append(d)
            else:
                _add_cluster_as_moment(current_cluster, segments, flagged_moments)
                current_cluster = [d]
        _add_cluster_as_moment(current_cluster, segments, flagged_moments)

    for i in range(1, len(words)):
        gap = words[i]["start"] - words[i-1]["end"]
        if gap >= 1.5:
            context_before = words[i-1]["text"]
            context_after = words[i]["text"]
            pause_start = words[i-1]["end"]
            pause_end = words[i]["start"]
            # Expand to include lead-in and the sentence after the pause
            exp_start, exp_end = _expand_to_context(pause_start, pause_end, segments)
            pause_transcript = " ".join(
                seg["text"].strip() for seg in segments
                if seg["end"] > exp_start and seg["start"] < exp_end
            ).strip() or f"...{context_before} [{gap:.1f}s pause] {context_after}..."
            flagged_moments.append({
                "start": exp_start,
                "end": exp_end,
                "type": "long_pause",
                "severity": min(7, 3 + int(gap)),
                "coach_type": "speech",
                "transcript_text": pause_transcript,
                "detail": f"Long pause: {gap:.1f} seconds",
            })

    # Drop moments too short to be useful practice (< 4 seconds)
    flagged_moments = [m for m in flagged_moments if m["end"] - m["start"] >= 4.0]

    flagged_moments.sort(key=lambda x: x["severity"], reverse=True)
    flagged_moments = flagged_moments[:10]

    total_words = len(words)
    wpm = (total_words / duration * 60) if duration > 0 else 0

    return {
        "transcript": {
            "text": "",
            "segments": segments,
            "words": words,
        },
        "disfluencies": {
            "fillers": fillers,
            "repetitions": repetitions,
            "restarts": restarts,
            "all": all_disfluencies,
        },
        "speakers": speakers,
        "flagged_moments": flagged_moments,
        "overall_metrics": {
            "filler_count": len(fillers),
            "repetition_count": len(repetitions),
            "restart_count": len(restarts),
            "total_disfluencies": len(all_disfluencies),
            "pause_count": len([m for m in flagged_moments if m["type"] == "long_pause"]),
            "avg_pace_wpm": round(wpm, 1),
            "word_count": total_words,
            "duration_seconds": round(duration, 1),
        },
        "duration_seconds": round(duration, 1),
    }


def _expand_to_context(start, end, segments, lead_seconds=3.0):
    """Expand a time range to include context, staying within the same speaker's turn."""
    context_start = max(0, start - lead_seconds)
    context_end = end

    # Find the segment that contains the moment
    match_seg = None
    for seg in segments:
        if seg["start"] <= start <= seg["end"] or seg["start"] <= end <= seg["end"]:
            match_seg = seg
            break

    if match_seg:
        speaker = match_seg.get("speaker")

        # Expand backward within same speaker, up to lead_seconds before the moment
        context_start = max(match_seg["start"], start - lead_seconds)

        # Expand forward to end of containing segment only.
        # Don't jump to the next segment even if same speaker.
        context_end = match_seg["end"]

    return context_start, context_end


def _add_cluster_as_moment(cluster, segments, flagged_moments):
    """Convert a cluster of nearby disfluencies into a flagged moment."""
    if not cluster:
        return

    raw_start = cluster[0]["start"]
    raw_end = cluster[-1]["end"]
    count = len(cluster)
    types = set(d["type"] for d in cluster)

    # Expand to include lead-in context and full sentence
    start, end = _expand_to_context(raw_start, raw_end, segments)

    # Build transcript text from all segments within the expanded range
    transcript_text = " ".join(
        seg["text"].strip() for seg in segments
        if seg["end"] > start and seg["start"] < end
    ).strip() or ""

    # Severity based on density
    severity = min(9, 2 + count * 2)

    type_str = "+".join(sorted(types)) if len(types) > 1 else list(types)[0]
    disfluency_texts = [d["text"] for d in cluster]

    flagged_moments.append({
        "start": start,
        "end": end,
        "type": type_str,
        "severity": severity,
        "coach_type": "speech",
        "transcript_text": transcript_text,
        "detail": f"{count} disfluencies in {raw_end - raw_start:.1f}s: {', '.join(disfluency_texts)}",
    })
