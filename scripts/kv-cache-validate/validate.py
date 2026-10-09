#!/usr/bin/env python3
import argparse
import asyncio
import json
import sys
import threading
import time

import torch
from prometheus_client import CollectorRegistry, Counter, start_http_server

from lmcache.utils import CacheEngineKey
from lmcache.v1.config import LMCacheEngineConfig
from lmcache.v1.memory_allocators.pin_memory_allocator import PinMemoryAllocator
from lmcache.v1.metadata import LMCacheMetadata
from lmcache.v1.storage_backend.connector import CreateConnector
from lmcache.v1.storage_backend.local_cpu_backend import LocalCPUBackend

CHUNK_TOKENS = 256
CHUNK_SHAPE = torch.Size([2, 24, CHUNK_TOKENS, 128])
KV_SHAPE = (24, 2, CHUNK_TOKENS, 2, 64)
REDIS_CHUNK_CAP = 4
HASH_MULTIPLIER = 0x9E3779B97F4A7C15
HASH_MASK = 0xFFFFFFFFFFFFFFFF
OP_TIMEOUT_SECONDS = 120
HALF_GAP_SECONDS = 60
CLOSE_TIMEOUT_SECONDS = 10
LABEL_NAMES = ["model_name", "worker_id", "role", "served_model_name"]
COUNTER_NAMES = [
    "lmcache:num_requested_tokens",
    "lmcache:num_hit_tokens",
    "lmcache:num_lookup_tokens",
    "lmcache:num_lookup_hits",
]


def parse_args():
    parser = argparse.ArgumentParser(
        description="Store synthetic LMCache chunks in Valkey and serve "
        "matching Prometheus counters for BetterDB validation."
    )
    parser.add_argument("--url", required=True, help="redis://... or valkey://...")
    parser.add_argument("--chunks", type=int, default=8)
    parser.add_argument("--hit-ratio", type=float, default=0.7)
    parser.add_argument("--lookups", type=int, default=200)
    parser.add_argument("--port", type=int, default=9400)
    parser.add_argument("--model", default="Qwen/Qwen2.5-0.5B-Instruct")
    parser.add_argument(
        "--extra",
        default=None,
        help="JSON for extra_config. For valkey:// with a password pass the "
        'swapped pair {"valkey_username": "<password>", '
        '"valkey_password": "<username>"} (LMCache credential-order bug).',
    )
    parser.add_argument("--hold", type=int, default=600)
    return parser.parse_args()


def start_loop():
    loop = asyncio.new_event_loop()
    thread = threading.Thread(target=loop.run_forever, daemon=True)
    thread.start()
    return loop


def run(loop, coroutine):
    return asyncio.run_coroutine_threadsafe(coroutine, loop).result(
        OP_TIMEOUT_SECONDS
    )


def make_key(model, chunk_hash):
    return CacheEngineKey(
        model,
        world_size=1,
        worker_id=0,
        chunk_hash=chunk_hash,
        dtype=torch.bfloat16,
    )


def chunk_hash_for(index):
    return (HASH_MULTIPLIER * (index + 1)) & HASH_MASK


def confirm_observability():
    import lmcache.observability as observability

    print(f"lmcache.observability: {observability.__file__}")
    with open(observability.__file__, encoding="utf-8") as handle:
        source = handle.read()
    missing = [name for name in COUNTER_NAMES if f'"{name}"' not in source]
    if missing:
        sys.exit(f"LMCache does not define these counters: {missing}")
    for label in LABEL_NAMES:
        if f'"{label}"' not in source:
            sys.exit(f"LMCache does not define the label: {label}")
    print("confirmed counter and label names")


def build_counters(model, registry):
    labels = (model, "0", "worker", model)
    counters = {}
    for name in COUNTER_NAMES:
        counter = Counter(name, name, LABEL_NAMES, registry=registry)
        counters[name] = counter.labels(*labels)
    return counters


