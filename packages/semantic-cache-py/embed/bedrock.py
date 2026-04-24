"""AWS Bedrock embedding helper for betterdb-semantic-cache.

Supports Titan Text Embeddings v2 and Cohere Embed v3.
Requires the 'bedrock' extra: pip install betterdb-semantic-cache[bedrock]

Usage::

    from embed.bedrock import create_bedrock_embed
    embed = create_bedrock_embed(model_id="amazon.titan-embed-text-v2:0")
    cache = SemanticCache(SemanticCacheOptions(client=client, embed_fn=embed))
"""
from __future__ import annotations

import json
import os
from typing import Any

from betterdb_semantic_cache.types import EmbedFn


def create_bedrock_embed(
    *,
    client: Any = None,
    model_id: str = "amazon.titan-embed-text-v2:0",
    region: str | None = None,
) -> EmbedFn:
    """Create an EmbedFn backed by AWS Bedrock embedding models.

    Args:
        client: Pre-configured BedrockRuntimeClient. If not provided, one is
            created from environment credentials.
        model_id: Bedrock model ID. Default: 'amazon.titan-embed-text-v2:0'.
        region: AWS region. Default: AWS_DEFAULT_REGION env var or 'us-east-1'.
    """
    _client_cache: list[Any] = []

    async def _get_client() -> Any:
        if _client_cache:
            return _client_cache[0]
        if client is not None:
            _client_cache.append(client)
            return client
        try:
            import boto3
        except ImportError:
            raise ImportError(
                'betterdb-semantic-cache embed/bedrock requires the "boto3" package. '
                "Install it: pip install betterdb-semantic-cache[bedrock]"
            )
        aws_region = region or os.environ.get("AWS_DEFAULT_REGION", "us-east-1")
        c = boto3.client("bedrock-runtime", region_name=aws_region)
        _client_cache.append(c)
        return c

    async def embed(text: str) -> list[float]:
        import asyncio

        c = await _get_client()

        is_titan = model_id.startswith("amazon.titan")
        is_cohere = model_id.startswith("cohere.embed")

        if is_titan:
            body = {"inputText": text}
        elif is_cohere:
            body = {"texts": [text], "input_type": "search_document", "truncate": "END"}
        else:
            body = {"inputText": text}

        # boto3 is synchronous — run in thread pool
        def _invoke() -> dict:
            resp = c.invoke_model(
                modelId=model_id,
                body=json.dumps(body),
                contentType="application/json",
                accept="application/json",
            )
            return json.loads(resp["body"].read())

        parsed = await asyncio.get_event_loop().run_in_executor(None, _invoke)

        if is_titan:
            return parsed.get("embedding", [])
        elif is_cohere:
            return (parsed.get("embeddings") or [[]])[0]
        return parsed.get("embedding") or (parsed.get("embeddings") or [[]])[0]

    return embed
