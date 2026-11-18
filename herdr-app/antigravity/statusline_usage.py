"""Cumulative agy usage from the exact conversation's append-only full transcript.

The v1.5 status API's total_input_tokens is a context estimate, not cumulative
usage. Full transcript records report input and cached input separately.
Parent counters stay separate. Cost usage also follows explicit subagent creation
links within the same brain directory; unrelated sessions are never scanned.
This module never writes files. Subagent previews contain only bounded visible
assistant responses and role names; prompts and thinking are never retained.
"""

import json
import math
import os
from pathlib import Path
import re
import time
from collections import deque
from datetime import datetime
from urllib.parse import urlsplit

MAX_BYTES = 64 * 1024 * 1024
MAX_RECORDS = 100_000
MAX_SECONDS = 1.0
MAX_TREE_SECONDS = 2.0
MAX_TREE_BYTES = 128 * 1024 * 1024
MAX_TREE_NODES = 64
MAX_TREE_DEPTH = 8
MAX_STATE_BYTES = 8 * 1024 * 1024
MAX_MODEL_BUCKETS = 256
MAX_TOKEN = 2**53 - 1
FIELDS = ("input_tokens", "output_tokens", "input_cached_tokens")
MODEL_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}\Z")
CONVERSATION_ID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\Z")
TIMESTAMP = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})\Z")


def display_text(value, limit, byte_limit):
    if not isinstance(value, str):
        return ""
    value = value[:max(1024, limit * 8)]
    value = " ".join("".join(c for c in value if c.isprintable() or c.isspace()).split())[:limit]
    return value.encode("utf-8")[:byte_limit].decode("utf-8", errors="ignore")


def timestamp(value):
    return value if isinstance(value, str) and TIMESTAMP.fullmatch(value) else None


def last_activity(row, previous):
    """DONE is a record status, never proof that a subagent has completed."""
    step = token(row.get("step_index"))
    if step is None or step < previous.get("step", -1) or row.get("type") not in {"PLANNER_RESPONSE", "GENERIC"}:
        return previous
    if row.get("type") == "GENERIC" and row.get("source") != "MODEL":
        return previous
    summary = display_text(row.get("content"), 240, 480) if row.get("type") == "PLANNER_RESPONSE" else ""
    responded = (row.get("type") == "PLANNER_RESPONSE" and row.get("status") == "DONE"
                 and not row.get("tool_calls") and bool(summary))
    return {"step": step, "state": "responded" if responded else "unknown",
            "summary": summary or None, "updated_at": timestamp(row.get("created_at"))}


def unavailable():
    return {**dict.fromkeys(FIELDS), "source": "transcript", "usage_scope": "conversation",
            "usage_complete": False, "usage_by_model": None}


