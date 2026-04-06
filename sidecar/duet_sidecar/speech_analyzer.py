"""Speech analysis via AssemblyAI Universal-3 Pro.

Replaces Whisper + librosa + NLP regex with a single API call.
Returns transcription, disfluencies, speaker diarization, and word timestamps.
"""

import os
from typing import Callable

import assemblyai as aai


def _get_client():
    api_key = (
        os.environ.get("ASSEMBLYAI_API_KEY")
        or os.environ.get("DUET_ASSEMBLYAI_KEY")
    )
    if not api_key:
        raise ValueError(
            "No AssemblyAI API key found. "
            "Set ASSEMBLYAI_API_KEY in your .env file."
        )
    aai.settings.api_key = api_key


def analyze_speech(params: dict, progress_callback: Callable) -> dict:
    """Transcribe and analyze speech in one API call.

    Params:
        audio_path: Path to audio file (local)
        speaker_labels: Whether to detect different speakers (default: true)

    Returns:
        {
            "transcript": {
                "text": str,
                "segments": [{"start": ms, "end": ms, "text": str, "speaker": str}],
                "words": [{"start": ms, "end": ms, "text": str, "speaker": str}]
            },
            "disfluencies": {
                "fillers": [{"start": ms, "end": ms, "text": str}],
                "repetitions": [{"start": ms, "end": ms, "text": str}],
                "restarts": [{"start": ms, "end": ms, "text": str}],
                "all": [{"start": ms, "end": ms, "text": str, "type": str}]
            },
            "speakers": [{"speaker": str, "word_count": int}],
            "flagged_moments": [...],
            "overall_metrics": {...},
            "duration_seconds": float,
            "language": str
        }
    """
    audio_path = params.get("audio_path")
    speaker_labels = params.get("speaker_labels", True)

    if not audio_path:
        raise ValueError("audio_path is required")

    progress_callback({"type": "progress", "stage": "uploading", "percent": 5})

    _get_client()

    # Configure transcription with disfluency detection
    config = aai.TranscriptionConfig(
        speech_model=aai.SpeechModel.nano,  # Start with nano, upgrade to best if needed
        speaker_labels=speaker_labels,
        word_boost=[],  # Can add domain terms later
        disfluencies=True,  # Preserve fillers, repetitions, etc.
        language_code="en",
    )

    progress_callback({"type": "progress", "stage": "transcribing", "percent": 15})

    transcriber = aai.Transcriber()
    transcript = transcriber.transcribe(audio_path, config=config)

    if transcript.status == aai.TranscriptStatus.error:
        raise RuntimeError(f"Transcription failed: {transcript.error}")

    progress_callback({"type": "progress", "stage": "processing", "percent": 70})

    # Extract segments (utterances)
    segments = []
    if transcript.utterances:
        for utt in transcript.utterances:
            segments.append({
                "start": utt.start / 1000.0,  # ms to seconds
                "end": utt.end / 1000.0,
                "text": utt.text,
                "speaker": utt.speaker,
            })

    # Extract words with timestamps
    words = []
    if transcript.words:
        for w in transcript.words:
            words.append({
                "start": w.start / 1000.0,
                "end": w.end / 1000.0,
                "text": w.text,
                "speaker": getattr(w, "speaker", None),
            })

    # Identify disfluencies from the word list
    filler_words = {"um", "uh", "er", "erm", "ah", "hmm", "mhm", "like", "you know", "i mean"}
    fillers = []
    repetitions = []
    restarts = []
    all_disfluencies = []

    for i, w in enumerate(words):
        word_lower = w["text"].lower().strip(".,!?")

        # Fillers
        if word_lower in filler_words:
            entry = {"start": w["start"], "end": w["end"], "text": w["text"]}
            fillers.append(entry)
            all_disfluencies.append({**entry, "type": "filler"})

        # Repetitions (same word repeated)
        if i > 0 and word_lower == words[i-1]["text"].lower().strip(".,!?"):
            entry = {"start": words[i-1]["start"], "end": w["end"], "text": f"{words[i-1]['text']} {w['text']}"}
            repetitions.append(entry)
            all_disfluencies.append({**entry, "type": "repetition"})

        # Restarts (word ending with -)
        if w["text"].endswith("-"):
            entry = {"start": w["start"], "end": w["end"], "text": w["text"]}
            restarts.append(entry)
            all_disfluencies.append({**entry, "type": "restart"})

    # Speaker stats
    speaker_stats = {}
    for w in words:
        spk = w.get("speaker") or "unknown"
        speaker_stats[spk] = speaker_stats.get(spk, 0) + 1
    speakers = [{"speaker": k, "word_count": v} for k, v in speaker_stats.items()]

    progress_callback({"type": "progress", "stage": "building_moments", "percent": 85})

    # Build flagged moments
    flagged_moments = []

    # Cluster nearby disfluencies into moments (within 10s windows)
    if all_disfluencies:
        current_cluster = [all_disfluencies[0]]
        for d in all_disfluencies[1:]:
            if d["start"] - current_cluster[-1]["end"] < 10:
                current_cluster.append(d)
            else:
                _add_cluster_as_moment(current_cluster, segments, flagged_moments)
                current_cluster = [d]
        _add_cluster_as_moment(current_cluster, segments, flagged_moments)

    # Detect long pauses between words (>1.5s)
    for i in range(1, len(words)):
        gap = words[i]["start"] - words[i-1]["end"]
        if gap >= 1.5:
            context_before = words[i-1]["text"]
            context_after = words[i]["text"]
            flagged_moments.append({
                "start": words[i-1]["end"],
                "end": words[i]["start"],
                "type": "long_pause",
                "severity": min(7, 3 + int(gap)),
                "coach_type": "speech",
                "transcript_text": f"...{context_before} [{gap:.1f}s pause] {context_after}...",
                "detail": f"Long pause: {gap:.1f} seconds",
            })

    # Sort by severity, cap at 10
    flagged_moments.sort(key=lambda x: x["severity"], reverse=True)
    flagged_moments = flagged_moments[:10]

    # Overall metrics
    total_words = len(words)
    duration = (transcript.audio_duration or 0) / 1000.0
    wpm = (total_words / duration * 60) if duration > 0 else 0

    progress_callback({"type": "progress", "stage": "complete", "percent": 100})

    return {
        "transcript": {
            "text": transcript.text or "",
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
        "language": transcript.language_code or "en",
    }


def _add_cluster_as_moment(cluster, segments, flagged_moments):
    """Convert a cluster of nearby disfluencies into a flagged moment."""
    if not cluster:
        return

    start = cluster[0]["start"]
    end = cluster[-1]["end"]
    count = len(cluster)
    types = set(d["type"] for d in cluster)

    # Find surrounding transcript text
    transcript_text = ""
    for seg in segments:
        if seg["start"] <= start <= seg["end"] or seg["start"] <= end <= seg["end"]:
            transcript_text = seg["text"]
            break

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
        "detail": f"{count} disfluencies in {end - start:.1f}s: {', '.join(disfluency_texts)}",
    })
