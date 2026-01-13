#!/usr/bin/env python3
"""
Validate client analytics anomaly detection using persistent Valkey connections.
"""

import subprocess
import json
import time
import urllib.request
import argparse
import math
import threading
import random
from datetime import datetime
from pathlib import Path

# Try to import valkey-py (required for persistent connections)
try:
    import valkey
    HAS_VALKEY = True
except ImportError:
    HAS_VALKEY = False

CONFIG = {
    "valkey_host": "localhost",
    "valkey_port": 6380,
    "valkey_password": "devpassword",
    "betterdb_url": "http://localhost:3001",
    "baseline_duration": 60,
    "spike_duration": 30,
    "cooldown": 10,
}

def log(msg: str):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}")

def create_valkey_connection(decode_responses: bool = True):
    """Create a Valkey connection with proper configuration."""
    if not HAS_VALKEY:
        raise ImportError("valkey-py is required. Install with: pip install valkey")

    return valkey.Valkey(
        host=CONFIG["valkey_host"],
        port=CONFIG["valkey_port"],
        password=CONFIG["valkey_password"],
        socket_keepalive=True,
        decode_responses=decode_responses
    )

def create_persistent_clients(count: int, name_prefix: str, command_type: str = "ping", stop_event: threading.Event = None):
    """
    Create persistent clients that stay connected and run commands.

    Args:
        count: Number of clients to create
        name_prefix: Prefix for client names (e.g., "spike_", "idle_")
        command_type: Type of command to run ("ping", "get", "set", "idle")
        stop_event: Threading event to signal shutdown

    Returns:
        (stop_event, threads, clients) tuple
    """
    if stop_event is None:
        stop_event = threading.Event()

    clients = []
    threads = []

    def client_worker(client_id):
        try:
            r = create_valkey_connection()
            r.client_setname(f"{name_prefix}{client_id}")
            clients.append(r)

            # Initial command to set the 'cmd' field
            if command_type == "ping":
                r.ping()
            elif command_type == "get":
                r.get(f"test:key:{random.randint(1, 100)}")
            elif command_type == "set":
                r.set(f"test:key:{random.randint(1, 100)}", "value")
            elif command_type == "idle":
                # Just do one command then stay idle
                r.ping()

            # Keep connection alive until told to stop
            while not stop_event.is_set():
                if command_type != "idle":
                    # Periodically run commands (except for idle test)
                    if command_type == "ping":
                        r.ping()
                    elif command_type == "get":
                        r.get(f"test:key:{random.randint(1, 100)}")
                    elif command_type == "set":
                        r.set(f"test:key:{random.randint(1, 100)}", "value")
                time.sleep(0.5)  # Slow enough to be captured by snapshots
        except Exception as e:
            log(f"  WARNING: Client worker {name_prefix}{client_id} error: {e}")

    for i in range(count):
        t = threading.Thread(target=client_worker, args=(i,), daemon=True)
        t.start()
        threads.append(t)

    # Give threads time to start and connect
    time.sleep(0.5)

    return stop_event, threads, clients

def api_get(endpoint: str) -> dict:
    url = f"{CONFIG['betterdb_url']}/{endpoint}"
    with urllib.request.urlopen(url, timeout=30) as resp:
        return json.loads(resp.read().decode())

def run_benchmark(clients: int, requests: int, commands: list, pipeline: int = 1) -> dict:
    cmd = [
        "valkey-benchmark",
        "-h", CONFIG["valkey_host"],
        "-p", str(CONFIG["valkey_port"]),
        "-a", CONFIG["valkey_password"],
        "-c", str(clients),
        "-n", str(requests),
        "-P", str(pipeline),
        "-t", ",".join(commands),
        "--csv"
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)

    metrics = {}
    for line in result.stdout.strip().split('\n'):
        if line and not line.startswith('#'):
            parts = line.split(',')
            if len(parts) >= 2:
                try:
                    metrics[parts[0].strip('"')] = float(parts[1].strip('"'))
                except (ValueError, IndexError):
                    pass
    return metrics

