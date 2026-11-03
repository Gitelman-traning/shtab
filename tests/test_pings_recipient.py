"""Check that delivery resolves a recipient without the administrative users API."""
import ast
import pathlib
from types import SimpleNamespace
import unittest


class RecipientTests(unittest.TestCase):
    def resolve(self, forced="", recipient="synthetic-chat"):
        path = pathlib.Path(__file__).resolve().parents[1] / "collector" / "pings.py"
        tree = ast.parse(path.read_text(encoding="utf-8"))
        function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "manager_chat")
        calls = []
        def shtab(*args, **kwargs):
            calls.append((args, kwargs))
            return {"ok": True, "tg_id": recipient}
        namespace = {"os": SimpleNamespace(environ={"PINGS_TG_CHAT": forced}), "shtab": shtab}
        exec(compile(ast.Module(body=[function], type_ignores=[]), str(path), "exec"), namespace)
        return namespace["manager_chat"]({"tg_match": "Synthetic"}), calls

    def test_only_recipient_route_is_used(self):
        result, calls = self.resolve()
        self.assertEqual(result, "synthetic-chat")
        self.assertEqual(calls, [(("GET", "/api/pings"), {"params": {"mode": "recipient", "match": "Synthetic"}})])

    def test_missing_recipient_is_not_guessed(self):
        self.assertIsNone(self.resolve(recipient=None)[0])

    def test_explicit_destination_needs_no_lookup(self):
        self.assertEqual(self.resolve(forced="configured-chat"), ("configured-chat", []))


if __name__ == "__main__":
    unittest.main()
