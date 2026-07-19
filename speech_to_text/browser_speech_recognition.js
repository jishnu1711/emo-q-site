/**
 * Returns the browser's built-in speech-to-text engine.
 *
 * Chrome-based browsers expose this under one of two names. Keeping that
 * browser-specific detail here lets the main UI focus on application behavior.
 */
export function getSpeechRecognition() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}