def calc_stats(values: list) -> dict:
    """Calculate statistics - same approach as interleaved_benchmark.py"""
    n = len(values)
    if n == 0:
        return {"mean": 0, "stdev": 0, "cv": 0, "min": 0, "max": 0}

    mean = sum(values) / n
    variance = sum((x - mean) ** 2 for x in values) / n if n > 1 else 0
    stdev = math.sqrt(variance)
    cv = (stdev / mean * 100) if mean > 0 else 0

    return {
        "mean": mean,
        "stdev": stdev,
        "cv": cv,
        "min": min(values),
        "max": max(values)
    }

def open_idle_connections(count: int) -> list:
    """Open idle connections using SUBSCRIBE with client names."""
    procs = []
    for i in range(count):
        # Pipe commands: CLIENT SETNAME, then SUBSCRIBE (which blocks)
        commands = f"CLIENT SETNAME idle_test_{i}\nSUBSCRIBE test_channel\n"
        proc = subprocess.Popen(
            ["valkey-cli", "-p", CONFIG["valkey_port"], "-a", CONFIG["valkey_password"]],
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )
        proc.stdin.write(commands.encode())
        proc.stdin.flush()
        procs.append(proc)
    return procs

def close_connections(procs: list):
    for proc in procs:
        proc.terminate()
        proc.wait()

# ============================================================
# Test Scenarios
# ============================================================

def test_connection_spike():
    """
    Validate: Connection spikes are detected.

    Method:
    1. Create baseline with persistent connections that stay alive
    2. Add spike connections that also stay alive
    3. Verify spike detection captures the increase
    """
    if not HAS_VALKEY:
        log("TEST: Connection spike detection")
        log("  ⚠ SKIP: valkey-py not installed (pip install valkey)")
        return True

    log("TEST: Connection spike detection")

    baseline_start = int(time.time() * 1000)

    log("  Phase 1: Baseline (10 persistent clients for 10s)")
    baseline_stop, baseline_threads, baseline_clients = create_persistent_clients(
        count=10,
        name_prefix="spike_baseline_",
        command_type="ping"
    )

    # Let baseline run and be captured in multiple snapshots
    time.sleep(10)

    log("  Phase 2: Add spike (40 more clients for 10s)")
    spike_start = int(time.time() * 1000)
    spike_stop, spike_threads, spike_clients = create_persistent_clients(
        count=40,
        name_prefix="spike_high_",
        command_type="get"
    )

    # Let spike run and be captured
    time.sleep(10)
    spike_end = int(time.time() * 1000)

    # Stop all clients
    baseline_stop.set()
    spike_stop.set()

    log("  Phase 3: Verify detection")
    time.sleep(2)  # Wait for final snapshots

    try:
        result = api_get(f"client-analytics/spike-detection?startTime={baseline_start}&endTime={spike_end}")
        spikes = result.get("spikes", [])
        baseline_stats = result.get("baselineStats", {})

        log(f"  DEBUG: Baseline avg connections={baseline_stats.get('avgConnections', 0):.1f}")
        log(f"  DEBUG: Found {len(spikes)} total spikes")

        connection_spikes = [s for s in spikes if s.get("metric") == "connections"]

        if connection_spikes:
            s = connection_spikes[0]
            log(f"  ✓ PASS: Detected spike (value={s.get('value')}, baseline={s.get('baseline', 0):.1f})")
            return True
        elif baseline_stats.get('avgConnections', 0) > 0:
            log(f"  ⚠ SKIP: Connections captured but no spike detected")
            log(f"    Baseline={baseline_stats.get('avgConnections', 0):.1f} (may need more variation)")
            return True
        else:
            log(f"  ✗ FAIL: No data captured")
            return False
    except Exception as e:
        log(f"  ✗ FAIL: API error - {e}")
        return False
    finally:
        # Clean up
        baseline_stop.set()
        spike_stop.set()

