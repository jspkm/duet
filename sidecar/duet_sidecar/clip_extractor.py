"""Audio clip extraction via ffmpeg.

Slices flagged moments from the original recording into individual audio clips
for practice drill playback. Runs on-device.
"""

import os
import subprocess
from pathlib import Path
from typing import Callable


def extract_clips(params: dict, progress_callback: Callable) -> dict:
    """Extract audio clips for flagged moments.

    Params:
        audio_path: Path to the original recording
        moments: List of {start, end, id} — timestamps to extract
        output_dir: Directory to write clips to

    Returns:
        {
            "clips": [
                {"moment_id": int, "clip_path": str, "duration": float}
            ]
        }
    """
    audio_path = params.get("audio_path")
    moments = params.get("moments", [])
    output_dir = params.get("output_dir")

    if not audio_path:
        raise ValueError("audio_path is required")
    if not moments:
        return {"clips": []}
    if not output_dir:
        raise ValueError("output_dir is required")

    path = Path(audio_path)
    if not path.exists():
        raise FileNotFoundError(f"Audio file not found: {audio_path}")

    os.makedirs(output_dir, exist_ok=True)

    progress_callback({"type": "progress", "stage": "extracting_clips", "percent": 5})

    clips = []
    total = len(moments)

    for i, moment in enumerate(moments):
        start = moment["start"]
        end = moment["end"]
        moment_id = moment.get("id", i)

        # Small padding for smooth audio edges (context is already in the moment timestamps)
        padded_start = max(0, start - 0.25)
        padded_end = end + 0.25
        duration = padded_end - padded_start

        clip_filename = f"clip-{moment_id}.wav"
        clip_path = os.path.join(output_dir, clip_filename)

        cmd = [
            "ffmpeg",
            "-y",             # overwrite
            "-i", str(audio_path),
            "-ss", str(padded_start),
            "-t", str(duration),
            "-ar", "16000",   # 16kHz sample rate (good enough for speech)
            "-ac", "1",       # mono
            "-q:a", "0",      # best quality
            clip_path,
        ]

        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=30,
        )

        if result.returncode != 0:
            # Log but don't fail the whole batch
            progress_callback({
                "type": "progress",
                "stage": "clip_error",
                "message": f"Failed to extract clip {moment_id}: {result.stderr[:200]}",
            })
            continue

        clips.append({
            "moment_id": moment_id,
            "clip_path": clip_path,
            "duration": round(duration, 2),
        })

        percent = int(5 + (90 * (i + 1) / total))
        progress_callback({"type": "progress", "stage": "extracting_clips", "percent": percent})

    progress_callback({"type": "progress", "stage": "complete", "percent": 100})

    return {"clips": clips}
