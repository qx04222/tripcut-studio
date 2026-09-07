import importlib.util
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "scripts" / "benchmark.py"
SPEC = importlib.util.spec_from_file_location("tripcut_benchmark", MODULE_PATH)
BENCHMARK = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(BENCHMARK)


class DriverRequestTests(unittest.TestCase):
    def test_fixture_request_includes_only_identity_source_and_observation_checkpoints(self):
        fixture = {
            "id": "F-006",
            "group": "F",
            "scenario": "answer text must stay private",
            "golden": True,
            "expected": {"important_event": True},
            "timeline": {
                "vfr_checkpoints_us": [0, 33_367, 100_100],
                "proxy_checkpoints_us": [0, 100_100],
            },
        }

        request = BENCHMARK.driver_fixture_request(fixture, Path("/media/F-006.mov"))

        self.assertEqual(request["vfr_checkpoints_us"], [0, 33_367, 100_100])
        self.assertEqual(request["proxy_checkpoints_us"], [0, 100_100])
        self.assertNotIn("expected", request)
        self.assertNotIn("golden", request)
        self.assertNotIn("scenario", request)


if __name__ == "__main__":
    unittest.main()