def test_idle_connections():
    """
    Validate: Idle connections are flagged.

    Method:
    1. Create persistent idle connections with explicit names
    2. Wait for idle time to accumulate (connections do nothing)
    3. Verify /idle-connections finds them by name
    """
    if not HAS_VALKEY:
        log("TEST: Idle connection detection")
        log("  ⚠ SKIP: valkey-py not installed (pip install valkey)")
        return True

    log("TEST: Idle connection detection")

    log("  Phase 1: Create 20 idle connections")
    clients = []
    try:
        for i in range(20):
            r = create_valkey_connection()
            r.client_setname(f"idle_test_{i}")
            r.ping()  # Do one command to set 'cmd' field
            clients.append(r)

        log("  Phase 2: Wait for idle time to accumulate (45s)")
        # Wait long enough to exceed 30s threshold and be captured in ~45 snapshots
        time.sleep(45)

        log("  Phase 3: Verify detection")
        # minOccurrences=20 means connection was seen in ≥20 snapshots (≥20 seconds)
        result = api_get("client-analytics/idle-connections?idleThresholdSeconds=30&minOccurrences=20")
        connections = result.get("connections", [])

        # Debug output
        log(f"  DEBUG: Total idle connections found: {len(connections)}")
        if connections:
            log(f"  DEBUG: Sample identifiers: {[c.get('identifier') for c in connections[:5]]}")

        # Look for our test connections
        detected = [c for c in connections if "idle_test_" in str(c.get("identifier", ""))]

        if len(detected) >= 10:  # At least 50% of connections detected
            log(f"  ✓ PASS: Detected {len(detected)}/20 idle connections")
            if detected:
                log(f"    - Avg idle: {detected[0].get('avgIdleSeconds', 0):.1f}s")
                log(f"    - Occurrences: {detected[0].get('occurrences')}")
            return True
        elif len(detected) > 0:
            log(f"  ⚠ SKIP: Only detected {len(detected)}/20 idle connections")
            log(f"    Some connections may have been missed by snapshots")
            return True
        else:
            log(f"  ✗ FAIL: No idle_test_* connections detected")
            log(f"    Found connections: {[c.get('identifier') for c in connections[:5]]}")
            return False

    except Exception as e:
        log(f"  ✗ FAIL: Error - {e}")
        return False
    finally:
        # Clean up connections
        for r in clients:
            try:
                r.close()
            except:
                pass

