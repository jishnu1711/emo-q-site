#!/usr/bin/env python3
"""Always-on, low-latency YuNet + SFace identity service for Echo Q."""

from __future__ import annotations

import argparse
import json
import os
import platform
import threading
import time
from collections import deque
from dataclasses import asdict, dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import cv2
import numpy as np


ROOT = Path(__file__).resolve().parent
DEFAULT_CONFIG = ROOT / "config.json"
DEFAULT_MODELS = ROOT / "models"
DEFAULT_PROFILES = ROOT / "data" / "profiles.npz"


@dataclass
class Config:
    camera_index: int = 0
    camera_width: int = 640
    camera_height: int = 480
    camera_fps: int = 30
    inference_fps: float = 10.0
    detector_score_threshold: float = 0.85
    detector_nms_threshold: float = 0.3
    detector_top_k: int = 50
    identity_threshold: float = 0.42
    identity_margin: float = 0.08
    identity_ttl_seconds: float = 2.0
    min_face_size: int = 90
    min_blur_variance: float = 45.0
    enrollment_samples: int = 20
    host: str = "127.0.0.1"
    port: int = 8001

    @classmethod
    def load(cls, path: Path) -> "Config":
        if not path.exists():
            return cls()
        raw = json.loads(path.read_text(encoding="utf-8"))
        known = cls.__dataclass_fields__
        unknown = set(raw) - set(known)
        if unknown:
            raise ValueError(f"Unknown config keys: {sorted(unknown)}")
        return cls(**raw)


class RollingRate:
    def __init__(self, seconds: float = 3.0) -> None:
        self.seconds = seconds
        self.events: deque[float] = deque()

    def tick(self, now: float) -> None:
        self.events.append(now)
        self._trim(now)

    def value(self, now: float) -> float:
        self._trim(now)
        if len(self.events) < 2:
            return 0.0
        span = self.events[-1] - self.events[0]
        return (len(self.events) - 1) / span if span > 0 else 0.0

    def _trim(self, now: float) -> None:
        while self.events and now - self.events[0] > self.seconds:
            self.events.popleft()


