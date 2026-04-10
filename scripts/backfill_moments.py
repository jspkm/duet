"""Re-analyze existing recordings to expand flagged moment timestamps.

Reads speaker_segments from the DB (already populated by backfill_speakers),
runs _build_analysis to get moments with expanded context windows,
updates flagged_moments timestamps, and re-extracts clips.
"""

import json
import os
import sqlite3
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "sidecar"))

from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

from duet_sidecar.speech_analyzer import _build_analysis
from duet_sidecar.clip_extractor import extract_clips

DB_PATH = os.path.expanduser(
    "~/Library/Application Support/com.tauri.dev/duet.db"
)
APP_DATA = os.path.expanduser(
    "~/Library/Application Support/com.tauri.dev"
)


def progress(msg):
    pass  # silent


def main():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    # Get recordings that have flagged moments
    recordings = conn.execute("""
        SELECT DISTINCT fm.recording_id, r.local_audio_path, r.speaker_segments, r.duration_seconds
        FROM flagged_moments fm
        JOIN recordings r ON r.id = fm.recording_id
        WHERE r.speaker_segments IS NOT NULL
    """).fetchall()

    if not recordings:
        print("No recordings with flagged moments to update.")
        return

    print(f"Found {len(recordings)} recordings to update.\n")

    for rec in recordings:
        rec_id = rec["recording_id"]
        audio_path = rec["local_audio_path"]
        duration = rec["duration_seconds"]

        print(f"Recording {rec_id}:")

        # Parse stored segments and words
        try:
            segments = json.loads(rec["speaker_segments"])
        except:
            print("  No valid speaker_segments, skipping.")
            continue

        # Get existing flagged moments to preserve coaching_text
        existing = conn.execute(
            "SELECT id, start_time, end_time, moment_type, coaching_text, transcript_text FROM flagged_moments WHERE recording_id = ? ORDER BY id",
            (rec_id,),
        ).fetchall()

        # We need words to rebuild analysis. Get them from the segments
        # (we don't store words separately, so re-run analyze_speech would be needed)
        # Instead, just update the timestamps on existing moments using segment data

        for moment in existing:
            old_start = moment["start_time"]
            old_end = moment["end_time"]

            # Find the containing segment
            match_seg = None
            for seg in segments:
                if seg["start"] <= old_start <= seg["end"] or seg["start"] <= old_end <= seg["end"]:
                    match_seg = seg
                    break

            if match_seg:
                lead = 3.0
                new_start = max(match_seg["start"], old_start - lead)
                new_end = match_seg["end"]
            else:
                new_start = max(0, old_start - 3.0)
                new_end = old_end

            # Build transcript text from segments within the new range
            new_text = " ".join(
                seg["text"].strip() for seg in segments
                if seg["end"] > new_start and seg["start"] < new_end
            ).strip() or moment["transcript_text"]

            conn.execute(
                "UPDATE flagged_moments SET start_time = ?, end_time = ?, transcript_text = ? WHERE id = ?",
                (new_start, new_end, new_text, moment["id"]),
            )

            print(f"  Moment {moment['id']} ({moment['moment_type']}): {old_start:.1f}-{old_end:.1f}s -> {new_start:.1f}-{new_end:.1f}s")

        conn.commit()

        # Re-extract clips with new timestamps
        if os.path.exists(audio_path):
            updated = conn.execute(
                "SELECT id, start_time, end_time FROM flagged_moments WHERE recording_id = ? ORDER BY id",
                (rec_id,),
            ).fetchall()

            moments_for_clips = []
            for i, m in enumerate(updated):
                moments_for_clips.append({
                    "id": i,
                    "start": m["start_time"],
                    "end": m["end_time"],
                })

            clips_dir = os.path.join(APP_DATA, "clips", f"recording-{rec_id}")
            print(f"  Re-extracting {len(moments_for_clips)} clips...")
            try:
                extract_clips({
                    "audio_path": audio_path,
                    "moments": moments_for_clips,
                    "output_dir": clips_dir,
                }, progress_callback=progress)
                print(f"  Clips updated.")
            except Exception as e:
                print(f"  Clip extraction failed: {e}")
        else:
            print(f"  Audio file not found, skipping clip extraction.")

        print()

    conn.close()
    print("Done.")


if __name__ == "__main__":
    main()
