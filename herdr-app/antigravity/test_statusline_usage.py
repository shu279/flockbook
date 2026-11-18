import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from statusline_usage import usage


class UsageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "transcript_full.jsonl"

    def write(self, rows, mode="w"):
        with self.path.open(mode) as stream:
            for row in rows:
                stream.write(json.dumps(row) + "\n")

    def row(self, step=1, input=8855, output=133, cache=0, kind="PLANNER_RESPONSE"):
        return dict(type=kind, status="DONE", step_index=step, input_tokens=input,
                    output_tokens=output, cache_read_tokens=cache)

    def test_cumulative_input_separate_from_cache_and_context_estimate(self):
        self.write([self.row(), self.row(3, 3060, 179, 6801)])
        got, _ = usage(self.path)
        self.assertEqual(got, dict(input_tokens=11915, output_tokens=312,
                                  input_cached_tokens=6801, source="transcript"))

    def test_checkpoint_and_latest_step_replacement(self):
        self.write([self.row(), self.row(2, 100, 20, kind="CHECKPOINT")])
        _, old = usage(self.path)
        self.write([self.row(1, 9000, 150), self.row(3, 10, 5)], "a")
        got, new = usage(self.path, old)
        self.assertEqual((got["input_tokens"], got["output_tokens"]), (9110, 175))
        self.assertEqual(old["rows"]["1"], [8855, 133, 0])
        self.assertEqual(new["rows"]["1"], [9000, 150, 0])

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


if __name__ == "__main__":
    unittest.main()
