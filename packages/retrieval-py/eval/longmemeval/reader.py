from __future__ import annotations

import os
import re

from .openai_http import post_json
from .types import Reader

# Reader model. Defaults to gpt-5.4; override with LONGMEMEVAL_READER_MODEL to
# run a like-for-like comparison config (e.g. gpt-4o) without editing the default.
CHAT_MODEL = os.environ.get("LONGMEMEVAL_READER_MODEL") or "gpt-5.4"
_OPENAI_URL = "https://api.openai.com/v1/chat/completions"

_GPT5_RE = re.compile(r"^gpt-5", re.IGNORECASE)


def _is_gpt5_tier(model: str) -> bool:
    """GPT-5-tier reasoning models reject a non-default ``temperature``; callers
    must omit it for those models and keep deterministic ``temperature: 0``
    elsewhere.
    """
    return _GPT5_RE.search(model) is not None


class _MockReader:
    name = "mock-top-hit"

    async def answer(self, question: str, contexts: list[str]) -> str:
        return contexts[0] if contexts else ""


def create_mock_reader() -> Reader:
    """Mock reader: echo the top retrieved chunk's text as the answer."""
    return _MockReader()


async def chat(api_key: str, model: str, system: str, user: str) -> str:
    body: dict[str, object] = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    }
    # Deterministic grading where the model allows it; GPT-5-tier models reject a
    # non-default temperature, so omit the field and let the API default stand.
    if not _is_gpt5_tier(model):
        body["temperature"] = 0
    json_resp = await post_json(_OPENAI_URL, api_key, body, "chat")
    return json_resp["choices"][0]["message"]["content"].strip()


class _OpenAIReader:
    def __init__(self, api_key: str) -> None:
        self.name = f"openai:{CHAT_MODEL}"
        self._api_key = api_key

    async def answer(self, question: str, contexts: list[str]) -> str:
        system = (
            "You answer questions about a user from the provided conversation excerpts. "
            "Answer concisely. "
            "For factual questions, give the answer stated in the excerpts; if the excerpts do not "
            'contain it, say "I don\'t know". '
            "For questions asking for a recommendation, suggestion, advice, or tips, infer and give "
            "a recommendation grounded in what the excerpts reveal about this user's preferences, "
            "context, and history. Base the recommendation only on preferences and signals actually "
            "present in the excerpts — do not invent preferences or recommend from general knowledge "
            "unsupported by the excerpts. If the excerpts reveal nothing relevant to the request, "
            'say "I don\'t know".'
        )
        joined = "\n\n".join(f"[{i + 1}] {c}" for i, c in enumerate(contexts))
        user = f"Conversation excerpts:\n{joined}\n\nQuestion: {question}\nAnswer:"
        return await chat(self._api_key, CHAT_MODEL, system, user)


def create_openai_reader(api_key: str) -> Reader:
    """Real reader: answer the question from retrieved context."""
    return _OpenAIReader(api_key)
