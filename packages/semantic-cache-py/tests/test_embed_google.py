"""Request shape for the Google AI (Gemini) embedding provider.

gemini-embedding-2 and gemini-embedding-001 take different request shapes, and
the difference is not cosmetic: gemini-embedding-2 rejects ``taskType``
outright, so sending it fails the call. These tests pin both shapes against a
stub transport rather than the live API.
"""

from __future__ import annotations

from typing import Any

import pytest

from betterdb_semantic_cache.embed.google import create_google_embed


class _StubResponse:
    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, Any]:
        return self._payload


class _StubClient:
    def __init__(self, calls: list[dict[str, Any]]) -> None:
        self._calls = calls

    async def post(self, url: str, *, headers: dict[str, str], json: dict[str, Any]) -> Any:
        self._calls.append({"url": url, "headers": headers, "body": json})
        return _StubResponse({"embedding": {"values": [0.1, 0.2, 0.3]}})

    async def aclose(self) -> None:
        return None


@pytest.fixture
def calls(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    import httpx

    recorded: list[dict[str, Any]] = []
    monkeypatch.setattr(httpx, "AsyncClient", lambda **_: _StubClient(recorded))
    monkeypatch.setenv("GOOGLE_API_KEY", "test-key")
    return recorded


async def test_defaults_to_gemini_embedding_2(calls: list[dict[str, Any]]) -> None:
    embed = create_google_embed()
    await embed("hello")

    assert calls[0]["url"].endswith("/models/gemini-embedding-2:embedContent")
    assert calls[0]["body"]["model"] == "models/gemini-embedding-2"


async def test_defaults_gemini_embedding_2_to_768_dimensions(calls: list[dict[str, Any]]) -> None:
    embed = create_google_embed()
    await embed("hello")

    assert calls[0]["body"]["outputDimensionality"] == 768


async def test_explicit_dimensionality_wins(calls: list[dict[str, Any]]) -> None:
    embed = create_google_embed(output_dimensionality=3072)
    await embed("hello")

    assert calls[0]["body"]["outputDimensionality"] == 3072


async def test_leaves_other_models_at_their_native_width(calls: list[dict[str, Any]]) -> None:
    # Truncating an existing gemini-embedding-001 caller from 3072 to 768 would
    # silently break the index it has already written.
    embed = create_google_embed(model="gemini-embedding-001")
    await embed("hello")

    assert "outputDimensionality" not in calls[0]["body"]


async def test_never_sends_task_type_to_gemini_embedding_2(calls: list[dict[str, Any]]) -> None:
    embed = create_google_embed(task_type="SEMANTIC_SIMILARITY")
    await embed("hello")

    assert "taskType" not in calls[0]["body"]
    assert "title" not in calls[0]["body"]


@pytest.mark.parametrize(
    ("task_type", "expected"),
    [
        ("RETRIEVAL_QUERY", "task: search result | query: hello"),
        ("QUESTION_ANSWERING", "task: question answering | query: hello"),
        ("FACT_VERIFICATION", "task: fact checking | query: hello"),
        ("CODE_RETRIEVAL_QUERY", "task: code retrieval | query: hello"),
        ("CLASSIFICATION", "task: classification | query: hello"),
        ("CLUSTERING", "task: clustering | query: hello"),
        ("SEMANTIC_SIMILARITY", "task: sentence similarity | query: hello"),
    ],
)
async def test_carries_the_task_in_the_text(
    calls: list[dict[str, Any]], task_type: str, expected: str
) -> None:
    embed = create_google_embed(task_type=task_type)
    await embed("hello")

    assert calls[0]["body"]["content"]["parts"][0]["text"] == expected


async def test_documents_use_the_title_text_form(calls: list[dict[str, Any]]) -> None:
    embed = create_google_embed(task_type="RETRIEVAL_DOCUMENT", title="Release notes")
    await embed("hello")

    assert calls[0]["body"]["content"]["parts"][0]["text"] == (
        "title: Release notes | text: hello"
    )


async def test_documents_without_a_title_say_none(calls: list[dict[str, Any]]) -> None:
    embed = create_google_embed(task_type="RETRIEVAL_DOCUMENT")
    await embed("hello")

    assert calls[0]["body"]["content"]["parts"][0]["text"] == "title: none | text: hello"


async def test_unknown_task_passes_the_text_through(calls: list[dict[str, Any]]) -> None:
    embed = create_google_embed(task_type="SOMETHING_NEW")
    await embed("hello")

    assert calls[0]["body"]["content"]["parts"][0]["text"] == "hello"


@pytest.mark.parametrize("task_type", ["keys", "items", "values", "get", "update"])
async def test_dict_method_names_are_not_mistaken_for_instructions(
    calls: list[dict[str, Any]], task_type: str
) -> None:
    # The TypeScript port had to guard this: a plain object lookup resolves
    # Object.prototype members. A Python dict has no such fallback, and this
    # pins that difference rather than assuming it.
    embed = create_google_embed(task_type=task_type)
    await embed("hello")

    assert calls[0]["body"]["content"]["parts"][0]["text"] == "hello"


async def test_gemini_embedding_001_keeps_the_field_based_shape(
    calls: list[dict[str, Any]],
) -> None:
    embed = create_google_embed(
        model="gemini-embedding-001",
        task_type="RETRIEVAL_DOCUMENT",
        title="Release notes",
    )
    await embed("hello")

    body = calls[0]["body"]
    assert body["taskType"] == "RETRIEVAL_DOCUMENT"
    assert body["title"] == "Release notes"
    assert body["content"]["parts"][0]["text"] == "hello"


async def test_requires_an_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    embed = create_google_embed()

    with pytest.raises(ValueError, match="Google API key is required"):
        await embed("hello")
