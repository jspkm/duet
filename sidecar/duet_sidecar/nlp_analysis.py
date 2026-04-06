"""NLP delivery analysis.

First-pass analysis of transcribed speech: filler words, hedging phrases,
deflection patterns, speaking pace. Runs entirely on-device.
"""

import re
from typing import Callable


FILLER_WORDS = {
    "um", "uh", "er", "ah", "like", "you know", "basically",
    "actually", "literally", "so", "right", "okay so", "i mean",
    "sort of", "kind of", "well",
}

HEDGING_PHRASES = [
    r"\bi think\b(?! therefore)",
    r"\bmaybe\b",
    r"\bperhaps\b",
    r"\bsort of\b",
    r"\bkind of\b",
    r"\bi guess\b",
    r"\bprobably\b",
    r"\bi'm not sure\b",
    r"\bit seems like\b",
    r"\bi would say\b",
    r"\bin my opinion\b",
    r"\bif i'm being honest\b",
    r"\bto be honest\b",
]

DEFLECTION_PHRASES = [
    r"\bi'll get back to you\b",
    r"\blet me check\b",
    r"\bi'll follow up\b",
    r"\bi'll look into\b",
    r"\bi need to verify\b",
    r"\blet me find out\b",
    r"\bi don't have that in front of me\b",
    r"\bwe can discuss that offline\b",
    r"\bthat's a good question\b",
    r"\bi'll circle back\b",
]


def _count_pattern_matches(text: str, patterns: list[str]) -> list[dict]:
    """Find all matches for a list of regex patterns with positions."""
    matches = []
    for pattern in patterns:
        for m in re.finditer(pattern, text, re.IGNORECASE):
            matches.append({
                "text": m.group(),
                "start": m.start(),
                "end": m.end(),
            })
    return sorted(matches, key=lambda x: x["start"])


def _count_filler_words(text: str) -> list[dict]:
    """Count filler word occurrences with positions."""
    matches = []
    text_lower = text.lower()
    for filler in FILLER_WORDS:
        pattern = r"\b" + re.escape(filler) + r"\b"
        for m in re.finditer(pattern, text_lower):
            matches.append({
                "text": filler,
                "start": m.start(),
                "end": m.end(),
            })
    return sorted(matches, key=lambda x: x["start"])


def _estimate_words_per_minute(text: str, duration_seconds: float) -> float:
    """Estimate speaking pace in words per minute."""
    if duration_seconds <= 0:
        return 0.0
    word_count = len(text.split())
    return round((word_count / duration_seconds) * 60, 1)


def analyze_delivery(params: dict, progress_callback: Callable) -> dict:
    """Analyze transcript for delivery issues.

    Params:
        segments: List of {start, end, text} from transcription
        user_segments_only: If true, only analyze segments tagged as user's speech

    Returns:
        {
            "filler_words": {"count": int, "matches": [...]},
            "hedging": {"count": int, "matches": [...]},
            "deflections": {"count": int, "matches": [...]},
            "pace_wpm": float,
            "flagged_moments": [
                {
                    "start": float, "end": float,
                    "type": "filler_words"|"hedging"|"deflection",
                    "severity": int (1-10),
                    "text": str,
                    "matches": [...]
                }
            ]
        }
    """
    segments = params.get("segments", [])
    if not segments:
        raise ValueError("segments is required")

    progress_callback({"type": "progress", "stage": "analyzing", "percent": 10})

    full_text = " ".join(seg["text"] for seg in segments)
    total_duration = max(
        (seg["end"] for seg in segments), default=0
    ) - min((seg["start"] for seg in segments), default=0)

    filler_matches = _count_filler_words(full_text)
    hedging_matches = _count_pattern_matches(full_text, HEDGING_PHRASES)
    deflection_matches = _count_pattern_matches(full_text, DEFLECTION_PHRASES)
    pace = _estimate_words_per_minute(full_text, total_duration)

    progress_callback({"type": "progress", "stage": "analyzing", "percent": 50})

    # Build flagged moments by mapping matches back to segments
    flagged_moments = []

    for seg in segments:
        seg_text = seg["text"].lower()
        seg_fillers = []
        seg_hedges = []
        seg_deflects = []

        for filler in FILLER_WORDS:
            if re.search(r"\b" + re.escape(filler) + r"\b", seg_text):
                seg_fillers.append(filler)

        for pattern in HEDGING_PHRASES:
            if re.search(pattern, seg_text, re.IGNORECASE):
                seg_hedges.append(re.search(pattern, seg_text, re.IGNORECASE).group())

        for pattern in DEFLECTION_PHRASES:
            if re.search(pattern, seg_text, re.IGNORECASE):
                seg_deflects.append(re.search(pattern, seg_text, re.IGNORECASE).group())

        issues = []
        if seg_fillers:
            issues.append(("filler_words", seg_fillers, min(6, 2 + len(seg_fillers))))
        if seg_hedges:
            issues.append(("hedging", seg_hedges, min(7, 3 + len(seg_hedges))))
        if seg_deflects:
            issues.append(("deflection", seg_deflects, 8))

        for issue_type, matches, severity in issues:
            flagged_moments.append({
                "start": seg["start"],
                "end": seg["end"],
                "type": issue_type,
                "severity": severity,
                "text": seg["text"],
                "matches": matches,
            })

    # Sort by severity descending
    flagged_moments.sort(key=lambda x: x["severity"], reverse=True)

    progress_callback({"type": "progress", "stage": "complete", "percent": 100})

    return {
        "filler_words": {"count": len(filler_matches), "matches": filler_matches},
        "hedging": {"count": len(hedging_matches), "matches": hedging_matches},
        "deflections": {"count": len(deflection_matches), "matches": deflection_matches},
        "pace_wpm": pace,
        "flagged_moments": flagged_moments,
    }
