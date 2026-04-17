"""
llm.py — LLM abstraction layer for AI-powered portfolio insights.

Supports two providers, switched via environment variable:
  LLM_PROVIDER=groq    (default) — uses Groq API with open-source LLaMA models
  LLM_PROVIDER=openai            — uses OpenAI-compatible API

Model routing:
  tier="ask"      → fast model  (quick Q&A responses)
  tier="analysis" → full model  (complete portfolio analysis)
"""

import os
import requests

LLM_PROVIDER = os.getenv("LLM_PROVIDER", "groq").lower()


def llm_call(prompt: str, max_tokens: int = 800, temperature: float = 0.65,
             tier: str = "ask") -> str:
    """Single entry point for all LLM calls in the app."""
    return _call_groq(prompt, max_tokens, temperature, tier)


def _call_groq(prompt: str, max_tokens: int, temperature: float, tier: str) -> str:
    api_key = os.getenv("GROQ_API_KEY")
    if not api_key:
        raise Exception("GROQ_API_KEY not set in .env")

    model = "llama-3.3-70b-versatile" if tier == "analysis" else "llama-3.1-8b-instant"

    r = requests.post(
        "https://api.groq.com/openai/v1/chat/completions",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json={
            "model":       model,
            "messages":    [{"role": "user", "content": prompt}],
            "temperature": temperature,
            "max_tokens":  max_tokens,
        },
        timeout=40,
    )
    if r.status_code != 200:
        raise Exception(f"LLM API error {r.status_code}: {r.json()}")
    return r.json()["choices"][0]["message"]["content"].strip()
