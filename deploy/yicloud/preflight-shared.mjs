// 在 fork worker 前验证共享盘、凭据、数据写入和监听端口；不请求真实模型或输出密钥。
/* global process, console */
import { readFile, stat, mkdir, open, unlink, realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { URL } from "node:url";

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}
function positiveInteger(value, maximum, name) {
  requireCondition(
    /^\d+$/.test(value) && Number(value) > 0 && Number(value) <= maximum,
    `Invalid ${name}`,
  );
  return Number(value);
}
try {
  requireCondition(
    process.platform === "linux" && process.arch === "x64",
    "共享运行时要求 Linux x86_64",
  );
  const mountInfo = await readFile("/proc/self/mountinfo", "utf8");
  const mounts = mountInfo
    .trim()
    .split("\n")
    .map((line) =>
      line
        .split(" ")[4]
        .replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8))),
    );
  for (const expected of [
    "/mnt/shared-storage-gpfs2/df4-hicache",
    "/mnt/shared-storage-gpfs3/yicheng-deploy",
  ]) {
    const family = expected.split("/").slice(0, 3).join("/");
    requireCondition(
      mounts.some(
        (mount) =>
          (mount === family || mount.startsWith(family + "/")) &&
          (expected === mount || expected.startsWith(mount + "/")),
      ),
      `必须挂载共享盘：${expected}`,
    );
  }
  for (const [name, filename] of [
    ["upstream", process.env.AIMOCK_UPSTREAM_CONFIG],
    ["client key", process.env.AIMOCK_CLIENT_KEY_FILE],
  ]) {
    const info = await stat(filename);
    requireCondition(
      info.isFile() && (info.mode & 0o077) === 0,
      `${name} 配置必须是仅属主可读写的普通文件（600）：${filename}`,
    );
  }
  const config = JSON.parse(await readFile(process.env.AIMOCK_UPSTREAM_CONFIG, "utf8"));
  const key = (await readFile(process.env.AIMOCK_CLIENT_KEY_FILE, "utf8")).trim();
  requireCondition(
    typeof config.YICLOUD_API_KEY === "string" && config.YICLOUD_API_KEY.length > 0,
    "缺少 YICLOUD_API_KEY",
  );
  requireCondition(
    typeof config.YICLOUD_QWEN_MODEL === "string" && config.YICLOUD_QWEN_MODEL.length > 0,
    "缺少 YICLOUD_QWEN_MODEL",
  );
  const target = new URL(config.YICLOUD_MODEL_URL);
  requireCondition(
    ["https:", "http:"].includes(target.protocol) &&
      target.pathname.endsWith("/v1/chat/completions"),
    "YICLOUD_MODEL_URL 必须是 HTTP(S) /v1/chat/completions URL",
  );
  requireCondition(
    key.length >= 24 && key !== config.YICLOUD_API_KEY,
    "下游 key 至少 24 字符，且必须与上游 key 不同",
  );
  const port = positiveInteger(process.env.AIMOCK_PORT, 65535, "AIMOCK_PORT");
  const workers = positiveInteger(process.env.AIMOCK_WORKERS, 128, "AIMOCK_WORKERS");
  const data = process.env.AIMOCK_DATA_ROOT;
  requireCondition(path.isAbsolute(data), "AIMOCK_DATA_ROOT 必须是绝对路径");
  requireCondition(
    data.startsWith("/mnt/shared-storage-gpfs2/df4-hicache/"),
    "数据必须留在指定 gpfs2 共享盘内",
  );
  await mkdir(data, { recursive: true, mode: 0o700 });
  const resolvedData = await realpath(data);
  requireCondition(
    resolvedData.startsWith("/mnt/shared-storage-gpfs2/df4-hicache/"),
    "数据必须留在指定 gpfs2 共享盘内",
  );
  const probe = path.join(resolvedData, `.startup-check-${randomUUID()}`);
  const handle = await open(probe, "wx", 0o600);
  await handle.close();
  await unlink(probe);
  await import("@copilotkit/aimock");
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
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      port,
      workers,
      data: resolvedData,
    }),
  );
} catch (error) {
  // 配置解析错误可能带有原文；仅输出类别和本脚本生成的说明，不泄漏配置内容。
  const message = error instanceof SyntaxError ? "配置 JSON 无效" : error.code || error.message;
  console.error(`[aimock preflight] ${message}`);
  process.exit(1);
}