def token(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not math.isfinite(value) or value < 0 or value > MAX_TOKEN or int(value) != value:
        return None
    return int(value)


def model_id(value):
    """Keep only a model identifier, never arbitrary text from a transcript."""
    return value if isinstance(value, str) and MODEL_ID.fullmatch(value) else None


def counters(rows):
    result = {}
    for index, field in enumerate(FIELDS):
        values = [row[index] for row in rows]
        result[field] = None if any(v is None for v in values) else token(sum(values))
    return result


def aggregate(rows):
    result = {"source": "transcript", "usage_scope": "conversation", **counters(rows.values())}
    by_model = {}
    for row in rows.values():
        by_model.setdefault(row[3], []).append(row)
    # CHECKPOINT records have usage but no model. Leave them in an explicit
    # unknown bucket; the current or neighbouring model is not evidence of the
    # model that produced a compaction summary.
    result["usage_by_model"] = limit_buckets([
        {"model": model, "requests": len(group), **counters(group)}
        for model, group in sorted(by_model.items(), key=lambda item: (item[0] is None, item[0] or ""))
    ])
    result["usage_complete"] = all(result[field] is not None for field in FIELDS)
    return result


def merge_bucket(model, group):
    return {"model": model, "requests": token(sum(item["requests"] for item in group)),
            **counters([[item[field] for field in FIELDS] for item in group])}


def limit_buckets(buckets):
    # Bound the public snapshot independently of the private cache. Overflow
    # becomes explicitly unpriced usage rather than disappearing from totals.
    if len(buckets) <= MAX_MODEL_BUCKETS:
        return buckets
    kept = buckets[:MAX_MODEL_BUCKETS - 1]
    return kept + [merge_bucket(None, buckets[MAX_MODEL_BUCKETS - 1:])]


def brain_location(path):
    """A full transcript establishes the only directory links may target."""
    path = Path(path).resolve()
    if (path.name == "transcript_full.jsonl" and path.parent.name == "logs"
            and path.parent.parent.name == ".system_generated"
            and CONVERSATION_ID.fullmatch(path.parent.parent.parent.name)):
        return path.parent.parent.parent.parent, path.parent.parent.parent.name
    return None, None


def file_fingerprint(path, *, canonical=True):
    """Cheap invalidation only; no transcript contents are read here."""
    try:
        path = Path(path)
        if canonical and path.resolve() != path:
            return None
        stat = path.stat()
        return [stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns]
    except (OSError, ValueError, TypeError, RuntimeError):
        return None


def usage_fingerprint(path, watched=()):
    """Watch the exact parent and its validated linked children, including missing logs."""
    try:
        brain, _ = brain_location(path)
        result = {"parent": file_fingerprint(path, canonical=False)}
        for child in list(watched)[:MAX_TREE_NODES]:
            if brain is not None and isinstance(child, str) and CONVERSATION_ID.fullmatch(child):
                result[child] = file_fingerprint(brain / child / ".system_generated" / "logs" / "transcript_full.jsonl")
        return result
    except (OSError, ValueError, TypeError, RuntimeError):
        return {"parent": None}


def child_creation(row, brain):
    """Read the structured creation result, never UUIDs in arbitrary prose."""
    content = row.get("content")
    if (brain is None or row.get("source") != "MODEL" or row.get("status") != "DONE"
            or not isinstance(content, str) or len(content) > 65536):
        return None
    start = content.find("{")
    if start < 0:
        return None
    try:
        value, _ = json.JSONDecoder().raw_decode(content, start)
        if (not isinstance(value, dict)
                or set(value) != {"conversationId", "logAbsoluteUri", "workspaceUris"}
                or not isinstance(value["conversationId"], str)
                or not CONVERSATION_ID.fullmatch(value["conversationId"])
                or not isinstance(value["workspaceUris"], list)
                or not all(isinstance(uri, str) for uri in value["workspaceUris"])
                or not isinstance(value["logAbsoluteUri"], str)):
            return None
        child = value["conversationId"]
        expected = brain / child / ".system_generated" / "logs" / "transcript.jsonl"
        uri = urlsplit(value["logAbsoluteUri"])
        if (uri.scheme != "file" or uri.netloc or uri.query or uri.fragment
                or value["logAbsoluteUri"] != expected.as_uri()
                or expected.resolve() != expected):
            return None
        return child
    except (ValueError, OSError, RuntimeError):
        return None


def managed_children(row, brain):
    """UUID-bound last-recorded state from a manage_subagents result array."""
    content = row.get("content")
    if (brain is None or row.get("source") != "MODEL" or row.get("status") != "DONE"
            or not isinstance(content, str) or len(content) > 65536):
        return {}
    start = content.find("[")
    if start < 0:
        return {}
    try:
        values, _ = json.JSONDecoder().raw_decode(content, start)
        if not isinstance(values, list) or len(values) > MAX_TREE_NODES:
            return {}
        result = {}
        for value in values:
            required = {"role", "type", "conversationId", "transcript", "state", "lastStepTime"}
            if (not isinstance(value, dict) or not required.issubset(value)
                    or set(value) - required - {"stateDetail"}
                    or not isinstance(value["conversationId"], str)
                    or not CONVERSATION_ID.fullmatch(value["conversationId"])):
                continue
            child = value["conversationId"]
            expected = brain / child / ".system_generated" / "logs" / "transcript.jsonl"
            if value["transcript"] != expected.as_uri() or expected.resolve() != expected:
                continue
            state = {"running": "working", "idle": "waiting", "waiting_for_dependents": "waiting"}.get(value["state"])
            updated = timestamp(value["lastStepTime"])
            if state and updated:
                result[child] = {"name": display_text(value["role"], 80, 160), "state": state, "updated_at": updated}
        return result
    except (OSError, ValueError, TypeError, RuntimeError):
        return {}


def newer_time(first, second):
    try:
        return datetime.fromisoformat(first.replace("Z", "+00:00")) >= datetime.fromisoformat(second.replace("Z", "+00:00"))
    except (ValueError, TypeError, AttributeError):
        return first is not None and second is None


def valid_calls(calls, active):
    if not isinstance(calls, dict) or len(calls) > MAX_RECORDS or (active is not None and active not in calls):
        return False
    for step, call in calls.items():
        if (not isinstance(step, str) or not step.isdigit() or not isinstance(call, dict)
                or set(call) != {"expected", "children", "name"}
                or token(call["expected"]) is None or call["expected"] < 1
                or not isinstance(call["name"], str) or call["name"] != display_text(call["name"], 80, 160)
                or not isinstance(call["children"], dict)
                or len(call["children"]) > call["expected"]):
            return False
        if any(not isinstance(key, str) or not key.isdigit() or not isinstance(child, str)
               or not CONVERSATION_ID.fullmatch(child) for key, child in call["children"].items()):
            return False
    return True


def valid_activity(value):
    return value == {} or (isinstance(value, dict) and set(value) == {"step", "state", "summary", "updated_at"}
            and token(value["step"]) is not None and value["state"] in {"responded", "unknown"}
            and (value["summary"] is None or (isinstance(value["summary"], str)
                 and value["summary"] == display_text(value["summary"], 240, 480)))
            and (value["updated_at"] is None or timestamp(value["updated_at"]) is not None))


def valid_managed(value):
    if not isinstance(value, dict) or len(value) > MAX_TREE_NODES:
        return False
    return all(isinstance(child, str) and CONVERSATION_ID.fullmatch(child)
               and isinstance(info, dict) and set(info) == {"name", "state", "updated_at"}
               and isinstance(info["name"], str) and info["name"] == display_text(info["name"], 80, 160)
               and info["state"] in {"working", "waiting"} and timestamp(info["updated_at"]) is not None
               for child, info in value.items())


def read_usage(path, previous_state=None, deadline=None, *, preview=False):
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
        brain, _ = brain_location(path)
        with open(path, "rb") as stream:
            stat = os.fstat(stream.fileno())
            if stat.st_size > MAX_BYTES:
                return unavailable(), None
            old = previous_state if isinstance(previous_state, dict) else {}
            rows = old.get("rows")
            reusable = (
                old.get("version") == 4 and old.get("path") == path
                and old.get("preview") is preview
                and old.get("dev") == stat.st_dev and old.get("ino") == stat.st_ino
                and isinstance(old.get("offset"), int) and isinstance(old.get("size"), int)
                and 0 <= old["offset"] <= old["size"] <= stat.st_size
                and (old["size"] < stat.st_size or (old.get("mtime_ns") == stat.st_mtime_ns
                     and old.get("ctime_ns") == stat.st_ctime_ns))
                and isinstance(rows, dict) and len(rows) <= MAX_RECORDS
                and valid_calls(old.get("calls"), old.get("active_call"))
                and valid_activity(old.get("latest")) and valid_managed(old.get("managed"))
                and isinstance(old.get("managing"), bool)
            )
            if reusable:
                reusable = all(isinstance(row, list) and len(row) == 4
                    and all(v is None or token(v) is not None for v in row[:3])
                    and (row[3] is None or model_id(row[3]) is not None) for row in rows.values())
            rows = dict(rows) if reusable else {}
            calls = {step: {"expected": call["expected"], "children": dict(call["children"]), "name": call["name"]}
                     for step, call in old["calls"].items()} if reusable else {}
            active = old.get("active_call") if reusable else None
            latest = old.get("latest", {}) if reusable else {}
            if not isinstance(latest, dict):
                latest = {}
            managed = dict(old.get("managed", {})) if reusable and isinstance(old.get("managed"), dict) else {}
            managing = old.get("managing") is True if reusable else False
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
                now = time.monotonic()
                if now - started > MAX_SECONDS or (deadline is not None and now > deadline):
                    return unavailable(), None
                if not line.strip():
                    continue
                row = json.loads(line)
                if not isinstance(row, dict):
                    return unavailable(), None
                if preview:
                    latest = last_activity(row, latest)
                step = token(row.get("step_index"))
                if row.get("type") == "PLANNER_RESPONSE" and step is None:
                    return unavailable(), None
                if row.get("type") == "PLANNER_RESPONSE" and step is not None:
                    tools = row.get("tool_calls")
                    if tools is None:
                        tools = []
                    managing = isinstance(tools, list) and any(isinstance(tool, dict) and tool.get("name") == "manage_subagents" for tool in tools)
                    # Unknown tool metadata cannot establish that all children
                    # were discovered. Represent it as one unresolved result.
                    expected = (sum(not isinstance(tool, dict) or not isinstance(tool.get("name"), str)
                                    or tool["name"] == "invoke_subagent" for tool in tools)
                                if isinstance(tools, list) else 1)
                    key = str(step)
                    if expected:
                        invokes = [tool for tool in tools if isinstance(tool, dict) and tool.get("name") == "invoke_subagent"] if isinstance(tools, list) else []
                        args = invokes[0].get("args") if len(invokes) == 1 and expected == 1 else None
                        name = display_text(args.get("Role"), 80, 160) if isinstance(args, dict) else ""
                        if key not in calls or calls[key]["expected"] != expected:
                            calls[key] = {"expected": expected, "children": {}, "name": name}
                        else:
                            calls[key]["name"] = name
                        active = key
                    else:
                        calls.pop(key, None)
                        active = None
                    if len(calls) > MAX_RECORDS:
                        return unavailable(), None
                elif row.get("type") == "GENERIC" and step is not None:
                    if managing:
                        managed.update(managed_children(row, brain))
                        if len(managed) > MAX_TREE_NODES:
                            managed = dict(list(managed.items())[-MAX_TREE_NODES:])
                    key = str(step)
                    owner = next((key_call for key_call, call in calls.items() if key in call["children"]), active)
                    if owner is not None and step > int(owner):
                        call = calls[owner]
                        if key in call["children"] or len(call["children"]) < call["expected"]:
                            child = child_creation(row, brain)
                            if child:
                                call["children"][key] = child
                            else:
                                call["children"].pop(key, None)
                if row.get("type") not in {"PLANNER_RESPONSE", "CHECKPOINT"}:
                    continue
                if not any(key in row for key in ("input_tokens", "output_tokens", "cache_read_tokens")):
                    if step is not None:
                        rows.pop(str(step), None)
                    continue
                if step is None:
                    return unavailable(), None
                rows[str(step)] = [token(row.get("input_tokens")), token(row.get("output_tokens")),
                                   token(row.get("cache_read_tokens", 0)), model_id(row.get("model"))]
                if len(rows) > MAX_RECORDS:
                    return unavailable(), None
            if os.fstat(stream.fileno()).st_size < stat.st_size:
                return unavailable(), None
            state = {"version": 4, "path": path, "dev": stat.st_dev, "ino": stat.st_ino,
                     "size": stat.st_size, "mtime_ns": stat.st_mtime_ns, "ctime_ns": stat.st_ctime_ns,
                     "offset": offset, "rows": rows,
                     "calls": calls, "active_call": active, "latest": latest,
                     "managed": managed, "managing": managing, "preview": preview}
            return aggregate(rows), state
    except (OSError, ValueError, TypeError, OverflowError, RuntimeError):
        return unavailable(), None


def combine_usage(usages):
    """Merge model buckets, preserving missing counters as unknown."""
    models = {}
    for item in usages:
        for bucket in item["usage_by_model"]:
            models.setdefault(bucket["model"], []).append(bucket)
    buckets = []
    for model, group in sorted(models.items(), key=lambda item: (item[0] is None, item[0] or "")):
        buckets.append(merge_bucket(model, group))
    return {**counters([[item[field] for field in FIELDS] for item in usages]), "usage_by_model": limit_buckets(buckets)}


def usage(path, previous_state=None):
    """Return parent usage plus a bounded subtotal of explicitly linked children.

    ``conversations`` counts readable logs including the parent. Missing links,
    files and traversal limits make the cost subtotal incomplete. Cached child
    states are returned to the caller without writing any file. Creation links
    are accepted only in the response block of an invoke_subagent tool call.
    """
    deadline = time.monotonic() + MAX_TREE_SECONDS
    parent, state = read_usage(path, previous_state, deadline)
    tree = {**unavailable(), "usage_scope": "conversation_tree", "conversations": 0,
            "missing_conversations": 1}
    if state is None:
        return {**parent, "cost_usage": tree, "subagents": None}, None
    brain, parent_id = brain_location(path)
    visited = {parent_id}
    queue = deque()
    usages = []
    children = {}
    old_children = previous_state.get("child_states", {}) if isinstance(previous_state, dict) else {}
    if not isinstance(old_children, dict):
        old_children = {}
    total_bytes = 0
    attempted = 1
    missing = 0
    complete = True
    items = []
    managed = {}
    observed_files = {}

    def include(item, item_state, depth, owner):
        nonlocal missing, complete, total_bytes
        usages.append(item)
        observed_files["parent" if owner == parent_id else owner] = [item_state[field] for field in ("dev", "ino", "size", "mtime_ns", "ctime_ns")]
        total_bytes += item_state["size"]
        complete = complete and item["usage_complete"] and item_state["offset"] == item_state["size"]
        for child, info in item_state.get("managed", {}).items():
            old = managed.get(child)
            if not old or newer_time(info.get("updated_at"), old.get("updated_at")):
                managed[child] = info
        for call in item_state["calls"].values():
            missing += call["expected"] - len(call["children"])
            for child in call["children"].values():
                if child not in visited:
                    visited.add(child)
                    queue.append((child, depth + 1, owner, call["name"]))

    include(parent, state, 0, parent_id)
    while queue:
        child, depth, owner, name = queue.popleft()
        item_info = {"id": child, "parent_id": owner, "name": name or "Subagent " + child[:8],
                     "state": "unknown", "state_current": False, "summary": None, "updated_at": None}
        if len(items) < MAX_TREE_NODES:
            items.append(item_info)
        child_path = brain / child / ".system_generated" / "logs" / "transcript_full.jsonl" if brain is not None else None
        if len(observed_files) <= MAX_TREE_NODES:
            observed_files[child] = file_fingerprint(child_path)
        if (attempted >= MAX_TREE_NODES or depth > MAX_TREE_DEPTH or brain is None
                or total_bytes >= MAX_TREE_BYTES or time.monotonic() >= deadline):
            missing += 1
            continue
        attempted += 1
        try:
            safe = child_path.resolve() == child_path and child_path.stat().st_size + total_bytes <= MAX_TREE_BYTES
        except (OSError, RuntimeError):
            safe = False
        if not safe:
            missing += 1
            continue
        item, item_state = read_usage(child_path, old_children.get(child), deadline, preview=True)
        if item_state is None:
            missing += 1
            continue
        children[child] = item_state
        latest = item_state.get("latest", {})
        item_info.update({key: latest.get(key) for key in ("summary", "updated_at")})
        item_info["state"] = latest.get("state", "unknown")
        include(item, item_state, depth, child)
    state["child_states"] = children
    state["watched_children"] = [child for child in observed_files if child != "parent"][:MAX_TREE_NODES]
    state["observed_files"] = observed_files
    tree = {**combine_usage(usages), "source": "transcript", "usage_scope": "conversation_tree",
            "usage_complete": complete and missing == 0, "conversations": len(usages),
            "missing_conversations": missing}
    for item in items:
        info = managed.get(item["id"])
        if info:
            if info.get("name"):
                item["name"] = info["name"]
            if newer_time(info.get("updated_at"), item.get("updated_at")):
                item.update({key: info[key] for key in ("state", "updated_at")})
    subagents = {"parent_id": parent_id, "complete": complete and missing == 0,
                "missing": missing, "items": items}
    # This state is embedded beside the status/clock in a 16 MiB bridge cache.
    # Discard optional incremental caches before allowing them to crowd out the
    # clock. A future read reparses logs; the current public subtotal is intact.
    if len(json.dumps(state, separators=(",", ":"))) > MAX_STATE_BYTES:
        state.pop("child_states", None)
        if len(json.dumps(state, separators=(",", ":"))) > MAX_STATE_BYTES:
            state = {"version": 0, "watched_children": state["watched_children"], "observed_files": observed_files}
    return {**parent, "cost_usage": tree, "subagents": subagents}, state


def totals(path):
    return usage(path)[0]