class FaceService:
    def __init__(self, cfg: Config, models_dir: Path, profiles_path: Path) -> None:
        self.cfg = cfg
        self.models_dir = models_dir
        self.profiles_path = profiles_path
        self.stop_event = threading.Event()
        self.lock = threading.RLock()
        self.frame_lock = threading.Lock()
        self.camera_lock = threading.Lock()
        self.latest_frame: np.ndarray | None = None
        self.latest_frame_seq = 0
        self.camera_error: str | None = None
        self.started_at = time.time()
        self.capture_rate = RollingRate()
        self.inference_rate = RollingRate()
        self.inference_ms: deque[float] = deque(maxlen=100)
        self.profiles: dict[str, np.ndarray] = {}
        self.identity: dict[str, Any] = self._unknown_identity("starting")
        self.enrollment: dict[str, Any] | None = None
        self.detector: Any = None
        self.recognizer: Any = None
        self.capture: Any = None
        self.camera_paused = False
        self.capture_thread: threading.Thread | None = None
        self.inference_thread: threading.Thread | None = None

    def _unknown_identity(self, reason: str, now: float | None = None) -> dict[str, Any]:
        return {
            "name": "Unknown",
            "recognized": False,
            "score": 0.0,
            "margin": 0.0,
            "faces": 0,
            "reason": reason,
            "observed_at": now or time.time(),
        }

    def start(self) -> None:
        detector_path = self.models_dir / "face_detection_yunet_2023mar.onnx"
        recognizer_path = self.models_dir / "face_recognition_sface_2021dec.onnx"
        missing = [str(p) for p in (detector_path, recognizer_path) if not p.exists()]
        if missing:
            raise FileNotFoundError("Missing model files: " + ", ".join(missing))
        self.detector = cv2.FaceDetectorYN.create(
            str(detector_path), "", (self.cfg.camera_width, self.cfg.camera_height),
            self.cfg.detector_score_threshold, self.cfg.detector_nms_threshold,
            self.cfg.detector_top_k,
        )
        self.recognizer = cv2.FaceRecognizerSF.create(str(recognizer_path), "")
        self._load_profiles()
        self.capture = self._open_camera()
        self.capture_thread = threading.Thread(target=self._capture_loop, name="camera-capture", daemon=True)
        self.inference_thread = threading.Thread(target=self._inference_loop, name="face-inference", daemon=True)
        self.capture_thread.start()
        self.inference_thread.start()

    def _open_camera(self):
        if platform.system() == "Windows":
            cap = cv2.VideoCapture(self.cfg.camera_index, cv2.CAP_DSHOW)
            if not cap.isOpened():
                cap.release()
                cap = cv2.VideoCapture(self.cfg.camera_index)
        else:
            cap = cv2.VideoCapture(self.cfg.camera_index, cv2.CAP_V4L2)
            if not cap.isOpened():
                cap.release()
                cap = cv2.VideoCapture(self.cfg.camera_index)
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, self.cfg.camera_width)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self.cfg.camera_height)
        cap.set(cv2.CAP_PROP_FPS, self.cfg.camera_fps)
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        if not cap.isOpened():
            available: list[int] = []
            for index in range(4):
                if index == self.cfg.camera_index:
                    continue
                probe = cv2.VideoCapture(index, cv2.CAP_DSHOW) if platform.system() == "Windows" else cv2.VideoCapture(index, cv2.CAP_V4L2)
                if probe.isOpened():
                    available.append(index)
                probe.release()
            detail = f" Available camera indices: {available}." if available else " No camera could be opened."
            raise RuntimeError(
                f"Unable to open configured external webcam at camera index {self.cfg.camera_index}.{detail} "
                "Reconnect the external webcam, close Windows Camera/Teams/Zoom, then start Echo Q again."
            )
        return cap

    def stop(self) -> None:
        self.stop_event.set()
        for thread in (self.capture_thread, self.inference_thread):
            if thread:
                thread.join(timeout=2)
        with self.camera_lock:
            if self.capture is not None:
                self.capture.release()
                self.capture = None

    def pause_camera(self) -> dict[str, Any]:
        """Release the camera and invalidate identity for privacy."""
        with self.camera_lock:
            self.camera_paused = True
            if self.capture is not None:
                self.capture.release()
                self.capture = None
        with self.frame_lock:
            self.latest_frame = None
        with self.lock:
            self.identity = self._unknown_identity("camera paused")
        return self.status()

    def resume_camera(self) -> dict[str, Any]:
        with self.camera_lock:
            if not self.camera_paused and self.capture is not None and self.capture.isOpened():
                return self.status()
            self.capture = self._open_camera()
            self.camera_paused = False
            self.camera_error = None
        return self.status()

    def _capture_loop(self) -> None:
        failures = 0
        while not self.stop_event.is_set():
            if self.camera_paused:
                self.stop_event.wait(0.05)
                continue
            with self.camera_lock:
                cap = self.capture
                ok, frame = cap.read() if cap is not None else (False, None)
            now = time.monotonic()
            if self.camera_paused:
                continue
            if not ok:
                failures += 1
                self.camera_error = f"camera read failed ({failures})"
                time.sleep(0.05)
                continue
            failures = 0
            self.camera_error = None
            with self.frame_lock:
                self.latest_frame = frame
                self.latest_frame_seq += 1
            with self.lock:
                self.capture_rate.tick(now)

    def _inference_loop(self) -> None:
        interval = 1.0 / max(1.0, self.cfg.inference_fps)
        last_seq = -1
        while not self.stop_event.is_set():
            loop_start = time.monotonic()
            with self.frame_lock:
                seq = self.latest_frame_seq
                frame = None if self.latest_frame is None else self.latest_frame.copy()
            if frame is not None and seq != last_seq:
                last_seq = seq
                try:
                    self._process_frame(frame)
                except Exception as exc:  # keep the camera service alive
                    with self.lock:
                        self.identity = self._unknown_identity(f"inference error: {exc}")
            elapsed = time.monotonic() - loop_start
            self.stop_event.wait(max(0.001, interval - elapsed))

    def _process_frame(self, frame: np.ndarray) -> None:
        if self.camera_paused:
            return
        started = time.perf_counter()
        height, width = frame.shape[:2]
        self.detector.setInputSize((width, height))
        _, faces = self.detector.detect(frame)
        now_wall = time.time()
        now_mono = time.monotonic()
        face_rows = [] if faces is None else sorted(faces, key=lambda f: float(f[2] * f[3]), reverse=True)
        candidate = self._unknown_identity("no face", now_wall)
        candidate["faces"] = len(face_rows)
        if len(face_rows) > 1:
            candidate["reason"] = "multiple faces"
        elif len(face_rows) == 1:
            face = face_rows[0]
            size = int(min(face[2], face[3]))
            x, y, w, h = [int(v) for v in face[:4]]
            crop = frame[max(0, y):min(height, y + h), max(0, x):min(width, x + w)]
            blur = float(cv2.Laplacian(cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY), cv2.CV_64F).var()) if crop.size else 0.0
            if size < self.cfg.min_face_size:
                candidate.update(reason="face too small", face_size=size, blur=round(blur, 1))
            elif blur < self.cfg.min_blur_variance:
                candidate.update(reason="face too blurry", face_size=size, blur=round(blur, 1))
            else:
                aligned = self.recognizer.alignCrop(frame, face)
                embedding = self.recognizer.feature(aligned).reshape(-1).astype(np.float32)
                embedding /= max(float(np.linalg.norm(embedding)), 1e-12)
                candidate = self._classify(embedding, len(face_rows), now_wall)
                candidate.update(face_size=size, blur=round(blur, 1))
                if len(face_rows) == 1:
                    self._collect_enrollment(embedding, candidate)
        duration_ms = (time.perf_counter() - started) * 1000.0
        with self.lock:
            self.identity = self._unknown_identity("camera paused") if self.camera_paused else candidate
            self.inference_ms.append(duration_ms)
            self.inference_rate.tick(now_mono)

    def _classify(self, embedding: np.ndarray, face_count: int, now: float) -> dict[str, Any]:
        with self.lock:
            scores = sorted(
                ((name, float(np.dot(embedding, profile))) for name, profile in self.profiles.items()),
                key=lambda item: item[1], reverse=True,
            )
        if not scores:
            result = self._unknown_identity("no enrolled profiles", now)
            result["faces"] = face_count
            return result
        best_name, best = scores[0]
        second = scores[1][1] if len(scores) > 1 else -1.0
        margin = best - second
        recognized = best >= self.cfg.identity_threshold and margin >= self.cfg.identity_margin
        return {
            "name": best_name if recognized else "Unknown",
            "recognized": recognized,
            "score": round(best, 4),
            "margin": round(margin, 4),
            "faces": face_count,
            "reason": "matched" if recognized else ("low score" if best < self.cfg.identity_threshold else "ambiguous"),
            "observed_at": now,
        }

    def begin_enrollment(self, name: str, samples: int | None = None) -> dict[str, Any]:
        clean = " ".join(name.strip().split())
        if not clean or len(clean) > 64 or any(c in clean for c in "\\/\0"):
            raise ValueError("name must be 1-64 safe characters")
        target = int(samples or self.cfg.enrollment_samples)
        if target < 5 or target > 100:
            raise ValueError("samples must be between 5 and 100")
        with self.lock:
            self.enrollment = {
                "name": clean, "target": target, "captured": 0,
                "state": "collecting", "started_at": time.time(),
                "last_capture_at": 0.0, "embeddings": [],
            }
        return self.enrollment_status()

    def _collect_enrollment(self, embedding: np.ndarray, observation: dict[str, Any]) -> None:
        with self.lock:
            job = self.enrollment
            if not job or job["state"] != "collecting":
                return
            now = time.time()
            if now - job["last_capture_at"] < 0.15:
                return
            job["last_capture_at"] = now
            job["embeddings"].append(embedding.copy())
            job["captured"] = len(job["embeddings"])
            if job["captured"] >= job["target"]:
                matrix = np.stack(job["embeddings"])
                center = np.median(matrix, axis=0)
                center /= max(float(np.linalg.norm(center)), 1e-12)
                similarities = matrix @ center
                keep = matrix[similarities >= np.percentile(similarities, 20)]
                profile = np.mean(keep, axis=0)
                profile /= max(float(np.linalg.norm(profile)), 1e-12)
                self.profiles[job["name"]] = profile.astype(np.float32)
                self._save_profiles()
                job["state"] = "complete"
                job["completed_at"] = now
                job["kept_samples"] = len(keep)

    def cancel_enrollment(self) -> dict[str, Any]:
        with self.lock:
            if self.enrollment and self.enrollment["state"] == "collecting":
                self.enrollment["state"] = "cancelled"
        return self.enrollment_status()

    def enrollment_status(self) -> dict[str, Any]:
        with self.lock:
            if not self.enrollment:
                return {"state": "idle"}
            return {k: v for k, v in self.enrollment.items() if k != "embeddings"}

    def delete_profile(self, name: str) -> bool:
        with self.lock:
            removed = self.profiles.pop(name, None) is not None
            if removed:
                self._save_profiles()
            return removed

    def _load_profiles(self) -> None:
        if not self.profiles_path.exists():
            return
        with np.load(self.profiles_path, allow_pickle=False) as stored:
            self.profiles = {name: stored[name].astype(np.float32) for name in stored.files}

    def _save_profiles(self) -> None:
        self.profiles_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.profiles_path.with_suffix(".tmp.npz")
        np.savez_compressed(tmp, **self.profiles)
        os.replace(tmp, self.profiles_path)

    def identity_snapshot(self) -> dict[str, Any]:
        with self.lock:
            value = dict(self.identity)
        age = max(0.0, time.time() - float(value["observed_at"]))
        value["age_ms"] = round(age * 1000)
        value["fresh"] = age <= self.cfg.identity_ttl_seconds
        if not value["fresh"]:
            value.update(
                name="Unknown", recognized=False, score=0.0, margin=0.0,
                faces=0, reason="identity expired",
            )
        return value

    def status(self) -> dict[str, Any]:
        now = time.monotonic()
        with self.lock:
            latencies = list(self.inference_ms)
            return {
                "ok": self.camera_paused or (
                    self.camera_error is None and self.capture is not None and self.capture.isOpened()
                ),
                "pipeline": {
                    "engine": "OpenCV YuNet + SFace",
                    "mode": "always_on",
                    "models_ready": self.detector is not None and self.recognizer is not None,
                    "identity_cache_ttl_seconds": self.cfg.identity_ttl_seconds,
                },
                "camera": {
                    "index": self.cfg.camera_index,
                    "paused": self.camera_paused,
                    "capture_fps": round(self.capture_rate.value(now), 1),
                    "inference_fps": round(self.inference_rate.value(now), 1),
                    "error": self.camera_error,
                },
                "inference": {
                    "last_ms": round(latencies[-1], 1) if latencies else None,
                    "average_ms": round(float(np.mean(latencies)), 1) if latencies else None,
                    "p95_ms": round(float(np.percentile(latencies, 95)), 1) if latencies else None,
                    "samples": len(latencies),
                },
                "identity": self.identity_snapshot(),
                "profiles": sorted(self.profiles),
                "enrollment": self.enrollment_status(),
                "uptime_seconds": round(time.time() - self.started_at),
                "opencv": cv2.__version__,
            }


