"""Tests for document parsing and chunking."""

import tempfile
from pathlib import Path

from duet_sidecar.doc_parser import parse_document, _chunk_by_headings


def _noop_progress(data):
    pass


class TestChunking:
    def test_chunks_by_headings(self):
        text = """# Introduction
This is the intro section with some content.

# Methods
This section describes our methods.

# Results
Here are the results.
"""
        chunks = _chunk_by_headings(text)
        assert len(chunks) >= 3
        assert chunks[0]["heading"] is not None

    def test_fallback_to_sliding_window(self):
        text = "No headings here. " * 200  # Long text without headings
        chunks = _chunk_by_headings(text, max_chunk_size=500)
        assert len(chunks) >= 2
        assert chunks[0]["heading"] is None

    def test_respects_max_chunk_size(self):
        text = """# Big Section
""" + "word " * 2000

        chunks = _chunk_by_headings(text, max_chunk_size=500)
        for chunk in chunks:
            assert len(chunk["text"]) <= 500 + 50  # small tolerance

    def test_empty_text(self):
        chunks = _chunk_by_headings("")
        assert chunks == []


class TestParsePlainText:
    def test_parses_txt_file(self):
        with tempfile.NamedTemporaryFile(suffix=".txt", mode="w", delete=False) as f:
            f.write("# Section One\nSome content here.\n\n# Section Two\nMore content.")
            f.flush()
            result = parse_document({"file_path": f.name}, _noop_progress)

        assert result["format"] == ".txt"
        assert result["total_chars"] > 0
        assert len(result["chunks"]) >= 1

    def test_parses_md_file(self):
        with tempfile.NamedTemporaryFile(suffix=".md", mode="w", delete=False) as f:
            f.write("# README\nThis is a markdown file.")
            f.flush()
            result = parse_document({"file_path": f.name}, _noop_progress)

        assert result["format"] == ".md"


class TestErrorHandling:
    def test_missing_file_path(self):
        try:
            parse_document({}, _noop_progress)
            assert False, "Should have raised ValueError"
        except ValueError as e:
            assert "file_path" in str(e)

    def test_nonexistent_file(self):
        try:
            parse_document({"file_path": "/tmp/nonexistent.pdf"}, _noop_progress)
            assert False, "Should have raised FileNotFoundError"
        except FileNotFoundError:
            pass

    def test_unsupported_format(self):
        with tempfile.NamedTemporaryFile(suffix=".xlsx", delete=False) as f:
            f.write(b"fake")
            f.flush()
            try:
                parse_document({"file_path": f.name}, _noop_progress)
                assert False, "Should have raised ValueError"
            except ValueError as e:
                assert "Unsupported format" in str(e)


class TestProgressCallback:
    def test_progress_events_emitted(self):
        events = []
        with tempfile.NamedTemporaryFile(suffix=".txt", mode="w", delete=False) as f:
            f.write("Some content to parse.")
            f.flush()
            parse_document({"file_path": f.name}, events.append)

        progress_events = [e for e in events if e.get("type") == "progress"]
        assert len(progress_events) >= 2
        assert progress_events[-1]["percent"] == 100
