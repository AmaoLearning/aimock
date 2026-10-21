// 保存独立请求及不可变轨迹；磁盘只接收显式白名单数据，不接收鉴权头。
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, readdir } from "node:fs/promises";
import path from "node:path";
import { collapseOpenAISSE } from "@copilotkit/aimock";

export const digest = (value) => createHash("sha256").update(value).digest("hex");
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function requestHash(body) {
  const semantic = { ...body };
  delete semantic.stream;
  delete semantic.stream_options;
  return digest(canonical(semantic));
}
export function numeric(value, name) {
  if (!/^\d{1,7}$/.test(String(value)))
    throw Object.assign(new Error(`Invalid ${name}`), { status: 400 });
  return String(Number(value));
}
export function safeId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value))
    throw Object.assign(
      new Error(
        "Session/trace ID must be 1-160 ASCII letters, digits, dot, colon, underscore or dash",
      ),
      { status: 400 },
    );
  return value;
}
// 优先保留显式路由；无路由时提取调用方已发送的稳定会话标识。
// request ID、user、prompt hash 和连接均不能证明是同一会话，因此不作为兜底。
export function recordSession(headers, body, explicit) {
  if (explicit !== undefined) return safeId(explicit);
  if (headers["x-test-id"] !== undefined) return safeId(headers["x-test-id"]);
  const candidates = [
    ...["x-aimock-session", "x-session-id", "session-id", "session_id", "x-session-affinity"].map(
      (name) => headers[name],
    ),
    body.metadata?.session_id,
    body.metadata?.sessionId,
    body.session_id,
  ].filter((value) => value !== undefined && value !== null);
  if (!candidates.length)
    throw Object.assign(
      new Error("Missing session ID; send a stable session header or use /record/SESSION/v1"),
      { status: 400 },
    );
  const ids = candidates.map(safeId);
  if (new Set(ids).size !== 1)
    throw Object.assign(new Error("Conflicting session IDs in request"), { status: 400 });
  return ids[0];
}
export async function atomicJson(filename, data) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(data, null, 2), { mode: 0o600, flag: "wx" });
  await rename(temporary, filename);
}
// 从原始响应生成原生 AIMock fixture；不把损坏或未结束的流变成成功记录。
export function responseFixture(raw, contentType, status) {
  let response, finishReason;
  if (status !== 200) throw new Error(`Upstream status ${status}`);
  if (contentType.includes("text/event-stream")) {
    if (!/^data:\s*\[DONE\]\s*$/m.test(raw)) throw new Error("Missing terminal SSE [DONE]");
    const collapsed = collapseOpenAISSE(raw);
    if (collapsed.truncated || collapsed.droppedChunks)
      throw new Error("Incomplete or malformed SSE");
    response = Object.fromEntries(
      ["content", "reasoning", "toolCalls", "blocks", "usage"]
        .filter((key) => collapsed[key] !== undefined)
        .map((key) => [key, collapsed[key]]),
    );
    for (const line of raw.split(/\r?\n/)) {
      if (!line.startsWith("data:") || line.includes("[DONE]")) continue;
      const event = JSON.parse(line.slice(5).trim());
      finishReason = event.choices?.[0]?.finish_reason || finishReason;
    }
  } else {
    const parsed = JSON.parse(raw);
    const choice = parsed.choices?.[0];
    if (!choice?.message) throw new Error("Missing Chat Completion message");
    const message = choice.message;
    response = {
      content: message.content ?? "",
      ...(message.reasoning_content || message.reasoning
        ? { reasoning: message.reasoning_content || message.reasoning }
        : {}),
      ...(message.tool_calls?.length
        ? {
            toolCalls: message.tool_calls.map((call) => ({
              id: call.id,
              name: call.function.name,
              arguments: call.function.arguments,
            })),
          }
        : {}),
      ...(parsed.usage ? { usage: parsed.usage } : {}),
    };
    finishReason = choice.finish_reason;
  }
  if (!finishReason) throw new Error("Missing finish_reason");
  if (response.content === undefined && !response.toolCalls?.length) response.content = "";
  for (const call of response.toolCalls ?? []) JSON.parse(call.arguments);
  response.finishReason = finishReason;
  return { match: { context: "assigned-on-replay" }, response, latency: 0, chunkSize: 20 };
}
export async function beginRecord(root, session, step, attempt, body) {
  const started = new Date().toISOString();
  const id = `${started.replace(/[:.]/g, "-")}-${randomUUID()}`;
  const directory = path.join(root, "records", started.slice(0, 10), digest(session), id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await atomicJson(path.join(directory, "request.json"), body);
  const metadata = {
    schema: 1,
    id,
    session,
    step,
    attempt,
    started,
    requestHash: requestHash(body),
    model: body.model,
    complete: false,
  };
  await atomicJson(path.join(directory, "metadata.json"), metadata);
  return { directory, metadata };
}
// 按 UTC 日期和会话哈希缩小扫描范围；时间范围为 [from, to)。
export async function findRecords(root, { session, from, to } = {}) {
  const lower = from ? new Date(from).toISOString() : "";
  const upper = to ? new Date(to).toISOString() : "9999";
  const directory = path.join(root, "records");
  const rows = [];
  for (const day of await readdir(directory).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  })) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < lower.slice(0, 10) || day > upper.slice(0, 10))
      continue;
    const sessions = session ? [digest(session)] : await readdir(path.join(directory, day));
    for (const hash of sessions) {
      const base = path.join(directory, day, hash);
      for (const id of await readdir(base).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      })) {
        const relative = path.join("records", day, hash, id);
        const record = JSON.parse(
          await readFile(path.join(root, relative, "metadata.json"), "utf8"),
        );
        if (
          record.started >= lower &&
          record.started < upper &&
          (!session || record.session === session)
        )
          rows.push({ ...record, relative });
      }
    }
  }
  return rows.sort((a, b) => a.started.localeCompare(b.started) || a.id.localeCompare(b.id));
}
// 只导出一个会话；同一步不同请求必须显式分 attempt，避免静默选错分支。
export async function exportTrace(root, options) {
  safeId(options.session);
  const records = (await findRecords(root, options)).filter((record) => record.complete);
  if (!records.length) throw new Error("No complete recordings in selected session/time range");
  const steps = {};
  for (const record of records) {
    const key = `${record.step}:${record.attempt}`;
    if (steps[key] && steps[key].requestHash !== record.requestHash)
      throw new Error(
        `Ambiguous step ${key}; split sessions or use explicit X-AIMock-Step / X-AIMock-Attempt`,
      );
    if (!steps[key])
      steps[key] = { requestHash: record.requestHash, relative: record.relative, id: record.id };
  }
  const id = `trace-${randomUUID()}`;
  const manifest = {
    schema: 1,
    id,
    session: options.session,
    exported: new Date().toISOString(),
    from: options.from,
    to: options.to,
    steps,
  };
  const directory = path.join(root, "traces", id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await atomicJson(path.join(directory, "manifest.json"), manifest);
  return manifest;
}
export function resolveRecord(root, relative) {
  if (!/^records\/\d{4}-\d{2}-\d{2}\/[a-f0-9]{64}\/[A-Za-z0-9.-]+$/.test(relative))
    throw new Error("Invalid recording reference");
  return path.join(root, relative);
}
