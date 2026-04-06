"""Audio-level speech analysis.

Analyzes the raw audio signal for delivery metrics that transcription misses:
filler sounds, pauses, speaking pace, vocal confidence. Works alongside
Whisper transcript for timestamp anchoring.
"""

import numpy as np
from typing import Callable


def analyze_audio(params: dict, progress_callback: Callable) -> dict:
    """Analyze raw audio for speech delivery metrics.

    Params:
        audio_path: Path to audio file
        transcript_segments: Optional list of {start, end, text} from Whisper
            Used to anchor audio findings to readable text.
        word_timestamps: Optional list of {start, end, word} from Whisper
            For precise word-level alignment.

    Returns:
        {
            "filler_sounds": [{"start": f, "end": f, "type": str, "confidence": f}],
            "pauses": [{"start": f, "end": f, "duration": f, "context": str}],
            "pace": {"overall_wpm": f, "segments": [{"start": f, "end": f, "wpm": f}]},
            "confidence_signals": [{"start": f, "end": f, "type": str, "value": f}],
            "flagged_moments": [
                {
                    "start": f, "end": f,
                    "type": str,
                    "severity": int,
                    "coach_type": "speech",
                    "transcript_text": str,
                    "detail": str
                }
            ],
            "overall_metrics": {
                "filler_count": int,
                "pause_count": int,
                "avg_pace_wpm": f,
                "pace_variance": f,
                "avg_confidence": f
            }
        }
    """
    import librosa

    audio_path = params.get("audio_path")
    transcript_segments = params.get("transcript_segments", [])
    word_timestamps = params.get("word_timestamps", [])

    if not audio_path:
        raise ValueError("audio_path is required")

    progress_callback({"type": "progress", "stage": "loading_audio", "percent": 5})

    # Load audio
    y, sr = librosa.load(audio_path, sr=16000, mono=True)
    duration = len(y) / sr

    progress_callback({"type": "progress", "stage": "analyzing_pauses", "percent": 15})

    # ── Pause detection ──
    # Use energy-based voice activity detection
    frame_length = int(0.025 * sr)  # 25ms frames
    hop_length = int(0.010 * sr)    # 10ms hop
    energy = librosa.feature.rms(y=y, frame_length=frame_length, hop_length=hop_length)[0]

    # Adaptive threshold: mean energy * factor
    energy_threshold = np.mean(energy) * 0.3
    is_speech = energy > energy_threshold

    # Find silent regions (pauses)
    pauses = []
    in_silence = False
    silence_start = 0
    min_pause_duration = 0.5  # Only flag pauses > 500ms

    for i, speech in enumerate(is_speech):
        time = i * hop_length / sr
        if not speech and not in_silence:
            in_silence = True
            silence_start = time
        elif speech and in_silence:
            in_silence = False
            pause_duration = time - silence_start
            if pause_duration >= min_pause_duration:
                context = _find_surrounding_text(
                    silence_start, time, transcript_segments
                )
                pauses.append({
                    "start": round(silence_start, 2),
                    "end": round(time, 2),
                    "duration": round(pause_duration, 2),
                    "context": context,
                })

    progress_callback({"type": "progress", "stage": "analyzing_pace", "percent": 35})

    # ── Speaking pace ──
    # Calculate words per minute per segment
    pace_segments = []
    if transcript_segments:
        for seg in transcript_segments:
            seg_duration = seg["end"] - seg["start"]
            if seg_duration > 0:
                word_count = len(seg["text"].split())
                wpm = (word_count / seg_duration) * 60
                pace_segments.append({
                    "start": round(seg["start"], 2),
                    "end": round(seg["end"], 2),
                    "wpm": round(wpm, 1),
                })

    overall_wpm = 0.0
    pace_variance = 0.0
    if pace_segments:
        wpms = [s["wpm"] for s in pace_segments]
        overall_wpm = round(float(np.mean(wpms)), 1)
        pace_variance = round(float(np.std(wpms)), 1)

    progress_callback({"type": "progress", "stage": "analyzing_pitch", "percent": 55})

    # ── Confidence signals (pitch analysis) ──
    # Pitch drops and monotone regions suggest uncertainty
    f0, voiced_flag, _ = librosa.pyin(
        y, fmin=60, fmax=400, sr=sr,
        frame_length=frame_length * 4, hop_length=hop_length,
    )

    confidence_signals = []
    if f0 is not None:
        # Find regions where pitch drops significantly (uncertainty)
        f0_clean = np.where(np.isnan(f0), 0, f0)
        f0_voiced = f0_clean[f0_clean > 0]

        if len(f0_voiced) > 10:
            pitch_mean = np.mean(f0_voiced)
            pitch_std = np.std(f0_voiced)

            # Scan for pitch drops (>1 std below mean, sustained > 0.5s)
            window_size = int(0.5 * sr / hop_length)
            for i in range(0, len(f0_clean) - window_size, window_size // 2):
                window = f0_clean[i:i + window_size]
                window_voiced = window[window > 0]
                if len(window_voiced) > window_size * 0.3:
                    window_mean = np.mean(window_voiced)
                    time_start = i * hop_length / sr
                    time_end = (i + window_size) * hop_length / sr

                    if window_mean < pitch_mean - pitch_std:
                        confidence_signals.append({
                            "start": round(time_start, 2),
                            "end": round(time_end, 2),
                            "type": "pitch_drop",
                            "value": round(float(window_mean - pitch_mean), 1),
                        })

                    # Also check for very low variance (monotone = rehearsed/uncertain)
                    if len(window_voiced) > 5 and np.std(window_voiced) < pitch_std * 0.3:
                        confidence_signals.append({
                            "start": round(time_start, 2),
                            "end": round(time_end, 2),
                            "type": "monotone",
                            "value": round(float(np.std(window_voiced)), 1),
                        })

    progress_callback({"type": "progress", "stage": "detecting_fillers", "percent": 70})

    # ── Filler sound detection ──
    # Detect "um", "uh" patterns: voiced, low energy, steady pitch, short duration
    filler_sounds = []
    if f0 is not None and len(f0) > 0:
        f0_clean = np.where(np.isnan(f0), 0, f0)
        min_filler_frames = int(0.15 * sr / hop_length)  # min 150ms
        max_filler_frames = int(1.0 * sr / hop_length)   # max 1s

        in_potential_filler = False
        filler_start_frame = 0

        for i in range(len(f0_clean)):
            is_voiced = f0_clean[i] > 0
            is_low_energy = i < len(energy) and energy[i] < np.mean(energy) * 0.8

            if is_voiced and is_low_energy and not in_potential_filler:
                in_potential_filler = True
                filler_start_frame = i
            elif (not is_voiced or not is_low_energy) and in_potential_filler:
                in_potential_filler = False
                filler_length = i - filler_start_frame

                if min_filler_frames <= filler_length <= max_filler_frames:
                    # Check pitch stability (fillers have steady pitch)
                    filler_f0 = f0_clean[filler_start_frame:i]
                    filler_voiced = filler_f0[filler_f0 > 0]
                    if len(filler_voiced) > 3:
                        pitch_cv = np.std(filler_voiced) / np.mean(filler_voiced)
                        if pitch_cv < 0.15:  # Very stable pitch = likely filler
                            t_start = filler_start_frame * hop_length / sr
                            t_end = i * hop_length / sr
                            filler_sounds.append({
                                "start": round(t_start, 2),
                                "end": round(t_end, 2),
                                "type": "filler_sound",
                                "confidence": round(1.0 - pitch_cv, 2),
                            })

    progress_callback({"type": "progress", "stage": "building_moments", "percent": 85})

    # ── Build flagged moments ──
    flagged_moments = []

    # Fillers
    for filler in filler_sounds:
        text = _find_text_at(filler["start"], transcript_segments)
        flagged_moments.append({
            "start": filler["start"],
            "end": filler["end"],
            "type": "filler_sound",
            "severity": min(8, 3 + len([f for f in filler_sounds
                                        if abs(f["start"] - filler["start"]) < 30])),
            "coach_type": "speech",
            "transcript_text": text,
            "detail": f"Filler sound detected (confidence: {filler['confidence']})",
        })

    # Long pauses (>1.5s are awkward)
    for pause in pauses:
        if pause["duration"] >= 1.5:
            flagged_moments.append({
                "start": pause["start"],
                "end": pause["end"],
                "type": "long_pause",
                "severity": min(7, 3 + int(pause["duration"])),
                "coach_type": "speech",
                "transcript_text": pause["context"],
                "detail": f"Long pause: {pause['duration']}s",
            })

    # Pace outliers (too fast or too slow)
    if pace_segments and pace_variance > 0:
        for seg in pace_segments:
            if seg["wpm"] > overall_wpm + pace_variance * 2:
                text = _find_text_at(seg["start"], transcript_segments)
                flagged_moments.append({
                    "start": seg["start"],
                    "end": seg["end"],
                    "type": "rushing",
                    "severity": 4,
                    "coach_type": "speech",
                    "transcript_text": text,
                    "detail": f"Rushing: {seg['wpm']} wpm (your average is {overall_wpm})",
                })

    # Pitch drops
    for sig in confidence_signals:
        if sig["type"] == "pitch_drop":
            text = _find_text_at(sig["start"], transcript_segments)
            flagged_moments.append({
                "start": sig["start"],
                "end": sig["end"],
                "type": "uncertainty",
                "severity": 5,
                "coach_type": "speech",
                "transcript_text": text,
                "detail": "Voice pitch dropped, suggesting uncertainty",
            })

    # Sort by severity
    flagged_moments.sort(key=lambda x: x["severity"], reverse=True)

    # Cap at top 10 most severe
    flagged_moments = flagged_moments[:10]

    avg_confidence = 5.0
    if confidence_signals:
        pitch_drops = [s for s in confidence_signals if s["type"] == "pitch_drop"]
        avg_confidence = max(1.0, 10.0 - len(pitch_drops) * 1.5)

    progress_callback({"type": "progress", "stage": "complete", "percent": 100})

    return {
        "filler_sounds": filler_sounds,
        "pauses": pauses,
        "pace": {
            "overall_wpm": overall_wpm,
            "variance": pace_variance,
            "segments": pace_segments,
        },
        "confidence_signals": confidence_signals,
        "flagged_moments": flagged_moments,
        "overall_metrics": {
            "filler_count": len(filler_sounds),
            "pause_count": len(pauses),
            "avg_pace_wpm": overall_wpm,
            "pace_variance": pace_variance,
            "avg_confidence": round(avg_confidence, 1),
        },
    }


def _find_text_at(time: float, segments: list) -> str:
    """Find the transcript text at a given timestamp."""
    for seg in segments:
        if seg["start"] <= time <= seg["end"]:
            return seg["text"]
    # Find nearest
    if segments:
        nearest = min(segments, key=lambda s: abs(s["start"] - time))
        return nearest["text"]
    return ""


def _find_surrounding_text(start: float, end: float, segments: list) -> str:
    """Find transcript text around a pause."""
    before = ""
    after = ""
    for seg in segments:
        if seg["end"] <= start:
            before = seg["text"]
        elif seg["start"] >= end and not after:
            after = seg["text"]
    if before and after:
        return f"...{before[-40:]} [pause] {after[:40]}..."
    elif before:
        return f"...{before[-60:]} [pause]"
    elif after:
        return f"[pause] {after[:60]}..."
    return "[pause in speech]"
