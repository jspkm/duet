"""Speaker voice enrollment and matching via pyannote embeddings.

Extracts a 512-dim speaker embedding from audio for voice enrollment.
Compares embeddings using cosine similarity for speaker identification.
"""

import os
from typing import Callable

import numpy as np
import torch
import whisperx

_embedding_model = None


def _get_embedding_model():
    global _embedding_model
    if _embedding_model is None:
        from pyannote.audio import Model
        token = os.environ.get("HF_TOKEN") or os.environ.get("DUET_HF_TOKEN") or True
        _embedding_model = Model.from_pretrained(
            "pyannote/embedding", use_auth_token=token
        )
        _embedding_model.eval()
    return _embedding_model


def extract_embedding(params: dict, progress_callback: Callable) -> dict:
    """Extract a speaker embedding from an audio file.

    Uses the first 30 seconds of audio to generate a 512-dim voiceprint.

    Params:
        audio_path: Path to audio file

    Returns:
        {"embedding": list[float], "dimension": int}
    """
    audio_path = params.get("audio_path")
    if not audio_path:
        raise ValueError("audio_path is required")

    progress_callback({"type": "progress", "stage": "loading", "percent": 10})

    # Load audio via whisperx (handles all formats via ffmpeg)
    audio_np = whisperx.load_audio(audio_path)

    progress_callback({"type": "progress", "stage": "extracting", "percent": 40})

    # Convert to torch, take first 30s
    waveform = torch.from_numpy(audio_np).unsqueeze(0)  # [1, samples]
    clip = waveform[:, :16000 * 30]

    model = _get_embedding_model()
    with torch.no_grad():
        embedding = model(clip.unsqueeze(0))  # [1, 1, samples]

    embedding_list = embedding[0].cpu().numpy().tolist()

    progress_callback({"type": "progress", "stage": "complete", "percent": 100})

    return {
        "embedding": embedding_list,
        "dimension": len(embedding_list),
    }


def match_speaker(params: dict, progress_callback: Callable) -> dict:
    """Match diarized speakers against a stored voiceprint.

    Extracts embeddings for each speaker segment and compares against
    the stored voiceprint using cosine similarity.

    Params:
        audio_path: Path to audio file
        segments: List of {start, end, speaker} from diarization
        stored_embedding: The user's stored voiceprint (list of floats)

    Returns:
        {"matched_speaker": str, "similarity": float, "scores": {speaker: similarity}}
    """
    audio_path = params.get("audio_path")
    segments = params.get("segments", [])
    stored_embedding = params.get("stored_embedding", [])

    if not audio_path or not segments or not stored_embedding:
        return {"matched_speaker": None, "similarity": 0, "scores": {}}

    progress_callback({"type": "progress", "stage": "loading", "percent": 10})

    audio_np = whisperx.load_audio(audio_path)
    stored = np.array(stored_embedding, dtype=np.float32)
    stored_norm = stored / (np.linalg.norm(stored) + 1e-8)

    # Group segments by speaker, take up to 30s of audio per speaker
    speakers = {}
    for seg in segments:
        spk = seg.get("speaker")
        if not spk:
            continue
        if spk not in speakers:
            speakers[spk] = []
        speakers[spk].append(seg)

    progress_callback({"type": "progress", "stage": "comparing", "percent": 40})

    model = _get_embedding_model()
    scores = {}

    for spk, spk_segs in speakers.items():
        # Concatenate up to 30s of this speaker's audio
        chunks = []
        total = 0
        for seg in spk_segs:
            start_sample = int(seg["start"] * 16000)
            end_sample = int(seg["end"] * 16000)
            chunk = audio_np[start_sample:end_sample]
            chunks.append(chunk)
            total += len(chunk)
            if total >= 16000 * 30:
                break

        if not chunks:
            continue

        speaker_audio = np.concatenate(chunks)[:16000 * 30]
        waveform = torch.from_numpy(speaker_audio).unsqueeze(0)

        with torch.no_grad():
            emb = model(waveform.unsqueeze(0))

        emb_np = emb[0].cpu().numpy()
        emb_norm = emb_np / (np.linalg.norm(emb_np) + 1e-8)
        similarity = float(np.dot(stored_norm, emb_norm))
        scores[spk] = round(similarity, 4)

    progress_callback({"type": "progress", "stage": "complete", "percent": 100})

    if not scores:
        return {"matched_speaker": None, "similarity": 0, "scores": {}}

    best_speaker = max(scores, key=scores.get)
    return {
        "matched_speaker": best_speaker,
        "similarity": scores[best_speaker],
        "scores": scores,
    }
