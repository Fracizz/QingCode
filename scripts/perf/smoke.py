#!/usr/bin/env python3
"""Linux collector integration smoke: actual parent/child processes, no desktop."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile


def main():
    if not sys.platform.startswith("linux"):
        raise SystemExit("This smoke fixture requires Linux signal semantics; desktop Windows acceptance is separate")
    runner = Path(__file__).with_name("benchmark.py")
    with tempfile.TemporaryDirectory(prefix="qingcode-perf-") as temporary:
        directory = Path(temporary)
        fixture = directory / "fixture.py"
        marker = directory / "ready"
        fixture.write_text('''import signal
import subprocess
import sys
import time
from pathlib import Path

child = subprocess.Popen([sys.executable, "-c", "import time; data=bytearray(32*1024*1024); end=time.monotonic()+20\\nwhile time.monotonic()<end: pass"])
def stop(*_):
    child.terminate()
    child.wait(timeout=5)
    sys.exit(0)
signal.signal(signal.SIGTERM, stop)
Path(sys.argv[1]).touch()
time.sleep(20)
stop()
''', encoding="utf-8")
        report = directory / "result.json"
        subprocess.run([sys.executable, str(runner), "run", "--scenario", "collector-smoke",
                        "--cache", "uncontrolled", "--cache-preparation", "none", "--version", "fixture",
                        "--duration", "1.5", "--warmup", "0.3", "--interval", "0.1",
                        "--ready-file", str(marker), "--stop", "terminate", "--output", str(report),
                        "--", sys.executable, str(fixture), str(marker)], check=True, timeout=15)
        data = json.loads(report.read_text(encoding="utf-8"))
        assert data["status"] == "passed", data["errors"]
        assert data["startupMs"] is not None
        assert data["exitMs"] is not None
        assert data["summary"]["peakProcessCount"] >= 2
        assert data["summary"]["peakRssBytes"] >= 32 * 1024 * 1024
        assert data["summary"]["meanCpuPercentOneCore"] > 0
        subprocess.run([sys.executable, str(runner), "compare", str(report), str(report)], check=True, timeout=5)
        modified = directory / "incompatible.json"
        data["metadata"]["cache"] = "cold"
        modified.write_text(json.dumps(data), encoding="utf-8")
        failed = subprocess.run([sys.executable, str(runner), "compare", str(report), str(modified)],
                                capture_output=True, text=True, timeout=5)
        assert failed.returncode != 0 and "cache" in failed.stderr
    print("PASS: readiness, descendant RSS/CPU, termination, JSON comparison and incompatible-run rejection")


if __name__ == "__main__":
    main()
