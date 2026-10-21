// 初始化一次；重新安装只发布代码，绝不覆盖已有配置、密钥或数据。
/* global process, console */
import { randomBytes, createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  copyFile,
  symlink,
  rename,
  stat,
  chmod,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";

process.umask(0o077);
const source = path.resolve(process.argv[2]);
const home = path.resolve(
  process.env.AIMOCK_HOME || path.join(os.homedir(), ".local/share/aimock-gateway"),
);
const configDir = path.join(home, "config");
await mkdir(configDir, { recursive: true, mode: 0o700 });
await chmod(configDir, 0o700);
const upstream = process.env.AIMOCK_UPSTREAM_CONFIG || path.join(configDir, "upstream.json");
const clientKey = process.env.AIMOCK_CLIENT_KEY_FILE || path.join(configDir, "client-key");
for (const filename of [upstream, clientKey]) {
  if (!path.isAbsolute(filename)) throw new Error("Configuration paths must be absolute");
}
async function createOnly(filename, content) {
  try {
    await writeFile(filename, content, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
}
if (!(await stat(upstream).catch(() => null))) {
  const input = {
    url: process.env.UPSTREAM_URL || process.env.YICLOUD_MODEL_URL,
    model: process.env.UPSTREAM_MODEL || process.env.YICLOUD_QWEN_MODEL,
    apiKey: process.env.UPSTREAM_API_KEY || process.env.YICLOUD_API_KEY,
  };
  if (!input.url || !input.model || !input.apiKey)
    throw new Error(
      "Set UPSTREAM_URL, UPSTREAM_MODEL and UPSTREAM_API_KEY, or provide AIMOCK_UPSTREAM_CONFIG",
    );
  await createOnly(upstream, JSON.stringify(input, null, 2));
}
let configuration;
try {
  configuration = JSON.parse(await readFile(upstream, "utf8"));
} catch {
  throw new Error("Invalid upstream configuration JSON");
}
const model = configuration.model ?? configuration.YICLOUD_QWEN_MODEL;
if (typeof model !== "string" || !model) throw new Error("Missing configured model");
const modelDirectory = model
  .split("/")
  .at(-1)
  .replace(/[^a-zA-Z0-9._-]/g, "_");
const data = process.env.AIMOCK_DATA_ROOT || path.join(home, "data", modelDirectory);
if (!path.isAbsolute(data)) throw new Error("AIMOCK_DATA_ROOT must be absolute");
await mkdir(data, { recursive: true, mode: 0o700 });
await createOnly(
  clientKey,
  (process.env.AIMOCK_CLIENT_API_KEY || randomBytes(32).toString("hex")) + "\n",
);
for (const filename of [upstream, clientKey]) {
  const info = await stat(filename);
  if (!info.isFile() || info.mode & 0o077)
    throw new Error(`Require private file permissions (600): ${filename}`);
}
const values = {
  AIMOCK_HOME: home,
  AIMOCK_HOST: process.env.AIMOCK_HOST || "0.0.0.0",
  AIMOCK_PORT: process.env.AIMOCK_PORT || "4010",
  AIMOCK_WORKERS: process.env.AIMOCK_WORKERS || "8",
  AIMOCK_DATA_ROOT: data,
  AIMOCK_UPSTREAM_CONFIG: upstream,
  AIMOCK_CLIENT_KEY_FILE: clientKey,
  AIMOCK_REQUIRED_MOUNTS: process.env.AIMOCK_REQUIRED_MOUNTS || "[]",
  NODE_OPTIONS: process.env.NODE_OPTIONS || "--max-old-space-size=4096",
};
if (process.env.AIMOCK_STORAGE_BOUNDARY)
  values.AIMOCK_STORAGE_BOUNDARY = process.env.AIMOCK_STORAGE_BOUNDARY;
const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
await createOnly(
  path.join(configDir, "gateway.env"),
  "# Paths and settings only. Keep this file private; it is sourced by bash.\n" +
    Object.entries(values)
      .map(([key, value]) => `${key}=${quote(value)}`)
      .join("\n") +
    "\n",
);
const id = new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomBytes(3).toString("hex");
const release = path.join(home, "releases", id);
await mkdir(release, { recursive: true, mode: 0o700 });
const hashes = {};
for (const name of await readdir(source)) {
  if (
    !/\.(mjs|py)$/.test(name) &&
    !["README.md", "package.json", "install-user-service.sh"].includes(name)
  )
    continue;
  await copyFile(path.join(source, name), path.join(release, name));
  hashes[name] = createHash("sha256")
    .update(await readFile(path.join(release, name)))
    .digest("hex");
}
const examples = path.join(release, "examples");
await mkdir(examples);
for (const name of await readdir(path.join(source, "examples")))
  await copyFile(path.join(source, "examples", name), path.join(examples, name));
await symlink(
  "../../runtime/node-22.22.0-aimock-1.46.0/node_modules",
  path.join(release, "node_modules"),
);
await writeFile(
  path.join(release, "release-manifest.json"),
  JSON.stringify(
    {
      aimock: "1.46.0",
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      hashes,
    },
    null,
    2,
  ),
);
const link = path.join(home, ".current-" + id);
await symlink(path.join("releases", id), link);
await rename(link, path.join(home, "current"));
await copyFile(path.join(source, "launch.sh"), path.join(home, "aimock"));
await chmod(path.join(home, "aimock"), 0o755);
console.log(
  JSON.stringify({
    installed: home,
    release,
    config: path.join(configDir, "gateway.env"),
    existingCredentialsNotOverwritten: true,
    aimock: "1.46.0",
  }),
);
