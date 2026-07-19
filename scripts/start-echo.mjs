import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const candidates = process.platform === "win32"
  ? [join(root, "face_recognition", ".venv", "Scripts", "python.exe"), "python"]
  : [join(root, "face_recognition", ".venv", "bin", "python"), "python3", "python"];
const python = process.env.ECHO_Q_PYTHON || candidates.find(candidate => !candidate.includes(root) || existsSync(candidate));

if (!python) {
  console.error("Echo Q could not find Python. Set ECHO_Q_PYTHON or create face_recognition/.venv first.");
  process.exit(1);
}

const services = [
  {
    name: "vision",
    child: spawn(python, ["-u", join("face_recognition", "face_service.py")], {
      cwd: root,
      env: process.env,
      stdio: "inherit"
    })
  },
  {
    name: "web",
    child: spawn(process.execPath, [join("backend", "server.mjs")], {
      cwd: root,
      env: process.env,
      stdio: "inherit"
    })
  }
];

let shuttingDown = false;
let finishShutdown;
const shutdownFinished = new Promise(resolve => { finishShutdown = resolve; });

function stopAll(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of services) {
    if (!child.killed) child.kill();
  }
  const forceTimer = setTimeout(() => {
    for (const { child } of services) {
      if (!child.killed) child.kill("SIGKILL");
    }
    process.exit(exitCode);
  }, 2500);
  forceTimer.unref();
  setTimeout(() => finishShutdown(exitCode), 500);
}

for (const service of services) {
  service.child.on("error", error => {
    console.error(`[${service.name}] failed to start: ${error.message}`);
    stopAll(1);
  });
  service.child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(`[${service.name}] stopped (${signal || `code ${code}`}). Stopping Echo Q.`);
    stopAll(code || 1);
  });
}

process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));
process.on("exit", () => {
  for (const { child } of services) {
    if (!child.killed) child.kill();
  }
});

console.log("Starting Echo Q vision and web services…");
console.log("Open http://localhost:3000 after both ready messages appear.");

const exitCode = await shutdownFinished;
process.exit(exitCode);
