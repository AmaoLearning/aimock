# 用户侧 coding-agent 录制与回放网关

适配 **AIMock 1.46.0**，运行时固定 **Node 22.22.0**。用户侧按通用服务运行环境设计，不假定是开发机，也不要求使用原集群的 GPFS、公网发布接口或 systemd。本分支交付代码、打包/部署脚本和配置说明；目前不在用户侧执行安装或部署。

```text
录制：Agent → 本网关 → OpenAI Chat Completions 模型服务
                  ← 原始 JSON / SSE / HTTP 状态
                  → 按模型目录、会话和 UTC 日期落盘
回放：Agent → trace / step / attempt → AIMock 1.46.0
```

## 新增功能与范围

- 在线录制每次都转发给真实模型，保存完整请求、工具定义、工具结果、原始响应及数据块到达时间；保留 429、Retry-After 和增量 SSE。
- 支持固定 `/v1`，自动提取调用方发送的稳定会话 ID；显式 `/record/<session>/v1` 和 `X-Test-Id` 继续有效。
- 每个请求独立落盘，无全局回放游标；按会话和时间筛选，导出不可变 trace。多个 agent 可并发复用同一 trace。
- 回放默认验证完整请求指纹，未命中明确报错，不会退回真实模型。工具仍由 agent 执行。
- 只处理文本、Chat Completions 和 function tools，`n=1`；不接入 MCP、多媒体或 dsec suites。
- 无凭据部署包、可配置路径、前台启动入口和启动检查；另提供准备机安装辅助、可选 systemd user service、真实 pi smoke 和 HTTP replay 验证。

## 1. 部署资料与运行环境

以下是后续部署时的操作说明，当前不需要在用户侧执行。运行环境需能执行 Bash 和对应平台的 Node 二进制；Linux 推荐 glibc 环境（如 Debian 12 / Ubuntu 22.04+，需 libstdc++），不直接使用 Alpine/musl。可在主机进程或容器中以前台方式托管。

在与目标 OS/CPU 架构相同的**准备机**上生成部署包：

```bash
git clone --branch deploy/user-side-v1.46.0 https://github.com/AmaoLearning/aimock.git
cd aimock
bash deploy/agent-gateway/bundle.sh --output /absolute/output/aimock-agent-gateway-1.46.0.tar.gz
```

准备机需要 Node.js >=20.15、npm、Bash。脚本固定下载 Node 22.22.0 / AIMock 1.46.0，打包 app、运行时、配置模板和启动入口，不连接用户侧，不包含真实上游配置、密钥或录制数据。已有匹配运行时时可传 `--runtime /absolute/runtime-directory`，该目录需包含 `node_modules`；此方式不执行 npm 安装。npm 镜像使用标准 `NPM_CONFIG_REGISTRY`。

用户侧后续只需把包放到指定目录，例如 `/srv/aimock`；无需在运行环境中 clone、npm install 或构建源码。包内 `current -> app`，启动入口为 `aimock`。需要由部署方提供/挂载：

| 内容            | 示例位置                           | 用途                                                     |
| --------------- | ---------------------------------- | -------------------------------------------------------- |
| 无凭据运行包    | `/srv/aimock`                      | 代码和私有 Node/AIMock 运行时                            |
| `gateway.env`   | `/srv/aimock/config/gateway.env`   | 包内自带模板，修改路径和监听参数                         |
| `upstream.json` | `/srv/aimock/config/upstream.json` | 单独注入完整模型 URL、model、上游 key                    |
| `client-key`    | `/srv/aimock/config/client-key`    | 单独复制原下游 key，Agent 继续沿用                       |
| 数据卷          | `/data/aimock/deepseekv4.1-flash`  | 在 `gateway.env` 设置 `AIMOCK_DATA_ROOT`，与旧 Qwen 分离 |

配置文件权限为 600；运行 UID/GID 需能读取配置并写入数据卷。配置可只读挂载，数据目录需可写。未注入配置时启动会明确失败，不会自动向用户侧申请或创建凭据。不要将凭据、业务请求或录制数据提交到 Git。

### 可选：准备机安装辅助

`install.sh` 只是在准备机/测试主机上建立可运行目录的另一种方式，不是用户侧部署的前提。它不修改系统 Node、不覆盖已有配置或密钥，也不会自动启动服务。需要真实 pi 验证时才加 `--with-pi`，并提供 Python 3。

```bash
export AIMOCK_HOME='/absolute/preparation/aimock'
export AIMOCK_DATA_ROOT='/absolute/test-data/deepseekv4.1-flash'
export AIMOCK_UPSTREAM_CONFIG='/absolute/private-config/upstream.json'
export AIMOCK_CLIENT_KEY_FILE='/absolute/private-config/client-key'
bash deploy/agent-gateway/install.sh --with-pi
```

