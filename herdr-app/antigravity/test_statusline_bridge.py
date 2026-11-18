"""Synthetic integration checks; never read a real agent's log or settings."""
import copy
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

import statusline_bridge as bridge


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.state = self.root / "state"
        self.transcript = self.root / ".gemini/antigravity-cli/brain/session-a/.system_generated/logs/transcript_full.jsonl"
        self.transcript.parent.mkdir(parents=True)
        self.transcript.write_text(json.dumps({"type": "PLANNER_RESPONSE", "step_index": 1,
                                              "input_tokens": 169032, "output_tokens": 208355}) + "\n")
        self.payload = {
            "conversation_id": "session-a", "session_id": "session-a",
            "transcript_path": str(self.transcript), "agent_state": "idle",
            "model": {"display_name": "Gemini 4 Carbon", "effort": "High"},
            "context_window": {"total_input_tokens": 169032, "total_output_tokens": 208355},
        }

    def tearDown(self):
        self.temporary.cleanup()

    def update(self, seconds, state=None, terminal="t1", producer="100:123", payload=None, **extra):
        p = copy.deepcopy(payload if payload is not None else self.payload)
        if state:
            p["agent_state"] = state
        p.update(extra)
        return bridge.update(p, state_dir=self.state, terminal_id=terminal, producer=producer,
                             wall_ms=1_000_000 + seconds * 1000, monotonic_ns=seconds * 1_000_000_000)

    def artifact(self, terminal="t1"):
        return Path(f"{self.transcript}.flockbook-status.{terminal}.json")

    def read(self, seconds, terminal="t1", alive=True):
        return bridge.read_current(str(self.artifact(terminal)), terminal, state_dir=self.state,
                                   monotonic_ns=seconds * 1_000_000_000, wall_ms=999_999,
                                   alive=lambda _producer: alive)

    def test_unknown_cost_is_distinct_from_reported_zero(self):
        self.assertIsNone(self.update(1)["cost_usd"])
        self.assertEqual(self.update(2, cost={"total_usd": 0})["cost_usd"], 0)
        self.assertEqual(self.update(3, cost={"total_usd": 0.000001})["cost_usd"], 0.000001)
        for value in (-1, float("nan"), float("inf"), True, "0.25"):
            self.assertIsNone(self.update(4, cost={"total_usd": value})["cost_usd"])

    def test_active_only_timer_pauses_for_confirmation_and_idle(self):
        self.update(1, "idle")
        first = self.update(5, "working")
        self.assertEqual(first["turn"]["elapsed_ms"], 0)
        self.assertTrue(first["turn"]["complete"])
        running = self.update(10, "tool_use")
        self.assertEqual(running["turn"]["elapsed_ms"], 5000)
        pending = self.update(12, "tool_use", tool_confirmation_pending=True)
        self.assertEqual(pending["turn"]["elapsed_ms"], 7000)
        self.assertFalse(pending["turn"]["running"])
        self.update(50, "reviewing")
        resumed = self.update(80, "working")
        self.assertEqual(resumed["turn"]["elapsed_ms"], 7000)
        ended = self.update(83, "idle")
        self.assertEqual(ended["turn"]["elapsed_ms"], 10000)
        self.assertTrue(ended["turn"]["finished"])
        self.assertEqual(self.update(900, "idle")["turn"]["elapsed_ms"], 10000)
        next_turn = self.update(1000, "working")
        self.assertEqual(next_turn["turn"]["elapsed_ms"], 0)
        self.assertNotEqual(first["turn"]["id"], next_turn["turn"]["id"])

    def test_install_midturn_is_unknown_until_next_observed_boundary(self):
        partial = self.update(10, "working")
        self.assertFalse(partial["turn"]["complete"])
        self.assertIsNone(partial["turn"]["elapsed_ms"])
        self.assertIsNone(self.update(30, "idle")["turn"]["elapsed_ms"])
        self.assertEqual(self.update(60, "working")["turn"]["elapsed_ms"], 0)

    def test_first_turn_uses_idle_without_a_conversation(self):
        empty = {"agent_state": "idle", "conversation_id": "", "session_id": ""}
        self.update(1, payload=empty)
        first = self.update(2, "working")
        self.assertTrue(first["turn"]["complete"])
        self.assertEqual(self.update(5, "idle")["turn"]["elapsed_ms"], 3000)

    def test_queued_message_does_not_restart_work(self):
        self.update(1, "idle")
        first = self.update(2, "working")
        queued = self.update(12, "working", pending_input_count=2)
        self.assertEqual(queued["turn"]["id"], first["turn"]["id"])
        self.assertEqual(queued["turn"]["elapsed_ms"], 10000)

    def test_error_finishes_and_authentication_is_not_work(self):
        self.update(1, "idle")
        self.update(2, "working")
        self.update(5, "authenticating")
        self.update(50, "working")
        self.assertEqual(self.update(52, "error")["turn"]["elapsed_ms"], 5000)
        self.assertEqual(self.read(500)["turn"]["elapsed_ms"], 5000)

    def test_reader_samples_old_active_snapshot_without_host_clock_subtraction(self):
        self.update(1, "idle")
        self.update(5, "working")
        sample = self.read(65)
        self.assertEqual(sample["turn"]["elapsed_ms"], 60000)
        self.assertEqual(sample["observed_at_ms"], 1_005_000)
        self.assertEqual(sample["sampled_at_ms"], 999_999)
        self.assertTrue(sample["producer_alive"])
        self.assertEqual(self.read(70)["turn"]["elapsed_ms"], 65000)
        self.assertEqual(json.loads(self.artifact().read_text())["turn"]["elapsed_ms"], 0,
                         "reads never change the producer's timing state")

    def test_reader_refreshes_usage_flushed_after_last_status_callback(self):
        self.update(1, "idle")
        with self.transcript.open("a") as handle:
            handle.write(json.dumps({"type": "CHECKPOINT", "step_index": 2,
                                    "input_tokens": 20, "cache_read_tokens": 40, "output_tokens": 30}) + "\n")
        sample = self.read(10)
        self.assertEqual(sample["input_tokens"], 169052)
        self.assertEqual(sample["output_tokens"], 208385)
        self.assertEqual(sample["input_cached_tokens"], 40)

    def test_reader_refuses_stopped_process_wrong_terminal_or_mismatched_cache(self):
        self.update(1, "idle")
        self.assertIsNone(self.read(2, alive=False))
        self.assertIsNone(bridge.read_current(str(self.artifact()), "t2", state_dir=self.state, alive=lambda _: True))
        snap = json.loads(self.artifact().read_text())
        snap["session_id"] = "session-other"
        self.artifact().write_text(json.dumps(snap))
        self.assertIsNone(self.read(2))

    def test_same_conversation_two_terminals_are_separate(self):
        self.update(1, "idle", terminal="t1", producer="100:123")
        self.update(2, "working", terminal="t1", producer="100:123")
        self.update(3, "idle", terminal="t2", producer="101:234")
        self.update(4, "working", terminal="t2", producer="101:234")
        self.assertEqual(self.read(10, "t1")["turn"]["elapsed_ms"], 8000)
        self.assertEqual(self.read(10, "t2")["turn"]["elapsed_ms"], 6000)
        self.assertEqual(self.artifact().stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.state.stat().st_mode & 0o777, 0o700)

    def test_new_producer_and_new_session_do_not_reuse_old_duration(self):
        self.update(1, "idle")
        self.update(2, "working")
        restarted = self.update(50, "working", producer="200:456")
        self.assertIsNone(restarted["turn"]["elapsed_ms"])
        fresh = self.update(51, "working", conversation_id="session-new", producer="200:456")
        self.assertIsNone(fresh["transcript_path"])
        self.assertIsNone(fresh["turn"]["elapsed_ms"])

    def test_out_of_order_callback_cannot_revert_newer_idle(self):
        self.update(1, "idle")
        self.update(2, "working")
        self.update(8, "idle")
        late = self.update(7, "working")
        self.assertEqual(late["state"], "idle")
        self.assertEqual(self.read(10)["turn"]["elapsed_ms"], 6000)

    def test_actual_buggy_documented_path_maps_to_the_exact_full_log(self):
        p = copy.deepcopy(self.payload)
        p["transcript_path"] = str(self.transcript).replace("antigravity-cli/", "antigravity/").replace("transcript_full.jsonl", "transcript.jsonl")
        self.assertEqual(bridge.transcript_path(p), str(self.transcript))
        p["conversation_id"] = "wrong-session"
        self.assertIsNone(bridge.transcript_path(p))

    def test_private_payload_fields_do_not_escape(self):
        result = self.update(1, email="private@example.invalid", access_token="private-token", quota={"private": 1})
        serialized = self.artifact().read_text()
        self.assertNotIn("private", serialized)
        self.assertNotIn("_monotonic_ns", serialized)
        self.assertEqual(result["model"], {"name": "Gemini 4 Carbon", "effort": "High"})

    def test_malformed_payload_does_not_destroy_previous_timing(self):
        self.update(1, "idle")
        self.update(2, "working")
        before = self.artifact().read_text()
        self.update(3, payload={})
        self.assertEqual(self.artifact().read_text(), before)
        self.assertEqual(self.update(5, "idle")["turn"]["elapsed_ms"], 3000)

    def test_artifact_symlink_is_not_followed(self):
        target = self.root / "keep.txt"
        target.write_text("unchanged")
        self.artifact().symlink_to(target)
        self.update(1, "idle")
        self.assertEqual(target.read_text(), "unchanged")

    def test_nonfinite_and_control_values_do_not_reach_terminal_metadata(self):
        p = copy.deepcopy(self.payload)
        p["model"]["display_name"] = "Gemini\x1b[31m\nname"
        p["context_window"] = {"total_input_tokens": -1, "total_output_tokens": float("inf")}
        self.transcript.write_text(json.dumps({"type": "PLANNER_RESPONSE", "step_index": 1,
                                              "input_tokens": -1, "output_tokens": -1}) + "\n")
        result = self.update(1, payload=p)
        self.assertIsNone(result["input_tokens"])
        self.assertIsNone(result["output_tokens"])
        self.assertNotIn("\x1b", result["model"]["name"])


