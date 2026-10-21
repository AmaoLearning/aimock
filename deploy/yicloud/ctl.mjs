#!/usr/bin/env node
// 离线查询与导出录制；仅访问数据目录，不接触上游密钥或修改既有记录。
/* global process, console */
import { findRecords, exportTrace } from "./storage.mjs";
const [command, ...args] = process.argv.slice(2);
const options = {};
for (let index = 0; index < args.length; index += 2) {
  if (!["--session", "--from", "--to", "--root"].includes(args[index]) || !args[index + 1])
    throw new Error(
      "Usage: ctl.mjs list|export [--session ID] [--from ISO] [--to ISO] [--root DIR]",
    );
  options[args[index].slice(2)] = args[index + 1];
}
const root =
  options.root || process.env.AIMOCK_DATA_ROOT || "/mnt/shared-storage-gpfs2/df4-hicache/aimock-v1";
if (command === "list") console.log(JSON.stringify(await findRecords(root, options), null, 2));
else if (command === "export")
  console.log(JSON.stringify(await exportTrace(root, options), null, 2));
else throw new Error("Usage: ctl.mjs list|export --session ID [--from ISO] [--to ISO]");
