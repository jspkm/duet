"""Remove practice points that belong to other speakers.

Uses the stored voiceprint to identify the user, then removes
any flagged moments that fall in other speakers' time ranges.
"""

import json
import os
import sqlite3
import sys

DB_PATH = os.path.expanduser(
    "~/Library/Application Support/com.tauri.dev/duet.db"
)


def main():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    # Get voiceprint
    vp = conn.execute("SELECT embedding_json FROM voice_profiles WHERE id=1").fetchone()
    if not vp or not vp["embedding_json"]:
        print("No voiceprint stored. Run a coach session first.")
        return

    # Get all recordings with speaker segments and flagged moments
    recordings = conn.execute("""
        SELECT DISTINCT fm.recording_id, r.speaker_segments, r.local_audio_path
        FROM flagged_moments fm
        JOIN recordings r ON r.id = fm.recording_id
        WHERE r.speaker_segments IS NOT NULL
    """).fetchall()

    if not recordings:
        print("No recordings with flagged moments and speaker data.")
        return

    # Try voiceprint matching
    stored_emb = json.loads(vp["embedding_json"])
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "sidecar"))

    total_removed = 0

    for rec in recordings:
        segs = json.loads(rec["speaker_segments"])
        speakers = set(s.get("speaker") for s in segs if s.get("speaker"))

        if len(speakers) <= 1:
            print(f"Recording {rec['recording_id']}: single speaker, skipping.")
            continue

        # Determine user's speaker via voiceprint or word count fallback
        my_speaker = None
        if os.path.exists(rec["local_audio_path"]):
            try:
                import warnings
                warnings.filterwarnings("ignore")
                from dotenv import load_dotenv
                load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))
                from duet_sidecar.voice import match_speaker
                result = match_speaker({
                    "audio_path": rec["local_audio_path"],
                    "segments": segs,
                    "stored_embedding": stored_emb,
                }, lambda x: None)
                if result["matched_speaker"] and result["similarity"] > 0.5:
                    my_speaker = result["matched_speaker"]
                    print(f"Recording {rec['recording_id']}: voiceprint matched {my_speaker} (sim={result['similarity']:.3f})")
            except Exception as e:
                print(f"Recording {rec['recording_id']}: voiceprint matching failed: {e}")

        if not my_speaker:
            # Fallback: most words
            counts = {}
            for seg in segs:
                spk = seg.get("speaker")
                if spk:
                    counts[spk] = counts.get(spk, 0) + len(seg["text"].split())
            my_speaker = max(counts, key=counts.get) if counts else None
            print(f"Recording {rec['recording_id']}: fallback to most words: {my_speaker}")

        if not my_speaker:
            continue

        # Check each moment
        moments = conn.execute(
            "SELECT id, start_time, end_time FROM flagged_moments WHERE recording_id=?",
            (rec["recording_id"],),
        ).fetchall()

        to_remove = []
        for m in moments:
            mid = (m["start_time"] + m["end_time"]) / 2
            speaker = None
            for seg in segs:
                if seg["start"] <= mid <= seg["end"]:
                    speaker = seg.get("speaker")
                    break
            if speaker and speaker != my_speaker:
                to_remove.append(m["id"])

        if to_remove:
            conn.execute(
                f"DELETE FROM flagged_moments WHERE id IN ({','.join(str(i) for i in to_remove)})"
            )
            conn.commit()
            total_removed += len(to_remove)
            print(f"  Removed {len(to_remove)} moments from other speakers.")
        else:
            print(f"  All {len(moments)} moments belong to user. No cleanup needed.")

    conn.close()
    print(f"\nDone. Removed {total_removed} total moments from other speakers.")


if __name__ == "__main__":
    main()