也可在初次准备时通过 `UPSTREAM_URL`、`UPSTREAM_MODEL`、`UPSTREAM_API_KEY`（或原 `YICLOUD_*`）初始化配置；缺少下游 key 时才随机生成。需沿用原 key 时提供上述文件或 `AIMOCK_CLIENT_API_KEY` 环境变量。已有 `gateway.env` 保留，变更模型/路径需显式编辑后重启。

上游 JSON 的通用格式见 [examples/upstream.json](examples/upstream.json)：

```json
{
  "url": "https://maas.yicloud.com.cn/v1/chat/completions",
  "model": "m-20260919193841-2dxhf/deepseekv4.1-flash",
  "apiKey": "REPLACE_WITH_UPSTREAM_API_KEY"
}
```

原配置中的 `YICLOUD_MODEL_URL`、`YICLOUD_QWEN_MODEL`、`YICLOUD_API_KEY` 字段仍可读取，DeepSeek 也可使用这些旧字段。`url` 必须是完整 `/v1/chat/completions` 地址，模型 ID 必须与真实服务完全一致。

重新安装只发布新代码，保留已有 `gateway.env`、上游配置、client key 和数据。要变更模型或数据路径，请编辑配置文件并重启，不能依靠再次安装覆盖已有配置。

## 2. 必须确认的路径

主要设置保存在 `$AIMOCK_HOME/config/gateway.env`，由 Bash 读取，权限必须为 600。已导出的同名环境变量优先于该文件。路径可以包含空格；配置文件中的路径需用 shell 引号包裹。

| 配置                     | 含义与默认值                                                                            | 用户侧需要确认                                         |
| ------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `AIMOCK_HOME`            | 部署根目录；包内入口默认使用其所在目录，辅助安装默认 `~/.local/share/aimock-gateway`    | 例如 `/srv/aimock`；重定位部署包时检查配置内的绝对路径 |
| `AIMOCK_DATA_ROOT`       | 数据根目录，配置模板默认 `$AIMOCK_HOME/data/deepseekv4.1-flash`                         | 建议显式指定持久化目录；不同模型使用不同目录           |
| `AIMOCK_UPSTREAM_CONFIG` | 默认 `$AIMOCK_HOME/config/upstream.json`                                                | 上游 URL、模型、key；文件必须可读且为 600              |
| `AIMOCK_CLIENT_KEY_FILE` | 默认 `$AIMOCK_HOME/config/client-key`                                                   | Agent 使用的下游 key；需沿用时复制原文件               |
| `AIMOCK_APP_DIR`         | 默认 `$AIMOCK_HOME/current`                                                             | 通常不用改；指向本次代码 release                       |
| `AIMOCK_NODE_BIN`        | 固定私有运行时中的 Node                                                                 | 通常不用改；自定义运行时需 Node >=22.22、AIMock 1.46.0 |
| `AIMOCK_PI_CLI`          | 默认 `$AIMOCK_HOME/pi-runtime/node_modules/@earendil-works/pi-coding-agent/dist/cli.js` | 只在使用已有 pi 安装进行验证时指定                     |

旧部署迁移映射：

| 旧位置                                                               | 用户侧替代位置                                       |
| -------------------------------------------------------------------- | ---------------------------------------------------- |
| `/mnt/shared-storage-gpfs3/yicheng-deploy/aimock`、`/opt/aimock`     | `$AIMOCK_HOME`，部署包或准备机辅助脚本建立独立运行时 |
| `/etc/aimock/upstream.json`、共享盘 `config/upstream*.json`          | `AIMOCK_UPSTREAM_CONFIG`                             |
| `/etc/aimock/client-key`、共享盘 `config/client-key`                 | `AIMOCK_CLIENT_KEY_FILE`                             |
| `/mnt/shared-storage-gpfs2/df4-hicache/aimock-v1`                    | 为旧 Qwen 数据指定一个独立目录                       |
| `/mnt/shared-storage-gpfs2/df4-hicache/aimock-deepseekv4.1-flash-v1` | 为 DeepSeek 数据指定另一个独立目录                   |
| 原公网 IP                                                            | `http://<用户侧服务可达地址>:4010`                   |

迁移已有数据时完整复制 `records/` 和 `traces/`，保留目录层级和文件权限，manifest 使用相对路径。可另外复制 `receipts/`；不要只复制 fixture 文件。存储 schema 保持 1，无需改写旧录制。不同模型的数据不要合并。

如果数据必须在挂载盘上，显式设置保护条件：

