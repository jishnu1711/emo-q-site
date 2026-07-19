# Echo Q

Echo Q is a local-first ambient assistant for personalized reminders. YuNet detects faces, SFace identifies enrolled people, browser speech recognition captures the request, and the Node service attaches the identity visible when speech began.

## What is implemented

- Always-on C270 capture separated from inference: stale frames never queue.
- OpenCV YuNet face detection and SFace aligned embeddings.
- Local enrollment with strict `Unknown` rejection, score margin, and identity expiry.
- Continuous browser speech recognition with no wake word and a typed-command fallback.
- Automatic identity snapshot when speech begins—no recognition button.
- Persistent recurring reminders, SSE delivery, chime, vibration, browser notification, and polite speech.
- Google Calendar event parsing with an explicit review step.
- Phone-first Apple-inspired interface with independent light and dark themes.
- One privacy control pauses both browser speech and the server-side camera.

## Run on Windows

One command starts both OpenCV vision and the Echo Q web service:

```powershell
cd D:\AI_Hack
npm start
```

Open:

```text
http://localhost:3000
```

Wait until both `Echo Q: http://localhost:3000` and `Echo Q vision ready` appear. Stop both services with `Ctrl+C`. No services are configured to start automatically.

For diagnostics, they can still be launched separately with `npm run start:vision` and `npm run start:web`.

## Enroll Abiram and Jishnu

Keep `npm start` running. Open a second PowerShell, make sure only the person being enrolled is visible, and look forward, then slightly left and right while 20 good samples are collected.

```powershell
Invoke-RestMethod -Method Post -ContentType application/json `
  -Body '{"name":"Abiram","samples":20}' `
  http://127.0.0.1:8001/enrollment/start
```

Check progress:

```powershell
Invoke-RestMethod http://127.0.0.1:8001/enrollment | ConvertTo-Json -Depth 5
```

Repeat with Jishnu:

```powershell
Invoke-RestMethod -Method Post -ContentType application/json `
  -Body '{"name":"Jishnu","samples":20}' `
  http://127.0.0.1:8001/enrollment/start
```

Profiles are stored locally in `face_recognition/data/profiles.npz`. Enrollment is not model training and normally takes about one minute per person.

## Demo flow

1. Run `npm start` and enroll the demo speakers once.
2. Open Echo Q and select **Enable Echo Q**.
3. Say: `Echo, I want to drink water. Remind me every hour.`
4. Echo Q snapshots the current SFace identity, saves the reminder, and acknowledges that person.
5. Use a one-minute interval when demonstrating notification delivery.
6. Say: `Echo, add to the calendar birthday is on 11th February.`
7. Review the interpreted event and continue to Google Calendar.

If identity is stale, ambiguous, or below threshold, the reminder is safely stored as `Unknown` rather than assigning the wrong person.

After enabling the microphone once, speak the reminder or calendar request directly. Echo Q continuously listens and processes each completed utterance; no wake word is required.

## Phone access

The phone and computer must be on the same Wi-Fi. Run `ipconfig`, find the active adapter's IPv4 address, then open:

```text
http://<computer-ip>:3000
```

The C270 vision pipeline runs on the computer or UNO Q, so the phone does not need camera access. Hands-free browser speech and browser notifications may require HTTPS or `localhost`; typed commands still work over ordinary LAN HTTP. On Android, `adb reverse tcp:3000 tcp:3000` allows the phone to use `http://localhost:3000` over USB.

## Performance measured on the development computer

- C270 capture: 30.1 FPS
- Configured recognition: 10 FPS
- Mean live inference: 20.5 ms
- p95 live inference: 32.5 ms

These figures are measured, not estimates. Re-run the benchmark through `http://127.0.0.1:8001/status` on the UNO Q before quoting board performance.

## Tests

Run the complete suite:

```powershell
npm run test:all
```

Current suite: eight Node integration/server tests and five Python vision tests.

## Configuration and deployment

- Face-recognition settings: copy `face_recognition/config.example.json` to `face_recognition/config.json` and tune thresholds only after collecting known and unknown trials.
- Vision API: `http://127.0.0.1:8001` by default.
- Override from Node with `ECHO_Q_VISION_URL`.
- Reminder data: `storage/state.json`.
- OpenCV models: `face_recognition/models/`.
- UNO Q and calibration instructions: [face_recognition/README.md](face_recognition/README.md).
- Product acceptance targets: [docs/product-acceptance.md](docs/product-acceptance.md).

Google Calendar currently opens a prepared event for user confirmation. Direct background writes require a Google OAuth client and Calendar API credentials.
