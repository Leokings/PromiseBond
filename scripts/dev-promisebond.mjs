import { spawn } from "node:child_process";

const commands = [
  {
    args: [
      "node_modules/vite/bin/vite.js",
      "--mode",
      "promisebond",
      "--host",
      "127.0.0.1",
      "--port",
      "8080"
    ],
    command: process.execPath,
    name: "web"
  },
  {
    args: ["server/promisebond/index.js"],
    command: process.execPath,
    name: "api"
  }
];

const children = [];
let stopping = false;

function stopAll(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }
}

for (const entry of commands) {
  const child = spawn(entry.command, entry.args, {
    env: process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });

  children.push(child);
  child.stdout.on("data", (chunk) => process.stdout.write(`[${entry.name}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[${entry.name}] ${chunk}`));
  child.on("exit", (code, signal) => {
    if (stopping) return;
    console.error(`[${entry.name}] exited with ${signal || code}`);
    stopAll();
    process.exitCode = code || 1;
  });
}

process.on("SIGINT", () => stopAll("SIGINT"));
process.on("SIGTERM", () => stopAll("SIGTERM"));
