# Speech to text

Echo Q uses the browser's built-in Web Speech API, so it does not need a
separate Python speech service. `browser_speech_recognition.js` isolates the
browser-specific setup. Speech API endpoints are handled by
`backend/server.mjs`.