```bash
# gateway.env 中的示例；填真正的挂载点，而不是普通子目录。
AIMOCK_REQUIRED_MOUNTS='["/mnt/customer-data"]'
AIMOCK_STORAGE_BOUNDARY='/mnt/customer-data'
```

默认不要求任何共享盘。设置上述配置后，缺失挂载或数据路径经 symlink 逃出指定边界会拒绝启动，避免把数据误写到临时本地盘。

## 3. 启动与停止

```bash
bash "$AIMOCK_HOME/aimock" start
```

这是前台进程，接收 Ctrl-C / SIGTERM 后排空在途请求。平台停止宽限期建议至少 35 秒。启动前会检查配置、AIMock 版本、数据写入和端口占用。

进程托管平台的启动命令栏只填**单行**，将路径换成实际安装目录：

```text
/bin/bash /srv/aimock/aimock start
```

不要向该字段粘贴带续行反斜杠的多行命令。平台必须持久化安装目录、配置和数据目录，并允许到上游模型 URL 的出站网络。运行用户应与安装及数据文件的属主一致。

默认 `0.0.0.0:4010`、8 workers、每个 worker 的 Node heap 上限 4096 MiB。可以在 `gateway.env` 调整 `AIMOCK_HOST`、`AIMOCK_PORT`、`AIMOCK_WORKERS`、`NODE_OPTIONS`。16 核运行环境可以从 8 workers 开始；实际并发容量需要按自身请求长度和存储条件测试。

仅当所在主机支持 systemd user 时可选：

```bash
bash "$AIMOCK_HOME/current/install-user-service.sh" --enable
systemctl --user status aimock-gateway
journalctl --user -u aimock-gateway -f
```

该方式要求 user systemd 会话可用；否则使用前台命令或服务平台已有的进程管理功能。安装器不修改系统 nginx、系统 Node 或其他模型服务。

## 4. 端口与探针

| 项目              | 设置                                                        |
| ----------------- | ----------------------------------------------------------- |
| 容器/进程监听端口 | `4010`，或 `gateway.env` 中的 `AIMOCK_PORT`                 |
| 路径与用途        | `/`，HTTP 模型代理、录制与回放；支持 SSE                    |
| 健康请求          | `GET /healthz`，无需鉴权                                    |
| 请求头            | `Accept: application/json`                                  |
| 存活检查          | 初始等待 30 秒，间隔 10 秒，超时 5 秒，失败阈值 3           |
| 就绪检查          | 初始等待 5 秒，间隔 5 秒，超时 3 秒，成功阈值 1，失败阈值 3 |

`bash "$AIMOCK_HOME/aimock" health` 可在服务所在环境中检查。健康检查不调用真实模型；启动检查会验证数据可写，健康端点检查数据目录存在，不能把它当作上游模型可用性的证明。

网关提供 HTTP。外部访问需由用户侧配置可达地址、端口映射或 HTTPS 反向代理；SSE 代理应关闭缓冲，保留路径、Authorization 和会话头，流超时建议至少 300 秒。此仓库不负责开通平台公网权限。

## 5. Agent 录制接入

| 参数     | 值                                                                  |
| -------- | ------------------------------------------------------------------- |
| base URL | `http://<用户侧地址>:4010/v1`                                       |
| API key  | `AIMOCK_CLIENT_KEY_FILE` 的内容，发送为 `Authorization: Bearer ...` |
| model    | 配置中的完整模型 ID                                                 |

录制只允许当前配置的 model，避免其他模型混入存储目录。请求体的 model/messages/tools/stream 和生成参数正常发送。

会话 ID 提取优先级：显式 `/record/<session-id>/v1` → `X-Test-Id` → 原生会话字段。
原生字段包括 `X-AIMock-Session`、`X-Session-Id`、`Session-Id`、`session_id`、`X-Session-Affinity`，以及请求体 `metadata.session_id`、`metadata.sessionId`、`session_id`。没有显式路由时，多个原生字段必须一致。缺失或冲突返回 400。

不使用 IP、TCP 连接、用户 ID、相同 prompt、`X-Request-Id` 或 `X-Client-Request-Id` 猜测会话。请求体身份字段会原样转发，能否被上游接受取决于上游；优先使用会话头。

pi 0.81.1 的 provider 示例见 [examples/pi-models.json](examples/pi-models.json)。配置 `compat.sendSessionAffinityHeaders: true` 后，pi 自动发送其内部会话 ID；不需要先向网关申请 ID，也不需要每个会话更换 URL。不要将 pi cache retention 设为 `none`，该模式会关闭关联头。

将示例 provider 合并到 agent 的 `models.json`，修改 base URL 和模型 ID，设置 `AIMOCK_API_KEY` 环境变量。示例已包含本次 DeepSeek 所需的兼容参数；其中的 `contextWindow`/`maxTokens` 是验证配置，不是服务能力上限。

