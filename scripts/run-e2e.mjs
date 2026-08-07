import { spawn } from "node:child_process";
import { once } from "node:events";

const port = Number(process.env.E2E_PORT ?? 4174);
const appUrl = `http://127.0.0.1:${port}`;
const python = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForServer() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(appUrl);
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await wait(100);
  }
  throw new Error(`開発サーバーを起動できませんでした: ${appUrl}`);
}

const server = spawn(python, ["scripts/serve.py", "--port", String(port)], {
  stdio: "inherit",
  windowsHide: true
});

try {
  await waitForServer();
  const test = spawn(process.execPath, ["tests/e2e.test.mjs"], {
    stdio: "inherit",
    windowsHide: true,
    env: { ...process.env, APP_URL: appUrl }
  });
  const [exitCode] = await once(test, "exit");
  process.exitCode = exitCode ?? 1;
} finally {
  if (!server.killed) server.kill();
  await Promise.race([once(server, "exit"), wait(3_000)]);
}
