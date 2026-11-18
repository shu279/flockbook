import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from statusline_usage import usage, usage_fingerprint


class UsageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "transcript_full.jsonl"

    def write(self, rows, mode="w"):
        with self.path.open(mode) as stream:
            for row in rows:
                stream.write(json.dumps(row) + "\n")

    def row(self, step=1, input=8855, output=133, cache=0, kind="PLANNER_RESPONSE", model=None):
        row = dict(type=kind, status="DONE", step_index=step, input_tokens=input,
                   output_tokens=output, cache_read_tokens=cache)
        if model is not None:
            row["model"] = model
        return row

    def test_cumulative_input_separate_from_cache_and_context_estimate(self):
        self.write([self.row(), self.row(3, 3060, 179, 6801)])
        got, _ = usage(self.path)
        tree = got.pop("cost_usage")
        self.assertEqual(got.pop("subagents")["items"], [])
        self.assertEqual((tree["conversations"], tree["missing_conversations"]), (1, 0))
        self.assertEqual(tree["input_tokens"], got["input_tokens"])
        self.assertEqual(got, dict(input_tokens=11915, output_tokens=312,
                                  input_cached_tokens=6801, source="transcript",
                                  usage_scope="conversation", usage_complete=True,
                                  usage_by_model=[dict(model=None, requests=2, input_tokens=11915,
                                                      output_tokens=312, input_cached_tokens=6801)]))

    def test_checkpoint_and_latest_step_replacement(self):
        self.write([self.row(), self.row(2, 100, 20, kind="CHECKPOINT")])
        _, old = usage(self.path)
        self.write([self.row(1, 9000, 150), self.row(3, 10, 5)], "a")
        got, new = usage(self.path, old)
        self.assertEqual((got["input_tokens"], got["output_tokens"]), (9110, 175))
        self.assertEqual(old["rows"]["1"], [8855, 133, 0, None])
        self.assertEqual(new["rows"]["1"], [9000, 150, 0, None])

    def test_partial_line_is_counted_once_when_complete(self):
        self.write([self.row()])
        partial = json.dumps(self.row(2, 10, 20))
        with self.path.open("a") as stream:
            stream.write(partial[:20])
        got, old = usage(self.path)
        self.assertEqual(got["input_tokens"], 8855)
        with self.path.open("a") as stream:
            stream.write(partial[20:] + "\n")
        got, state = usage(self.path, old)
        self.assertEqual(got["input_tokens"], 8865)
        self.assertEqual(usage(self.path, state)[0], got)

    def test_rewrite_truncation_and_other_session_invalidate_cache(self):
        self.write([self.row(), self.row(2)])
        _, old = usage(self.path)
        self.write([self.row(1, 10, 20)])
        self.assertEqual(usage(self.path, old)[0]["input_tokens"], 10)
        other = Path(self.temp.name) / "other.jsonl"
        other.write_text(json.dumps(self.row(1, 99, 5)) + "\n")
        self.assertEqual(usage(other, old)[0]["input_tokens"], 99)

    def test_absent_malformed_oversized_and_invalid_counts_are_unknown(self):
        self.assertIsNone(usage(self.path)[0]["input_tokens"])
        self.path.write_text("{malformed}\n")
        self.assertIsNone(usage(self.path)[0]["input_tokens"])
        self.write([self.row(input=-1)])
        self.assertIsNone(usage(self.path)[0]["input_tokens"])
        with patch("statusline_usage.MAX_BYTES", 1):
            self.assertIsNone(usage(self.path)[0]["output_tokens"])
        self.write([self.row(input=True)])
        self.assertIsNone(usage(self.path)[0]["input_tokens"])

    def test_missing_counts_are_not_zero_and_corrected_duplicates_recover(self):
        row = self.row()
        del row["input_tokens"]
        self.write([row])
        got, old = usage(self.path)
        self.assertIsNone(got["input_tokens"])
        self.write([self.row()], "a")
        self.assertEqual(usage(self.path, old)[0]["input_tokens"], 8855)

    def test_canceled_response_without_any_usage_is_not_a_usage_event(self):
        self.write([self.row(), dict(type="PLANNER_RESPONSE", step_index=2,
                    status="DONE", thinking="Synthetic interrupted reasoning"),
                    dict(type="ERROR_MESSAGE", step_index=3, status="DONE")])
        got, state = usage(self.path)
        self.assertEqual((got["input_tokens"], got["output_tokens"]), (8855, 133))
        self.assertEqual(len(state["rows"]), 1)

    def test_mixed_model_buckets_include_cache_and_keep_checkpoint_model_unknown(self):
        self.write([self.row(1, 100, 20, 1000, model="gemini-4-carbon-high"),
                    self.row(2, 200, 30, 2000, model="gemini-4-argon-high"),
                    self.row(3, 50, 7, 3000, kind="CHECKPOINT"),
                    self.row(4, 300, 40, 4000, model="gemini-4-argon-high")])
        got, state = usage(self.path)
        self.assertEqual((got["input_tokens"], got["output_tokens"], got["input_cached_tokens"]),
                         (650, 97, 10000))
        self.assertEqual(got["usage_by_model"], [
            dict(model="gemini-4-argon-high", requests=2, input_tokens=500, output_tokens=70, input_cached_tokens=6000),
            dict(model="gemini-4-carbon-high", requests=1, input_tokens=100, output_tokens=20, input_cached_tokens=1000),
            dict(model=None, requests=1, input_tokens=50, output_tokens=7, input_cached_tokens=3000),
        ])
        self.assertTrue(got["usage_complete"], "unknown model does not make the numeric usage unknown")
        self.assertEqual(state["version"], 4)

    def test_correction_moves_usage_between_models_and_cancellation_removes_it(self):
        self.write([self.row(model="gemini-4-carbon-high")])
        _, old = usage(self.path)
        self.write([self.row(input=10, output=2, cache=100, model="gemini-4-argon-high")], "a")
        got, old = usage(self.path, old)
        self.assertEqual(got["usage_by_model"], [dict(model="gemini-4-argon-high", requests=1,
                         input_tokens=10, output_tokens=2, input_cached_tokens=100)])
        self.write([dict(type="PLANNER_RESPONSE", step_index=1, model="gemini-4-argon-high")], "a")
        got, _ = usage(self.path, old)
        self.assertEqual(got["usage_by_model"], [])
        self.assertEqual(got["input_tokens"], 0)

    def test_version_one_cache_is_reparsed_instead_of_guessing_historical_models(self):
        self.write([self.row(model="gemini-4-carbon-high")])
        _, old = usage(self.path)
        old["version"] = 1
        old["rows"] = {"1": [99999, 99999, 99999]}
        got, new = usage(self.path, old)
        self.assertEqual(new["version"], 4)
        self.assertEqual(got["input_tokens"], 8855)
        self.assertEqual(got["usage_by_model"][0]["model"], "gemini-4-carbon-high")

    def test_model_metadata_is_defensive_and_no_conversation_text_is_cached(self):
        models = [True, 42, {"id": "gemini-4-carbon-high"}, "a\nsecret", "x" * 161, "bad model"]
        rows = [self.row(i, input=1, output=1, model=model) for i, model in enumerate(models)]
        rows.append({**self.row(10, model="gemini-4-carbon-high"),
                     "content": "PRIVATE MESSAGE MUST NOT LEAVE THE LOG",
                     "thinking": "PRIVATE THINKING MUST NOT LEAVE THE LOG"})
        self.write(rows)
        got, state = usage(self.path)
        unknown = next(bucket for bucket in got["usage_by_model"] if bucket["model"] is None)
        self.assertEqual(unknown["requests"], len(models))
        self.assertNotIn("PRIVATE", json.dumps([got, state]))
        self.assertTrue(all(len(row) == 4 for row in state["rows"].values()))

    def test_invalid_cached_model_or_counter_forces_a_clean_reparse(self):
        self.write([self.row(model="gemini-4-carbon-high")])
        _, old = usage(self.path)
        old["rows"]["1"][3] = {"unsafe": "not an identifier"}
        got, new = usage(self.path, old)
        self.assertEqual(got["usage_by_model"][0]["model"], "gemini-4-carbon-high")
        new["rows"]["1"][0] = -1
        self.assertEqual(usage(self.path, new)[0]["input_tokens"], 8855)

    def test_missing_counter_is_unknown_in_its_bucket_without_poisoning_other_models(self):
        bad = self.row(model="gemini-4-carbon-high")
        del bad["output_tokens"]
        self.write([bad, self.row(2, input=3, output=4, cache=5, model="gemini-4-argon-high")])
        got, _ = usage(self.path)
        self.assertFalse(got["usage_complete"])
        self.assertIsNone(got["output_tokens"])
        self.assertEqual(got["usage_by_model"][0]["output_tokens"], 4)
        self.assertIsNone(got["usage_by_model"][1]["output_tokens"])

    def test_failed_or_bounded_reads_never_return_a_partial_model_subtotal(self):
        got, _ = usage(self.path)
        self.assertIsNone(got["usage_by_model"])
        self.assertFalse(got["usage_complete"])
        self.write([self.row(model="gemini-4-carbon-high"), self.row(2, model="gemini-4-argon-high")])
        for name, limit in (("MAX_BYTES", 1), ("MAX_RECORDS", 1), ("MAX_SECONDS", -1)):
            with patch("statusline_usage." + name, limit):
                got, _ = usage(self.path)
                self.assertIsNone(got["usage_by_model"], name)
                self.assertFalse(got["usage_complete"], name)

    def test_shrinking_log_drops_previous_model_buckets(self):
        self.write([self.row(model="gemini-4-carbon-high"), self.row(2, model="gemini-4-argon-high")])
        _, old = usage(self.path)
        self.write([self.row(3, input=1, output=2, cache=3, model="gemini-4-argon-high")])
        got, _ = usage(self.path, old)
        self.assertEqual(got["usage_by_model"], [dict(model="gemini-4-argon-high", requests=1,
                         input_tokens=1, output_tokens=2, input_cached_tokens=3)])


