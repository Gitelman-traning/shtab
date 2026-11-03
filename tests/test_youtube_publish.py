"""Exercise the collector's real publication function without credentials or network."""
import ast
import pathlib
import unittest


class YouTubePublishTests(unittest.TestCase):
    def publish(self, mode, rows, paid, drop=(), send=None):
        source = pathlib.Path(__file__).resolve().parents[1] / "collector" / "youtube.py"
        tree = ast.parse(source.read_text(encoding="utf-8"))
        function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "publish")
        calls = []
        namespace = {"MODE": mode, "send": send or calls.append}
        exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), "exec"), namespace)
        namespace["publish"](rows, paid, drop, "synthetic-start")
        return calls

    def test_full_snapshot_is_one_request_without_reset_or_truncation(self):
        rows = [{"id": i} for i in range(1251)]
        paid = [{"id": i} for i in range(5001)]
        calls = self.publish("full", rows, paid)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["yt_leads_replace"]["rows"], rows)
        self.assertEqual(calls[0]["yt_paid"], {"replace": True, "rows": paid})
        self.assertNotIn("yt_reset", calls[0])
        self.assertTrue(calls[0]["finalize"])

    def test_empty_full_snapshot_is_explicit(self):
        body = self.publish("full", [], [])[0]
        self.assertEqual(body["yt_leads_replace"], {"rows": []})
        self.assertEqual(body["yt_paid"], {"replace": True, "rows": []})

    def test_incremental_protocol_preserves_batches_and_final_snapshot(self):
        rows = [{"id": i} for i in range(1251)]
        drop = list(range(2001))
        calls = self.publish("inc", rows, [{"id": 1}], drop)
        self.assertEqual([len(b["yt_leads"]) for b in calls if "yt_leads" in b], [500, 500, 251])
        self.assertEqual([r for b in calls for r in b.get("yt_leads", [])], rows)
        self.assertEqual([r for b in calls for r in b.get("yt_drop", [])], drop)
        self.assertTrue(calls[-1]["yt_paid"]["replace"])
        self.assertFalse(any("yt_reset" in b or "yt_leads_replace" in b for b in calls))

    def test_failed_increment_does_not_finalize_or_replace_payments(self):
        calls = []
        def fail(body):
            calls.append(body)
            raise RuntimeError("synthetic failure")
        with self.assertRaises(RuntimeError):
            self.publish("inc", [{"id": 1}], [{"id": 2}], send=fail)
        self.assertEqual(len(calls), 1)
        self.assertNotIn("finalize", calls[0])
        self.assertNotIn("yt_paid", calls[0])


if __name__ == "__main__":
    unittest.main()
