import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { Ollama } from "ollama";
import { afterEach, expect, test } from "vitest";
import { LLMock } from "../llmock.js";

const mocks: LLMock[] = [];
let upstream: http.Server | undefined;
let directory: string | undefined;

afterEach(async () => {
  for (const mock of mocks.splice(0)) await mock.stop();
  if (upstream?.listening) await new Promise<void>((resolve) => upstream!.close(() => resolve()));
  upstream = undefined;
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

test("Ollama SDK embed preserves ordered batch vectors through recording and offline replay", async () => {
  const expected = {
    model: "nomic-embed-text",
    embeddings: [
      [0.1, 0.2],
      [0.3, 0.4],
    ],
    prompt_eval_count: 7,
  };
  upstream = http.createServer((req, res) => {
    expect(req.url).toBe("/api/embed");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(expected));
  });
  await new Promise<void>((resolve) => upstream!.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("No upstream port");
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "aimock-ollama-embed-"));
  const recorder = new LLMock({
    port: 0,
    logLevel: "silent",
    record: { providers: { ollama: `http://127.0.0.1:${address.port}` }, fixturePath: directory },
  });
  mocks.push(recorder);
  await recorder.start();
  const input = { model: "nomic-embed-text", input: ["first", "second"] };
  expect(await new Ollama({ host: recorder.url }).embed(input)).toEqual(expected);
  await recorder.stop();
  mocks.splice(mocks.indexOf(recorder), 1);
  await new Promise<void>((resolve) => upstream!.close(() => resolve()));
  const replay = new LLMock({ port: 0, logLevel: "silent", strict: true });
  replay.loadFixtureDir(directory);
  mocks.push(replay);
  await replay.start();
  expect(await new Ollama({ host: replay.url }).embed(input)).toEqual(expected);
});

test("Ollama SDK embeds each batch item independently with the requested dimensions", async () => {
  const mock = new LLMock({ port: 0, logLevel: "silent" });
  mocks.push(mock);
  await mock.start();
  const client = new Ollama({ host: mock.url });
  const batch = await client.embed({
    model: "nomic-embed-text",
    input: ["first", "second", "first"],
    dimensions: 8,
  });
  expect(batch.embeddings.map((vector) => vector.length)).toEqual([8, 8, 8]);
  expect(batch.embeddings[0]).toEqual(batch.embeddings[2]);
  expect(batch.embeddings[0]).not.toEqual(batch.embeddings[1]);
  const single = await client.embed({ model: "nomic-embed-text", input: "second", dimensions: 8 });
  expect(single.embeddings).toEqual([batch.embeddings[1]]);
});

test.each([
  { input: ["first", 2] },
  { input: [[1, 2], "second"] },
  { input: { text: "first" } },
  { input: true },
  { input: "first", model: 42 },
  { input: "first", dimensions: -1 },
  { input: "first", dimensions: 0 },
  { input: "first", dimensions: 1.5 },
  { input: "first", dimensions: 100001 },
])("Ollama current embeddings reject invalid input %j", async (fields) => {
  const mock = new LLMock({ port: 0, logLevel: "silent" });
  mocks.push(mock);
  await mock.start();
  const response = await fetch(`${mock.url}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "nomic-embed-text", ...fields }),
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: expect.any(String) });
});

test("Ollama SDK fixture batches and legacy embedding keep their own response shapes", async () => {
  const mock = new LLMock({ port: 0, logLevel: "silent", strict: true });
  mock.addFixture({
    match: { endpoint: "embedding", inputText: "first second" },
    response: { embedding: [0.1, 0.2] },
  });
  mocks.push(mock);
  await mock.start();
  const client = new Ollama({ host: mock.url });
  expect(
    (await client.embed({ model: "nomic-embed-text", input: ["first", "second"] })).embeddings,
  ).toEqual([
    [0.1, 0.2],
    [0.1, 0.2],
  ]);
  expect(
    (await client.embeddings({ model: "nomic-embed-text", prompt: "first second" })).embedding,
  ).toEqual([0.1, 0.2]);
  await expect(client.embed({ model: "nomic-embed-text", input: "missing" })).rejects.toMatchObject(
    { status_code: 503 },
  );
});

test("Ollama current endpoint matches input even when a legacy prompt is also supplied", async () => {
  const mock = new LLMock({ port: 0, logLevel: "silent", strict: true });
  mock.addFixture({ match: { inputText: "current" }, response: { embedding: [0.25] } });
  mocks.push(mock);
  await mock.start();
  const response = await fetch(`${mock.url}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "nomic-embed-text", input: "current", prompt: "legacy" }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ model: "nomic-embed-text", embeddings: [[0.25]] });
});

test("Ollama SDK receives a fixture error message and status on the current endpoint", async () => {
  const mock = new LLMock({ port: 0, logLevel: "silent", strict: true });
  mock.addFixture({
    match: { inputText: "failure" },
    response: {
      error: { message: "embedding unavailable", type: "server_error" },
      status: 429,
      retryAfter: 2,
    },
  });
  mocks.push(mock);
  await mock.start();
  await expect(
    new Ollama({ host: mock.url }).embed({ model: "nomic-embed-text", input: "failure" }),
  ).rejects.toMatchObject({ message: "embedding unavailable", status_code: 429 });
});

test("legacy Ollama fixture errors retain their existing envelope", async () => {
  const mock = new LLMock({ port: 0, logLevel: "silent", strict: true });
  mock.addFixture({
    match: { inputText: "legacy failure" },
    response: { error: { message: "legacy unavailable", type: "server_error" }, status: 429 },
  });
  mocks.push(mock);
  await mock.start();
  const response = await fetch(`${mock.url}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "nomic-embed-text", prompt: "legacy failure" }),
  });
  expect(response.status).toBe(429);
  expect(await response.json()).toEqual({
    error: { message: "legacy unavailable", type: "server_error", param: null, code: null },
  });
});
