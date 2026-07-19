# Echo Q vision service

An always-on local face identity service using OpenCV YuNet for detection and
SFace for aligned face embeddings. Camera capture and model inference run on
separate threads. Inference always consumes the newest frame, so frames never
queue and the camera pipeline does not accumulate latency.

This is enrollment, not model training. Each person looks at the camera while
the service collects good face embeddings. Profiles stay local in
`face_recognition/data/profiles.npz`.

## Windows setup

From `D:\AI_Hack`:

```powershell
py -3.14 -m venv --system-site-packages face_recognition\.venv
.\face_recognition\.venv\Scripts\python.exe -m pip install -r face_recognition\requirements.txt
Copy-Item face_recognition\config.example.json face_recognition\config.json
.\face_recognition\.venv\Scripts\python.exe face_recognition\face_service.py
```

The official OpenCV Zoo models must exist at:

```text
face_recognition/models/face_detection_yunet_2023mar.onnx
face_recognition/models/face_recognition_sface_2021dec.onnx
```

The included `config.json` selects camera 1 for the external webcam. Override it
with `--camera 0` if Windows assigns the external webcam differently. Only one
process can own a camera reliably, so close camera preview applications first.

## UNO Q / Debian setup

```bash
cd /path/to/AI_Hack
python3 -m venv face_recognition/.venv
face_recognition/.venv/bin/python -m pip install -r face_recognition/requirements.txt
cp face_recognition/config.example.json face_recognition/config.json
face_recognition/.venv/bin/python face_recognition/face_service.py
```

Set `host` to `0.0.0.0` only when the web server must reach the service over a
trusted LAN. Keep the default `127.0.0.1` when both services share the UNO Q.

## Enrollment

Start the service, stand alone in front of the camera, and call:

```powershell
Invoke-RestMethod -Method Post -ContentType application/json `
  -Body '{"name":"Abiram","samples":20}' `
  http://127.0.0.1:8001/enrollment/start

Invoke-RestMethod http://127.0.0.1:8001/enrollment
```

Repeat for Jishnu. Slowly look forward, slightly left, and slightly right.
Enrollment rejects faces below the configured size and blur thresholds. Never
enroll with two people in frame; collection pauses automatically unless exactly
one face is visible.

## API

- `GET /health` and `GET /status`: camera, identity, profiles, capture FPS,
  inference FPS, average latency, p95 latency, OpenCV model readiness, and
  always-on pipeline mode. Before enrollment, `profiles` is empty and identity
  truthfully remains `Unknown`.
- `GET /identity` and `GET /identity/latest`: newest identity with `fresh` and `age_ms`. An observation
  older than the configured two-second TTL returns `Unknown`.
- `POST /enrollment/start`: JSON `{ "name": "Abiram", "samples": 20 }`.
- `GET /enrollment`: enrollment progress.
- `POST /enrollment/cancel`: cancel collection.
- `DELETE /profiles/Abiram`: remove a stored profile.
- `POST /camera/pause`: release the device and expire identity for privacy.
- `POST /camera/resume`: reopen the configured camera and resume recognition.

The camera and inference loops begin as soon as this service starts; there is no
recognition button and no per-utterance camera startup. The integration should
query `/identity/latest` at the first speech event and retain that snapshot
for the complete utterance. Accept a name only when both `recognized` and
`fresh` are true. Otherwise use `Unknown`. Do not wait for another recognition
cycle after speech begins, because that could associate a later bystander with
the utterance.

Identity is fail-closed. A frame with no face replaces any prior match with
`Unknown`, zero score, and zero margin on the next inference tick. An expired
cache does the same. If more than one face is visible, the result is `Unknown`
with reason `multiple faces`; Echo Q does not guess which visible person spoke.
At the default 10 inference FPS, no-face invalidation occurs within one 100 ms
scheduling interval plus that frame's inference time.

## Calibration and performance

Defaults target 30 FPS capture and 10 FPS identity inference at 640x480. Inspect:

```powershell
Invoke-RestMethod http://127.0.0.1:8001/status | ConvertTo-Json -Depth 5
```

Tune `identity_threshold` using same-person and unknown-person trials on the
actual camera. `identity_margin` prevents a close first/second match from being
accepted. Production acceptance should include unknown people, varied lighting,
glasses, angles, and distances. A two-person demo is not biometric-grade access
control; never use this result for safety-critical authorization.

Measured on the development computer with the C270 at 640x480: 30.1 capture
FPS, 10.0 configured inference FPS, 20.5 ms mean end-to-end face inference and
32.5 ms p95 across the first 20 live samples. Re-benchmark on the UNO Q using
`/status`; workstation results do not predict board performance.

Run unit tests without a camera:

```powershell
.\face_recognition\.venv\Scripts\python.exe -m unittest discover -s tests/face_recognition -p "test_*.py"
```