def lookup_half(loop, connector, model, counters, stored_hashes, args, start, end):
    hit_threshold = round(args.hit_ratio * 100)
    hits = 0
    for i in range(start, end):
        use_stored = i % 100 < hit_threshold
        if use_stored:
            chunk_hash = stored_hashes[i % len(stored_hashes)]
        else:
            chunk_hash = chunk_hash_for(10_000 + i)
        counters["lmcache:num_requested_tokens"].inc(CHUNK_TOKENS)
        counters["lmcache:num_lookup_tokens"].inc(CHUNK_TOKENS)
        if run(loop, connector.exists(make_key(model, chunk_hash))):
            counters["lmcache:num_hit_tokens"].inc(CHUNK_TOKENS)
            counters["lmcache:num_lookup_hits"].inc(1)
            hits += 1
    return hits


def main():
    args = parse_args()
    extra = json.loads(args.extra) if args.extra else {}
    chunks = args.chunks
    if args.url.startswith("redis://") and chunks > REDIS_CHUNK_CAP:
        print(
            f"capping chunks at {REDIS_CHUNK_CAP} for redis://: LMCache 0.5.5 "
            "puts stalled at the 8th 3.5 MB chunk in the spike"
        )
        chunks = REDIS_CHUNK_CAP

    confirm_observability()

    loop = start_loop()
    metadata = LMCacheMetadata(
        model_name=args.model,
        world_size=1,
        local_world_size=1,
        worker_id=0,
        local_worker_id=0,
        kv_dtype=torch.bfloat16,
        kv_shape=KV_SHAPE,
        use_mla=False,
    )
    config = LMCacheEngineConfig.from_defaults(
        extra_config=extra, save_unfull_chunk=False
    )
    cpu = LocalCPUBackend(
        config,
        metadata,
        memory_allocator=PinMemoryAllocator(512 * 1024 * 1024),
    )
    connector = CreateConnector(args.url, loop, cpu, config)

    stored_hashes = []
    first_key = None
    for i in range(chunks):
        chunk_hash = chunk_hash_for(i)
        key = make_key(args.model, chunk_hash)
        memory_obj = cpu.allocate(CHUNK_SHAPE, torch.bfloat16)
        if memory_obj is None:
            sys.exit("could not allocate a memory object for the chunk")
        memory_obj.tensor.copy_(torch.randn(CHUNK_SHAPE).to(torch.bfloat16))
        run(loop, connector.put(key, memory_obj))
        stored_hashes.append(chunk_hash)
        if first_key is None:
            first_key = key.to_string()
        print(f"stored chunk {i + 1}/{chunks}")

    registry = CollectorRegistry()
    counters = build_counters(args.model, registry)
    start_http_server(args.port, registry=registry)
    print(f"serving metrics on http://localhost:{args.port}/metrics")

    midpoint = args.lookups // 2
    hits = lookup_half(
        loop, connector, args.model, counters, stored_hashes, args, 0, midpoint
    )
    print(f"first half done, waiting {HALF_GAP_SECONDS}s")
    time.sleep(HALF_GAP_SECONDS)
    hits += lookup_half(
        loop,
        connector,
        args.model,
        counters,
        stored_hashes,
        args,
        midpoint,
        args.lookups,
    )

    requested = args.lookups * CHUNK_TOKENS
    hit_tokens = hits * CHUNK_TOKENS
    print(f"expected hit rate: {hit_tokens / requested:.4f} ({hit_tokens}/{requested})")
    print(f"stored chunks: {len(stored_hashes)}")
    print(f"first key: {first_key}")
    print(f"holding for {args.hold}s")
    time.sleep(args.hold)
    try:
        asyncio.run_coroutine_threadsafe(connector.close(), loop).result(CLOSE_TIMEOUT_SECONDS)
    except Exception as error:
        print(f"connector close did not finish cleanly: {error!r}")


if __name__ == "__main__":
    main()
