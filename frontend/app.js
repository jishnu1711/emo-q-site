import { getSpeechRecognition } from "/speech_to_text/browser_speech_recognition.js";

(() => {
  "use strict";

  const byId = (...ids) => ids.map(id => document.getElementById(id)).find(Boolean);
  const ui = {
    app: byId("app"),
    overlay: byId("enableOverlay"),
    onboardingStatus: byId("onboardingStatus"),
    enable: byId("enableButton", "micButton"),
    mic: byId("micButton"),
    theme: byId("themeButton"),
    test: byId("testButton"),
    save: byId("saveButton"),
    input: byId("commandInput", "command"),
    form: byId("commandForm"),
    submit: byId("submitCommand"),
    state: byId("assistantState", "activeState"),
    stateTitle: byId("stateTitle"),
    stateDetail: byId("stateDetail"),
    liveTranscript: byId("liveTranscript"),
    transcript: byId("transcript"),
    speakerChip: byId("speakerChip"),
    speakerAvatar: byId("speakerAvatar"),
    speaker: byId("speakerName"),
    confidence: byId("speakerConfidence"),
    privacy: byId("privacyStatus"),
    privacyToggle: byId("privacyToggle"),
    serviceIndicator: byId("serviceIndicator"),
    serviceStatus: byId("serviceStatus"),
    micIndicator: byId("micIndicator"),
    micStatus: byId("micStatus"),
    reminder: byId("reminderTitle"),
    reminderSchedule: byId("reminderSchedule"),
    reminderPerson: byId("reminderPerson"),
    next: byId("nextReminder", "nextTime"),
    countdown: byId("reminderCountdown"),
    list: byId("remindersList", "events"),
    toast: byId("toast"),
    toastTitle: byId("toastTitle"),
    toastText: byId("toastText"),
    calendarSheet: byId("calendarSheet"),
    calendarTitle: byId("calendarEventTitle"),
    calendarDate: byId("calendarEventDate"),
    calendarCancel: byId("cancelCalendar"),
    calendarConfirm: byId("confirmCalendar"),
    calendarBackdrop: byId("calendarBackdrop"),
    contentSheet: byId("contentSheet"),
    sheetTitle: byId("sheetTitle"),
    sheetContent: byId("sheetContent"),
    closeSheet: byId("closeSheetButton"),
    sheetBackdrop: byId("sheetBackdrop"),
    reminderDetails: byId("reminderDetailsButton"),
    quickListen: byId("quickListenButton"),
    clock: byId("clockTime"),
    date: byId("clockDate")
  };

  const SpeechRecognition = getSpeechRecognition();
  const app = {
    enabled: localStorage.getItem("echo-q-enabled") === "true",
    recognition: null,
    recognitionRunning: false,
    restartTimer: null,
    restartDelay: 250,
    speechSession: null,
    utteranceText: "",
    finalTimer: null,
    visionReady: false,
    visionChecked: false,
    speechBlocked: false,
    lastSpeechError: "",
    manualRestart: false,
    runtimePollTimer: null,
    currentCalendarUrl: "",
    reminders: [],
    calendarEvents: [],
    paused: false
  };

  function setText(element, value) { if (element) element.textContent = value; }
  function setState(state, detail = "") {
    document.documentElement.dataset.assistantState = state;
    if (ui.app) ui.app.dataset.assistantState = state;
    const labels = {
      ready: ["Echo Q is ready", "What can I remember for you?"],
      hearing: ["Listening", "Go ahead. I’m listening."],
      processing: ["Understanding", "One moment…"],
      done: ["All set", "Consider it remembered."],
      offline: ["Echo Q is paused", "Listening is off."]
    };
    const label = labels[state] || [state, state]; setText(ui.state, label[0]); setText(ui.stateTitle, label[1]);
    if (detail) { setText(ui.stateDetail, detail); setText(ui.transcript, detail); ui.liveTranscript?.removeAttribute("data-empty"); }
  }
  function setSpeechDiagnostic(status, detail) {
    document.documentElement.dataset.speechStatus = status;
    const messages = {
      unsupported: "Speech recognition unsupported · type instead",
      denied: "Microphone permission denied · enable it in browser settings",
      "audio-capture": "No microphone is available",
      network: "Speech service network error · retrying",
      "no-speech": "No speech heard · still listening",
      active: "Microphone active · speak naturally",
      supported: "Speech recognition supported · enable Echo Q",
      restarting: "Speech recognition restarting…",
      paused: "Camera & voice paused"
    };
    const message = detail || messages[status] || status;
    const indicatorState = ({ active: "listening", supported: "waiting", restarting: "checking", "no-speech": "waiting", paused: "paused", unsupported: "error", denied: "error", "audio-capture": "error", network: "error" })[status] || "error";
    setText(ui.privacy, message); setText(ui.micStatus, message);
    if (ui.micIndicator) { ui.micIndicator.dataset.status = indicatorState; ui.micIndicator.setAttribute("aria-label", `Microphone: ${message}`); }
  }
  function showToast(title, text) {
    setText(ui.toastTitle, title); setText(ui.toastText, text);
    if (!ui.toast) return;
    ui.toast.hidden = false; ui.toast.classList.add("show");
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => { ui.toast.classList.remove("show"); ui.toast.hidden = true; }, 4200);
  }
  function formatNext(value) {
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? "—" : new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
  }
  function speak(text) {
    if (!text || !("speechSynthesis" in window)) return;
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.96; utterance.pitch = 1; utterance.volume = 0.85;
    speechSynthesis.speak(utterance);
  }
  function alarm() {
    navigator.vibrate?.([120, 70, 120]);
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      const context = new AudioContext(); const gain = context.createGain();
      gain.gain.setValueAtTime(0.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.16, context.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.7);
      const oscillator = context.createOscillator(); oscillator.type = "sine"; oscillator.frequency.value = 660;
      oscillator.connect(gain).connect(context.destination); oscillator.start(); oscillator.stop(context.currentTime + 0.72);
      oscillator.onended = () => context.close();
    } catch { /* Vibration and speech remain available. */ }
  }
  function notifyReminder(reminder) {
    const body = `${reminder.speaker && reminder.speaker !== "Unknown" ? `${reminder.speaker}, ` : ""}it’s time to ${reminder.title.toLowerCase()}.`;
    alarm(); speak(`Gentle reminder. ${body}`);
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification(`Echo Q · ${reminder.title}`, { body, tag: reminder.id, renotify: true });
    }
    showToast("Reminder", body);
  }

  async function api(path, options = {}) {
    const response = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(body.error || body.reply || "Request failed."), { status: response.status, body });
    return body;
  }

  function renderIdentity(identity) {
    const name = identity?.name || "Unknown";
    const confidence = Number(identity?.confidence ?? identity?.score ?? 0);
    setText(ui.speaker, name === "Unknown" ? "Speaker unknown" : name);
    const visionLabel = app.visionChecked ? (app.visionReady ? "OpenCV ready" : "OpenCV vision offline") : "Face recognition ready";
    setText(ui.confidence, name === "Unknown" ? `${visionLabel}${app.visionReady ? " · looking for a clear face" : ""}` : `${Math.round(confidence * 100)}% match · ${visionLabel}`);
    setText(ui.speakerAvatar, name === "Unknown" ? "?" : name[0].toUpperCase());
    if (ui.speakerChip) ui.speakerChip.dataset.recognition = !app.visionReady && app.visionChecked ? "offline" : name === "Unknown" ? "unknown" : "recognized";
  }
  function applyRuntimeSnapshot(runtime) {
    const vision = runtime?.vision || {};
    app.visionChecked = true; app.visionReady = Boolean(vision.online && vision.ready && !app.paused);
    const identity = app.paused ? { name: "Unknown" } : runtime?.identity || { name: "Unknown" };
    renderIdentity(identity);
    let serviceState = "ready"; let serviceText = "OpenCV ready";
    if (!vision.online) { serviceState = "offline"; serviceText = "OpenCV vision offline"; setText(ui.confidence, serviceText); }
    else if (app.paused || vision.camera?.paused) { serviceState = "paused"; serviceText = "Vision paused"; setText(ui.confidence, "OpenCV ready · camera paused"); }
    else if (identity.name === "Unknown") { serviceState = "waiting"; serviceText = "Looking for a face"; setText(ui.confidence, "OpenCV ready · no recognized face"); }
    else serviceText = `${runtime.identity.name} recognized`;
    setText(ui.serviceStatus, serviceText);
    if (ui.serviceIndicator) { ui.serviceIndicator.dataset.status = serviceState; ui.serviceIndicator.setAttribute("aria-label", `Vision: ${serviceText}`); }
  }
  async function pollRuntime() {
    clearTimeout(app.runtimePollTimer);
    try { applyRuntimeSnapshot(await api("/api/runtime")); }
    catch { applyRuntimeSnapshot({ vision: { online: false, ready: false }, identity: { name: "Unknown" } }); }
    app.runtimePollTimer = setTimeout(pollRuntime, 500);
  }
  function renderReminders(reminders) {
    app.reminders = reminders || [];
    const active = app.reminders.filter(item => item.active);
    const upcoming = active.sort((a, b) => Date.parse(a.nextAt) - Date.parse(b.nextAt))[0];
    setText(ui.reminder, upcoming?.title || "No reminders yet");
    setText(ui.reminderSchedule, upcoming?.frequency || "No schedule");
    setText(ui.reminderPerson, upcoming ? (upcoming.speaker === "Unknown" ? "Speaker unknown" : `For ${upcoming.speaker}`) : "Say a reminder to begin");
    setText(ui.next, upcoming ? formatNext(upcoming.nextAt) : "—");
    updateCountdown();
    if (!ui.list) return;
    ui.list.replaceChildren(...app.reminders.slice(0, 6).map(item => {
      const row = document.createElement("button"); row.type = "button"; row.className = "reminder-row";
      row.dataset.id = item.id; row.setAttribute("aria-pressed", String(item.active));
      const title = document.createElement("span"); title.textContent = item.title;
      const meta = document.createElement("small"); meta.textContent = `${item.speaker} · ${item.active ? item.frequency : "Paused"}`;
      row.append(title, meta); row.addEventListener("click", () => toggleReminder(item)); return row;
    }));
  }
  async function refreshState() {
    try { const state = await api("/api/state"); app.calendarEvents = state.calendarEvents || []; renderReminders(state.reminders); }
    catch { setState("offline", "Echo Q server is unavailable."); }
  }
  async function toggleReminder(reminder) {
    try {
      const updated = await api(`/api/reminders/${encodeURIComponent(reminder.id)}`, { method: "PATCH", body: JSON.stringify({ active: !reminder.active }) });
      const index = app.reminders.findIndex(item => item.id === updated.id); if (index >= 0) app.reminders[index] = updated;
      renderReminders(app.reminders); showToast(updated.active ? "Reminder resumed" : "Reminder paused", updated.title);
    } catch (error) { showToast("Couldn’t update reminder", error.message); }
  }

  async function beginSpeechSession(detail = "I’m listening…") {
    setState("hearing", detail);
    const pending = api("/api/speech/start", { method: "POST", body: "{}" });
    app.speechSession = pending;
    try { const session = await pending; renderIdentity(session.identity); return session; }
    catch { renderIdentity({ name: "Unknown" }); return null; }
  }
  async function submitTranscript(transcript) {
    const text = String(transcript || "").trim(); if (!text) return;
    setText(ui.transcript, text); setState("processing");
    let session = null;
    try { session = await app.speechSession; } catch { /* server will sample identity again */ }
    try {
      const result = await api("/api/speech/final", { method: "POST", body: JSON.stringify({ sessionId: session?.id, transcript: text }) });
      renderIdentity(result.identity); setState("done", result.reply); speak(result.reply);
      if (result.reminder) { await refreshState(); showToast("Reminder saved", `${result.reminder.title} · ${result.reminder.frequency}`); }
      if (result.event) openCalendarSheet(result.event);
      setTimeout(() => app.enabled && setState("ready", "Listening continuously. Speak when you need me."), 2800);
    } catch (error) {
      const reply = error.body?.reply || "I’m sorry, something went wrong. Please try again.";
      setState("ready", reply); speak(reply);
    } finally { app.speechSession = null; }
  }

  function handleSpokenUtterance(transcript) {
    const text = String(transcript || "").trim(); if (!text) return;
    if (!app.speechSession) beginSpeechSession(`Heard · ${text}`);
    submitTranscript(text);
  }

  function startRecognition() {
    if (!app.enabled || app.paused || !app.recognition || app.recognitionRunning || document.hidden) return;
    try { app.recognition.start(); }
    catch (error) { setSpeechDiagnostic("restarting", `Couldn’t start recognition · ${error?.name || "retrying"}`); scheduleRecognitionRestart(); }
  }
  function scheduleRecognitionRestart(preserveDiagnostic = false) {
    clearTimeout(app.restartTimer); if (!app.enabled || app.paused || app.speechBlocked || document.hidden) return;
    const restart = () => { setSpeechDiagnostic("restarting"); app.restartTimer = setTimeout(startRecognition, app.restartDelay); };
    if (preserveDiagnostic) app.restartTimer = setTimeout(restart, 700); else restart();
    app.restartDelay = Math.min(app.restartDelay * 1.6, 4000);
  }
  async function activateRecognitionFromGesture() {
    if (!app.enabled) return enableEcho();
    if (!SpeechRecognition) { setSpeechDiagnostic("unsupported"); setState("offline", "Voice recognition isn’t supported here. Type your request below."); return; }
    if (app.paused) return togglePrivacy();
    app.speechBlocked = false; clearTimeout(app.restartTimer);
    if (app.recognitionRunning) {
      app.manualRestart = true; setSpeechDiagnostic("restarting", "Restarting recognition from your tap…");
      try { app.recognition.abort(); } catch { app.recognitionRunning = false; startRecognition(); }
    } else startRecognition();
  }
  function configureRecognition() {
    if (!SpeechRecognition) {
      app.speechBlocked = true; setSpeechDiagnostic("unsupported");
      return;
    }
    const recognition = app.recognition = new SpeechRecognition();
    setSpeechDiagnostic("supported");
    recognition.continuous = true; recognition.interimResults = true; recognition.maxAlternatives = 3; recognition.lang = document.documentElement.lang || "en-IN";
    recognition.onstart = () => { app.recognitionRunning = true; app.speechBlocked = false; app.manualRestart = false; app.restartDelay = 250; setSpeechDiagnostic("active"); setState("ready", "Listening continuously. Speak when you need me."); };
    recognition.onspeechstart = () => { app.utteranceText = ""; clearTimeout(app.finalTimer); if (!app.speechSession) beginSpeechSession(); };
    recognition.onresult = event => {
      let interim = "";
      for (let index = event.resultIndex; index < event.results.length; index++) {
        const result = event.results[index];
        const selected = result[0].transcript;
        if (result.isFinal) app.utteranceText += `${selected} `; else interim += selected;
      }
      if (interim) { setState("hearing"); setText(ui.transcript, interim); }
      if (app.utteranceText) {
        clearTimeout(app.finalTimer);
        app.finalTimer = setTimeout(() => { const text = app.utteranceText; app.utteranceText = ""; handleSpokenUtterance(text); }, 220);
      }
    };
    recognition.onspeechend = () => {
      if (!app.utteranceText) return;
      clearTimeout(app.finalTimer);
      app.finalTimer = setTimeout(() => { const text = app.utteranceText; app.utteranceText = ""; handleSpokenUtterance(text); }, 120);
    };
    recognition.onerror = event => {
      const error = event.error || "unknown";
      app.lastSpeechError = error;
      if (error === "aborted" && app.manualRestart) { setSpeechDiagnostic("restarting"); return; }
      if (error === "not-allowed" || error === "service-not-allowed") {
        app.enabled = false; app.speechBlocked = true; localStorage.removeItem("echo-q-enabled"); setSpeechDiagnostic("denied"); setState("offline", "Microphone permission was denied. Allow it in browser settings, or type below."); showToast("Microphone blocked", "Allow microphone access in browser settings to use Echo Q hands-free."); return;
      }
      if (error === "audio-capture") { app.speechBlocked = true; setSpeechDiagnostic("audio-capture"); setState("offline", "No working microphone was found. Check the device, then tap the orb."); showToast("Microphone unavailable", "Check that another app isn’t using the microphone."); return; }
      if (error === "network") { setSpeechDiagnostic("network"); showToast("Speech network error", "Echo Q will retry automatically. Typed commands still work."); return; }
      if (error === "no-speech") { setSpeechDiagnostic("no-speech"); return; }
      setSpeechDiagnostic("restarting", `Speech error: ${error} · retrying`); showToast("Speech recognition error", `${error}. Echo Q will retry.`);
    };
    recognition.onend = () => { app.recognitionRunning = false; if (app.manualRestart) app.restartDelay = 50; const preserve = app.lastSpeechError === "no-speech" || app.lastSpeechError === "network"; app.lastSpeechError = ""; scheduleRecognitionRestart(preserve); };
  }

  async function enableEcho() {
    app.enabled = true; app.speechBlocked = false; localStorage.setItem("echo-q-enabled", "true");
    if (!app.recognition) configureRecognition();
    const enableLabel = ui.enable?.querySelector("span"); setText(enableLabel, "Echo Q is enabled");
    if (ui.overlay) { ui.overlay.classList.add("is-hidden"); setTimeout(() => { ui.overlay.hidden = true; }, 460); }
    setText(ui.onboardingStatus, "Echo Q is ready."); startRecognition();
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {});
  }
  function openCalendarSheet(event) {
    app.currentCalendarUrl = event.calendarUrl;
    setText(ui.calendarTitle, event.title); setText(ui.calendarDate, event.date);
    if (ui.calendarSheet) { ui.calendarSheet.hidden = false; ui.calendarSheet.classList.add("open"); }
  }
  function closeCalendarSheet() { ui.calendarSheet?.classList.remove("open"); if (ui.calendarSheet) ui.calendarSheet.hidden = true; }

  function updateCountdown() {
    const upcoming = app.reminders.filter(item => item.active).sort((a, b) => Date.parse(a.nextAt) - Date.parse(b.nextAt))[0];
    if (!upcoming) return setText(ui.countdown, "Nothing scheduled");
    const minutes = Math.max(0, Math.ceil((Date.parse(upcoming.nextAt) - Date.now()) / 60_000));
    setText(ui.countdown, minutes < 1 ? "due now" : minutes < 60 ? `in ${minutes} min` : `in ${Math.floor(minutes / 60)} hr ${minutes % 60 ? `${minutes % 60} min` : ""}`.trim());
  }

  function openContentSheet(view) {
    if (!ui.contentSheet || !ui.sheetContent) return;
    const names = { reminders: "Reminders", calendar: "Calendar", settings: "Settings" };
    setText(ui.sheetTitle, names[view] || "Echo Q"); ui.sheetContent.replaceChildren();
    if (view === "reminders") {
      if (!app.reminders.length) ui.sheetContent.append(document.createTextNode("No reminders yet. Say “Remind me to drink water every hour.”"));
      for (const reminder of app.reminders) {
        const button = document.createElement("button"); button.type = "button"; button.className = "sheet-list-item";
        const strong = document.createElement("strong"); strong.textContent = reminder.title;
        const small = document.createElement("small"); small.textContent = `${reminder.frequency} · ${reminder.speaker} · ${reminder.active ? "Active" : "Paused"}`;
        button.append(strong, small); button.addEventListener("click", () => toggleReminder(reminder).then(() => openContentSheet("reminders"))); ui.sheetContent.append(button);
      }
    } else if (view === "calendar") {
      if (!app.calendarEvents.length) ui.sheetContent.append(document.createTextNode("No calendar events prepared yet."));
      for (const event of app.calendarEvents) {
        const row = document.createElement("div"); row.className = "sheet-list-item";
        const strong = document.createElement("strong"); strong.textContent = event.title;
        const small = document.createElement("small"); small.textContent = `${event.date} · ${event.speaker}`; row.append(strong, small); ui.sheetContent.append(row);
      }
    } else {
      const status = document.createElement("p"); status.textContent = `Theme: ${document.documentElement.dataset.theme}. Voice: ${app.paused ? "paused" : "enabled"}. Face identity is processed locally by the Echo Q vision service.`; ui.sheetContent.append(status);
    }
    ui.contentSheet.hidden = false;
  }
  function closeContentSheet() { if (ui.contentSheet) ui.contentSheet.hidden = true; }

  async function togglePrivacy() {
    const paused = !app.paused;
    app.paused = paused;
    ui.privacyToggle?.setAttribute("aria-pressed", String(app.paused));
    ui.privacyToggle?.setAttribute("aria-label", app.paused ? "Resume camera and microphone" : "Pause camera and microphone");
    if (app.paused) {
      clearTimeout(app.restartTimer); app.recognition?.stop(); renderIdentity({ name: "Unknown" }); setSpeechDiagnostic("paused"); setState("offline", "Tap privacy again when you’re ready.");
    } else {
      setState("ready", "Listening continuously. Speak when you need me."); startRecognition();
    }
    try { await api("/api/vision/camera", { method: "POST", body: JSON.stringify({ paused }) }); }
    catch { setSpeechDiagnostic(paused ? "paused" : "active", paused ? "Voice paused · camera control unavailable" : "Voice on · camera control unavailable"); showToast("Camera control unavailable", "Voice privacy was updated, but check the local vision service."); }
  }

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme; document.documentElement.style.colorScheme = theme;
    localStorage.setItem("echo-q-theme", theme); ui.theme?.setAttribute("aria-label", `Use ${theme === "dark" ? "light" : "dark"} mode`); ui.theme?.setAttribute("aria-pressed", String(theme === "dark"));
  }
  function tickClock() {
    const now = new Date(); setText(ui.clock, new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(now));
    setText(ui.date, new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(now));
  }
  function connectEvents() {
    const source = new EventSource("/api/events");
    source.addEventListener("reminder", event => notifyReminder(JSON.parse(event.data)));
    for (const type of ["reminder-created", "reminder-updated"]) source.addEventListener(type, refreshState);
    source.onerror = () => { document.documentElement.dataset.reminderStream = "reconnecting"; };
    source.onopen = () => { document.documentElement.dataset.reminderStream = "connected"; };
  }

  ui.enable?.addEventListener("click", enableEcho);
  if (ui.mic && ui.mic !== ui.enable) ui.mic.addEventListener("click", activateRecognitionFromGesture);
  ui.form?.addEventListener("submit", async event => { event.preventDefault(); const text = ui.input?.value; if (!text?.trim()) return; await beginSpeechSession(); submitTranscript(text); ui.input.value = ""; });
  ui.save?.addEventListener("click", async () => { await beginSpeechSession(); submitTranscript(ui.input?.value); });
  ui.input?.addEventListener("keydown", async event => { if (event.key === "Enter") { event.preventDefault(); await beginSpeechSession(); submitTranscript(ui.input.value); } });
  ui.test?.addEventListener("click", () => notifyReminder({ id: "test", title: "Drink water", speaker: "", frequency: "Now" }));
  ui.theme?.addEventListener("click", () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
  ui.calendarCancel?.addEventListener("click", closeCalendarSheet);
  ui.calendarBackdrop?.addEventListener("click", closeCalendarSheet);
  ui.calendarConfirm?.addEventListener("click", () => { if (app.currentCalendarUrl) window.open(app.currentCalendarUrl, "_blank", "noopener"); closeCalendarSheet(); });
  ui.privacyToggle?.addEventListener("click", togglePrivacy);
  ui.quickListen?.addEventListener("click", activateRecognitionFromGesture);
  ui.reminderDetails?.addEventListener("click", () => openContentSheet("reminders"));
  ui.closeSheet?.addEventListener("click", closeContentSheet); ui.sheetBackdrop?.addEventListener("click", closeContentSheet);
  document.querySelectorAll("[data-view]").forEach(button => button.addEventListener("click", () => {
    const view = button.dataset.view; document.querySelectorAll("[data-view]").forEach(item => { item.classList.toggle("is-active", item === button); item.toggleAttribute("aria-current", item === button); });
    if (view === "listen") return;
    if (view !== "home") openContentSheet(view); else closeContentSheet();
  }));
  document.addEventListener("visibilitychange", () => document.hidden ? app.recognition?.stop() : startRecognition());

  const preferred = localStorage.getItem("echo-q-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  if (ui.serviceIndicator) ui.serviceIndicator.dataset.status = "checking";
  setText(ui.serviceStatus, "Checking OpenCV…");
  applyTheme(preferred); configureRecognition(); refreshState(); pollRuntime(); connectEvents(); tickClock(); setInterval(tickClock, 1000); setInterval(updateCountdown, 30_000);
  if (app.enabled) { if (ui.overlay) ui.overlay.hidden = true; startRecognition(); } else setState("ready", "Enable the microphone once, then speak naturally.");
})();
