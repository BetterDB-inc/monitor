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

The script stores the chunks, serves `http://localhost:9400/metrics`, and then
waits until it has been scraped twice: once by the test scrape when you link
the engine, and once by BetterDB's first poll, which records the counter
baseline. Lookups made before that baseline would not count. Press Enter to
start without waiting. It then performs the lookups in two halves 60 seconds
apart, prints the expected hit rate, the stored chunk count and the first key,
and holds for `--hold` seconds (default 600). `--chunks` and `--lookups` must be
at least 1.

The metrics server binds to `127.0.0.1`. Pass `--bind 0.0.0.0` when BetterDB
runs in a container and has to reach the script from outside the host's
loopback.

## Check

1. Once the script prints that it is serving metrics, link
   `http://localhost:9400/metrics` as a scrape engine on the KV Cache page
   (development allows localhost).
2. Wait until the script reports both halves done, plus a minute, so both halves
   land in minute buckets.

Pass criteria:

- the panel hit rate is within 2 points of the printed expected hit rate
- the chunk estimate equals the stored chunk count

Run it for both `redis://` and `valkey://`. Flush the first run's keys from the
database before the second run.