class ApiHandler(BaseHTTPRequestHandler):
    service: FaceService

    def _send(self, status: int, payload: Any) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length > 16_384:
            raise ValueError("request body too large")
        return json.loads(self.rfile.read(length) or b"{}")

    def do_OPTIONS(self) -> None:
        self._send(204, {})

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path in ("/health", "/status"):
            status = self.service.status()
            self._send(200 if status["ok"] else 503, status)
        elif path in ("/identity", "/identity/latest"):
            self._send(200, self.service.identity_snapshot())
        elif path == "/enrollment":
            self._send(200, self.service.enrollment_status())
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self) -> None:
        try:
            path = urlparse(self.path).path
            if path == "/enrollment/start":
                body = self._body()
                self._send(202, self.service.begin_enrollment(body.get("name", ""), body.get("samples")))
            elif path == "/enrollment/cancel":
                self._send(200, self.service.cancel_enrollment())
            elif path == "/camera/pause":
                self._send(200, self.service.pause_camera())
            elif path == "/camera/resume":
                self._send(200, self.service.resume_camera())
            else:
                self._send(404, {"error": "not found"})
        except (ValueError, json.JSONDecodeError) as exc:
            self._send(400, {"error": str(exc)})

    def do_DELETE(self) -> None:
        path = urlparse(self.path).path
        prefix = "/profiles/"
        if path.startswith(prefix):
            name = path[len(prefix):]
            self._send(200, {"removed": self.service.delete_profile(name), "name": name})
        else:
            self._send(404, {"error": "not found"})

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[api] {self.address_string()} {fmt % args}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--models", type=Path, default=DEFAULT_MODELS)
    parser.add_argument("--profiles", type=Path, default=DEFAULT_PROFILES)
    parser.add_argument("--camera", type=int, help="override camera index")
    args = parser.parse_args()
    cfg = Config.load(args.config)
    if args.camera is not None:
        cfg.camera_index = args.camera
    service = FaceService(cfg, args.models, args.profiles)
    service.start()
    ApiHandler.service = service
    server = ThreadingHTTPServer((cfg.host, cfg.port), ApiHandler)
    print(f"Echo Q vision ready at http://{cfg.host}:{cfg.port}")
    print(f"Camera {cfg.camera_index}; enrolled: {', '.join(sorted(service.profiles)) or 'none'}")
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        print("Stopping Echo Q vision")
    finally:
        server.server_close()
        service.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
