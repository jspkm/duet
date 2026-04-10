"""Fix practice point transcripts to match clip timestamps.

Re-runs WhisperX to get word-level data, then rebuilds transcript_text
for each flagged moment using only the words within the clip time range.
"""

import json
import os
import sqlite3
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "sidecar"))

from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

from duet_sidecar.speech_analyzer import analyze_speech
from duet_sidecar.clip_extractor import extract_clips

DB_PATH = os.path.expanduser(
    "~/Library/Application Support/com.tauri.dev/duet.db"
)
APP_DATA = os.path.expanduser(
    "~/Library/Application Support/com.tauri.dev"
)


def progress(msg):
    stage = msg.get("stage", "")
    pct = msg.get("percent", "")
    print(f"  [{stage}] {pct}%", flush=True)


def main():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    recordings = conn.execute("""
        SELECT DISTINCT fm.recording_id, r.local_audio_path
        FROM flagged_moments fm
        JOIN recordings r ON r.id = fm.recording_id
    """).fetchall()

    if not recordings:
        print("No recordings with flagged moments.")
        return

    for rec in recordings:
        rec_id = rec["recording_id"]
        audio_path = rec["local_audio_path"]

        if not os.path.exists(audio_path):
            print(f"Recording {rec_id}: file not found, skipping.")
            continue

        print(f"Recording {rec_id}: re-analyzing for word-level data...")

        result = analyze_speech(
            {"audio_path": audio_path, "speaker_labels": True},
            progress_callback=progress,
        )

        words = result["transcript"]["words"]
        print(f"  Got {len(words)} words")

        # Get existing flagged moments
        moments = conn.execute(
            "SELECT id, start_time, end_time, moment_type FROM flagged_moments WHERE recording_id = ? ORDER BY start_time",
            (rec_id,),
        ).fetchall()

        for m in moments:
            # Build transcript from words within the clip range
            clip_words = [
                w["text"] for w in words
                if w["start"] >= m["start_time"] - 0.1 and w["end"] <= m["end_time"] + 0.1
            ]
            new_text = " ".join(clip_words).strip()

            if new_text:
                conn.execute(
                    "UPDATE flagged_moments SET transcript_text = ? WHERE id = ?",
                    (new_text, m["id"]),
                )
                print(f"  Moment {m['id']}: {m['start_time']:.1f}-{m['end_time']:.1f}s -> \"{new_text[:80]}...\"")
            else:
                print(f"  Moment {m['id']}: no words in range {m['start_time']:.1f}-{m['end_time']:.1f}s, keeping existing")

        conn.commit()

        # Re-extract clips
        updated = conn.execute(
            "SELECT id, start_time, end_time FROM flagged_moments WHERE recording_id = ? ORDER BY id",
            (rec_id,),
        ).fetchall()

        clips_dir = os.path.join(APP_DATA, "clips", f"recording-{rec_id}")
        moments_for_clips = [{"id": i, "start": m["start_time"], "end": m["end_time"]} for i, m in enumerate(updated)]

        print(f"  Re-extracting {len(moments_for_clips)} clips...")
        try:
            extract_clips({
                "audio_path": audio_path,
                "moments": moments_for_clips,
                "output_dir": clips_dir,
            }, progress_callback=lambda x: None)
            print(f"  Done.")
        except Exception as e:
            print(f"  Clip extraction failed: {e}")

        print()

    conn.close()
    print("All done.")


if __name__ == "__main__":
    main()
