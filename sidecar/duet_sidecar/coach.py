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


COACHING_SYSTEM_PROMPT = """You are Duet, a professional speech coach with deep expertise in executive communication, public speaking, and vocal performance. You've coached hundreds of speakers from startup founders to Fortune 500 executives.

Your coaching style:
- Name the specific pattern you hear, explain WHY it undermines their message, and give a concrete physical or mental technique to fix it.
- Reference their exact words. Never give generic advice like "try to reduce fillers." Instead: "You said 'um' three times before your main point about pricing. That signals uncertainty to your audience right when you need authority."
- For each moment, give a PRACTICE DRILL: a specific exercise they can repeat 5-10 times to build muscle memory. Think like a vocal coach or acting teacher. Examples: "Pause for a full 2-count before your next sentence instead of filling with 'um'" or "Say the replacement phrase below three times, each time slower and more deliberately."
- Connect the fix to the outcome: what will the audience feel differently when they nail it.

Never be condescending. The user is a professional who wants to get sharper. Treat them like an athlete reviewing game tape with their coach."""


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

1. **coaching_text**: 4-6 sentences of professional speech coaching. Structure it as:
   - WHAT happened: Name the exact pattern and quote their words. ("You used 'like' as a verbal crutch four times in this sentence...")
   - WHY it matters: How this specific pattern affects the listener's perception. ("This makes your recommendation sound tentative when you actually have strong conviction...")
   - THE FIX: A concrete technique or exercise, not just "try to avoid it." Give them a physical action, mental reframe, or practice drill. ("Before your next key point, take a deliberate breath and let one full beat of silence pass. Silence reads as confidence...")
   - PRACTICE TIP: How to drill this at home. ("Record yourself saying the replacement phrase below 5 times. On each rep, slow down slightly and emphasize the verb...")

2. **suggested_delivery**: Rewrite what they said as a polished version. Write 2-3 natural sentences they should actually practice saying out loud. Keep their meaning and personality intact but remove the disfluency pattern. This should sound like them on their best day, not like a script.

3. **topic**: If this moment relates to a specific subject/topic, name it. Otherwise null.

Also provide:
- **overall_score**: 1-10 delivery score (10 = broadcast-quality, 7 = solid professional, 4 = needs work, 1 = significant coaching needed). Be calibrated and honest.
- **summary**: 3-4 sentence overall assessment. Lead with what's working (specific strength), then the #1 pattern to fix, then a concrete next step.

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


def evaluate_drill(params: dict, progress_callback: Callable) -> dict:
    """Evaluate a user's drill attempt against the original flagged moment.

    Params:
        original_text: What the user originally said (the flagged moment)
        moment_type: Type of disfluency (filler, hedging, etc.)
        suggested_delivery: The coached version they should aim for
        attempt_transcript: What they said in this drill attempt
        attempt_number: Which attempt this is (1, 2, or 3)

    Returns:
        {
            "passed": bool,
            "score": float (1-10),
            "feedback": str (2-3 sentences),
            "remaining_issues": [str] or []
        }
    """
    original_text = params.get("original_text", "")
    moment_type = params.get("moment_type", "")
    suggested_delivery = params.get("suggested_delivery", "")
    attempt_transcript = params.get("attempt_transcript", "")
    attempt_number = params.get("attempt_number", 1)

    if not attempt_transcript.strip():
        return {
            "passed": False,
            "score": 0,
            "feedback": "No speech detected. Make sure your microphone is working and try again.",
            "remaining_issues": [],
        }

    progress_callback({"type": "progress", "stage": "evaluating", "percent": 30})

    client = _get_client()

    user_prompt = f"""You are evaluating a speech drill. The user had a disfluency in their original speech and is practicing saying it cleanly.

ORIGINAL (what they said, with the problem):
"{original_text}"

PROBLEM TYPE: {moment_type}

TARGET (what clean delivery sounds like):
"{suggested_delivery}"

THEIR ATTEMPT (attempt #{attempt_number}):
"{attempt_transcript}"

Evaluate:
1. Did they eliminate the specific disfluency ({moment_type})? Check for fillers (um, uh, like, you know), repetitions, false starts, hedging words, and long pauses.
2. Does it sound natural, not robotic?
3. Did they convey the same meaning?

Be encouraging but honest. If they still have the same disfluency, point it out specifically. If they cleaned it up, celebrate that.

Respond in JSON:
{{
    "passed": true/false,
    "score": N (1-10, where 7+ = passed),
    "feedback": "2-3 sentences. Be specific about what improved and what remains.",
    "remaining_issues": ["list of specific remaining disfluencies, if any"]
}}"""

    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=500,
        system="You are a speech coach evaluating a practice drill. Be warm, specific, and encouraging. Celebrate improvement even if it's not perfect yet.",
        messages=[{"role": "user", "content": user_prompt}],
    )

    progress_callback({"type": "progress", "stage": "evaluating", "percent": 90})

    response_text = response.content[0].text
    json_text = response_text
    if "```json" in json_text:
        json_text = json_text.split("```json")[1].split("```")[0]
    elif "```" in json_text:
        json_text = json_text.split("```")[1].split("```")[0]

    result = json.loads(json_text.strip())

    progress_callback({"type": "progress", "stage": "complete", "percent": 100})

    return {
        "passed": result.get("passed", False),
        "score": result.get("score", 5),
        "feedback": result.get("feedback", ""),
        "remaining_issues": result.get("remaining_issues", []),
    }
