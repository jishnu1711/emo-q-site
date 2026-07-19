# Echo Q for Arduino UNO Q

This folder is the portable UNO Q version of Echo Q. It intentionally excludes
the Windows Python environment, cached files, enrolled face profiles, and old
reminders.

## 1. Copy and extract

Copy `echo-q-uno-q.zip` to the UNO Q and extract it. Open a terminal inside the
extracted `echo-q-uno-q` folder.

## 2. Check the board

```bash
uname -m
python3 --version
node --version
ls -l /dev/video*
```

Node.js 18 or newer and Python 3 are required. The USB camera should appear as
`/dev/video0` or another `/dev/video*` device.

## 3. Install and test

```bash
chmod +x setup.sh start.sh
./setup.sh
```

If Python reports that `venv` is unavailable, install the Debian
`python3-venv` package and retry. If OpenCV cannot be installed, confirm that
the board is online and that pip is using an ARM64-compatible package.

## 4. Start Echo Q

```bash
./start.sh
```

Open `http://<uno-q-ip>:3000` from a phone or computer on the same trusted
network. The face-recognition API stays private on `127.0.0.1:8001`.

## 5. Enrol faces again

Use the enrollment API described in `face_recognition/README.md`. Enrol people
using the final UNO Q camera, lighting, distance, and mounting position.

## Notes

- Browser speech recognition runs on the phone/computer displaying the UI.
- Microphone permissions may require HTTPS or localhost.
- Start manually until camera and recognition performance are proven stable.
- Do not expose ports 3000 or 8001 directly to the public internet.
