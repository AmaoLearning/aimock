// 为原生 AIMock 提供强制会话隔离、持续录制和不可变轨迹寻址；不执行 Agent 工具。
/* global process, console, Buffer, setTimeout, clearTimeout */
import cluster from "node:cluster";
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import { readFile, mkdir, open, access } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createServer } from "@copilotkit/aimock";
import {
  atomicJson,
  beginRecord,
  numeric,
  safeId,
  requestHash,
  responseFixture,
  resolveRecord,
} from "./storage.mjs";

const root = process.env.AIMOCK_DATA_ROOT || "/mnt/shared-storage-gpfs2/df4-hicache/aimock-v1";
const configFile = process.env.AIMOCK_UPSTREAM_CONFIG || "/etc/aimock/upstream.json";
const keyFile = process.env.AIMOCK_CLIENT_KEY_FILE || "/etc/aimock/client-key";
const workers = Number(process.env.AIMOCK_WORKERS || 8);
const maxBody = Number(process.env.AIMOCK_MAX_REQUEST_BYTES || 16 * 1024 * 1024);
const maxResponse = Number(process.env.AIMOCK_MAX_RESPONSE_BYTES || 64 * 1024 * 1024);
const cacheLimit = Number(process.env.AIMOCK_FIXTURE_CACHE || 512);
const timeoutMs = Number(process.env.AIMOCK_TIMEOUT_MS || 300000);
const port = Number(process.env.AIMOCK_PORT || 4010);

if (cluster.isPrimary && workers > 1) {
  for (let index = 0; index < workers; index++) cluster.fork();
  let stopping = false;
  cluster.on("exit", (worker) => {
    if (!stopping) {
      console.error(JSON.stringify({ event: "worker-exit", pid: worker.process.pid }));
      setTimeout(() => {
        if (!stopping) cluster.fork();
      }, 1000);
    }
  });
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () => {
      stopping = true;
      for (const worker of Object.values(cluster.workers)) worker.process.kill(signal);
    });
} else {
  await startWorker();
}

