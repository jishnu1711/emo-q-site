import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projectDirectory = resolve(fileURLToPath(new URL("../", import.meta.url)));
const frontendDirectory = resolve(projectDirectory, "frontend");
const speechToTextDirectory = resolve(projectDirectory, "speech_to_text");
const defaultStateFile = resolve(projectDirectory, "storage", "state.json");
const defaultVisionUrl = process.env.ECHO_Q_VISION_URL ?? "http://127.0.0.1:8001";
const port = Number.parseInt(process.env.PORT ?? "3000", 10);

const mimeTypes = {
  ".bin": "application/octet-stream", ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8", ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".svg": "image/svg+xml"
};

const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10,
  dec: 11, december: 11
};

const RESPONSES = Object.freeze({
  reminder: (name, title, frequency) => `Of course${name ? `, ${name}` : ""}. I’ll remind you to ${title.toLowerCase()} ${frequency.toLowerCase()}.`,
  calendar: (name, title, date) => `Of course${name ? `, ${name}` : ""}. I’ve prepared ${title} for ${date} in Google Calendar.`,
  unknown: "I’m sorry, I didn’t catch a reminder or calendar event. Please try that again.",
  empty: "I’m sorry, I didn’t hear anything. Please try again."
});

function cleanText(value, maximum = 180) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, maximum) : "";
}