class LinkedUsageTests(unittest.TestCase):
    ROOT = "00000000-0000-4000-8000-000000000001"
    CHILD = "00000000-0000-4000-8000-000000000002"
    OTHER = "00000000-0000-4000-8000-000000000003"
    MODEL = "gemini-4-argon-high"

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.brain = Path(self.temp.name).resolve() / "brain"
        self.path = self.log(self.ROOT)

    def log(self, child):
        return self.brain / child / ".system_generated" / "logs" / "transcript_full.jsonl"

    def write(self, child, rows, mode="w"):
        path = self.log(child)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open(mode) as stream:
            for row in rows:
                stream.write(json.dumps(row) + "\n")

    def planner(self, step=1, count=1, value=10, model=MODEL):
        return {"type": "PLANNER_RESPONSE", "status": "DONE", "step_index": step,
                "model": model, "input_tokens": value, "output_tokens": value * 2,
                "cache_read_tokens": value * 3,
                "tool_calls": [{"name": "invoke_subagent", "args": {"Prompt": "PRIVATE PROMPT"}}] * count}

    def creation(self, child=CHILD, step=2, **changes):
        obj = {"conversationId": child,
               "logAbsoluteUri": self.log(child).with_name("transcript.jsonl").as_uri(),
               "workspaceUris": ["file:///synthetic/workspace"]}
        obj.update(changes)
        return {"type": "GENERIC", "source": "MODEL", "status": "DONE", "step_index": step,
                "content": "Synthetic tool result:\n" + json.dumps(obj) + "\nSynthetic tool postamble."}

    def test_explicit_children_aggregate_but_parent_counters_stay_separate(self):
        self.write(self.ROOT, [self.planner(count=2), self.creation(), self.creation(self.OTHER, 3)])
        self.write(self.CHILD, [self.planner(count=0, value=20)])
        self.write(self.OTHER, [{**self.planner(count=0, value=30), "type": "CHECKPOINT", "model": None}])
        got, state = usage(self.path)
        tree = got["cost_usage"]
        self.assertEqual((got["input_tokens"], tree["input_tokens"], tree["output_tokens"],
                          tree["input_cached_tokens"]), (10, 60, 120, 180))
        self.assertEqual((tree["conversations"], tree["missing_conversations"], tree["usage_complete"]), (3, 0, True))
        self.assertEqual(tree["usage_by_model"], [dict(model=self.MODEL, requests=2, input_tokens=30,
                         output_tokens=60, input_cached_tokens=90), dict(model=None, requests=1,
                         input_tokens=30, output_tokens=60, input_cached_tokens=90)])
        self.assertEqual(set(state["child_states"]), {self.CHILD, self.OTHER})
        self.assertNotIn("PRIVATE", json.dumps([got, state]))
        self.assertNotIn("Synthetic tool", json.dumps([got, state]))

    def test_creation_needs_matching_tool_response_block(self):
        self.write(self.CHILD, [self.planner(count=0, value=999)])
        for rows in ([self.planner(count=0), self.creation()],
                     [self.planner(), self.planner(step=2, count=0), self.creation(step=3)],
                     [self.planner(), {**self.creation(), "source": "USER"}]):
            with self.subTest(rows=len(rows)):
                self.write(self.ROOT, rows)
                tree = usage(self.path)[0]["cost_usage"]
                self.assertEqual(tree["conversations"], 1)
                self.assertLess(tree["input_tokens"], 999)

    def test_other_generic_results_do_not_consume_pending_invocations(self):
        self.write(self.ROOT, [self.planner(), {"type": "GENERIC", "step_index": 2,
                    "source": "MODEL", "status": "DONE", "content": "Synthetic command result"},
                    self.creation(step=3)])
        self.write(self.CHILD, [self.planner(count=0)])
        self.assertEqual(usage(self.path)[0]["cost_usage"]["conversations"], 2)

    def test_duplicates_cycles_and_nested_children_are_counted_once(self):
        self.write(self.ROOT, [self.planner(count=2), self.creation(), self.creation(step=3)])
        self.write(self.CHILD, [self.planner(count=2, value=20), self.creation(self.ROOT),
                               self.creation(self.OTHER, step=3)])
        self.write(self.OTHER, [self.planner(count=0, value=30)])
        tree = usage(self.path)[0]["cost_usage"]
        self.assertEqual((tree["conversations"], tree["input_tokens"], tree["usage_complete"]), (3, 60, True))

    def test_missing_children_are_partial_then_recover_without_parent_append(self):
        self.write(self.ROOT, [self.planner(), self.creation()])
        got, old = usage(self.path)
        self.assertEqual((got["cost_usage"]["missing_conversations"], got["cost_usage"]["usage_complete"]), (1, False))
        self.write(self.CHILD, [self.planner(count=0, value=20)])
        tree = usage(self.path, old)[0]["cost_usage"]
        self.assertEqual((tree["conversations"], tree["input_tokens"], tree["usage_complete"]), (2, 30, True))

    def test_pending_creation_is_partial_then_completes_incrementally(self):
        self.write(self.ROOT, [self.planner()])
        got, old = usage(self.path)
        self.assertEqual(got["cost_usage"]["missing_conversations"], 1)
        self.write(self.ROOT, [self.creation()], "a")
        self.write(self.CHILD, [self.planner(count=0)])
        self.assertTrue(usage(self.path, old)[0]["cost_usage"]["usage_complete"])

    def test_changed_child_usage_and_shrink_replace_previous_child_totals(self):
        self.write(self.ROOT, [self.planner(), self.creation()])
        self.write(self.CHILD, [self.planner(count=0, value=20), self.planner(step=2, count=0, value=30)])
        _, old = usage(self.path)
        self.write(self.CHILD, [self.planner(count=0, value=5)], "a")
        got, old = usage(self.path, old)
        self.assertEqual(got["cost_usage"]["input_tokens"], 45)
        self.write(self.CHILD, [self.planner(count=0, value=1)])
        self.assertEqual(usage(self.path, old)[0]["cost_usage"]["input_tokens"], 11)

    def test_rewritten_parent_removes_old_links_and_never_scans_unlinked_logs(self):
        self.write(self.ROOT, [self.planner(), self.creation()])
        self.write(self.CHILD, [self.planner(count=0, value=999)])
        _, old = usage(self.path)
        self.write(self.ROOT, [self.planner(count=0)])
        got, state = usage(self.path, old)
        self.assertEqual(got["cost_usage"]["input_tokens"], 10)
        self.assertEqual(state["child_states"], {})

    def test_invalid_uris_uuid_mismatch_and_symlinks_are_not_followed(self):
        self.write(self.CHILD, [self.planner(count=0, value=999)])
        expected = self.log(self.CHILD).with_name("transcript.jsonl").as_uri()
        for uri in ("https://example.invalid/log", expected + "?query=1", expected + "#part",
                    expected.replace("file:///", "file://host/"),
                    expected.replace(self.CHILD, self.OTHER),
                    expected.replace("/.system_generated", "/../" + self.CHILD + "/.system_generated")):
            with self.subTest(uri=uri):
                self.write(self.ROOT, [self.planner(), self.creation(logAbsoluteUri=uri)])
                tree = usage(self.path)[0]["cost_usage"]
                self.assertEqual((tree["conversations"], tree["missing_conversations"]), (1, 1))
        self.log(self.CHILD).unlink()
        self.log(self.CHILD).symlink_to(self.path)
        self.write(self.ROOT, [self.planner(), self.creation()])
        self.assertEqual(usage(self.path)[0]["cost_usage"]["missing_conversations"], 1)

    def test_malformed_child_and_missing_counters_never_become_zero(self):
        self.write(self.ROOT, [self.planner(), self.creation()])
        self.write(self.CHILD, [])
        self.log(self.CHILD).write_text("{malformed}\n")
        tree = usage(self.path)[0]["cost_usage"]
        self.assertEqual((tree["input_tokens"], tree["missing_conversations"], tree["usage_complete"]), (10, 1, False))
        row = self.planner(count=0)
        del row["input_tokens"]
        self.write(self.CHILD, [row])
        tree = usage(self.path)[0]["cost_usage"]
        self.assertIsNone(tree["input_tokens"])
        self.assertEqual(tree["conversations"], 2)
        self.assertFalse(tree["usage_complete"])

    def test_tree_limits_are_explicitly_partial(self):
        self.write(self.ROOT, [self.planner(), self.creation()])
        self.write(self.CHILD, [self.planner(count=0)])
        for name, value in (("MAX_TREE_NODES", 1), ("MAX_TREE_DEPTH", 0), ("MAX_TREE_BYTES", 1)):
            with self.subTest(name=name), patch("statusline_usage." + name, value):
                tree = usage(self.path)[0]["cost_usage"]
                self.assertEqual((tree["input_tokens"], tree["missing_conversations"], tree["usage_complete"]), (10, 1, False))
        with patch("statusline_usage.MAX_TREE_SECONDS", -1):
            tree = usage(self.path)[0]["cost_usage"]
            self.assertEqual((tree["conversations"], tree["missing_conversations"]), (0, 1))
            self.assertIsNone(tree["input_tokens"])

    def test_partial_trailing_child_record_marks_the_tree_incomplete(self):
        self.write(self.ROOT, [self.planner(), self.creation()])
        self.write(self.CHILD, [self.planner(count=0)])
        with self.log(self.CHILD).open("a") as stream:
            stream.write('{"type":')
        tree = usage(self.path)[0]["cost_usage"]
        self.assertEqual((tree["input_tokens"], tree["missing_conversations"]), (20, 0))
        self.assertFalse(tree["usage_complete"])

    def test_version_two_state_reparses_links_and_bad_link_cache_is_rejected(self):
        self.write(self.ROOT, [self.planner(), self.creation()])
        self.write(self.CHILD, [self.planner(count=0)])
        _, old = usage(self.path)
        old["version"] = 2
        old["calls"] = {}
        old["active_call"] = None
        got, old = usage(self.path, old)
        self.assertEqual(got["cost_usage"]["conversations"], 2)
        old["calls"]["1"]["children"]["2"] = "unsafe path"
        self.assertEqual(usage(self.path, old)[0]["cost_usage"]["conversations"], 2)

    def test_optional_cache_budget_does_not_discard_current_totals(self):
        self.write(self.ROOT, [self.planner(), self.creation()])
        self.write(self.CHILD, [self.planner(count=0)])
        with patch("statusline_usage.MAX_STATE_BYTES", 1):
            got, state = usage(self.path)
        self.assertEqual(state["version"], 0)
        self.assertNotIn("rows", state)
        self.assertIn(self.CHILD, state["observed_files"])
        self.assertEqual(got["cost_usage"]["input_tokens"], 20)
        self.assertEqual(usage(self.path, state)[0]["cost_usage"]["input_tokens"], 20)

    def test_public_model_bucket_bounds_keep_overflow_as_unpriced_usage(self):
        root_rows = [self.planner(step=i + 1, count=0, value=1, model="model-" + str(i).zfill(4))
                     for i in range(260)]
        root_rows += [self.planner(step=261), self.creation(step=262)]
        self.write(self.ROOT, root_rows)
        self.write(self.CHILD, [self.planner(step=i + 1, count=0, value=1,
                                          model="other-" + str(i).zfill(4)) for i in range(260)])
        got, _ = usage(self.path)
        for item in (got, got["cost_usage"]):
            self.assertEqual(len(item["usage_by_model"]), 256)
            self.assertIsNone(item["usage_by_model"][-1]["model"])
            self.assertGreater(item["usage_by_model"][-1]["requests"], 1)
            self.assertEqual(sum(b["input_tokens"] for b in item["usage_by_model"]), item["input_tokens"])
        self.assertEqual(got["cost_usage"]["input_tokens"], 530)
        self.assertLess(len(json.dumps(got)), 256 * 1024)

    def test_subagent_creation_is_visible_before_the_log_exists_and_roles_are_not_guessed(self):
        launch = self.planner()
        launch["tool_calls"][0]["args"] = {"Role": "Synthetic reviewer", "Prompt": "PRIVATE PROMPT"}
        self.write(self.ROOT, [launch, self.creation()])
        got, state = usage(self.path)
        agents = got["subagents"]
        self.assertEqual((agents["parent_id"], agents["missing"], agents["complete"]), (self.ROOT, 1, False))
        self.assertEqual(agents["items"], [dict(id=self.CHILD, parent_id=self.ROOT, name="Synthetic reviewer",
                         state="unknown", state_current=False, summary=None, updated_at=None)])
        self.assertNotIn("PRIVATE PROMPT", json.dumps([got, state]))
        self.write(self.ROOT, [self.planner(count=2), self.creation(), self.creation(self.OTHER, 3)])
        agents = usage(self.path)[0]["subagents"]
        self.assertTrue(all(item["name"].startswith("Subagent ") for item in agents["items"]))

    def test_child_response_is_a_bounded_preview_not_proof_of_completion(self):
        self.write(self.ROOT, [self.planner(), self.creation()])
        response = {**self.planner(count=0), "content": "Visible synthetic response " + "界" * 500,
                    "thinking": "PRIVATE THINKING", "created_at": "2026-01-01T12:00:00Z"}
        self.write(self.CHILD, [response])
        got, state = usage(self.path)
        item = got["subagents"]["items"][0]
        self.assertEqual((item["state"], item["state_current"]), ("responded", False))
        self.assertEqual(item["updated_at"], response["created_at"])
        self.assertLessEqual(len(item["summary"]), 240)
        self.assertLessEqual(len(item["summary"].encode()), 480)
        self.assertNotIn("PRIVATE THINKING", json.dumps([got, state]))
        self.write(self.CHILD, [{"type": "GENERIC", "source": "MODEL", "status": "DONE", "step_index": 2,
                                "content": "PRIVATE TOOL OUTPUT", "created_at": "2026-01-01T12:01:00Z"}], "a")
        got, state = usage(self.path, state)
        item = got["subagents"]["items"][0]
        self.assertEqual(item["state"], "unknown", "DONE is only the tool record status")
        self.assertIsNone(item["summary"])
        self.assertNotIn("PRIVATE TOOL OUTPUT", json.dumps([got, state]))

    def test_manager_state_is_uuid_bound_and_newer_child_response_wins(self):
        def manager(child, role, state="running"):
            return {"role": role, "type": "self", "conversationId": child,
                    "transcript": self.log(child).with_name("transcript.jsonl").as_uri(),
                    "state": state, "lastStepTime": "2026-01-01T12:00:00Z"}
        rows = [self.planner(count=2), self.creation(), self.creation(self.OTHER, 3),
                {**self.planner(step=4, count=0), "tool_calls": [{"name": "manage_subagents", "args": {}}]},
                {"type": "GENERIC", "source": "MODEL", "status": "DONE", "step_index": 5,
                 "content": "Synthetic manager result:\n" + json.dumps([
                     manager(self.OTHER, "Second reviewer", "idle"), manager(self.CHILD, "First reviewer")])}]
        self.write(self.ROOT, rows)
        self.write(self.CHILD, [{**self.planner(count=0), "content": "Earlier response",
                                "created_at": "2026-01-01T11:00:00Z"}])
        self.write(self.OTHER, [])
        got, state = usage(self.path)
        first, second = got["subagents"]["items"]
        self.assertEqual((first["id"], first["name"], first["state"]), (self.CHILD, "First reviewer", "working"))
        self.assertEqual((second["id"], second["name"], second["state"]), (self.OTHER, "Second reviewer", "waiting"))
        self.write(self.CHILD, [{**self.planner(step=2, count=0), "content": "Later response",
                                "created_at": "2026-01-01T13:00:00Z"}], "a")
        first = usage(self.path, state)[0]["subagents"]["items"][0]
        self.assertEqual((first["state"], first["summary"]), ("responded", "Later response"))
        # Identical text outside the corresponding tool block is not metadata.
        rows[3]["tool_calls"] = []
        self.write(self.ROOT, rows)
        self.assertTrue(usage(self.path)[0]["subagents"]["items"][0]["name"].startswith("Subagent "))

    def test_pruned_incremental_cache_keeps_observed_fingerprints_for_append_races(self):
        self.write(self.ROOT, [self.planner(), self.creation()])
        self.write(self.CHILD, [self.planner(count=0)])
        with patch("statusline_usage.MAX_STATE_BYTES", 1):
            _, state = usage(self.path)
        before = state["observed_files"][self.CHILD]
        self.write(self.CHILD, [self.planner(step=2, count=0)], "a")
        after = usage_fingerprint(self.path, state["watched_children"])[self.CHILD]
        self.assertNotEqual(before, after)
        self.assertEqual(state["version"], 0)


if __name__ == "__main__":
    unittest.main()
