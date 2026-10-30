import unittest

from benchmark import ProcessTree, summary


def row(pid, ppid, identity, cpu, rss):
    return {"pid": pid, "ppid": ppid, "identity": identity, "cpu": cpu, "rss": rss}


class ProcessTreeTest(unittest.TestCase):
    def test_reparenting_and_exited_process_cpu_are_preserved(self):
        tree = ProcessTree(10)
        first = tree.sample({10: row(10, 1, "a", 1, 100), 11: row(11, 10, "b", 2, 200),
                             12: row(12, 11, "c", 3, 300), 99: row(99, 1, "z", 100, 9999)})
        self.assertEqual(first["pids"], [10, 11, 12])
        self.assertEqual(first["rssBytes"], 600)
        after = tree.sample({12: row(12, 1, "c", 4, 300)})
        self.assertEqual(after["pids"], [12])
        self.assertEqual(after["cpuSeconds"], 7)
        reused = tree.sample({12: row(12, 1, "new", 30, 10000)})
        self.assertEqual(reused["pids"], [])
        self.assertEqual(reused["cpuSeconds"], 7)

    def test_cpu_uses_elapsed_time_not_sample_count(self):
        samples = [{"atMs": 0, "cpuSeconds": 0, "rssBytes": 100, "pids": [1]},
                   {"atMs": 100, "cpuSeconds": 0.1, "rssBytes": 200, "pids": [1, 2]},
                   {"atMs": 1000, "cpuSeconds": 0.1, "rssBytes": 100, "pids": [1]}]
        result = summary(samples)
        self.assertEqual(result["meanCpuPercentOneCore"], 10)
        self.assertEqual(result["peakRssBytes"], 200)


if __name__ == "__main__":
    unittest.main()
