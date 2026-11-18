#!/usr/bin/env python3
"""Project the official agy status payload into a small, local Flockbook snapshot.

Only bounded visible subagent previews are included, never prompts, thinking,
credentials, or terminal control sequences. No network requests are made.
stdout is JSON for statusline.sh, never a debug log.
"""

import argparse
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time

from statusline_usage import usage as transcript_usage, usage_fingerprint

SCHEMA = 1
IDENTIFIER = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
ACTIVE = {"working", "tool_use"}
MAX_PAYLOAD = 1024 * 1024
USAGE_CHECK_NS = 5_000_000_000
USAGE_RETRY_NS = 30_000_000_000
USAGE_FIELDS = {"input_tokens", "output_tokens", "input_cached_tokens", "usage_scope", "usage_complete",
                "usage_by_model", "cost_usage", "subagents"}


def number(value, integer=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not math.isfinite(value) or value < 0:
        return None
    return math.floor(value) if integer else value


def text(value, limit=200):
    if not isinstance(value, str):
        return ""
    # Model names arrive in the terminal too; do not pass control characters on.
    return "".join(c for c in value if c.isprintable())[:limit]


def object_value(value):
    return value if isinstance(value, dict) else {}


def transcript_path(payload):
    """Resolve agy's documented and v1.5.x alternate paths to the feed's full log."""
    raw = payload.get("transcript_path")
    sid = payload.get("conversation_id") or payload.get("session_id")
    if not isinstance(raw, str) or not isinstance(sid, str) or not IDENTIFIER.fullmatch(sid):
        return None
    if len(raw) > 4096 or any(ord(c) < 32 for c in raw):
        return None
    path = Path(raw).expanduser()
    if not path.is_absolute() or path.name not in {"transcript.jsonl", "transcript_full.jsonl"}:
        return None
    # Keep the exact conversation binding. Never choose the latest log by mtime.
    if path.parent.name != "logs" or path.parent.parent.name != ".system_generated":
        return None
    if path.parent.parent.parent.name != sid or path.parent.parent.parent.parent.name != "brain":
        return None
    path = path.with_name("transcript_full.jsonl")
    if not path.exists() and "/.gemini/antigravity/brain/" in str(path):
        alternate = Path(str(path).replace("/.gemini/antigravity/brain/", "/.gemini/antigravity-cli/brain/", 1))
        if alternate.parent.is_dir():
            path = alternate
    return str(path) if path.parent.is_dir() else None


def producer_identity():
    """Identify the actual agy ancestor, not the short-lived status shell.

    PID plus process creation time prevents an old cache being reused after an
    agent restarts in the same Herdr terminal, including /resume of the same ID.
    """
    pid = os.getppid()
    for _ in range(12):
        if pid <= 1:
            break
        try:
            if sys.platform.startswith("linux"):
                raw = Path(f"/proc/{pid}/stat").read_text()
                fields = raw[raw.rfind(")") + 2:].split()
                command = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0", 1)[0].decode(errors="replace")
                parent, started = int(fields[1]), fields[19]
            else:
                raw = subprocess.check_output(
                    ["ps", "-p", str(pid), "-o", "ppid=,lstart=,comm="],
                    text=True, timeout=0.2, stderr=subprocess.DEVNULL,
                ).strip().split(None, 6)
                parent, started, command = int(raw[0]), " ".join(raw[1:6]), raw[6]
            if Path(command).name in {"agy", "antigravity"}:
                return f"{pid}:{started}"
            pid = parent
        except (OSError, ValueError, IndexError, subprocess.SubprocessError):
            break
    return None


def producer_alive(producer):
    try:
        pid, started = producer.split(":", 1)
        if not pid.isdigit() or int(pid) <= 1:
            return False
        if sys.platform.startswith("linux"):
            raw = Path(f"/proc/{pid}/stat").read_text()
            fields = raw[raw.rfind(")") + 2:].split()
            return fields[19] == started and fields[0] != "Z"
        current = subprocess.check_output(
            ["ps", "-p", pid, "-o", "lstart="], text=True, timeout=0.2,
            stderr=subprocess.DEVNULL,
        )
        return " ".join(current.split()) == started
    except (AttributeError, OSError, ValueError, IndexError, subprocess.SubprocessError):
        return False


def projection(payload, terminal_id, producer, wall_ms):
    model = object_value(payload.get("model"))
    usage = object_value(payload.get("context_window"))
    cost = object_value(payload.get("cost"))
    sid = payload.get("conversation_id") or payload.get("session_id") or ""
    sid = sid if isinstance(sid, str) and IDENTIFIER.fullmatch(sid) else ""
    state = text(payload.get("agent_state"), 32) or "unknown"
    pending = payload.get("tool_confirmation_pending") is True
    return {
        "schema": SCHEMA,
        "session_id": sid,
        "transcript_path": transcript_path(payload),
        "terminal_id": terminal_id,
        "producer_id": producer,
        "model": {"name": text(model.get("display_name") or model.get("id")), "effort": text(model.get("effort"), 32)},
        # agy 1.5.10 calls context occupancy "total_input_tokens". Keep that
        # diagnostic separate; cumulative totals come from full transcript usage.
        "context_input_tokens": number(usage.get("total_input_tokens"), integer=True),
        "input_tokens": None,
        "output_tokens": None,
        "cost_usd": number(cost.get("total_usd")),
        "subagent_usd": number(cost.get("subagent_usd")),
        "state": state,
        "observed_at_ms": wall_ms,
        "terminal_width": number(payload.get("terminal_width"), integer=True) or 100,
        "turn": {"id": None, "elapsed_ms": None, "running": state in ACTIVE and not pending,
                 "complete": False, "finished": state in {"idle", "error"} and not pending},
    }


def advance(snapshot, previous, monotonic_ns):
    """Accumulate only observed active intervals; never guess from log wall time."""
    previous = previous if isinstance(previous, dict) else {}
    same_producer = snapshot["producer_id"] and previous.get("producer_id") == snapshot["producer_id"]
    same_terminal = snapshot["terminal_id"] == previous.get("terminal_id")
    old = object_value(previous.get("turn"))
    previous_ns = number(previous.get("_monotonic_ns"))
    valid = (same_producer and same_terminal and previous.get("schema") == SCHEMA
             and previous_ns is not None and previous_ns <= monotonic_ns)
    turn = snapshot["turn"]
    same_session = previous.get("session_id") == snapshot["session_id"]
    # The idle pre-conversation callback carries no UUID. Its observed idle state
    # is still a trustworthy boundary for the first working callback with a UUID.
    starts = valid and turn["running"] and (old.get("finished") is True)
    if starts:
        turn.update(id=f"{snapshot['session_id']}:{monotonic_ns}", elapsed_ms=0, complete=True)
    elif valid and same_session and old.get("id") is not None:
        turn.update(id=old["id"], complete=old.get("complete") is True)
        elapsed = number(old.get("elapsed_ms"))
        if turn["complete"] and elapsed is not None:
            delta = (monotonic_ns - previous_ns) / 1_000_000 if old.get("running") is True else 0
            turn["elapsed_ms"] = round(elapsed + delta, 3)
    elif turn["running"]:
        # Installation during an existing turn has no reliable start boundary.
        turn["id"] = f"{snapshot['session_id']}:{monotonic_ns}"
    snapshot["_monotonic_ns"] = monotonic_ns
    return snapshot


def read_snapshot(path, max_bytes=256 * 1024):
    try:
        if path.is_symlink() or path.stat().st_size > max_bytes:
            return None
        value = json.loads(path.read_text())
        return value if isinstance(value, dict) else None
    except (OSError, ValueError):
        return None


def atomic_write(path, value):
    """Atomic replace means a reader sees either complete old or complete new JSON."""
    if path.is_symlink():
        raise OSError("Refusing a symlink status cache")
    fd, temporary = tempfile.mkstemp(prefix=".flockbook-status-", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w") as handle:
            json.dump(value, handle, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
            handle.write("\n")
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def public_snapshot(snapshot):
    return {key: value for key, value in snapshot.items() if not key.startswith("_")}


def private_path(state_dir, terminal_id, producer):
    key = hashlib.sha256(f"{terminal_id}\0{producer}".encode()).hexdigest()[:32]
    return state_dir / f"{key}.json"


def default_state_dir():
    return Path.home() / ".gemini/antigravity-cli/flockbook-status/terminals"


def add_usage(snapshot, previous=None):
    previous = object_value(previous)
    totals, state = transcript_usage(snapshot.get("transcript_path"), previous.get("_usage"))
    snapshot.update({key: value for key, value in totals.items() if key != "source"})
    snapshot["usage_source"] = totals["source"]
    snapshot["_usage"] = state
    return snapshot


def cached_usage(snapshot, state_dir, current_ns, *, force=False, legacy_state=None):
    """Keep expensive usage sampling separate from the tiny producer clock.

    Status callbacks check at most every five seconds; explicit UI reads check
    file metadata immediately. Only changed files cause a transcript scan. A
    separate cache persists reader refreshes without changing the Turn clock.
    """
    state_path = private_path(state_dir, snapshot["terminal_id"], snapshot["producer_id"])
    cache_path = state_path.with_suffix(".usage.json")
    rows_path = state_path.with_suffix(".usage-state.json")
    binding = {key: snapshot.get(key) for key in ("session_id", "terminal_id", "producer_id", "transcript_path")}

    def valid_cache(value):
        return (isinstance(value, dict) and value.get("version") == 1 and value.get("binding") == binding
                and isinstance(value.get("totals"), dict) and isinstance(value.get("watched"), list)
                and set(value["totals"]).issubset(USAGE_FIELDS | {"source"})
                and value["totals"].get("source") == "transcript"
                and len(value["watched"]) <= 64 and number(value.get("checked_ns")) is not None
                and number(value.get("scanned_ns")) is not None and isinstance(value.get("retry"), bool)
                and value["checked_ns"] <= current_ns)

    cache = read_snapshot(cache_path)
    cache = cache if valid_cache(cache) else None

    def apply(value):
        snapshot.update({key: item for key, item in value.items() if key in USAGE_FIELDS})
        snapshot["usage_source"] = value.get("source", "transcript")
        return snapshot

    if cache and not force and current_ns - cache["checked_ns"] < USAGE_CHECK_NS:
        return apply(cache["totals"])
    flags = os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(state_path.with_suffix(".usage.lock"), flags, 0o600)
        with os.fdopen(fd, "w") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                # Another reader is already collecting this exact session.
                return apply(cache["totals"]) if cache else snapshot
            latest = read_snapshot(cache_path)
            cache = latest if valid_cache(latest) else cache
            if cache and not force and current_ns - cache["checked_ns"] < USAGE_CHECK_NS:
                return apply(cache["totals"])
            fingerprint = usage_fingerprint(binding["transcript_path"], cache["watched"] if cache else ())
            retry = bool(cache and cache.get("retry") and current_ns - cache.get("scanned_ns", 0) >= USAGE_RETRY_NS)
            if cache and fingerprint == cache.get("fingerprint") and not retry:
                cache["checked_ns"] = current_ns
                atomic_write(cache_path, cache)
                return apply(cache["totals"])
            previous = read_snapshot(rows_path, 16 * 1024 * 1024)
            previous_state = (previous.get("state") if previous and previous.get("binding") == binding else legacy_state)
            totals, usage_state = transcript_usage(binding["transcript_path"], previous_state)
            watched = usage_state.get("watched_children", []) if isinstance(usage_state, dict) else []
            if not watched:
                watched = [item["id"] for item in object_value(totals.get("subagents")).get("items", [])]
            fingerprint = usage_fingerprint(binding["transcript_path"], watched)
            # Store the fstat observed before parsing, not a later append that
            # has not been read yet. The next UI read then sees that append.
            states = {"parent": usage_state}
            if isinstance(usage_state, dict):
                states.update(usage_state.get("child_states", {}))
                fingerprint.update(usage_state.get("observed_files", {}))
            for key, state in states.items():
                if isinstance(state, dict) and all(field in state for field in ("dev", "ino", "size", "mtime_ns", "ctime_ns")):
                    fingerprint[key] = [state[field] for field in ("dev", "ino", "size", "mtime_ns", "ctime_ns")]
            cache = {"version": 1, "binding": binding, "checked_ns": current_ns, "scanned_ns": current_ns,
                     "watched": watched, "fingerprint": fingerprint, "totals": totals,
                     "retry": (not object_value(totals.get("cost_usage")).get("usage_complete", False)
                               or not isinstance(usage_state, dict) or usage_state.get("version") != 4)}
            atomic_write(rows_path, {"binding": binding, "state": usage_state})
            atomic_write(cache_path, cache)
            return apply(totals)
    except (OSError, ValueError, TypeError):
        # Terminal output and timing survive a missing/unwritable usage cache.
        return apply(cache["totals"]) if cache else snapshot


def read_current(path, terminal_id, *, state_dir=None, monotonic_ns=None, wall_ms=None, alive=producer_alive):
    """Sample elapsed time on the producer's clock, without mutating its state.

    The status command only runs when agy's state changes. A long-running tool
    therefore needs this reader, rather than treating an old snapshot as a fresh
    elapsed value or subtracting the Mac's wall clock from GCE's wall clock.
    """
    if not IDENTIFIER.fullmatch(terminal_id):
        return None
    artifact = Path(path)
    snapshot = read_snapshot(artifact)
    if not snapshot or snapshot.get("schema") != SCHEMA or snapshot.get("terminal_id") != terminal_id:
        return None
    expected_path = f"{snapshot.get('transcript_path')}.flockbook-status.{terminal_id}.json"
    if str(artifact) != expected_path or not alive(snapshot.get("producer_id")):
        return None
    state_dir = Path(state_dir) if state_dir else default_state_dir()
    previous = read_snapshot(private_path(state_dir, terminal_id, snapshot["producer_id"]), 16 * 1024 * 1024)
    if not previous or any(previous.get(key) != snapshot.get(key) for key in
                           ("schema", "session_id", "terminal_id", "producer_id", "transcript_path", "observed_at_ms", "turn")):
        return None
    current_ns = time.monotonic_ns() if monotonic_ns is None else monotonic_ns
    then_ns = number(previous.get("_monotonic_ns"))
    if then_ns is None or current_ns < then_ns:
        return None
    turn = object_value(snapshot.get("turn"))
    elapsed = number(turn.get("elapsed_ms"))
    if turn.get("running") is True and turn.get("complete") is True and elapsed is not None:
        turn["elapsed_ms"] = round(elapsed + (current_ns - then_ns) / 1_000_000, 3)
    snapshot["sampled_at_ms"] = int(time.time() * 1000) if wall_ms is None else wall_ms
    snapshot["producer_alive"] = True
    # The final transcript row can flush after the final status callback. Read
    # newly appended usage here too, without touching the producer's clock state.
    return public_snapshot(cached_usage(snapshot, state_dir, current_ns, force=True,
                                        legacy_state=previous.get("_usage")))


def update(payload, *, state_dir=None, terminal_id=None, producer=None, wall_ms=None, monotonic_ns=None):
    payload = object_value(payload)
    wall_ms = int(time.time() * 1000) if wall_ms is None else wall_ms
    monotonic_ns = time.monotonic_ns() if monotonic_ns is None else monotonic_ns
    if terminal_id is None:
        terminal_id = os.environ.get("HC_TERMINAL_ID", "")
    terminal_id = terminal_id if IDENTIFIER.fullmatch(terminal_id) else ""
    producer = producer if producer is not None else producer_identity()
    snapshot = projection(payload, terminal_id, producer, wall_ms)
    if not producer or not isinstance(payload.get("agent_state"), str):
        # A standalone script invocation can still render safely without leaving
        # a cache that impersonates a running agent.
        return public_snapshot(add_usage(snapshot))
    state_dir = Path(state_dir) if state_dir else default_state_dir()
    try:
        state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        state_path = private_path(state_dir, terminal_id, producer)
        flags = os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(state_path.with_suffix(".lock"), flags, 0o600)
        with os.fdopen(fd, "w") as lock:
            # agy cancels scripts after five seconds. Do not let lock contention
            # consume that budget or disable the original terminal status line.
            for attempt in range(6):
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if attempt == 5:
                        return snapshot
                    time.sleep(0.02)
            previous = read_snapshot(state_path, 16 * 1024 * 1024)
            if previous and previous.get("_monotonic_ns", 0) > monotonic_ns:
                return public_snapshot(previous)
            snapshot = advance(snapshot, previous, monotonic_ns)
            old = object_value(previous)
            boundary = (old.get("state") != snapshot["state"]
                        or object_value(old.get("turn")).get("running") != snapshot["turn"]["running"])
            cached_usage(snapshot, state_dir, monotonic_ns, force=boundary, legacy_state=old.get("_usage"))
            atomic_write(state_path, snapshot)
            if snapshot["transcript_path"] and snapshot["session_id"]:
                suffix = f".{terminal_id}" if terminal_id else ""
                destination = Path(f"{snapshot['transcript_path']}.flockbook-status{suffix}.json")
                atomic_write(destination, public_snapshot(snapshot))
    except (OSError, ValueError, TypeError):
        # Cache availability must never take away the terminal's own status line.
        pass
    return public_snapshot(snapshot)


def main():
    if len(sys.argv) > 1:
        parser = argparse.ArgumentParser(description=__doc__)
        parser.add_argument("--read", required=True, help="Exact per-terminal status artifact")
        parser.add_argument("--terminal", required=True, help="Bare Herdr terminal ID")
        args = parser.parse_args()
        print(json.dumps(read_current(args.read, args.terminal), ensure_ascii=False, allow_nan=False, separators=(",", ":")))
        return
    try:
        raw = sys.stdin.read(MAX_PAYLOAD + 1)
        payload = json.loads(raw) if len(raw) <= MAX_PAYLOAD else {}
    except (ValueError, OSError):
        payload = {}
    print(json.dumps(update(payload), ensure_ascii=False, allow_nan=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
