from __future__ import annotations

from typing import Literal, NotRequired, TypedDict

VectorMetric = Literal["cosine", "l2", "ip"]
VectorAlgorithm = Literal["hnsw", "flat"]


class FieldSpec(TypedDict, total=False):
    """Schema field specification.

    ``type`` is required. ``separator`` applies to tag fields; ``sortable``
    applies to numeric fields. Mirrors the TypeScript discriminated union, kept
    as a single ``TypedDict`` here so the camelCase-free Python surface stays
    flat.
    """

    type: Literal["text", "tag", "numeric"]
    separator: NotRequired[str]
    sortable: NotRequired[bool]


class VectorSpec(TypedDict, total=False):
    """Vector field specification.

    ``metric`` and ``algorithm`` are required. ``dims`` may be omitted and
    inferred from an ``embed_fn`` probe. ``m`` / ``efConstruction`` /
    ``efRuntime`` apply to the HNSW algorithm only.
    """

    metric: VectorMetric
    algorithm: VectorAlgorithm
    dims: NotRequired[int]
    fieldName: NotRequired[str]
    m: NotRequired[int]
    efConstruction: NotRequired[int]
    efRuntime: NotRequired[int]


class RetrievalSchema(TypedDict):
    fields: dict[str, FieldSpec]
    vector: VectorSpec


class FtCapabilities(TypedDict, total=False):
    textFields: NotRequired[bool]
