# LMCache end-to-end validation

Stores synthetic KV chunks in Valkey through LMCache's own connector and serves
matching Prometheus counters, so the KV Cache page can be checked against known
numbers.

## Setup

```
python3.11 -m venv .venv
. .venv/bin/activate
NO_GPU_EXT=1 pip install -r requirements.txt
```

`NO_GPU_EXT=1` is needed on CPU-only machines (including macOS).

## Run

```
python validate.py --url valkey://localhost:6380 \
  --extra '{"valkey_username": "<password>", "valkey_password": "<username>"}'

python validate.py --url redis://default:<password>@localhost:6380
```

For `valkey://` with a password, LMCache 0.5.5 passes the credentials to the
client in swapped order, so `--extra` carries the swapped pair. Omit `--extra`
when the instance has no auth.

`redis://` is capped at 4 chunks: puts stall on the 8th 3.5 MB chunk.

The script stores the chunks, serves `http://localhost:9400/metrics`, performs
the lookups in two halves 60 seconds apart, prints the expected hit rate, the
stored chunk count and the first key, then holds for `--hold` seconds
(default 600).

## Check

1. Link `http://localhost:9400/metrics` as a scrape engine on the KV Cache page
   (development allows localhost).
2. Wait two minutes so both halves of the lookups land in minute buckets.

Pass criteria:

- the panel hit rate is within 2 points of the printed expected hit rate
- the chunk estimate equals the stored chunk count

Run it for both `redis://` and `valkey://`. Flush the first run's keys from the
database before the second run.
