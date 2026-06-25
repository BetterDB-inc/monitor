from __future__ import annotations

import os
import re

from .reader import chat
from .types import Judge

# Judge model. Defaults to gpt-5.5; override with LONGMEMEVAL_JUDGE_MODEL to run
# a like-for-like comparison config (e.g. gpt-4o) without editing the default.
JUDGE_MODEL = os.environ.get("LONGMEMEVAL_JUDGE_MODEL") or "gpt-5.5"

_NON_ALNUM_RE = re.compile(r"[^a-z0-9\s]")
_WS_RE = re.compile(r"\s+")
_CORRECT_RE = re.compile(r"\bcorrect\b")
_INCORRECT_RE = re.compile(r"\bincorrect\b")
_NEGATED_RE = re.compile(r"\b(?:not|partially|isn't)\b[\s\S]{0,20}\bcorrect\b")


def _normalize(text: str) -> str:
    text = text.lower()
    text = _NON_ALNUM_RE.sub(" ", text)
    text = _WS_RE.sub(" ", text)
    return text.strip()


class _MockJudge:
    name = "mock-substring"

    async def grade(self, question: str, gold: str, predicted: str) -> bool:
        g = _normalize(gold)
        p = _normalize(predicted)
        # An empty prediction (e.g. a retrieval miss leaving the reader no
        # context) must never grade correct — ``g in ''`` is always true.
        if len(g) == 0 or len(p) == 0:
            return False
        return p == g or g in p or p in g


def create_mock_judge() -> Judge:
    """Mock judge: normalized substring/exact match against gold. Good enough to
    grade the bundled fixture deterministically without a model.
    """
    return _MockJudge()


class _OpenAIJudge:
    def __init__(self, api_key: str) -> None:
        self.name = f"openai-judge:{JUDGE_MODEL}"
        self._api_key = api_key

    async def grade(self, question: str, gold: str, predicted: str) -> bool:
        system = (
            "You are an impartial grader for a long-term memory QA benchmark. "
            "Given a question, the gold answer, and a model answer, decide whether the "
            "model answer is correct (conveys the same key information as the gold answer). "
            'Reply with exactly one word: "correct" or "incorrect".'
        )
        user = f"Question: {question}\nGold answer: {gold}\nModel answer: {predicted}\n\nVerdict:"
        verdict = await chat(self._api_key, JUDGE_MODEL, system, user)
        v = verdict.lower()
        # ``\bcorrect\b`` does not match inside "incorrect" (no word boundary), so
        # detect the verdict by whole word and reject negated/partial forms like
        # "incorrect", "not correct", or "partially correct".
        says_correct = _CORRECT_RE.search(v) is not None
        negated = _INCORRECT_RE.search(v) is not None or _NEGATED_RE.search(v) is not None
        return says_correct and not negated


def create_openai_judge(api_key: str) -> Judge:
    """Real judge: GPT grader returning correct/incorrect, LongMemEval-style."""
    return _OpenAIJudge(api_key)
