"""Regression coverage for long-run monitoring independent of SSH admission."""

import json
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest import mock

from stability_windows import WindowsSuite


class MonitorTests(unittest.TestCase):
    def suite(self, output):
        args = SimpleNamespace(output=output, sshctl="must-not-be-launched",
                               remote_dir="C:/Users/test/qingcode-stability-unit",
                               local=False, host="test.invalid")
        suite = WindowsSuite(args)
        suite.pid = 123
        suite.diagnostic_pty = "diagnostic"
        suite.remote = mock.Mock(side_effect=AssertionError("must reuse existing transport"))
        return suite

    @mock.patch("builtins.print")
    def test_resource_monitor_reuses_established_session(self, _print):
        with tempfile.TemporaryDirectory() as output:
            suite = self.suite(output)
            data = bytearray()

            def request(method, params):
                self.assertEqual(method, "pty.input")
                self.assertEqual(params["id"], "diagnostic")
                data.extend(b'\x1b[31mQC_RESOURCE:{"Id":123,"WorkingSet64":1024}\r\n')
                return {"ok": True}

            suite.sessions = [SimpleNamespace(
                output=lambda _pty: bytes(data), request=request,
                proc=SimpleNamespace(poll=lambda: None), pings=3,
                last_frame=time.monotonic(), failure=None)]
            suite.monitor()
            row = json.loads((Path(output) / "progress.jsonl").read_text(encoding="utf-8"))
            self.assertEqual(row["detail"]["WorkingSet64"], 1024)
            self.assertIsNone(row["diagnosticError"])
            suite.remote.assert_not_called()

    @mock.patch("builtins.print")
    def test_probe_failure_does_not_stop_healthy_long_sessions(self, _print):
        with tempfile.TemporaryDirectory() as output:
            suite = self.suite(output)
            suite.sessions = [SimpleNamespace(
                output=lambda _pty: b"", request=mock.Mock(side_effect=TimeoutError("probe late")),
                proc=SimpleNamespace(poll=lambda: None), pings=3,
                last_frame=time.monotonic(), failure=None)]
            suite.monitor()
            self.assertFalse(suite.stop.is_set())
            self.assertEqual(suite.failures, [])
            self.assertEqual(len(suite.infrastructure_warnings), 1)
            row = json.loads((Path(output) / "progress.jsonl").read_text(encoding="utf-8"))
            self.assertTrue(row["sessions"][0]["alive"])
            self.assertIn("probe late", row["diagnosticError"])
            suite.remote.assert_not_called()


if __name__ == "__main__":
    unittest.main()
