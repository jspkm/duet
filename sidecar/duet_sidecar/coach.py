"""Claude API integration for coaching analysis.

Sends transcript segments + NLP metrics to Claude for:
- Confidence scoring per topic
- Coaching text for flagged moments (how to say it better)
- Knowledge gap detection (when internal docs are available)

Only transcript text and doc chunks are sent. Never raw audio.
"""

import json
import os
from typing import Callable

try:
    import anthropic
except ImportError:
    anthropic = None


def _get_client():
    if anthropic is None:
        raise RuntimeError(
            "anthropic package not installed. Run: pip install anthropic"
        )
    api_key = os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("DUET_API_KEY")
    if not api_key:
        raise ValueError(
            "No API key found. Set ANTHROPIC_API_KEY or DUET_API_KEY environment variable."
        )
    return anthropic.Anthropic(api_key=api_key)


COACHING_SYSTEM_PROMPT = """You are Duet, a personal speech and expertise coach. You analyze meeting transcripts to help people speak more confidently and knowledgeably.

Your tone: direct, encouraging, specific. Like a trusted coach who has heard thousands of speakers. You give concrete advice, not generic tips. Reference the exact words the user said.

Never be condescending. The user is a professional who wants to improve. Treat them like a colleague who asked for honest feedback."""


def generate_coaching(params: dict, progress_callback: Callable) -> dict:
    """Generate coaching feedback for flagged moments.

    Params:
        flagged_moments: List of {start, end, type, severity, text, matches}
        full_transcript: The complete transcript text for context
        doc_chunks: Optional list of {heading, text} from internal docs

    Returns:
        {
            "coached_moments": [
                {
                    "start": float,
                    "end": float,
                    "coaching_text": str,
                    "suggested_delivery": str,
                    "topic": str | null
                }
            ],
            "overall_score": float,
            "summary": str
        }
    """
    flagged_moments = params.get("flagged_moments", [])
    full_transcript = params.get("full_transcript", "")
    doc_chunks = params.get("doc_chunks", [])

    if not flagged_moments:
        return {
            "coached_moments": [],
            "overall_score": 10.0,
            "summary": "Clean delivery. No moments flagged.",
        }

    progress_callback({"type": "progress", "stage": "coaching", "percent": 10})

    client = _get_client()

    # Build the prompt
    moments_text = ""
    for i, m in enumerate(flagged_moments[:10]):  # Cap at 10 to manage context
        moments_text += f"\n--- Moment {i+1} ({m['type']}, severity {m['severity']}/10) ---\n"
        moments_text += f"What they said: \"{m['text']}\"\n"
        if m.get("matches"):
            moments_text += f"Flagged patterns: {', '.join(m['matches'])}\n"

    doc_context = ""
    if doc_chunks:
        doc_context = "\n\n--- INTERNAL DOCUMENTATION (use this as ground truth for subject matter) ---\n"
        for chunk in doc_chunks[:5]:  # Cap at 5 chunks
            heading = chunk.get("heading", "")
            if heading:
                doc_context += f"\n## {heading}\n"
            doc_context += chunk["text"] + "\n"

    user_prompt = f"""Here is a meeting transcript to analyze:

--- FULL TRANSCRIPT ---
{full_transcript[:8000]}

--- FLAGGED MOMENTS ---
{moments_text}
{doc_context}

For each flagged moment, provide:
1. **coaching_text**: 2-3 sentences explaining what went wrong and how to fix it. Be specific to what they actually said. Reference their exact words.
2. **suggested_delivery**: How they should have said it instead. Write the actual words they should practice saying. Keep it natural, not scripted.
3. **topic**: If this moment relates to a specific subject/topic, name it. Otherwise null.

Also provide:
- **overall_score**: 1-10 delivery score for the entire transcript (10 = flawless, 1 = needs significant work). Be honest but not harsh.
- **summary**: 2-3 sentence overall assessment. What's working, what needs the most attention.

Respond in JSON format:
{{
    "coached_moments": [
        {{
            "index": 0,
            "coaching_text": "...",
            "suggested_delivery": "...",
            "topic": "..." or null
        }}
    ],
    "overall_score": N,
    "summary": "..."
}}"""

    progress_callback({"type": "progress", "stage": "coaching", "percent": 30})

    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=2000,
        system=COACHING_SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_prompt}],
    )

    progress_callback({"type": "progress", "stage": "coaching", "percent": 80})

    # Parse the response
    response_text = response.content[0].text

    # Extract JSON from response (handle markdown code blocks)
    json_text = response_text
    if "```json" in json_text:
        json_text = json_text.split("```json")[1].split("```")[0]
    elif "```" in json_text:
        json_text = json_text.split("```")[1].split("```")[0]

    result = json.loads(json_text.strip())

    # Merge coaching text back with timestamps from flagged moments
    coached = []
    for item in result.get("coached_moments", []):
        idx = item.get("index", 0)
        if idx < len(flagged_moments):
            moment = flagged_moments[idx]
            coached.append({
                "start": moment["start"],
                "end": moment["end"],
                "coaching_text": item.get("coaching_text", ""),
                "suggested_delivery": item.get("suggested_delivery", ""),
                "topic": item.get("topic"),
            })

    progress_callback({"type": "progress", "stage": "complete", "percent": 100})

    return {
        "coached_moments": coached,
        "overall_score": result.get("overall_score", 5.0),
        "summary": result.get("summary", ""),
    }