async function startWorker() {
  const clientKey = (await readFile(keyFile, "utf8")).trim();
  if (clientKey.length < 24) throw new Error("Client key must contain at least 24 characters");
  const config = JSON.parse(await readFile(configFile, "utf8"));
  const target = new URL(config.YICLOUD_MODEL_URL);
  if (!target.pathname.endsWith("/v1/chat/completions"))
    throw new Error("Upstream URL must end with /v1/chat/completions");
  await mkdir(root, { recursive: true, mode: 0o700 });
  // cluster 默认让 port=0 的监听也跨 worker 共享。内部后端必须改为 exclusive，
  // 否则请求会进入另一个 worker，找不到刚注册的 fixture。
  async function privateBackend(fixtures, options) {
    const instance = await createServer(fixtures, { ...options, port: 0, host: "127.0.0.1" });
    await new Promise((resolve, reject) =>
      instance.server.close((error) => (error ? reject(error) : resolve())),
    );
    await new Promise((resolve, reject) => {
      instance.server.once("error", reject);
      instance.server.listen({ port: 0, host: "127.0.0.1", exclusive: true }, resolve);
    });
    instance.url = `http://127.0.0.1:${instance.server.address().port}`;
    return instance;
  }
  const fixtures = [];
  const replay = await privateBackend(fixtures, {
    logLevel: "silent",
    strict: true,
    strictToolArguments: true,
    journalMaxEntries: 1,
    fixtureCountsMaxTestIds: 32,
  });
  const fixtureCache = new Map();
  const manifestCache = new Map();
  const counters = {
    requests: 0,
    active: 0,
    recorded: 0,
    record_errors: 0,
    replayed: 0,
    replay_misses: 0,
    drift: 0,
    rejected: 0,
  };
  const client = new http.Agent({ keepAlive: true, maxSockets: 20000, maxFreeSockets: 128 });
  const providerClient =
    target.protocol === "https:"
      ? new https.Agent({ keepAlive: true, maxSockets: 2048, maxFreeSockets: 128 })
      : new http.Agent({ keepAlive: true, maxSockets: 2048, maxFreeSockets: 128 });
  let closing = false;

  function authorized(req) {
    const supplied = Buffer.from(req.headers.authorization || "");
    const expected = Buffer.from(`Bearer ${clientKey}`);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }
  function fail(res, status, message) {
    if (res.destroyed) return;
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message, type: "aimock_gateway_error" } }));
  }
  async function readBody(req) {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > maxBody)
        throw Object.assign(new Error("Request body too large"), { status: 413 });
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!Array.isArray(body.messages) || !body.model || (body.n !== undefined && body.n !== 1))
      throw Object.assign(new Error("Require model, messages and n=1"), { status: 400 });
    // 当前范围仅 coding/text/function tools；拒绝媒体，防止无声丢失数据。
    for (const message of body.messages) {
      if (Array.isArray(message.content) && message.content.some((part) => part.type !== "text"))
        throw Object.assign(new Error("Only text content is supported"), { status: 400 });
    }
    return body;
  }
  function trimFixtures() {
    for (const [key, entry] of fixtureCache) {
      if (fixtureCache.size <= cacheLimit) break;
      if (entry.pins) continue;
      fixtureCache.delete(key);
      const index = fixtures.indexOf(entry.fixture);
      if (index >= 0) fixtures.splice(index, 1);
    }
  }
  // 大轨迹库使用 manifest 直接定位；AIMock 只扫描当前 worker 的小型热 fixture 集合。
  async function selectFixture(trace, step, attempt, body, strict) {
    let manifest = manifestCache.get(trace);
    if (!manifest) {
      manifest = JSON.parse(
        await readFile(path.join(root, "traces", trace, "manifest.json"), "utf8"),
      );
      manifestCache.set(trace, manifest);
      if (manifestCache.size > 256) manifestCache.delete(manifestCache.keys().next().value);
    }
    const row = manifest.steps[`${step}:${attempt}`];
    if (!row)
      throw Object.assign(new Error(`No recorded step ${step}, attempt ${attempt}`), {
        status: 409,
      });
    const drift = row.requestHash !== requestHash(body);
    if (drift) {
      counters.drift++;
      if (strict)
        throw Object.assign(new Error("Request fingerprint differs from recording"), {
          status: 409,
        });
    }
    const key = `${trace}:${step}:${attempt}`;
    let entry = fixtureCache.get(key);
    if (!entry) {
      const fixture = JSON.parse(
        await readFile(path.join(resolveRecord(root, row.relative), "fixture.json"), "utf8"),
      );
      // 并发 miss 可能同时读同一个文件，读完后再次检查缓存，避免重复注册。
      entry = fixtureCache.get(key);
      if (!entry) {
        fixture.match = { context: key };
        const ttft = Number(process.env.AIMOCK_REPLAY_TTFT_MS || 0);
        const chunksPerSecond = Number(process.env.AIMOCK_REPLAY_CHUNKS_PER_SECOND || 0);
        if (ttft || chunksPerSecond)
          fixture.streamingProfile = { ttft, ...(chunksPerSecond ? { tps: chunksPerSecond } : {}) };
        entry = { fixture, pins: 0 };
        fixtures.push(fixture);
        fixtureCache.set(key, entry);
      }
    }
    fixtureCache.delete(key);
    fixtureCache.set(key, entry);
    entry.pins++;
    trimFixtures();
    return { key, entry, drift };
  }
  function requestBackend(url, body, context, run, record) {
    const raw = Buffer.from(JSON.stringify(body));
    const endpoint = record ? target : new URL("/v1/chat/completions", url);
    const transport = endpoint.protocol === "https:" ? https : http;
    // AIMock 1.45.1 原生代理会把 429/503 统一成 502，并丢弃 Retry-After。
    // 在线录制直接透明转发，AIMock 负责流折叠和离线回放；录制永不命中旧 fixture。
    const request = transport.request(endpoint, {
      method: "POST",
      agent: record ? providerClient : client,
      headers: {
        "content-type": "application/json",
        "content-length": raw.length,
        ...(record
          ? { authorization: `Bearer ${config.YICLOUD_API_KEY}` }
          : { "x-aimock-context": context, "x-test-id": run }),
      },
    });
    const response = new Promise((resolve, reject) => {
      request.once("response", resolve);
      request.once("error", reject);
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("Backend idle timeout")));
    request.end(raw);
    return { request, response };
  }
  async function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/healthz") {
      await access(root);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          status: closing ? "draining" : "ready",
          pid: process.pid,
          workers,
          aimock: "1.45.1",
        }),
      );
      return;
    }
    if (!authorized(req)) {
      counters.rejected++;
      fail(res, 401, "Invalid gateway API key");
      return;
    }
    if (req.method === "GET" && url.pathname === "/metrics") {
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      // worker 标签避免将一个 worker 的瞬时状态误称为全机总量。
      res.end(
        Object.entries({ ...counters, cached_fixtures: fixtures.length })
          .map(([key, value]) => `aimock_gateway_${key}{pid="${process.pid}"} ${value}`)
          .join("\n") + "\n",
      );
      return;
    }
    if (req.method === "GET" && url.pathname.endsWith("/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: [{ id: config.YICLOUD_QWEN_MODEL, object: "model", owned_by: "yicloud" }],
        }),
      );
      return;
    }
    const route = url.pathname.match(/^\/(record|replay)\/([^/]+)\/v1\/chat\/completions$/);
    if (req.method !== "POST" || (!route && url.pathname !== "/v1/chat/completions")) {
      fail(res, 404, "Use /record/SESSION/v1 or /replay/TRACE/v1 Chat Completions");
      return;
    }
    if (closing) {
      fail(res, 503, "Gateway draining");
      return;
    }
    const mode = route?.[1] || req.headers["x-aimock-mode"] || "record";
    if (!["record", "replay"].includes(mode))
      throw Object.assign(new Error("Invalid mode"), { status: 400 });
    const session = safeId(
      route
        ? decodeURIComponent(route[2])
        : req.headers[mode === "record" ? "x-test-id" : "x-aimock-trace"],
    );
    const body = await readBody(req);
    const step = numeric(
      req.headers["x-aimock-step"] ??
        body.messages.filter((message) => message.role === "assistant").length,
      "step",
    );
    const attempt = numeric(req.headers["x-aimock-attempt"] ?? 0, "attempt");
    const start = performance.now();
    let recording, selection, upstream, rawFile;
    let complete = false;
    const frames = [];
    let bytes = 0;
    let captureError;
    const abort = () => {
      if (!res.writableFinished) upstream?.destroy(new Error("Client disconnected"));
    };
    res.once("close", abort);
    counters.requests++;
    counters.active++;
    try {
      if (mode === "record") {
        recording = await beginRecord(root, session, step, attempt, body);
        rawFile = await open(path.join(recording.directory, "response.raw"), "wx", 0o600);
      } else
        selection = await selectFixture(
          session,
          step,
          attempt,
          body,
          req.headers["x-aimock-strict"] !== "0",
        );
      const run = safeId(req.headers["x-test-id"] || session);
      const backend = requestBackend(
        replay.url,
        body,
        selection?.key || "live",
        run,
        mode === "record",
      );
      upstream = backend.request;
      if (res.destroyed) upstream.destroy(new Error("Client disconnected"));
      const source = await backend.response;
      // 响应头到达时原生 AIMock 已选定 fixture；后续流只持有该对象，可以解除热缓存 pin。
      if (selection) {
        selection.entry.pins--;
        selection.unpinned = true;
        trimFixtures();
      }
      const contentType = source.headers["content-type"] || "application/json";
      const forwardedHeaders = Object.fromEntries(
        Object.entries(source.headers).filter(([name]) =>
          [
            "retry-after",
            "x-request-id",
            "x-ratelimit-limit-requests",
            "x-ratelimit-remaining-requests",
            "x-ratelimit-reset-requests",
            "x-ratelimit-limit-tokens",
            "x-ratelimit-remaining-tokens",
            "x-ratelimit-reset-tokens",
          ].includes(name),
        ),
      );
      res.writeHead(source.statusCode, {
        ...forwardedHeaders,
        "content-type": contentType,
        "cache-control": "no-cache",
        "x-accel-buffering": "no",
        "x-aimock-session": session,
        "x-aimock-step": step,
        ...(recording
          ? { "x-aimock-record-id": recording.metadata.id }
          : { "x-aimock-drift": String(selection.drift) }),
      });
      for await (const chunk of source) {
        bytes += chunk.length;
        if (rawFile && !captureError) {
          if (bytes > maxResponse || frames.length >= 200000)
            captureError = "Capture limit exceeded";
          else {
            frames.push({ ms: performance.now() - start, bytes: chunk.length });
            await rawFile.writeFile(chunk);
          }
        }
        if (res.destroyed) throw new Error("Client disconnected");
        if (!res.write(chunk))
          await new Promise((resolve, reject) => {
            const cleanup = () => {
              res.off("drain", drained);
              res.off("close", closed);
              res.off("error", failed);
            };
            const drained = () => {
              cleanup();
              resolve();
            };
            const closed = () => {
              cleanup();
              reject(new Error("Client disconnected"));
            };
            const failed = (error) => {
              cleanup();
              reject(error);
            };
            res.once("drain", drained);
            res.once("close", closed);
            res.once("error", failed);
          });
      }
      if (rawFile) {
        await rawFile.close();
        rawFile = null;
        await atomicJson(path.join(recording.directory, "frames.json"), frames);
        let fixture;
        try {
          if (captureError) throw new Error(captureError);
          const raw = await readFile(path.join(recording.directory, "response.raw"), "utf8");
          fixture = responseFixture(raw, contentType, source.statusCode);
          await atomicJson(path.join(recording.directory, "fixture.json"), fixture);
        } catch (error) {
          captureError = error.message;
        }
        // 非 200、损坏 SSE 和超限回答也按原样转发并保存；只禁止将它们导出为成功 fixture。
        await atomicJson(path.join(recording.directory, "metadata.json"), {
          ...recording.metadata,
          complete: !captureError,
          transportComplete: true,
          status: source.statusCode,
          contentType,
          responseHeaders: forwardedHeaders,
          bytes,
          capturedBytes: frames.reduce((sum, frame) => sum + frame.bytes, 0),
          finished: new Date().toISOString(),
          durationMs: performance.now() - start,
          firstByteMs: frames[0]?.ms,
          tools: (fixture?.response.toolCalls || []).map((call) => call.name),
          ...(captureError ? { error: captureError } : {}),
        });
        if (captureError) counters.record_errors++;
        else counters.recorded++;
      } else {
        counters.replayed++;
      }
      complete = true;
      res.end();
    } catch (error) {
      if (recording) {
        counters.record_errors++;
        await atomicJson(path.join(recording.directory, "metadata.json"), {
          ...recording.metadata,
          complete: false,
          bytes,
          finished: new Date().toISOString(),
          error: error.message,
        }).catch(() => {});
      } else counters.replay_misses++;
      fail(res, error.status || (error.code === "ENOENT" ? 404 : 502), error.message);
    } finally {
      if (selection && !selection.unpinned) {
        selection.entry.pins--;
        trimFixtures();
      }
      await rawFile?.close().catch(() => {});
      if (!complete) upstream?.destroy();
      res.off("close", abort);
      counters.active--;
    }
  }
  const server = http.createServer((req, res) =>
    handle(req, res).catch((error) => fail(res, error.status || 400, error.message)),
  );
  server.requestTimeout = timeoutMs;
  server.headersTimeout = 30000;
  server.keepAliveTimeout = 65000;
  await new Promise((resolve) =>
    server.listen(port, process.env.AIMOCK_HOST || "0.0.0.0", resolve),
  );
  console.log(JSON.stringify({ event: "ready", pid: process.pid, port, root }));
  async function stop() {
    if (closing) return;
    closing = true;
    const deadline = setTimeout(() => process.exit(1), 30000);
    server.close(async () => {
      replay.server.close();
      client.destroy();
      providerClient.destroy();
      clearTimeout(deadline);
      process.exit(0);
    });
    server.closeIdleConnections();
  }
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, stop);
}