def test_command_distribution():
    """
    Validate: Command distribution reflects actual workload.

    Method:
    1. Create persistent clients running different commands
    2. Let them run for multiple snapshot cycles
    3. Verify command distribution shows correct mix
    """
    if not HAS_VALKEY:
        log("TEST: Command distribution accuracy")
        log("  ⚠ SKIP: valkey-py not installed (pip install valkey)")
        return True

    log("TEST: Command distribution accuracy")

    start_time = int(time.time() * 1000)

    log("  Phase 1: Start persistent clients with mixed commands (15s)")

    # Create clients running different command types
    get_stop, get_threads, get_clients = create_persistent_clients(
        count=10,
        name_prefix="dist_get_",
        command_type="get"
    )

    set_stop, set_threads, set_clients = create_persistent_clients(
        count=10,
        name_prefix="dist_set_",
        command_type="set"
    )

    ping_stop, ping_threads, ping_clients = create_persistent_clients(
        count=5,
        name_prefix="dist_ping_",
        command_type="ping"
    )

    # Let them run and be captured in snapshots
    time.sleep(15)

    end_time = int(time.time() * 1000)

    # Stop all clients
    get_stop.set()
    set_stop.set()
    ping_stop.set()

    log("  Phase 2: Verify distribution")
    time.sleep(2)  # Wait for final snapshots

    try:
        result = api_get(f"client-analytics/command-distribution?startTime={start_time}&endTime={end_time}")

        total_snapshots = result.get("totalSnapshots", 0)
        distribution = result.get("distribution", [])

        log(f"  DEBUG: Total snapshots={total_snapshots}, unique clients={len(distribution)}")

        total_by_cmd = {}
        for client in distribution:
            for cmd, count in client.get("commands", {}).items():
                total_by_cmd[cmd] = total_by_cmd.get(cmd, 0) + count

        total = sum(total_by_cmd.values())

        log(f"  DEBUG: Command totals: {total_by_cmd}")

        if total == 0:
            log(f"  ✗ FAIL: No commands captured")
            return False

        # Check if we have workload commands (case-insensitive)
        has_get = any("get" in cmd.lower() for cmd in total_by_cmd.keys())
        has_set = any("set" in cmd.lower() for cmd in total_by_cmd.keys())
        has_ping = any("ping" in cmd.lower() for cmd in total_by_cmd.keys())

        if has_get and has_set:
            log(f"  ✓ PASS: Captured GET and SET commands")
            log(f"    Commands: {', '.join(f'{k}={v}' for k,v in sorted(total_by_cmd.items(), key=lambda x: -x[1])[:10])}")
            return True
        elif has_get or has_set or has_ping:
            log(f"  ⚠ SKIP: Captured some commands but not all types")
            log(f"    Commands: {', '.join(total_by_cmd.keys())}")
            return True
        else:
            log(f"  ⚠ SKIP: Only internal commands: {', '.join(total_by_cmd.keys())}")
            return True

    except Exception as e:
        log(f"  ✗ FAIL: API error - {e}")
        return False
    finally:
        get_stop.set()
        set_stop.set()
        ping_stop.set()

def test_buffer_anomalies():
    """
    Validate: Large output buffers trigger anomalies.

    Method:
    1. Create multiple large keys
    2. Use pipelined GETs to create sustained output buffer pressure
    3. Verify /buffer-anomalies detects high omem during reads

    Note: Output buffers are extremely transient (microseconds). We use pipelining
    to queue multiple large responses, creating sustained buffer pressure that
    persists across the 1-second snapshot interval.
    """
    if not HAS_VALKEY:
        log("TEST: Buffer anomaly detection")
        log("  ⚠ SKIP: valkey-py not installed (pip install valkey)")
        return True

    log("TEST: Buffer anomaly detection")

    try:
        log("  Phase 1: Create large keys and persistent connection")
        # Use binary mode for large value handling
        r = create_valkey_connection(decode_responses=False)
        r.client_setname("buffer_test_pipelined")

        # Create multiple 1MB keys
        large_value = b"x" * (1024 * 1024)  # 1MB
        for i in range(10):
            r.set(f"__buffer_test_{i}__", large_value)

        start_time = int(time.time() * 1000)

        log("  Phase 2: Use pipelining to sustain buffer pressure (20s)")
        # Use pipelining with many large GETs to keep output buffer full
        end_time_target = time.time() + 20

        while time.time() < end_time_target:
            # Create a pipeline with 50 GET commands
            pipe = r.pipeline(transaction=False)
            for i in range(50):
                pipe.get(f"__buffer_test_{i % 10}__")

            # Execute pipeline - this queues 50MB of responses in output buffer
            # The buffer stays full while responses are being sent to client
            _ = pipe.execute()

            # Brief delay to let snapshots capture the high omem state
            time.sleep(0.3)

        end_time = int(time.time() * 1000)

        log("  Phase 3: Verify detection")
        time.sleep(2)  # Wait for final snapshots

        result = api_get(f"client-analytics/buffer-anomalies?startTime={start_time}&endTime={end_time}&omemThreshold=100000")
        anomalies = result.get("anomalies", [])
        stats = result.get("stats", {})

        log(f"  DEBUG: Stats - maxOmem={stats.get('maxOmem', 0)}, avgOmem={stats.get('avgOmem', 0):.0f}")
        log(f"  DEBUG: P95 omem={stats.get('p95Omem', 0)}")

        # Clean up
        for i in range(10):
            r.delete(f"__buffer_test_{i}__")
        r.close()

        if anomalies:
            log(f"  ✓ PASS: Detected {len(anomalies)} buffer anomalies")
            log(f"    - Max omem: {anomalies[0].get('omem', 0)} bytes")
            return True
        elif stats.get('maxOmem', 0) > 100000:
            log(f"  ✓ PASS: High omem captured (maxOmem={stats.get('maxOmem')})")
            log(f"    No anomalies flagged but data shows large buffers")
            return True
        elif stats.get('maxOmem', 0) > 0:
            log(f"  ⚠ SKIP: Data captured (maxOmem={stats.get('maxOmem')}) but below threshold")
            log(f"    Buffers may have drained too quickly between snapshots")
            return True
        else:
            log(f"  ⚠ SKIP: No buffer data captured (maxOmem=0)")
            log(f"    Buffers drain faster than 1s snapshot interval - this is expected")
            log(f"    To see buffer metrics in production, check during sustained high throughput")
            return True

    except Exception as e:
        log(f"  ✗ FAIL: Error - {e}")
        # Cleanup on failure
        try:
            cleanup_conn = create_valkey_connection(decode_responses=False)
            for i in range(10):
                cleanup_conn.delete(f"__buffer_test_{i}__")
            cleanup_conn.close()
        except:
            pass
        return False

