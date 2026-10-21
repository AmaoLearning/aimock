// 用真实 AIMock 和独立假上游验证代理透明性、工具保真、会话隔离及失败关闭。
/* global process, fetch, setTimeout */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { URL, fileURLToPath } from "node:url";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { exportTrace, findRecords } from "../storage.mjs";

test("concurrent record/replay with real AIMock", { timeout: 60000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "aimock-gateway-test-"));
  const key = "test-only-key-01234567890123456789";
  let calls = 0;
  const upstream = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    assert.equal(req.headers.authorization, "Bearer upstream-test-secret");
    assert.equal(req.url, "/v1/chat/completions");
    calls++;
    const marker = body.messages[0].content;
    if (marker === "rate-limit") {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "7" });
      res.end('{"error":{"message":"test rate limit"}}');
      return;
    }
    const message = body.messages.some((item) => item.role === "tool")
      ? { role: "assistant", content: `done-${marker}` }
      : {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: `call-${marker}`,
              type: "function",
              function: { name: "read", arguments: JSON.stringify({ path: `${marker}.txt` }) },
            },
          ],
        };
    const finish = message.tool_calls ? "tool_calls" : "stop";
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const delta = message.tool_calls
        ? { tool_calls: message.tool_calls.map((call) => ({ index: 0, ...call })) }
        : { content: message.content };
      res.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 } })}\n\n`,
      );
      res.end(marker === "broken" ? "" : "data: [DONE]\n\n");
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ index: 0, message, finish_reason: finish }],
          usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
        }),
      );
    }
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port;
  await writeFile(
    path.join(root, "upstream.json"),
    JSON.stringify({
      YICLOUD_API_KEY: "upstream-test-secret",
      YICLOUD_QWEN_MODEL: "qwen-test",
      YICLOUD_MODEL_URL: `http://127.0.0.1:${upstreamPort}/v1/chat/completions`,
    }),
  );
  await writeFile(path.join(root, "key"), key);
  const reservation = http.createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const gateway = spawn(
    process.execPath,
    [fileURLToPath(new URL("../gateway.mjs", import.meta.url))],
    {
      env: {
        ...process.env,
        AIMOCK_WORKERS: "2",
        AIMOCK_PORT: String(port),
        AIMOCK_DATA_ROOT: root,
        AIMOCK_UPSTREAM_CONFIG: path.join(root, "upstream.json"),
        AIMOCK_CLIENT_KEY_FILE: path.join(root, "key"),
        AIMOCK_FIXTURE_CACHE: "2",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let logs = "";
  gateway.stdout.on("data", (data) => {
    logs += data;
  });
  gateway.stderr.on("data", (data) => {
    logs += data;
  });
  t.after(async () => {
    if (gateway.exitCode === null) {
      gateway.kill("SIGTERM");
      await once(gateway, "exit");
    }
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  });
  const base = `http://127.0.0.1:${port}`;
  for (let index = 0; index < 500; index++) {
    try {
      if ((await fetch(base + "/healthz")).ok) break;
    } catch {
      // worker 仍在启动时连接可以暂时失败。
    }
    if (gateway.exitCode !== null) assert.fail(logs || `Gateway exited ${gateway.exitCode}`);
    await new Promise((resolve) => setTimeout(resolve, 40));
    if (index === 499) assert.fail(logs || "Gateway readiness timed out");
  }
  function body(marker, stream = true) {
    return {
      model: "qwen-test",
      stream,
      messages: [{ role: "user", content: marker }],
      tools: [
        {
          type: "function",
          function: {
            name: "read",
            parameters: { type: "object", properties: { path: { type: "string" } } },
          },
        },
      ],
    };
  }
  async function request(route, data, headers = {}) {
    const response = await fetch(base + route, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...headers },
      body: JSON.stringify(data),
    });
    const text = await response.text();
    return { status: response.status, text, headers: response.headers };
  }
  const sessions = Array.from({ length: 8 }, (_, index) => `s-${index}`);
  const recorded = await Promise.all(
    sessions.map((session) => request(`/record/${session}/v1/chat/completions`, body(session))),
  );
  assert.ok(recorded.every((row) => row.status === 200));
  assert.equal(calls, 8);
  // 相同请求第二次仍到上游，禁止被 AIMock 录制缓存替代。
  await request("/record/s-0/v1/chat/completions", body("s-0"));
  assert.equal(calls, 9);
  const traces = await Promise.all(sessions.map((session) => exportTrace(root, { session })));
  const replayed = await Promise.all(
    traces.map((trace, index) =>
      request(`/replay/${trace.id}/v1/chat/completions`, body(sessions[index], false)),
    ),
  );
  for (let index = 0; index < replayed.length; index++) {
    assert.equal(replayed[index].status, 200, replayed[index].text);
    const response = JSON.parse(replayed[index].text);
    assert.equal(response.choices[0].message.tool_calls[0].id, `call-${sessions[index]}`);
    assert.deepEqual(JSON.parse(response.choices[0].message.tool_calls[0].function.arguments), {
      path: `${sessions[index]}.txt`,
    });
    assert.equal(response.choices[0].finish_reason, "tool_calls");
    assert.equal(response.usage.total_tokens, 8);
  }
  assert.equal(calls, 9, "replay must not access upstream");
  const changed = body("changed", false);
  assert.equal(
    (
      await request(`/replay/${traces[0].id}/v1/chat/completions`, changed, {
        "x-aimock-strict": "1",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(`/replay/${traces[0].id}/v1/chat/completions`, body("s-0"), {
        "x-aimock-step": "99",
      })
    ).status,
    409,
  );
  assert.equal((await request("/v1/chat/completions", body("x"))).status, 400);
  const denied = await fetch(base + "/v1/models");
  assert.equal(denied.status, 401);
  // pi 可直接使用固定 /v1：稳定会话头在多 worker 之间保持隔离。
  const automatic = await Promise.all(
    sessions.map((_, index) => {
      const session = `native-pi-${index}`;
      return request("/v1/chat/completions", body(session), {
        session_id: session,
        "x-session-affinity": session,
      });
    }),
  );
  for (let index = 0; index < automatic.length; index++) {
    const session = `native-pi-${index}`;
    assert.equal(automatic[index].status, 200, automatic[index].text);
    assert.equal(automatic[index].headers.get("x-aimock-session"), session);
    assert.equal((await findRecords(root, { session })).length, 1);
  }
  const nativeSecond = body("native-pi-0", false);
  nativeSecond.messages.push(
    { role: "assistant", content: "continue" },
    { role: "user", content: "next" },
  );
  assert.equal(
    (await request("/v1/chat/completions", nativeSecond, { "x-session-id": "native-pi-0" })).status,
    200,
  );
  assert.equal((await findRecords(root, { session: "native-pi-0" })).length, 2);
  const metadataSession = { ...body("from-metadata"), metadata: { session_id: "from-metadata" } };
  assert.equal((await request("/v1/chat/completions", metadataSession)).status, 200);
  const beforeInvalid = calls;
  assert.equal(
    (
      await request("/v1/chat/completions", body("request-id-only"), {
        "x-request-id": "one-request",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/v1/chat/completions", body("conflict"), {
        "x-session-id": "session-a",
        "x-session-affinity": "session-b",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/record/wrong-model/v1/chat/completions", {
        ...body("wrong-model"),
        model: "other-model",
      })
    ).status,
    400,
  );
  assert.equal(calls, beforeInvalid, "invalid identity/model must not reach upstream");
  const limited = await request(
    "/record/rate-limit/v1/chat/completions",
    body("rate-limit", false),
  );
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "7");
  assert.equal(limited.text, '{"error":{"message":"test rate limit"}}');
  const failures = await findRecords(root, { session: "rate-limit" });
  assert.equal(failures[0].complete, false);
  assert.equal(failures[0].status, 429);
  assert.equal(failures[0].transportComplete, true);
  // 下一轮真实保存 role=tool 的内容，不只保存 assistant 的工具名称。
  const second = body("s-0", false);
  second.messages.push(
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call-s-0",
          type: "function",
          function: { name: "read", arguments: '{"path":"s-0.txt"}' },
        },
      ],
    },
    { role: "tool", tool_call_id: "call-s-0", content: "unique-tool-result" },
  );
  assert.equal((await request("/record/s-0/v1/chat/completions", second)).status, 200);
  const rows = await findRecords(root, { session: "s-0" });
  const stepOne = rows.find((row) => row.step === "1");
  assert.ok(
    (await readFile(path.join(root, stepOne.relative, "request.json"), "utf8")).includes(
      "unique-tool-result",
    ),
  );
  assert.equal((await findRecords(root, { session: "s-0", to: "2000-01-01T00:00:00Z" })).length, 0);
  assert.ok(
    (await findRecords(root, { session: "s-0", from: rows[0].started, to: "2100-01-01T00:00:00Z" }))
      .length >= 3,
  );
  await request("/record/broken/v1/chat/completions", body("broken")).catch(() => {});
  const broken = await findRecords(root, { session: "broken" });
  assert.equal(broken[0].complete, false);
  await assert.rejects(exportTrace(root, { session: "broken" }), /No complete/);
  await request("/record/s-0/v1/chat/completions", body("different-branch", false));
  await assert.rejects(exportTrace(root, { session: "s-0" }), /Ambiguous/);
  assert.ok(!logs.includes("upstream-test-secret"));
});
