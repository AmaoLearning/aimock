// 使用少量真实录制做并发 burst 功能验证；这不等于万 Agent 持续 SLO 或大轨迹库验收。
/* global process, console, Buffer */
import http from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { collapseOpenAISSE } from "@copilotkit/aimock";
import { canonical, resolveRecord } from "./storage.mjs";
import { dataRoot as root, clientKeyFile } from "./config.mjs";
const receipt = process.argv[2];
if (!receipt)
  throw new Error("Usage: replay-bench.mjs PI_RECEIPT_DIR [CONCURRENCY_LIST, default 8]");
const levels = (process.argv[3] || "8").split(",").map(Number);
if (levels.some((value) => !Number.isInteger(value) || value < 1 || value > 10000))
  throw new Error("Concurrency levels must be integers from 1 to 10000");
const traces = JSON.parse(await readFile(path.join(receipt, "replay-results.json"), "utf8"));
const key = (await readFile(clientKeyFile, "utf8")).trim();
const base = process.env.AIMOCK_BASE_URL || `http://127.0.0.1:${process.env.AIMOCK_PORT || 4010}`;
const samples = await Promise.all(
  traces.map(async (row) => {
    const manifest = JSON.parse(
      await readFile(path.join(root, "traces", row.trace, "manifest.json"), "utf8"),
    );
    const reference = manifest.steps["0:0"];
    const directory = resolveRecord(root, reference.relative);
    const body = JSON.parse(await readFile(path.join(directory, "request.json"), "utf8"));
    body.stream = true;
    const fixture = JSON.parse(await readFile(path.join(directory, "fixture.json"), "utf8"));
    return {
      trace: row.trace,
      body: JSON.stringify(body),
      expected: canonical(fixture.response.toolCalls),
    };
  }),
);
const results = [];
for (const concurrency of levels) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency, maxFreeSockets: 8 });
  let sockets = 0,
    peakSockets = 0;
  const start = performance.now();
  const rows = await Promise.all(
    Array.from(
      { length: concurrency },
      (_, index) =>
        new Promise((resolve) => {
          const sample = samples[index % samples.length];
          const began = performance.now();
          const req = http.request(`${base}/replay/${sample.trace}/v1/chat/completions`, {
            method: "POST",
            agent,
            headers: {
              authorization: `Bearer ${key}`,
              "content-type": "application/json",
              "x-test-id": `burst-${concurrency}-${index}`,
              "x-aimock-strict": "1",
              "content-length": Buffer.byteLength(sample.body),
            },
          });
          req.once("socket", (socket) => {
            sockets++;
            peakSockets = Math.max(peakSockets, sockets);
            socket.once("close", () => sockets--);
          });
          req.setTimeout(60000, () => req.destroy(new Error("Timeout")));
          req.on("response", (res) => {
            const parts = [];
            res.on("data", (part) => parts.push(part));
            res.on("end", () => {
              const raw = Buffer.concat(parts).toString();
              let passed = false;
              try {
                passed =
                  res.statusCode === 200 &&
                  canonical(collapseOpenAISSE(raw).toolCalls) === sample.expected &&
                  raw.includes("[DONE]");
              } catch {
                // Invalid response remains a failed replay sample.
              }
              resolve({
                passed,
                status: res.statusCode,
                elapsedMs: performance.now() - began,
                bytes: Buffer.byteLength(raw),
              });
            });
            res.on("error", (error) => resolve({ passed: false, error: error.message }));
          });
          req.on("error", (error) => resolve({ passed: false, error: error.message }));
          req.end(sample.body);
        }),
    ),
  );
  const elapsedMs = performance.now() - start;
  agent.destroy();
  const latencies = rows
    .filter((row) => row.elapsedMs !== undefined)
    .map((row) => row.elapsedMs)
    .sort((a, b) => a - b);
  const percentile = (fraction) =>
    Math.round(latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * fraction))]);
  const result = {
    concurrency,
    passed: rows.filter((row) => row.passed).length,
    failed: rows.filter((row) => !row.passed).length,
    elapsedMs: Math.round(elapsedMs),
    requestsPerSecond: Math.round((concurrency * 1000) / elapsedMs),
    clientPeakSockets: peakSockets,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    responseBytes: rows.reduce((sum, row) => sum + (row.bytes || 0), 0),
    failures: rows.filter((row) => !row.passed).slice(0, 5),
  };
  results.push(result);
  console.log(JSON.stringify(result));
  if (result.failed) break;
}
await writeFile(
  process.env.AIMOCK_BENCH_OUTPUT || path.join(receipt, "replay-burst-results.json"),
  JSON.stringify(
    {
      description:
        "single-host burst, existing traces, first step only, native AIMock timing; not sustained agent concurrency",
      results,
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
