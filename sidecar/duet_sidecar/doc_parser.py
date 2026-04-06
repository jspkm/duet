"""Document parsing and chunking.

Reads local PDF and Word files, extracts text, and chunks by sections.
Files never leave the machine. Only text chunks are sent to Claude API.
"""

from pathlib import Path
from typing import Callable


def _parse_pdf(file_path: str) -> str:
    """Extract text from a PDF file using PyMuPDF."""
    import fitz  # PyMuPDF

    doc = fitz.open(file_path)
    text_parts = []
    for page in doc:
        text = page.get_text()
        if text.strip():
            text_parts.append(text)

    if not text_parts:
        raise ValueError(
            "PDF appears to be scanned/image-only. "
            "OCR is not supported in this version. "
            "Please provide a text-based PDF or Word document."
        )

    return "\n\n".join(text_parts)


def _parse_docx(file_path: str) -> str:
    """Extract text from a Word document."""
    from docx import Document

    doc = Document(file_path)
    return "\n\n".join(p.text for p in doc.paragraphs if p.text.strip())


def _parse_text(file_path: str) -> str:
    """Read a plain text file."""
    return Path(file_path).read_text(encoding="utf-8")


PARSERS = {
    ".pdf": _parse_pdf,
    ".docx": _parse_docx,
    ".doc": _parse_docx,
    ".txt": _parse_text,
    ".md": _parse_text,
}


def _chunk_by_headings(text: str, max_chunk_size: int = 2000) -> list[dict]:
    """Split text into chunks, preferring section headings as boundaries.

    Falls back to sliding window if no headings are detected.
    """
    import re

    # Try to split on common heading patterns
    heading_pattern = re.compile(
        r"^(?:#{1,3}\s+.+|[A-Z][A-Z\s]{3,}$|(?:\d+\.)+\s+.+)",
        re.MULTILINE,
    )
    headings = list(heading_pattern.finditer(text))

    if len(headings) >= 2:
        chunks = []
        for i, match in enumerate(headings):
            start = match.start()
            end = headings[i + 1].start() if i + 1 < len(headings) else len(text)
            chunk_text = text[start:end].strip()
            if chunk_text:
                heading_text = match.group().strip()
                # Split oversized chunks
                if len(chunk_text) > max_chunk_size:
                    for j in range(0, len(chunk_text), max_chunk_size):
                        sub = chunk_text[j : j + max_chunk_size].strip()
                        if sub:
                            chunks.append({"heading": heading_text, "text": sub})
                else:
                    chunks.append({"heading": heading_text, "text": chunk_text})
        return chunks

    # Fallback: sliding window with overlap
    chunks = []
    overlap = 200
    for i in range(0, len(text), max_chunk_size - overlap):
        chunk_text = text[i : i + max_chunk_size].strip()
        if chunk_text:
            chunks.append({"heading": None, "text": chunk_text})
    return chunks


def parse_document(params: dict, progress_callback: Callable) -> dict:
    """Parse a document file and return text chunks.

    Params:
        file_path: Path to the document
        max_chunk_size: Maximum characters per chunk (default: 2000)

    Returns:
        {
            "filename": str,
            "format": str,
            "total_chars": int,
            "chunks": [{"heading": str|null, "text": str}]
        }
    """
    file_path = params.get("file_path")
    if not file_path:
        raise ValueError("file_path is required")

    path = Path(file_path)
    if not path.exists():
        raise FileNotFoundError(f"File not found: {file_path}")

    ext = path.suffix.lower()
    parser = PARSERS.get(ext)
    if parser is None:
        raise ValueError(
            f"Unsupported format: {ext}. "
            f"Supported: {', '.join(PARSERS.keys())}"
        )

    progress_callback({"type": "progress", "stage": "parsing", "percent": 10})

    text = parser(file_path)

    progress_callback({"type": "progress", "stage": "chunking", "percent": 60})

    max_chunk_size = params.get("max_chunk_size", 2000)
    chunks = _chunk_by_headings(text, max_chunk_size)

    progress_callback({"type": "progress", "stage": "complete", "percent": 100})

    return {
        "filename": path.name,
        "format": ext,
        "total_chars": len(text),
        "chunks": chunks,
    }