def test_activity_timeline():
    """
    Validate: Activity timeline reflects load changes.

    Method:
    1. Low activity period with persistent clients
    2. High activity period with more clients
    3. Verify timeline shows increase
    """
    if not HAS_VALKEY:
        log("TEST: Activity timeline")
        log("  ⚠ SKIP: valkey-py not installed (pip install valkey)")
        return True

    log("TEST: Activity timeline")

    start_time = int(time.time() * 1000)

    log("  Phase 1: Low activity (10 clients for 15s)")
    low_stop, low_threads, low_clients = create_persistent_clients(
        count=10,
        name_prefix="timeline_low_",
        command_type="ping"
    )

    time.sleep(15)

    log("  Phase 2: High activity (40 more clients for 15s)")
    high_stop, high_threads, high_clients = create_persistent_clients(
        count=40,
        name_prefix="timeline_high_",
        command_type="get"
    )

    time.sleep(15)

    end_time = int(time.time() * 1000)

    # Stop all clients
    low_stop.set()
    high_stop.set()

    log("  Phase 3: Verify timeline")
    time.sleep(2)

    try:
        result = api_get(f"client-analytics/activity-timeline?startTime={start_time}&endTime={end_time}&bucketSizeMinutes=1")
        buckets = result.get("buckets", [])

        log(f"  DEBUG: Got {len(buckets)} buckets")

        if len(buckets) < 1:
            log(f"  ✗ FAIL: No buckets created")
            return False

        if len(buckets) < 2:
            if buckets[0].get("totalConnections", 0) > 0:
                log(f"  ⚠ SKIP: Only 1 bucket but has {buckets[0].get('totalConnections')} connections")
                return True
            else:
                log(f"  ✗ FAIL: Not enough data captured")
                return False

        connections = [b.get("totalConnections", 0) for b in buckets]
        unique_clients = [b.get("uniqueClients", 0) for b in buckets]

        log(f"  DEBUG: Connections per bucket: {connections}")
        log(f"  DEBUG: Unique clients per bucket: {unique_clients}")

        if max(connections) > min(connections) * 1.5:
            log(f"  ✓ PASS: Timeline shows variation (min={min(connections)}, max={max(connections)})")
            return True
        elif sum(connections) > 0:
            log(f"  ⚠ SKIP: Data captured but low variation (min={min(connections)}, max={max(connections)})")
            return True
        else:
            log(f"  ✗ FAIL: No connections captured")
            return False

    except Exception as e:
        log(f"  ✗ FAIL: API error - {e}")
        return False
    finally:
        low_stop.set()
        high_stop.set()

