/* global process, fetch, setTimeout */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { URL, fileURLToPath } from "node:url";
import { mkdtemp, mkdir, symlink, readFile, writeFile, chmod, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";

const source = fileURLToPath(new URL("..", import.meta.url));
function command(program, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { env });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test(
  "user-side install paths, credentials, foreground startup and failure checks",
  { timeout: 60000 },
  async (t) => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "aimock-user-side-"));
    const home = path.join(temporary, "home with spaces");
    const data = path.join(temporary, "persistent data");
    let calls = 0;
    const upstream = http.createServer(async (req, res) => {
      let raw = "";
      for await (const part of req) raw += part;
      assert.equal(req.headers.authorization, "Bearer upstream-test-only");
      calls++;
      const request = JSON.parse(raw);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: { role: "assistant", content: request.messages[0].content },
              finish_reason: "stop",
            },
          ],
        }),
      );
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const reservation = http.createServer();
    await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const runtime = path.join(home, "runtime/node-22.22.0-aimock-1.46.0");
    await mkdir(runtime, { recursive: true });
    await symlink(path.join(source, "node_modules"), path.join(runtime, "node_modules"));
    const key = "client-test-key-01234567890123456789";
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^(AIMOCK_|UPSTREAM_|YICLOUD_)/.test(key)),
    );
    const env = {
      ...inherited,
      AIMOCK_HOME: home,
      AIMOCK_NODE_BIN: process.execPath,
      AIMOCK_DATA_ROOT: data,
      AIMOCK_HOST: "127.0.0.1",
      AIMOCK_PORT: String(port),
      AIMOCK_WORKERS: "2",
      UPSTREAM_URL: `http://127.0.0.1:${upstream.address().port}/v1/chat/completions`,
      UPSTREAM_MODEL: "deepseek-test",
      UPSTREAM_API_KEY: "upstream-test-only",
      AIMOCK_CLIENT_API_KEY: key,
    };
    const setup = await command(process.execPath, [path.join(source, "setup.mjs"), source], env);
    assert.equal(setup.code, 0, setup.stderr);
    assert.ok(!setup.stdout.includes(key) && !setup.stdout.includes(env.UPSTREAM_API_KEY));
    const entry = path.join(home, "aimock");
    const keyFile = path.join(home, "config/client-key");
    const configFile = path.join(home, "config/upstream.json");
    const envFile = path.join(home, "config/gateway.env");
    const before = await Promise.all(
      [keyFile, configFile, envFile].map((file) => readFile(file, "utf8")),
    );
    assert.equal(before[0].trim(), key);
    const reinstall = await command(process.execPath, [path.join(source, "setup.mjs"), source], {
      ...env,
      UPSTREAM_API_KEY: "must-not-replace",
      AIMOCK_CLIENT_API_KEY: "must-not-replace",
    });
    assert.equal(reinstall.code, 0, reinstall.stderr);
    assert.deepEqual(
      await Promise.all([keyFile, configFile, envFile].map((file) => readFile(file, "utf8"))),
      before,
    );
    const gateway = spawn("/bin/bash", [entry, "start"], { env, cwd: os.tmpdir() });
    let logs = "";
    gateway.stdout.on("data", (part) => (logs += part));
    gateway.stderr.on("data", (part) => (logs += part));
    t.after(async () => {
      if (gateway.exitCode === null) {
        gateway.kill("SIGTERM");
        await once(gateway, "exit");
      }
      upstream.closeAllConnections();
      await new Promise((resolve) => upstream.close(resolve));
      await rm(temporary, { recursive: true, force: true });
    });
    const base = `http://127.0.0.1:${port}`;
    for (let index = 0; index < 500; index++) {
      try {
        const response = await fetch(base + "/healthz");
        if (response.ok) {
          assert.equal((await response.json()).aimock, "1.46.0");
          break;
        }
      } catch {
        /* still starting */
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
      if (gateway.exitCode !== null) assert.fail(logs || `Gateway exited ${gateway.exitCode}`);
      if (index === 499) assert.fail(logs || "Gateway readiness timed out");
    }
    assert.ok(logs.includes("preflight-ok"));
    const body = {
      model: "deepseek-test",
      messages: [{ role: "user", content: "portable-request" }],
      stream: false,
    };
    const response = await fetch(base + "/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "x-session-id": "portable-session",
      },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200, await response.text());
    const listed = await command(
      "/bin/bash",
      [entry, "list", "--session", "portable-session"],
      env,
    );
    assert.equal(listed.code, 0, listed.stderr);
    assert.equal(JSON.parse(listed.stdout).length, 1);
    const exported = await command(
      "/bin/bash",
      [entry, "export", "--session", "portable-session"],
      env,
    );
    assert.equal(exported.code, 0, exported.stderr);
    const trace = JSON.parse(exported.stdout).id;
    const replay = await fetch(base + `/replay/${trace}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).choices[0].message.content, "portable-request");
    assert.equal(calls, 1, "replay never calls real upstream");
    const occupied = await command("/bin/bash", [entry, "start"], env);
    assert.notEqual(occupied.code, 0);
    assert.match(occupied.stderr, /EADDRINUSE/);
    const missing = await command("/bin/bash", [entry, "start"], {
      ...env,
      AIMOCK_UPSTREAM_CONFIG: path.join(home, "missing.json"),
    });
    assert.notEqual(missing.code, 0);
    assert.match(missing.stderr, /ENOENT/);
    const bad = path.join(home, "bad.json");
    const secret = "this-secret-must-not-appear-in-errors";
    await writeFile(bad, `{"apiKey":"${secret}",`, { mode: 0o600 });
    const invalid = await command("/bin/bash", [entry, "start"], {
      ...env,
      AIMOCK_UPSTREAM_CONFIG: bad,
    });
    assert.notEqual(invalid.code, 0);
    assert.ok(!invalid.stderr.includes(secret));
    await chmod(bad, 0o644);
    const permissions = await command("/bin/bash", [entry, "start"], {
      ...env,
      AIMOCK_UPSTREAM_CONFIG: bad,
    });
    assert.match(permissions.stderr, /private regular file/);
    const mount = await command("/bin/bash", [entry, "start"], {
      ...env,
      AIMOCK_REQUIRED_MOUNTS: '["/missing-aimock-customer-mount"]',
    });
    assert.notEqual(mount.code, 0);
    assert.match(mount.stderr, /Required mount is missing|Mount checks require Linux/);
    const boundary = await command("/bin/bash", [entry, "start"], {
      ...env,
      AIMOCK_STORAGE_BOUNDARY: home,
    });
    assert.notEqual(boundary.code, 0);
    assert.match(boundary.stderr, /escapes AIMOCK_STORAGE_BOUNDARY/);
    const exit = once(gateway, "exit");
    gateway.kill("SIGTERM");
    assert.equal((await exit)[0], 0);
  },
);
