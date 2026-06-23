from __future__ import annotations

from .fields import RESERVED_FIELD_NAMES
from .schema import FieldSpec, FtCapabilities, RetrievalSchema, VectorSpec

_HNSW_DEFAULTS = {"m": 16, "efConstruction": 200, "efRuntime": 10}

_METRIC_MAP = {"cosine": "COSINE", "l2": "L2", "ip": "IP"}


def _is_positive_int(value: object) -> bool:
    """Mirror ``Number.isInteger(x) && x > 0`` (accepts integral floats)."""
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return value > 0
    if isinstance(value, float):
        return value.is_integer() and value > 0
    return False


def _require_dims(dims: object) -> int:
    if dims is None or not _is_positive_int(dims):
        raise ValueError(f"dims must be a positive integer to build FT.CREATE args, got: {dims}")
    return int(dims)  # type: ignore[arg-type]


def _validate_field_names(fields: dict[str, FieldSpec], vector_field_name: str) -> None:
    for name in fields:
        if len(name) == 0:
            raise ValueError("Invalid field name: empty field name is not allowed")
        if name == vector_field_name:
            raise ValueError(
                f"Field name '{name}' collides with the vector field name '{vector_field_name}'"
            )
        if name in RESERVED_FIELD_NAMES:
            raise ValueError(f"Field name '{name}' is reserved and cannot be used in the schema")


def _validate_text_field_capabilities(
    fields: dict[str, FieldSpec], capabilities: FtCapabilities | None
) -> None:
    if not (capabilities is not None and capabilities.get("textFields") is False):
        return
    text_field_names = [name for name, spec in fields.items() if spec.get("type") == "text"]
    if text_field_names:
        raise ValueError(f"Text fields require valkey-search >= 1.2: {', '.join(text_field_names)}")


def _validate_flat_hnsw_params(vector: VectorSpec) -> None:
    if vector.get("algorithm") != "flat":
        return
    if vector.get("m") is not None:
        raise ValueError("FLAT algorithm does not support 'm' parameter")
    if vector.get("efConstruction") is not None:
        raise ValueError("FLAT algorithm does not support 'efConstruction' parameter")
    if vector.get("efRuntime") is not None:
        raise ValueError("FLAT algorithm does not support 'efRuntime' parameter")


def _build_field_args(name: str, spec: FieldSpec) -> list[str]:
    field_type = spec.get("type")
    if field_type == "text":
        return [name, "TEXT"]
    if field_type == "tag":
        args = [name, "TAG"]
        separator = spec.get("separator")
        if separator is not None:
            args.extend(["SEPARATOR", separator])
        return args
    args = [name, "NUMERIC"]
    if spec.get("sortable") is True:
        args.append("SORTABLE")
    return args


def resolve_vector_field_name(vector: VectorSpec) -> str:
    field_name = vector.get("fieldName")
    if field_name is None:
        return "embedding"
    if field_name.strip() == "":
        raise ValueError(
            f"Vector field name must not be empty or whitespace-only, got: '{field_name}'"
        )
    return field_name


def _build_vector_args(vector: VectorSpec, dims: int) -> list[str]:
    field_name = resolve_vector_field_name(vector)
    algo = str(vector["algorithm"]).upper()
    metric = _METRIC_MAP[vector["metric"]]

    if vector.get("algorithm") == "flat":
        return [
            field_name,
            "VECTOR",
            algo,
            "6",
            "TYPE",
            "FLOAT32",
            "DIM",
            str(dims),
            "DISTANCE_METRIC",
            metric,
        ]

    m = vector.get("m")
    if m is None:
        m = _HNSW_DEFAULTS["m"]
    ef_construction = vector.get("efConstruction")
    if ef_construction is None:
        ef_construction = _HNSW_DEFAULTS["efConstruction"]
    ef_runtime = vector.get("efRuntime")
    if ef_runtime is None:
        ef_runtime = _HNSW_DEFAULTS["efRuntime"]

    return [
        field_name,
        "VECTOR",
        algo,
        "12",
        "TYPE",
        "FLOAT32",
        "DIM",
        str(dims),
        "DISTANCE_METRIC",
        metric,
        "M",
        str(m),
        "EF_CONSTRUCTION",
        str(ef_construction),
        "EF_RUNTIME",
        str(ef_runtime),
    ]


def index_name(name: str) -> str:
    if name.strip() == "":
        raise ValueError(f"Index name must not be empty or whitespace-only, got: '{name}'")
    return f"{name}:idx"


def key_prefix(name: str) -> str:
    if name.strip() == "":
        raise ValueError(f"Index name must not be empty or whitespace-only, got: '{name}'")
    return f"{name}:"


def build_ft_create_args(
    name: str,
    schema: RetrievalSchema,
    capabilities: FtCapabilities | None = None,
) -> list[str]:
    if name.strip() == "":
        raise ValueError(f"Index name must not be empty or whitespace-only, got: '{name}'")

    dims = _require_dims(schema["vector"].get("dims"))
    vector_field_name = resolve_vector_field_name(schema["vector"])

    _validate_field_names(schema["fields"], vector_field_name)
    _validate_text_field_capabilities(schema["fields"], capabilities)
    _validate_flat_hnsw_params(schema["vector"])

    field_args: list[str] = []
    for field_name, spec in schema["fields"].items():
        field_args.extend(_build_field_args(field_name, spec))

    vector_args = _build_vector_args(schema["vector"], dims)

    return [
        index_name(name),
        "ON",
        "HASH",
        "PREFIX",
        "1",
        key_prefix(name),
        "SCHEMA",
        *field_args,
        *vector_args,
    ]
