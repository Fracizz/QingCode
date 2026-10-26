"""Bounds and protocol regressions for the live acceptance client.

Run: python -m unittest discover -s scripts/e2e-ssh-server -p test_stability.py
"""

import queue
from pathlib import Path
import subprocess
import sys
import time
import unittest
from unittest import mock

from stability import Session, mp, mp_decode


class StabilityClientTests(unittest.TestCase):
    def test_codec_preserves_large_unicode_binary_and_64_bit_sequences(self):
        original = {"seq": 2**60, "negative": -129, "name": "中文" * 200,
                    "data": bytes(range(256)) * 1025,
                    "nested": [None, True, False, {"value": -1}]}
        packed = mp(original)
        decoded, consumed = mp_decode(packed)
        self.assertEqual(decoded, original)
        self.assertEqual(consumed, len(packed))

    def test_hello_timeout_kills_untracked_proxy(self):
        processes = []
        real_popen = subprocess.Popen

        def record(*args, **kwargs):
            process = real_popen(*args, **kwargs)
            processes.append(process)
            return process

        started = time.perf_counter()
        with mock.patch("stability.subprocess.Popen", side_effect=record):
            with self.assertRaises(queue.Empty):
                Session([sys.executable, "-c", "import time; time.sleep(60)"],
                        "unused", timeout=.1)
        self.assertLess(time.perf_counter() - started, 5)
        self.assertEqual(len(processes), 1)
        self.assertIsNotNone(processes[0].poll())

    def test_rpc_deadline_is_effective_when_proxy_never_replies(self):
        location = str(Path(__file__).resolve().parent)
        # The fake transport completes HELLO then keeps stdout open forever.
        # A blocking read on the caller thread would hang this regression.
        program = (
            "import sys,time; sys.path.insert(0," + repr(location) + "); "
            "from stability import frame,mp,KIND; "
            "sys.stdout.buffer.write(frame(KIND['HELLO'],0,mp({'protocol':1}))); "
            "sys.stdout.buffer.flush(); time.sleep(60)"
        )
        client = Session([sys.executable, "-u", "-c", program], "unused", timeout=5)
        try:
            started = time.perf_counter()
            with self.assertRaises((queue.Empty, TimeoutError)):
                client.request("server.info", timeout=.1)
            self.assertLess(time.perf_counter() - started, 2)
        finally:
            client.close()


if __name__ == "__main__":
    unittest.main()