class TerminalScriptTests(unittest.TestCase):
    def render(self, payload):
        run = subprocess.run(["bash", str(Path(__file__).with_name("statusline.sh"))],
                             input=payload if isinstance(payload, str) else json.dumps(payload),
                             text=True, capture_output=True, timeout=5)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(run.stderr, "")
        return re.sub(r"\x1b\[[0-9;]*m", "", run.stdout)

    def test_terminal_keeps_model_grouping_and_ansi_layout_without_false_cost(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "brain/synthetic/.system_generated/logs/transcript_full.jsonl"
            path.parent.mkdir(parents=True)
            path.write_text(json.dumps({"type": "PLANNER_RESPONSE", "step_index": 1,
                                       "input_tokens": 169032, "output_tokens": 208355}) + "\n")
            result = self.render({"model": {"display_name": "Gemini 4 Carbon", "effort": "High"},
                                  "context_window": {"total_input_tokens": 100, "total_output_tokens": 208355},
                                  "conversation_id": "synthetic", "transcript_path": str(path),
                                  "agent_state": "idle", "terminal_width": 150})
        self.assertIn("Gemini 4 Carbon (High)", result)
        self.assertIn("In: 169,032", result)
        self.assertIn("Out: 208,355", result)
        self.assertIn("Est: N/A", result)
        self.assertNotIn("Session", result)
        self.assertNotIn("$0.0000", result)

    def test_explicit_zero_and_tiny_positive_cost_are_distinct(self):
        self.assertIn("Est: $0.0000", self.render({"cost": {"total_usd": 0}}))
        self.assertIn("Est: <$0.0001", self.render({"cost": {"total_usd": 0.000001}}))
        self.assertIn("(sub $0.2500)", self.render({"cost": {"total_usd": 1, "subagent_usd": 0.25}}))

    def test_malformed_stdin_and_missing_fields_still_render(self):
        self.assertIn("Est: N/A", self.render("not json"))
        self.assertIn("Model: N/A", self.render({}))


if __name__ == "__main__":
    unittest.main()
