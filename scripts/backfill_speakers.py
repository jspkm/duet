"""Re-process existing recordings through WhisperX for speaker diarization.

Updates transcript_text, speaker_segments, and duration_seconds with
on-device WhisperX results (Whisper large-v3-turbo + pyannote diarization).
"""

import json
import os
import sqlite3
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "sidecar"))

from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

from duet_sidecar.speech_analyzer import analyze_speech

DB_PATH = os.path.expanduser(
    "~/Library/Application Support/com.tauri.dev/duet.db"
)


def progress(msg):
    stage = msg.get("stage", "")
    pct = msg.get("percent", "")
    extra = msg.get("message", "")
    print(f"  [{stage}] {pct}% {extra}")


def main():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    recordings = conn.execute("""
        SELECT id, local_audio_path, transcript_text
        FROM recordings
        WHERE transcript_text IS NOT NULL AND length(transcript_text) > 50
        ORDER BY id
    """).fetchall()

    if not recordings:
        print("No recordings to reprocess.")
        return

    print(f"Found {len(recordings)} recordings to reprocess.\n")

    for rec in recordings:
        rec_id = rec["id"]
        audio_path = rec["local_audio_path"]

        if not os.path.exists(audio_path):
            print(f"Recording {rec_id}: file not found at {audio_path}, skipping.")
            continue

        print(f"Recording {rec_id}: {audio_path}")

        try:
            result = analyze_speech(
                {"audio_path": audio_path, "speaker_labels": True},
                progress_callback=progress,
            )
        except Exception as e:
            print(f"  FAILED: {e}\n")
            continue

        # Build speaker-labeled transcript text
        segments = result["transcript"]["segments"]
        speakers = result.get("speakers", [])
        duration = result["duration_seconds"]

        speaker_names = set(s.get("speaker") for s in segments if s.get("speaker"))

        if len(speaker_names) > 1:
            # Multi-speaker: build conversation-style transcript
            lines = []
            for seg in segments:
                spk = seg.get("speaker") or "?"
                lines.append(f"[{spk}] {seg['text']}")
            full_text = "\n".join(lines)
        else:
            full_text = result["transcript"]["text"]

        segments_json = json.dumps(segments)

        conn.execute(
            "UPDATE recordings SET transcript_text = ?, speaker_segments = ?, duration_seconds = ? WHERE id = ?",
            (full_text, segments_json, duration, rec_id),
        )
        conn.commit()

        print(f"  Speakers: {[s['speaker'] for s in speakers]}")
        print(f"  Duration: {duration}s")
        print(f"  Segments: {len(segments)}")
        print(f"  Updated.\n")

    conn.close()
    print("Done.")


if __name__ == "__main__":
    main()
