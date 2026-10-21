/* global process, fetch, setTimeout */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { URL, fileURLToPath } from "node:url";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";

const source = fileURLToPath(new URL("..", import.meta.url));
function command(program, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { env });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (part) => (stdout += part));
    child.stderr.on("data", (part) => (stderr += part));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test(
  "runtime bundle excludes credentials and starts after relocation without installation",
  { timeout: 90000 },
  async (t) => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "aimock-bundle-"));
    const archive = path.join(temporary, "runtime.tar.gz");
    const home = path.join(temporary, "relocated service");
    const data = path.join(temporary, "external data");
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^(AIMOCK_|UPSTREAM_|YICLOUD_)/.test(key)),
    );
    let gateway;
    let calls = 0;
    const upstream = http.createServer(async (req, res) => {
      for await (const chunk of req) void chunk;
      calls++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            { message: { role: "assistant", content: "bundle-ok" }, finish_reason: "stop" },
          ],
        }),
      );
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      if (gateway && gateway.exitCode === null) {
        gateway.kill("SIGTERM");
        await once(gateway, "exit");
      }
      upstream.closeAllConnections();
      await new Promise((resolve) => upstream.close(resolve));
      await rm(temporary, { recursive: true, force: true });
    });
    const build = await command(
      "/bin/bash",
      [path.join(source, "bundle.sh"), "--output", archive, "--runtime", source],
      env,
    );
    assert.equal(build.code, 0, build.stderr);
    const contents = await command("tar", ["-tzf", archive], env);
    assert.equal(contents.code, 0, contents.stderr);
    assert.ok(
      !contents.stdout
        .split("\n")
        .some((name) => /^\.\/config\/(upstream\.json|client-key)$/.test(name)),
    );
    assert.ok(!contents.stdout.includes("./data/") && !contents.stdout.includes("./records/"));
    await mkdir(home);
    const unpack = await command("tar", ["-xzf", archive, "-C", home], env);
    assert.equal(unpack.code, 0, unpack.stderr);
    const manifest = JSON.parse(await readFile(path.join(home, "bundle-manifest.json"), "utf8"));
    assert.equal(manifest.aimock, "1.46.0");
    assert.equal(manifest.containsCredentials, false);
    const key = "bundle-client-test-01234567890123456789";
    await writeFile(path.join(home, "config/client-key"), key, { mode: 0o600 });
    await writeFile(
      path.join(home, "config/upstream.json"),
      JSON.stringify({
        url: `http://127.0.0.1:${upstream.address().port}/v1/chat/completions`,
        model: "bundle-test",
        apiKey: "upstream-test-only",
      }),
      { mode: 0o600 },
    );
    const reservation = http.createServer();
    await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    gateway = spawn("/bin/bash", [path.join(home, "aimock"), "start"], {
      env: {
        ...env,
        AIMOCK_PORT: String(port),
        AIMOCK_HOST: "127.0.0.1",
        AIMOCK_WORKERS: "2",
        AIMOCK_DATA_ROOT: data,
      },
      cwd: os.tmpdir(),
    });
    let logs = "";
    gateway.stdout.on("data", (part) => (logs += part));
    gateway.stderr.on("data", (part) => (logs += part));
    const base = `http://127.0.0.1:${port}`;
    for (let index = 0; index < 500; index++) {
      try {
        const health = await fetch(base + "/healthz");
        if (health.ok) {
          assert.equal((await health.json()).aimock, "1.46.0");
          break;
        }
      } catch {
        /* wait for readiness */
      }
      if (gateway.exitCode !== null) assert.fail(logs);
      if (index === 499) assert.fail(logs || "Bundle startup timed out");
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    const response = await fetch(base + "/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "x-session-id": "bundle-session",
      },
      body: JSON.stringify({
        model: "bundle-test",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).choices[0].message.content, "bundle-ok");
    assert.equal(calls, 1);
  },
);
