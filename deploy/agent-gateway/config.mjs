// 用户侧部署配置；旧 YiCloud 字段仅作为导入现有受保护配置时的兼容别名。
/* global process */
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

export const home = path.resolve(
  process.env.AIMOCK_HOME || path.join(os.homedir(), ".local/share/aimock-gateway"),
);
export const dataRoot = process.env.AIMOCK_DATA_ROOT || path.join(home, "data/default");
export const upstreamFile =
  process.env.AIMOCK_UPSTREAM_CONFIG || path.join(home, "config/upstream.json");
export const clientKeyFile =
  process.env.AIMOCK_CLIENT_KEY_FILE || path.join(home, "config/client-key");
export const requiredVersion = "1.46.0";

export async function upstreamConfig(filename = upstreamFile) {
  let input;
  try {
    input = JSON.parse(await readFile(filename, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Invalid upstream configuration JSON");
    throw error;
  }
  return {
    url: input.url ?? input.YICLOUD_MODEL_URL,
    apiKey: input.apiKey ?? input.YICLOUD_API_KEY,
    model: input.model ?? input.YICLOUD_QWEN_MODEL,
  };
}

export async function aimockVersion() {
  const entry = createRequire(import.meta.url).resolve("@copilotkit/aimock");
  const manifest = path.join(path.dirname(entry), "../package.json");
  return JSON.parse(await readFile(manifest, "utf8")).version;
}