function titleCase(value) {
  const text = cleanText(value).replace(/[.!?]+$/, "");
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

function isoLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseCalendar(text, now) {
  const calendarLead = /(?:add|put|create|schedule).{0,18}(?:calendar|event)|calendar/i.test(text);
  if (!calendarLead) return null;
  const dateMatch = text.match(/(?:on\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+(\d{4}))?/i);
  if (!dateMatch) return null;
  const day = Number(dateMatch[1]);
  const month = MONTHS[dateMatch[2].toLowerCase()];
  let year = dateMatch[3] ? Number(dateMatch[3]) : now.getFullYear();
  let date = new Date(year, month, day, 9, 0, 0, 0);
  if (!dateMatch[3] && date < now) date = new Date(++year, month, day, 9, 0, 0, 0);
  if (date.getMonth() !== month || date.getDate() !== day) return null;
  let title = text
    .replace(/^(?:please\s+)?(?:add|put|create|schedule)\s+/i, "")
    .replace(/(?:to|in|on)\s+(?:my\s+|the\s+)?calendar\s*/i, "")
    .replace(/\s*(?:is\s+)?(?:on\s+)?\d{1,2}(?:st|nd|rd|th)?\s+[a-z]+(?:\s+\d{4})?.*$/i, "")
    .trim();
  title = titleCase(title || "Event");
  return { type: "calendar", title, date: isoLocalDate(date) };
}

function parseFrequency(text) {
  const every = text.match(/every\s+(?:(\d+)\s+)?(minute|minutes|hour|hours|day|days)\b/i);
  if (every) {
    const amount = Number(every[1] || 1);
    const unit = every[2].toLowerCase().replace(/s$/, "");
    const factors = { minute: 60_000, hour: 3_600_000, day: 86_400_000 };
    return { frequency: `Every ${amount === 1 ? "" : `${amount} `}${unit}${amount === 1 ? "" : "s"}`, intervalMs: amount * factors[unit] };
  }
  const inTime = text.match(/\bin\s+(\d+)\s+(minute|minutes|hour|hours)\b/i);
  if (inTime) {
    const amount = Number(inTime[1]);
    const unit = inTime[2].toLowerCase().replace(/s$/, "");
    return { frequency: `In ${amount} ${unit}${amount === 1 ? "" : "s"}`, intervalMs: amount * (unit === "hour" ? 3_600_000 : 60_000), oneShot: true };
  }
  return null;
}

export function parseIntent(input, referenceDate = new Date()) {
  const text = cleanText(input);
  if (!text) return { type: "empty" };
  const calendar = parseCalendar(text, referenceDate);
  if (calendar) return calendar;
  const timing = parseFrequency(text);
  if (!timing || !/(?:remind|remember|want to|need to)/i.test(text)) return { type: "unknown" };
  const desire = text.match(/\b(?:i want|i need)\s+to\s+(.+?)(?=\s*(?:[,.]|and)?\s*remind\s+(?:me|us)|\s+(?:every|in)\s+\d*\s*(?:minute|minutes|hour|hours|day|days)|$)/i);
  let title = desire?.[1] || text.replace(/^.*?\bremind\s+(?:me|us)\s+(?:to\s+)?/i, "");
  title = title
    .replace(/\s*(?:,|\.|and)?\s*remind\s+(?:me|us).*$/i, "")
    .replace(/\s+(?:every|in)\s+\d*\s*(?:minute|minutes|hour|hours|day|days).*$/i, "")
    .trim();
  title = titleCase(title || "Complete the task");
  return { type: "reminder", title, ...timing };
}

export function normalizeIdentity(payload, now = Date.now()) {
  const source = payload?.identity && typeof payload.identity === "object" ? payload.identity : payload?.latest ?? payload;
  const name = cleanText(source?.name ?? source?.person ?? (typeof source?.identity === "string" ? source.identity : ""), 60);
  let confidence = Number(source?.confidence ?? source?.score ?? 0);
  if (confidence > 1 && confidence <= 100) confidence /= 100;
  const rawObserved = source?.observedAt ?? source?.observed_at ?? source?.timestamp ?? source?.updated_at;
  const numericObserved = typeof rawObserved === "number" ? (rawObserved < 10_000_000_000 ? rawObserved * 1000 : rawObserved) : NaN;
  const observed = numericObserved || Date.parse(rawObserved ?? "") || now;
  const fresh = now - observed < 5_000;
  const rejectedByModel = source?.recognized === false;
  const noFace = source?.faces === 0;
  const explicitlyStale = source?.fresh === false;
  const belowGenericThreshold = source?.recognized !== true && confidence < 0.55;
  if (!name || /unknown|none/i.test(name) || noFace || explicitlyStale || rejectedByModel || !fresh || belowGenericThreshold) {
    return { name: "Unknown", confidence: Number.isFinite(confidence) ? confidence : 0, observedAt: new Date(observed).toISOString() };
  }
  return { name, confidence, observedAt: new Date(observed).toISOString() };
}

export function normalizeVisionStatus(payload, now = Date.now()) {
  const camera = payload?.camera && typeof payload.camera === "object" ? payload.camera : {};
  const online = Boolean(payload && payload.ok !== false && !camera.error);
  const paused = Boolean(camera.paused);
  const identity = online && !paused ? normalizeIdentity(payload?.identity, now) : normalizeIdentity({ name: "Unknown", confidence: 0, faces: 0 }, now);
  return {
    online,
    ready: online && !paused,
    camera: { paused, captureFps: Number(camera.capture_fps) || 0, inferenceFps: Number(camera.inference_fps) || 0, error: camera.error || null },
    identity
  };
}

export function buildGoogleCalendarUrl(event) {
  const date = event.date.replaceAll("-", "");
  const end = new Date(`${event.date}T00:00:00Z`); end.setUTCDate(end.getUTCDate() + 1);
  const endDate = end.toISOString().slice(0, 10).replaceAll("-", "");
  const params = new URLSearchParams({ action: "TEMPLATE", text: event.title, dates: `${date}/${endDate}`, details: `Created by Echo Q for ${event.speaker || "the speaker"}` });
  return `https://calendar.google.com/calendar/render?${params}`;
}

function inside(root, target) { return target === root || target.startsWith(`${root}${sep}`); }

export function resolveRequestPath(pathname) {
  if (pathname.startsWith("/speech_to_text/")) {
    const requested = pathname.slice("/speech_to_text/".length);
    const target = resolve(speechToTextDirectory, requested);
    return inside(speechToTextDirectory, target) ? target : null;
  }
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const target = resolve(frontendDirectory, requested);
  return inside(frontendDirectory, target) ? target : null;
}

export function createEchoServer(options = {}) {
  const stateFile = resolve(options.stateFile ?? defaultStateFile);
  const visionUrl = (options.visionUrl ?? defaultVisionUrl).replace(/\/$/, "");
  const now = options.now ?? (() => new Date());
  const fetcher = options.fetch ?? globalThis.fetch;
  const sessions = new Map();
  const clients = new Set();
  const timers = new Map();
  let writeChain = Promise.resolve();

  async function readState() {
    try {
      const state = JSON.parse(await readFile(stateFile, "utf8"));
      const reminders = (Array.isArray(state.reminders) ? state.reminders : []).map(item => {
        const timing = parseFrequency(item.frequency || "every hour") || { frequency: "Every hour", intervalMs: 3_600_000 };
        return {
          ...item,
          frequency: item.frequency || timing.frequency,
          intervalMs: Number(item.intervalMs) || timing.intervalMs,
          oneShot: Boolean(item.oneShot), active: item.active !== false,
          nextAt: item.nextAt || new Date(now().getTime() + (Number(item.intervalMs) || timing.intervalMs)).toISOString()
        };
      });
      return { reminders, calendarEvents: Array.isArray(state.calendarEvents) ? state.calendarEvents : [] };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return { reminders: [], calendarEvents: [] };
    }
  }

  function saveState(state) {
    writeChain = writeChain.then(async () => {
      await mkdir(dirname(stateFile), { recursive: true });
      await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    });
    return writeChain;
  }

  function emit(type, data) {
    const packet = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) client.write(packet);
  }

  function schedule(reminder) {
    clearTimeout(timers.get(reminder.id));
    if (!reminder.active || !reminder.nextAt) return;
    const remaining = Date.parse(reminder.nextAt) - Date.now();
    const delay = Math.max(0, Math.min(remaining, 2_147_000_000));
    timers.set(reminder.id, setTimeout(async () => {
      if (remaining > 2_147_000_000) return schedule(reminder);
      const state = await readState();
      const current = state.reminders.find(item => item.id === reminder.id);
      if (!current?.active) return;
      emit("reminder", { ...current, firedAt: new Date().toISOString() });
      if (current.oneShot) current.active = false;
      else current.nextAt = new Date(Date.now() + current.intervalMs).toISOString();
      await saveState(state);
      schedule(current);
    }, delay));
  }

  async function latestIdentity() {
    try {
      const response = await fetcher(`${visionUrl}/identity/latest`, { signal: AbortSignal.timeout(450) });
      if (response.ok) return normalizeIdentity(await response.json());
    } catch { /* Vision is optional; speech still works as Unknown. */ }
    return { name: "Unknown", confidence: 0, observedAt: now().toISOString() };
  }

  async function readJson(request) {
    const chunks = []; let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 64_000) throw Object.assign(new Error("Payload too large"), { statusCode: 413 });
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
    catch { throw Object.assign(new Error("Invalid JSON"), { statusCode: 400 }); }
  }

  function sendJson(response, status, payload) {
    response.writeHead(status, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(payload));
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      if (url.pathname === "/api/events" && request.method === "GET") {
        response.writeHead(200, { "Cache-Control": "no-cache", Connection: "keep-alive", "Content-Type": "text/event-stream", "X-Accel-Buffering": "no" });
        response.write(`event: connected\ndata: {"online":true}\n\n`);
        clients.add(response);
        request.on("close", () => clients.delete(response));
        return;
      }
      if (url.pathname === "/api/status" && request.method === "GET") {
        const state = await readState();
        return sendJson(response, 200, { online: true, visionUrl, reminders: state.reminders.length, calendarEvents: state.calendarEvents.length });
      }
      if (url.pathname === "/api/state" && request.method === "GET") return sendJson(response, 200, await readState());
      if (url.pathname === "/api/identity/latest" && request.method === "GET") return sendJson(response, 200, await latestIdentity());
      if (url.pathname === "/api/vision/status" && request.method === "GET") {
        try {
          const upstream = await fetcher(`${visionUrl}/status`, { signal: AbortSignal.timeout(700) });
          if (!upstream.ok) throw new Error("Vision service unavailable");
          return sendJson(response, 200, { online: true, ...(await upstream.json()) });
        } catch {
          return sendJson(response, 503, { online: false, error: "Vision service is offline." });
        }
      }
      if (url.pathname === "/api/runtime" && request.method === "GET") {
        try {
          const upstream = await fetcher(`${visionUrl}/status`, { signal: AbortSignal.timeout(450) });
          const payload = await upstream.json().catch(() => ({}));
          const vision = normalizeVisionStatus(upstream.ok ? payload : { ...payload, ok: false }, Date.now());
          return sendJson(response, 200, { online: true, vision, identity: vision.identity, timestamp: new Date().toISOString() });
        } catch {
          const vision = normalizeVisionStatus({ ok: false }, Date.now());
          return sendJson(response, 200, { online: true, vision, identity: vision.identity, timestamp: new Date().toISOString() });
        }
      }
      if (url.pathname === "/api/vision/camera" && request.method === "POST") {
        const body = await readJson(request);
        if (typeof body.paused !== "boolean") return sendJson(response, 400, { error: "paused must be a boolean." });
        try {
          const action = body.paused ? "pause" : "resume";
          const upstream = await fetcher(`${visionUrl}/camera/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(1_500) });
          if (!upstream.ok) throw new Error("Vision camera control failed");
          return sendJson(response, 200, { online: true, paused: body.paused, vision: await upstream.json() });
        } catch {
          return sendJson(response, 503, { online: false, paused: body.paused, error: "Couldn’t update the camera privacy state." });
        }
      }

      if (url.pathname === "/api/speech/start" && request.method === "POST") {
        const identity = await latestIdentity();
        const session = { id: crypto.randomUUID(), identity, startedAt: now().toISOString() };
        sessions.set(session.id, session);
        setTimeout(() => sessions.delete(session.id), 30_000).unref?.();
        emit("assistant-state", { state: "hearing", identity });
        return sendJson(response, 201, session);
      }

      if (url.pathname === "/api/speech/final" && request.method === "POST") {
        const body = await readJson(request);
        const transcript = cleanText(body.transcript, 500);
        const session = sessions.get(cleanText(body.sessionId, 80));
        const identity = session?.identity ?? await latestIdentity();
        const intent = parseIntent(transcript, now());
        const speaker = identity.name === "Unknown" ? "Unknown" : identity.name;
        if (intent.type === "empty" || intent.type === "unknown") {
          const reply = intent.type === "empty" ? RESPONSES.empty : RESPONSES.unknown;
          emit("assistant-state", { state: "ready", reply });
          return sendJson(response, 422, { intent, identity, reply });
        }
        const state = await readState();
        if (intent.type === "reminder") {
          const createdAt = now();
          const reminder = {
            id: crypto.randomUUID(), title: intent.title, speaker, identityConfidence: identity.confidence,
            frequency: intent.frequency, intervalMs: intent.intervalMs, oneShot: Boolean(intent.oneShot), active: true,
            createdAt: createdAt.toISOString(), nextAt: new Date(createdAt.getTime() + intent.intervalMs).toISOString()
          };
          state.reminders.unshift(reminder); state.reminders = state.reminders.slice(0, 100);
          await saveState(state); schedule(reminder);
          const reply = RESPONSES.reminder(speaker === "Unknown" ? "" : speaker, reminder.title, reminder.frequency);
          const result = { intent, identity, reminder, reply };
          emit("reminder-created", result); emit("assistant-state", { state: "done", reply });
          return sendJson(response, 201, result);
        }
        const event = { id: crypto.randomUUID(), title: intent.title, date: intent.date, speaker, status: "opened_for_confirmation", createdAt: now().toISOString() };
        event.calendarUrl = buildGoogleCalendarUrl(event);
        state.calendarEvents.unshift(event); state.calendarEvents = state.calendarEvents.slice(0, 100);
        await saveState(state);
        const reply = RESPONSES.calendar(speaker === "Unknown" ? "" : speaker, event.title, event.date);
        const result = { intent, identity, event, reply };
        emit("calendar-created", result); emit("assistant-state", { state: "done", reply });
        return sendJson(response, 201, result);
      }

      if (url.pathname === "/api/reminders" && request.method === "POST") {
        const body = await readJson(request);
        const transcript = `Remind me to ${cleanText(body.title)} ${cleanText(body.frequency) || "every hour"}`;
        request.url = "/api/speech/final";
        const identity = normalizeIdentity({ name: cleanText(body.speaker) || "Unknown", confidence: body.speaker ? 1 : 0 });
        const intent = parseIntent(transcript, now());
        const state = await readState(); const createdAt = now();
        const reminder = { id: crypto.randomUUID(), title: intent.title, speaker: identity.name, identityConfidence: identity.confidence, frequency: intent.frequency, intervalMs: intent.intervalMs, oneShot: Boolean(intent.oneShot), active: true, createdAt: createdAt.toISOString(), nextAt: new Date(createdAt.getTime() + intent.intervalMs).toISOString() };
        state.reminders.unshift(reminder); await saveState(state); schedule(reminder);
        return sendJson(response, 201, reminder);
      }

      const reminderMatch = url.pathname.match(/^\/api\/reminders\/([\w-]+)$/);
      if (reminderMatch && request.method === "PATCH") {
        const body = await readJson(request); const state = await readState();
        const reminder = state.reminders.find(item => item.id === reminderMatch[1]);
        if (!reminder) return sendJson(response, 404, { error: "Reminder not found." });
        if (typeof body.active === "boolean") reminder.active = body.active;
        if (reminder.active && Date.parse(reminder.nextAt) <= Date.now()) reminder.nextAt = new Date(Date.now() + reminder.intervalMs).toISOString();
        await saveState(state); schedule(reminder); emit("reminder-updated", reminder);
        return sendJson(response, 200, reminder);
      }

      if (request.method !== "GET" && request.method !== "HEAD") return sendJson(response, 405, { error: "Method not allowed." });
      const filePath = resolveRequestPath(decodeURIComponent(url.pathname));
      const fileInfo = filePath && await stat(filePath).catch(() => null);
      if (!fileInfo?.isFile()) { response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return response.end("Not found"); }
      response.writeHead(200, { "Cache-Control": "no-cache", "Content-Length": fileInfo.size, "Content-Type": mimeTypes[extname(filePath)] ?? "application/octet-stream" });
      if (request.method === "HEAD") return response.end();
      createReadStream(filePath).pipe(response);
    } catch (error) {
      sendJson(response, error.statusCode ?? 500, { error: error.statusCode ? error.message : "Server error." });
    }
  });

  server.initialize = async () => { const state = await readState(); await saveState(state); state.reminders.filter(item => item.active).forEach(schedule); };
  server.closeEcho = () => { for (const timer of timers.values()) clearTimeout(timer); for (const client of clients) client.end(); };
  return server;
}

export const server = createEchoServer();

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.on("error", error => {
    if (error.code === "EADDRINUSE") { console.error(`Port ${port} is already in use. Set PORT to choose another port.`); process.exitCode = 1; return; }
    throw error;
  });
  await server.initialize();
  server.listen(port, "0.0.0.0", () => {
    console.log(`Echo Q: http://localhost:${port}`);
    console.log(`Vision service: ${defaultVisionUrl}`);
  });
}
