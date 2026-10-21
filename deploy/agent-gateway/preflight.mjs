// 普通磁盘即可运行；共享盘检查和存储边界由用户显式配置。
/* global process, console */
import { readFile, stat, mkdir, open, unlink, realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { URL } from "node:url";
import {
  dataRoot,
  upstreamFile,
  clientKeyFile,
  upstreamConfig,
  aimockVersion,
  requiredVersion,
} from "./config.mjs";

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}
function number(value, max, name) {
  requireCondition(
    /^\d+$/.test(value) && Number(value) > 0 && Number(value) <= max,
    `Invalid ${name}`,
  );
  return Number(value);
}
try {
  const [major, minor] = process.versions.node.split(".").map(Number);
  requireCondition(major > 22 || (major === 22 && minor >= 22), "Require Node >=22.22");
  requireCondition(
    (await aimockVersion()) === requiredVersion,
    `Require AIMock ${requiredVersion}`,
  );
  for (const filename of [upstreamFile, clientKeyFile]) {
    requireCondition(path.isAbsolute(filename), "Credential paths must be absolute");
    const info = await stat(filename);
    requireCondition(
      info.isFile() && (info.mode & 0o077) === 0,
      `Require private regular file (600): ${filename}`,
    );
  }
  const config = await upstreamConfig();
  const key = (await readFile(clientKeyFile, "utf8")).trim();
  requireCondition(
    typeof config.apiKey === "string" && config.apiKey.length > 0,
    "Missing upstream apiKey",
  );
  requireCondition(
    typeof config.model === "string" && config.model.length > 0,
    "Missing upstream model",
  );
  const target = new URL(config.url);
  requireCondition(
    ["http:", "https:"].includes(target.protocol) &&
      target.pathname.endsWith("/v1/chat/completions"),
    "Upstream url must be HTTP(S) /v1/chat/completions",
  );
  requireCondition(
    key.length >= 24 && key !== config.apiKey,
    "Client key must be at least 24 characters and differ from upstream key",
  );
  const port = number(process.env.AIMOCK_PORT, 65535, "AIMOCK_PORT");
  const workers = number(process.env.AIMOCK_WORKERS, 128, "AIMOCK_WORKERS");
  requireCondition(path.isAbsolute(dataRoot), "AIMOCK_DATA_ROOT must be absolute");
  const mounts = JSON.parse(process.env.AIMOCK_REQUIRED_MOUNTS || "[]");
  requireCondition(
    Array.isArray(mounts) && mounts.every((p) => typeof p === "string" && path.isAbsolute(p)),
    "AIMOCK_REQUIRED_MOUNTS must be a JSON array of absolute mount points",
  );
  if (mounts.length) {
    requireCondition(
      process.platform === "linux",
      "Mount checks require Linux /proc/self/mountinfo",
    );
    const actual = (await readFile("/proc/self/mountinfo", "utf8"))
      .trim()
      .split("\n")
      .map((line) =>
        line
          .split(" ")[4]
          .replace(/\\([0-7]{3})/g, (_, code) => String.fromCharCode(parseInt(code, 8))),
      );
    for (const expected of mounts)
      requireCondition(
        actual.includes(path.resolve(expected)),
        `Required mount is missing: ${expected}`,
      );
  }
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  const data = await realpath(dataRoot);
  if (process.env.AIMOCK_STORAGE_BOUNDARY) {
    const boundary = await realpath(process.env.AIMOCK_STORAGE_BOUNDARY);
    requireCondition(
      data === boundary || data.startsWith(boundary + path.sep),
      "Data escapes AIMOCK_STORAGE_BOUNDARY",
    );
  }
  const probe = path.join(data, ".startup-check-" + randomUUID());
  const file = await open(probe, "wx", 0o600);
  await file.close();
  await unlink(probe);
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: process.env.AIMOCK_HOST, port, exclusive: true }, resolve);
  });
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  console.log(
    JSON.stringify({
      event: "preflight-ok",
      aimock: requiredVersion,
      node: process.version,
      data,
      port,
      workers,
    }),
  );
} catch (error) {
  // Invalid JSON/URL can contain credential text; never echo parser input.
  const message =
    error instanceof SyntaxError || error.code === "ERR_INVALID_URL"
      ? "Invalid configuration format"
      : error.code || error.message;
  console.error(`[aimock preflight] ${message}`);
  process.exit(1);
}
