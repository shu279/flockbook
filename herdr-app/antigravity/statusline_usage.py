"""Cumulative agy usage from the exact conversation's append-only full transcript.

The v1.5 status API's total_input_tokens is a context estimate, not cumulative
usage. Full transcript records report input and cached input separately. This
module never reads another session, writes files, or returns conversation text.
"""

import json
import math
import os
from pathlib import Path
import time

MAX_BYTES = 64 * 1024 * 1024
MAX_RECORDS = 100_000
MAX_SECONDS = 1.0
MAX_TOKEN = 2**53 - 1
FIELDS = ("input_tokens", "output_tokens", "input_cached_tokens")


def unavailable():
    return {**dict.fromkeys(FIELDS), "source": "transcript"}


def token(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not math.isfinite(value) or value < 0 or value > MAX_TOKEN or int(value) != value:
        return None
    return int(value)


def aggregate(rows):
    result = {"source": "transcript"}
    for index, field in enumerate(FIELDS):
        values = [row[index] for row in rows.values()]
        result[field] = None if any(v is None for v in values) else token(sum(values))
    return result


def usage(path, previous_state=None):
    """Return (totals, private JSON state); reuse the state for incremental reads.

    Completed lines are authoritative. Records without any usage fields (for
    example a canceled response) report no usage and are skipped, as in agy's
    cumulative output counter. A partial trailing line waits until its
    newline arrives. Repeated step indexes replace earlier usage, including a
    corrected CHECKPOINT. Missing, corrupt, oversized or slow logs yield unknown
    totals rather than a misleading partial sum. The caller may persist state;
    readers can reuse it without modifying any file.
    """
    started = time.monotonic()
    try:
        path = str(Path(path))
        with open(path, "rb") as stream:
            stat = os.fstat(stream.fileno())
            if stat.st_size > MAX_BYTES:
                return unavailable(), None
            old = previous_state if isinstance(previous_state, dict) else {}
            rows = old.get("rows")
            reusable = (
                old.get("version") == 1 and old.get("path") == path
                and old.get("dev") == stat.st_dev and old.get("ino") == stat.st_ino
                and isinstance(old.get("offset"), int) and isinstance(old.get("size"), int)
                and 0 <= old["offset"] <= old["size"] <= stat.st_size
                and (old["size"] < stat.st_size or old.get("mtime_ns") == stat.st_mtime_ns)
                and isinstance(rows, dict) and len(rows) <= MAX_RECORDS
            )
            if reusable:
                reusable = all(isinstance(row, list) and len(row) == 3
                    and all(v is None or token(v) is not None for v in row) for row in rows.values())
            rows = dict(rows) if reusable else {}
            offset = old["offset"] if reusable else 0
            stream.seek(offset)
            # Read only the size observed by fstat. Concurrent appends belong to
            # the next snapshot and must not make this read unbounded.
            remaining = stat.st_size - offset
            while remaining:
                line = stream.readline(remaining)
                if not line or not line.endswith(b"\n"):
                    break
                remaining -= len(line)
                offset += len(line)
                if time.monotonic() - started > MAX_SECONDS:
                    return unavailable(), None
                if not line.strip():
                    continue
                row = json.loads(line)
                if not isinstance(row, dict):
                    return unavailable(), None
                if row.get("type") not in {"PLANNER_RESPONSE", "CHECKPOINT"}:
                    continue
                step = token(row.get("step_index"))
                if not any(key in row for key in ("input_tokens", "output_tokens", "cache_read_tokens")):
                    if step is not None:
                        rows.pop(str(step), None)
                    continue
                if step is None:
                    return unavailable(), None
                rows[str(step)] = [token(row.get("input_tokens")), token(row.get("output_tokens")),
                                   token(row.get("cache_read_tokens", 0))]
                if len(rows) > MAX_RECORDS:
                    return unavailable(), None
            if os.fstat(stream.fileno()).st_size < stat.st_size:
                return unavailable(), None
            state = {"version": 1, "path": path, "dev": stat.st_dev, "ino": stat.st_ino,
                     "size": stat.st_size, "mtime_ns": stat.st_mtime_ns, "offset": offset, "rows": rows}
            return aggregate(rows), state
    except (OSError, ValueError, TypeError, OverflowError):
        return unavailable(), None


def totals(path):
    return usage(path)[0]
