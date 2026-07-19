import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEchoServer, normalizeIdentity, normalizeVisionStatus, parseIntent } from "../../backend/server.mjs";

test("parses natural recurring reminders without losing the requested action", () => {
  assert.deepEqual(parseIntent("I want to drink water. Remind me every hour.", new Date("2026-07-19T10:00:00")), {
    type: "reminder", title: "Drink water", frequency: "Every hour", intervalMs: 3_600_000
  });
  assert.equal(parseIntent("Remind me to stretch every 15 minutes").intervalMs, 900_000);
});

test("parses a calendar date into the next valid occurrence", () => {
  assert.deepEqual(parseIntent("Add to the calendar birthday is on 11th Feb", new Date("2026-07-19T10:00:00")), {
    type: "calendar", title: "Birthday", date: "2027-02-11"
  });
});

test("rejects stale and low-confidence identities", () => {
  const now = Date.parse("2026-07-19T10:00:00Z");
  assert.equal(normalizeIdentity({ name: "Jishnu", confidence: 0.93, timestamp: "2026-07-19T09:59:50Z" }, now).name, "Unknown");
  assert.equal(normalizeIdentity({ name: "Jishnu", confidence: 0.40, timestamp: "2026-07-19T10:00:00Z" }, now).name, "Unknown");
  assert.equal(normalizeIdentity({ name: "Jishnu", confidence: 0.93, timestamp: "2026-07-19T10:00:00Z" }, now).name, "Jishnu");
  assert.equal(normalizeIdentity({ name: "Jishnu", recognized: true, score: 0.47, observed_at: now / 1000 }, now).name, "Jishnu");
  assert.equal(normalizeIdentity({ name: "Jishnu", recognized: true, score: 0.75, faces: 0, fresh: true, observed_at: now / 1000 }, now).name, "Unknown");
});

test("normalizes runtime polling payloads and clears paused or missing faces", () => {
  const now = Date.parse("2026-07-19T10:00:00Z");
  const ready = normalizeVisionStatus({ ok: true, camera: { paused: false, capture_fps: 30.1, inference_fps: 10 }, identity: { name: "Jishnu", recognized: true, score: 0.75, faces: 1, fresh: true, observed_at: now / 1000 } }, now);
  assert.equal(ready.ready, true); assert.equal(ready.identity.name, "Jishnu"); assert.equal(ready.camera.captureFps, 30.1);
  const noFace = normalizeVisionStatus({ ok: true, camera: { paused: false }, identity: { name: "Jishnu", recognized: true, score: 0.75, faces: 0, fresh: true, observed_at: now / 1000 } }, now);
  assert.equal(noFace.identity.name, "Unknown");
  const paused = normalizeVisionStatus({ ok: true, camera: { paused: true }, identity: ready.identity }, now);
  assert.equal(paused.ready, false); assert.equal(paused.identity.name, "Unknown");
});

test("speech start captures identity and final attaches it to persisted reminder", async t => {
  const directory = await mkdtemp(join(tmpdir(), "echo-q-test-"));
  const stateFile = join(directory, "state.json");
  const observedAt = new Date().toISOString();
  const fakeFetch = async url => {
    if (String(url).endsWith("/identity/latest")) return new Response(JSON.stringify({ name: "Jishnu", confidence: 0.94, observedAt }), { status: 200 });
    return new Response("not found", { status: 404 });
  };
  const server = createEchoServer({ stateFile, visionUrl: "http://vision.test", fetch: fakeFetch });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeEcho(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;

  const started = await fetch(`${origin}/api/speech/start`, { method: "POST" }).then(response => response.json());
  assert.equal(started.identity.name, "Jishnu");
  const response = await fetch(`${origin}/api/speech/final`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: started.id, transcript: "Remind me to drink water every hour" })
  });
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(result.reminder.speaker, "Jishnu");
  assert.match(result.reply, /^Of course, Jishnu\./);

  const persisted = JSON.parse(await readFile(stateFile, "utf8"));
  assert.equal(persisted.reminders[0].title, "Drink water");
  assert.equal(persisted.reminders[0].speaker, "Jishnu");
});

test("calendar speech returns a Google Calendar confirmation URL", async t => {
  const directory = await mkdtemp(join(tmpdir(), "echo-q-calendar-"));
  const server = createEchoServer({ stateFile: join(directory, "state.json"), visionUrl: "http://vision.test", fetch: async () => new Response("", { status: 503 }), now: () => new Date("2026-07-19T10:00:00") });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeEcho(); server.close(); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/speech/final`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transcript: "Add to the calendar birthday is on 11th Feb" })
  });
  const result = await response.json();
  assert.equal(response.status, 201);
  assert.equal(result.event.date, "2027-02-11");
  assert.match(result.event.calendarUrl, /^https:\/\/calendar\.google\.com\/calendar\/render\?/);
  assert.match(result.event.calendarUrl, /dates=20270211%2F20270212/);
});

test("privacy API proxies camera pause to the local vision service", async t => {
  const directory = await mkdtemp(join(tmpdir(), "echo-q-privacy-"));
  const calls = [];
  const server = createEchoServer({
    stateFile: join(directory, "state.json"), visionUrl: "http://vision.test",
    fetch: async (url, options) => { calls.push({ url: String(url), method: options?.method }); return new Response(JSON.stringify({ camera: { paused: true } }), { status: 200 }); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeEcho(); server.close(); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/vision/camera`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paused: true })
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls[0], { url: "http://vision.test/camera/pause", method: "POST" });
});

test("runtime polling API never leaks an identity when the vision frame has no face", async t => {
  const directory = await mkdtemp(join(tmpdir(), "echo-q-runtime-"));
  const server = createEchoServer({
    stateFile: join(directory, "state.json"), visionUrl: "http://vision.test",
    fetch: async () => new Response(JSON.stringify({ ok: true, camera: { paused: false, capture_fps: 30 }, identity: { name: "Jishnu", recognized: true, score: 0.75, faces: 0, fresh: true, observed_at: Date.now() / 1000 } }), { status: 200 })
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeEcho(); server.close(); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/runtime`);
  const runtime = await response.json();
  assert.equal(response.status, 200); assert.equal(runtime.vision.online, true); assert.equal(runtime.identity.name, "Unknown");
});