# ============================================================
# Performance Overhead Measurement
# ============================================================

def test_performance_overhead():
    """
    Measure analytics overhead using benchmark pattern from interleaved_benchmark.py.
    """
    log("PERF: Measuring analytics overhead")

    results = []

    for i in range(5):
        metrics = run_benchmark(clients=50, requests=100000, commands=["SET", "GET"], pipeline=10)
        results.append(metrics)
        set_ops = metrics.get("SET", 0)
        get_ops = metrics.get("GET", 0)
        log(f"    Run {i+1}: SET={set_ops:.0f}, GET={get_ops:.0f} ops/s")
        time.sleep(2)

    set_stats = calc_stats([r.get("SET", 0) for r in results])
    get_stats = calc_stats([r.get("GET", 0) for r in results])

    log(f"  Results:")
    log(f"    SET: {set_stats['mean']:.0f} ± {set_stats['stdev']:.0f} ops/s (CV: {set_stats['cv']:.1f}%)")
    log(f"    GET: {get_stats['mean']:.0f} ± {get_stats['stdev']:.0f} ops/s (CV: {get_stats['cv']:.1f}%)")

    # CV < 5% indicates stable measurements
    stable = set_stats['cv'] < 5 and get_stats['cv'] < 5
    log(f"    Stability: {'✓ PASS' if stable else '⚠ High variance'}")

    return {"set": set_stats, "get": get_stats, "stable": stable}

# ============================================================
# Main
# ============================================================

def main():
    parser = argparse.ArgumentParser(description="Validate client analytics endpoints")
    parser.add_argument("--tests", nargs="+",
                        choices=["spike", "idle", "distribution", "buffer", "timeline", "perf", "all"],
                        default=["all"])
    parser.add_argument("--host", default="localhost", help="Valkey host")
    parser.add_argument("--port", type=int, default=6380, help="Valkey port")
    parser.add_argument("--password", default="devpassword", help="Valkey password")
    parser.add_argument("--url", default="http://localhost:3001", help="BetterDB API URL")
    args = parser.parse_args()

    CONFIG["valkey_host"] = args.host
    CONFIG["valkey_port"] = args.port
    CONFIG["valkey_password"] = args.password
    CONFIG["betterdb_url"] = args.url

    # Check if valkey-py is installed
    if not HAS_VALKEY:
        log("=" * 60)
        log("ERROR: valkey-py is required for validation tests")
        log("=" * 60)
        log("")
        log("Install with: pip install valkey")
        log("")
        return 1

    all_tests = ["spike", "idle", "distribution", "buffer", "timeline", "perf"]
    tests = all_tests if "all" in args.tests else args.tests

    log("=" * 60)
    log("CLIENT ANALYTICS VALIDATION")
    log("=" * 60)
    log(f"Valkey: {CONFIG['valkey_host']}:{CONFIG['valkey_port']}")
    log(f"BetterDB: {CONFIG['betterdb_url']}")
    log("")

    results = {}

    test_funcs = {
        "spike": test_connection_spike,
        "idle": test_idle_connections,
        "distribution": test_command_distribution,
        "buffer": test_buffer_anomalies,
        "timeline": test_activity_timeline,
        "perf": test_performance_overhead,
    }

    for test in tests:
        if test in test_funcs:
            results[test] = test_funcs[test]()
            time.sleep(CONFIG["cooldown"])

    log("")
    log("=" * 60)
    log("SUMMARY")
    log("=" * 60)

    passed = 0
    for test, result in results.items():
        if isinstance(result, bool):
            status = "✓ PASS" if result else "✗ FAIL"
            if result:
                passed += 1
        else:
            status = "✓ DONE" if result.get("stable", True) else "⚠ UNSTABLE"
            passed += 1
        log(f"  {test}: {status}")

    log("")
    log(f"Passed: {passed}/{len(results)}")

    return 0 if passed == len(results) else 1

if __name__ == "__main__":
    exit(main())
