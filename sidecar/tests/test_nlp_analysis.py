"""Tests for NLP delivery analysis."""

from duet_sidecar.nlp_analysis import analyze_delivery


def _noop_progress(data):
    pass


def _make_segments(texts: list[str], duration_each: float = 5.0) -> list[dict]:
    """Helper to create segment dicts from a list of text strings."""
    segments = []
    for i, text in enumerate(texts):
        segments.append({
            "start": i * duration_each,
            "end": (i + 1) * duration_each,
            "text": text,
        })
    return segments


class TestFillerWords:
    def test_counts_standard_fillers(self):
        segments = _make_segments(["Um, I think, uh, the project is like done"])
        result = analyze_delivery({"segments": segments}, _noop_progress)
        assert result["filler_words"]["count"] >= 3  # um, uh, like

    def test_empty_transcript(self):
        segments = _make_segments([""])
        result = analyze_delivery({"segments": segments}, _noop_progress)
        assert result["filler_words"]["count"] == 0

    def test_clean_speech(self):
        segments = _make_segments([
            "The quarterly results show a 15% increase in revenue."
        ])
        result = analyze_delivery({"segments": segments}, _noop_progress)
        assert result["filler_words"]["count"] == 0

    def test_multiple_fillers_in_one_segment(self):
        segments = _make_segments([
            "So um basically like you know the thing is um"
        ])
        result = analyze_delivery({"segments": segments}, _noop_progress)
        assert result["filler_words"]["count"] >= 4


class TestHedging:
    def test_detects_hedging_phrases(self):
        segments = _make_segments([
            "I think maybe we should sort of consider this"
        ])
        result = analyze_delivery({"segments": segments}, _noop_progress)
        assert result["hedging"]["count"] >= 2

    def test_no_false_positive_on_think_therefore(self):
        segments = _make_segments(["I think therefore I am"])
        result = analyze_delivery({"segments": segments}, _noop_progress)
        # "I think therefore" should NOT match as hedging
        hedging_texts = [m["text"].lower() for m in result["hedging"]["matches"]]
        assert "i think" not in hedging_texts

    def test_confident_speech_no_hedging(self):
        segments = _make_segments([
            "The data clearly shows that our approach works."
        ])
        result = analyze_delivery({"segments": segments}, _noop_progress)
        assert result["hedging"]["count"] == 0


class TestDeflections:
    def test_detects_deflections(self):
        segments = _make_segments([
            "I'll get back to you on that",
            "Let me check and follow up",
        ])
        result = analyze_delivery({"segments": segments}, _noop_progress)
        assert result["deflections"]["count"] >= 2

    def test_genuine_promise_is_deflection(self):
        # "I'll get back to you" is a deflection whether genuine or not
        # The user can dismiss false positives in the UI
        segments = _make_segments(["I'll get back to you with the numbers"])
        result = analyze_delivery({"segments": segments}, _noop_progress)
        assert result["deflections"]["count"] >= 1


class TestPace:
    def test_calculates_wpm(self):
        # 30 words in 30 seconds = 60 WPM
        text = " ".join(["word"] * 30)
        segments = [{"start": 0.0, "end": 30.0, "text": text}]
        result = analyze_delivery({"segments": segments}, _noop_progress)
        assert 55 <= result["pace_wpm"] <= 65

    def test_zero_duration(self):
        segments = [{"start": 0.0, "end": 0.0, "text": "hello"}]
        result = analyze_delivery({"segments": segments}, _noop_progress)
        assert result["pace_wpm"] == 0.0


class TestFlaggedMoments:
    def test_flagged_moments_sorted_by_severity(self):
        segments = _make_segments([
            "Um, I guess maybe we should look into it",  # fillers + hedging
            "I'll get back to you on the details",  # deflection (highest severity)
            "The results are clear and positive",  # clean
        ])
        result = analyze_delivery({"segments": segments}, _noop_progress)
        moments = result["flagged_moments"]
        assert len(moments) >= 2
        # Deflection should be first (severity 8)
        severities = [m["severity"] for m in moments]
        assert severities == sorted(severities, reverse=True)

    def test_clean_speech_no_flagged_moments(self):
        segments = _make_segments([
            "Our revenue grew 15% this quarter.",
            "The team shipped three major features.",
        ])
        result = analyze_delivery({"segments": segments}, _noop_progress)
        assert len(result["flagged_moments"]) == 0

    def test_flagged_moments_have_timestamps(self):
        segments = _make_segments(["Um, I'll get back to you"])
        result = analyze_delivery({"segments": segments}, _noop_progress)
        for moment in result["flagged_moments"]:
            assert "start" in moment
            assert "end" in moment
            assert "type" in moment
            assert "severity" in moment


class TestProgressCallback:
    def test_progress_events_emitted(self):
        events = []
        segments = _make_segments(["Um, hello"])
        analyze_delivery({"segments": segments}, events.append)
        progress_events = [e for e in events if e.get("type") == "progress"]
        assert len(progress_events) >= 2
        assert progress_events[-1]["percent"] == 100