```bash
export AIMOCK_API_KEY="$(cat "$AIMOCK_CLIENT_KEY_FILE")"
```

上面的变量在读取 `gateway.env` 的 shell 中可用；否则用实际 client-key 文件路径。已有稳定会话头的 agent 可以只改网关与 key；pi 自定义 provider 还需上述一次性兼容配置。完全不发送会话 ID 的客户端需要启动器/适配器注入，网关无法从标准 Chat Completions 请求可靠恢复会话身份。

## 6. 查询、导出与回放

```bash
bash "$AIMOCK_HOME/aimock" list --session '<session-id>'
bash "$AIMOCK_HOME/aimock" export --session '<session-id>' \
  --from '2026-10-21T00:00:00+08:00' --to '2026-10-22T00:00:00+08:00'
```

时间范围是 `[from, to)`。会话结束后再导出，返回不可变 manifest 和 `trace-...` ID；活跃会话的后续请求不会进入已有 manifest。

把 Agent 的 base URL 改为 `http://<用户侧地址>:4010/replay/<trace-id>/v1`，沿用 client key 和录制时的 model。默认严格匹配完整请求，仅忽略 `stream`、`stream_options`。

也可以固定 `/v1/chat/completions` 并提供：

| Header                  | 用途                                           |
| ----------------------- | ---------------------------------------------- |
| `X-AIMock-Mode: replay` | 选择回放                                       |
| `X-AIMock-Trace`        | 指定 trace                                     |
| `X-AIMock-Step`         | 显式步骤，从 0 开始；默认统计 assistant 消息数 |
| `X-AIMock-Attempt`      | 分支/重试编号，默认 0                          |
| `X-AIMock-Strict: 0`    | 显式允许请求漂移；响应头标记 drift             |

会话 ID 与 trace ID 不同；固定入口的自动 trace 分配不在本次功能内。发生历史压缩或并行分支时，调用方必须明确 step/attempt。严格回放还要求工具执行初始文件、工作目录、工具定义和工具输出与录制一致；把数据移到另一台机器并不保证任意 agent 的新请求指纹相同。

网关不执行工具。默认回放由 AIMock 重新生成 SSE，零延迟；不会逐 token/逐帧复现原始流。可设置 `AIMOCK_REPLAY_TTFT_MS` 和 `AIMOCK_REPLAY_CHUNKS_PER_SECOND`，后者为 chunk 速率，不是模型 token/s。

## 7. 数据格式与验证

```text
<AIMOCK_DATA_ROOT>/
  records/<UTC日期>/<SHA256(session-id)>/<时间戳-UUID>/
    request.json   # 包括完整历史、工具定义和工具结果
    response.raw   # 原始 JSON / SSE
    frames.json    # 数据块到达时间和长度
    fixture.json   # 完整成功响应对应的原生 AIMock fixture
    metadata.json  # model/session/step/attempt/时间/状态/指纹
  traces/<trace-id>/manifest.json
  receipts/        # 独立验证结果
```

不保存 Authorization。目录/文件默认 700/600；业务 prompt 和工具输出仍会保留原文，请按业务数据管理磁盘访问。非 200、取消、未结束/损坏 SSE、响应超限仍保留证据，但禁止导出成功 fixture。存储写入失败会中断请求。

在具备模型访问和数据目录访问权限的验证环境中运行真实 pi 验证（会调用真实模型，并只修改新建的测试目录）：

```bash
bash "$AIMOCK_HOME/aimock" pi-smoke --concurrency 3
# 需要 8 个完整并发 Agent 时改为 --concurrency 8。
```

该命令逐会话执行 read/read/edit/bash，核对测试未被修改、原生会话隔离、工具结果保存及严格回放，保存 `acceptance.json` 和 `data-changes.jsonl`。设置 `AIMOCK_BASE_URL` 可验证其他入口，但 执行验证脚本的环境必须能看到相同的录制数据目录。

使用上述输出的 receipt 路径，做 8 并发 HTTP replay：

```bash
bash "$AIMOCK_HOME/aimock" replay-bench '/absolute/path/to/pi-smoke-receipt' 8
```

这里仅回放现有 trace 的首步，不会执行 Agent 工具，不代表 8 个完整 agent 或持续长流性能。可传 `8,128,512` 分别测试；输出在 receipt 下，也可通过 `AIMOCK_BENCH_OUTPUT` 改路径。

开发验证：在本目录执行 `npm ci`，然后用 `node_modules/node/bin/node --test tests/*.test.mjs`。测试使用本地假上游，不需要真实凭据。
