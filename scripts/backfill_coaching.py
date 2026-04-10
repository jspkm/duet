"""Backfill coaching_text for existing flagged moments.

Reads flagged moments with NULL coaching_text from the DB, groups by recording,
calls the coaching API (same prompt as the app), and updates the DB.
"""

import os
import sys
import sqlite3

# Add sidecar to path so we can import the coaching module
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "sidecar"))

from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

from duet_sidecar.coach import generate_coaching

DB_PATH = os.path.expanduser(
    "~/Library/Application Support/com.tauri.dev/duet.db"
)


def progress(msg):
    print(f"  {msg.get('stage', '')} {msg.get('percent', '')}%")


def main():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    # Get recordings that have moments with NULL coaching_text
    recordings = conn.execute("""
        SELECT DISTINCT fm.recording_id, r.transcript_text
        FROM flagged_moments fm
        JOIN recordings r ON r.id = fm.recording_id
        WHERE fm.coaching_text IS NULL
    """).fetchall()

    if not recordings:
        print("No moments need backfill.")
        return

    print(f"Found {len(recordings)} recordings to backfill.\n")

    for rec in recordings:
        recording_id = rec["recording_id"]
        transcript = rec["transcript_text"] or ""

        moments = conn.execute("""
            SELECT id, start_time, end_time, moment_type, severity, coach_type, transcript_text
            FROM flagged_moments
            WHERE recording_id = ? AND coaching_text IS NULL
            ORDER BY severity DESC
        """, (recording_id,)).fetchall()

        print(f"Recording {recording_id}: {len(moments)} moments, transcript length {len(transcript)}")

        if not moments:
            continue

        # Build flagged_moments list matching the format generate_coaching expects
        flagged = []
        for m in moments:
            flagged.append({
                "start": m["start_time"],
                "end": m["end_time"],
                "type": m["moment_type"],
                "severity": m["severity"],
                "coach_type": m["coach_type"],
                "text": m["transcript_text"],
            })

        try:
            result = generate_coaching(
                {
                    "flagged_moments": flagged,
                    "full_transcript": transcript,
                    "doc_chunks": [],
                },
                progress_callback=progress,
            )
        except Exception as e:
            print(f"  Coaching failed: {e}")
            continue

        # Match coached moments back to DB rows and update
        updated = 0
        for coached in result.get("coached_moments", []):
            # Find the matching flagged moment by timestamp
            for m in moments:
                if abs(m["start_time"] - coached["start"]) < 0.5:
                    coaching_text = coached["coaching_text"]
                    suggested = coached.get("suggested_delivery", "")
                    if suggested:
                        coaching_text += f'\n\nTry saying: "{suggested}"'

                    conn.execute(
                        "UPDATE flagged_moments SET coaching_text = ? WHERE id = ?",
                        (coaching_text, m["id"]),
                    )
                    updated += 1
                    break

        conn.commit()
        print(f"  Updated {updated}/{len(moments)} moments.")
        print(f"  Score: {result.get('overall_score', '?')}/10")
        print(f"  Summary: {result.get('summary', '')}\n")

    conn.close()
    print("Done.")


if __name__ == "__main__":
    main()
