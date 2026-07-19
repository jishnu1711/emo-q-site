import tempfile
import sys
import time
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "face_recognition"))
from face_service import Config, FaceService


class FakeDetector:
    def __init__(self, faces):
        self.faces = faces

    def setInputSize(self, _size):
        pass

    def detect(self, _frame):
        return None, self.faces


class FaceServiceUnitTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.profiles = Path(self.temp.name) / "profiles.npz"
        self.service = FaceService(Config(), Path(self.temp.name), self.profiles)

    def tearDown(self):
        self.temp.cleanup()

    def test_unknown_without_profiles(self):
        result = self.service._classify(np.ones(4, dtype=np.float32) / 2, 1, time.time())
        self.assertEqual(result["name"], "Unknown")
        self.assertFalse(result["recognized"])

    def test_recognized_to_no_face_clears_name_and_score(self):
        self.service.identity = {
            "name": "Abiram", "recognized": True, "score": 0.77, "margin": 0.2,
            "faces": 1, "reason": "matched", "observed_at": time.time(),
        }
        self.service.detector = FakeDetector(None)
        self.service._process_frame(np.zeros((480, 640, 3), dtype=np.uint8))
        snapshot = self.service.identity_snapshot()
        self.assertEqual(snapshot["name"], "Unknown")
        self.assertFalse(snapshot["recognized"])
        self.assertEqual(snapshot["score"], 0.0)
        self.assertEqual(snapshot["margin"], 0.0)
        self.assertEqual(snapshot["faces"], 0)
        self.assertEqual(snapshot["reason"], "no face")

    def test_multiple_faces_fail_closed_without_selecting_one(self):
        faces = np.array([
            [10, 10, 120, 120, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.99],
            [200, 10, 100, 100, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.98],
        ], dtype=np.float32)
        self.service.detector = FakeDetector(faces)
        self.service._process_frame(np.zeros((480, 640, 3), dtype=np.uint8))
        snapshot = self.service.identity_snapshot()
        self.assertEqual(snapshot["name"], "Unknown")
        self.assertEqual(snapshot["reason"], "multiple faces")
        self.assertEqual(snapshot["faces"], 2)
        self.assertEqual(snapshot["score"], 0.0)

    def test_threshold_and_margin_reject_ambiguous(self):
        self.service.profiles = {
            "Abiram": np.array([1, 0], dtype=np.float32),
            "Jishnu": np.array([0.99, 0.01], dtype=np.float32),
        }
        query = np.array([1, 0], dtype=np.float32)
        result = self.service._classify(query, 1, time.time())
        self.assertEqual(result["name"], "Unknown")
        self.assertEqual(result["reason"], "ambiguous")

    def test_clear_match(self):
        self.service.profiles = {
            "Abiram": np.array([1, 0], dtype=np.float32),
            "Jishnu": np.array([0, 1], dtype=np.float32),
        }
        result = self.service._classify(np.array([1, 0], dtype=np.float32), 1, time.time())
        self.assertEqual(result["name"], "Abiram")
        self.assertTrue(result["recognized"])

    def test_profile_round_trip(self):
        self.service.profiles = {"Abiram": np.array([0.6, 0.8], dtype=np.float32)}
        self.service._save_profiles()
        second = FaceService(Config(), Path(self.temp.name), self.profiles)
        second._load_profiles()
        np.testing.assert_allclose(second.profiles["Abiram"], [0.6, 0.8])

    def test_expired_identity_is_unknown(self):
        self.service.identity = {
            "name": "Abiram", "recognized": True, "score": 0.8, "margin": 0.2,
            "faces": 1, "reason": "matched", "observed_at": time.time() - 10,
        }
        snapshot = self.service.identity_snapshot()
        self.assertEqual(snapshot["name"], "Unknown")
        self.assertFalse(snapshot["recognized"])
        self.assertEqual(snapshot["score"], 0.0)
        self.assertEqual(snapshot["margin"], 0.0)
        self.assertEqual(snapshot["faces"], 0)

    def test_fresh_identity_snapshot_keeps_match_for_wake(self):
        self.service.identity = {
            "name": "Jishnu", "recognized": True, "score": 0.71, "margin": 0.19,
            "faces": 1, "reason": "matched", "observed_at": time.time() - 0.1,
        }
        snapshot = self.service.identity_snapshot()
        self.assertEqual(snapshot["name"], "Jishnu")
        self.assertTrue(snapshot["recognized"])
        self.assertTrue(snapshot["fresh"])
        self.assertLess(snapshot["age_ms"], 500)


if __name__ == "__main__":
    unittest.main()
