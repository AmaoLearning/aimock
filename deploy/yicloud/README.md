# YiCloud 会话录制与回放

此部署为 OpenAI **Chat Completions** 提供在线录制代理和离线 AIMock 回放。
只处理文本、function tool calls 和工具结果。不会执行工具，不接入 MCP、多媒体或 dsec suites。

```text
录制：Agent → 会话网关 → 真实模型
                  ← 原始 HTTP 状态 / JSON 或 SSE
                  → 每次请求独立存储 → 原生 AIMock fixture
回放：Agent → trace / step 定位 → 原生 AIMock → 文本或工具调用
```

录制每次都访问真实模型，包括重复请求。响应内容逐段转发；不会等待完整回答再返回。
原生 AIMock 1.45.1 的代理会把上游 429/503 改为 502，因此在线链路使用透明 HTTP 转发，
AIMock 负责流内容折叠、fixture 和回放。回放未命中明确失败，没有真实模型 fallback。

## 安装

目标是专用工作机 `yicloud-aimock-cpu`，使用 8 个 worker，不替换系统 Node。
固定 Node `22.22.0`、AIMock `1.45.1`；验证使用 `@earendil-works/pi-coding-agent@0.81.1`。
这是部署目录，运行固定发布包，不要求将整个上游构建链安装到工作机。

先在机器上以权限 `600` 创建 `/etc/aimock/upstream.json`，字段来自已有环境变量：

```json
{
  "YICLOUD_API_KEY": "<从受保护配置读取>",
  "YICLOUD_MODEL_URL": "https://<模型入口>/v1/chat/completions",
  "YICLOUD_QWEN_MODEL": "<环境变量中的完整模型 ID>"
}
```

不要将真实配置、密钥、请求或录制数据提交到 Git。随后运行：

```bash
sudo bash deploy/yicloud/install.sh
systemctl status aimock-gateway
curl http://127.0.0.1:4010/healthz
```

运行目录 `/opt/aimock/deploy`，专用运行时 `/opt/aimock/runtime`。
下游 API key 自动生成到 `/etc/aimock/client-key`，不会使用上游密钥作为下游鉴权。
服务通过 systemd 自启，文件描述符上限 131072，内存上限 48 GiB，停止时最多等待 30 秒。

## Agent 接入

推荐为每个 Agent 会话设置独立的 base URL，session ID 必须在每次任务运行时重新生成：

| 用途         | base URL                                                 |
| ------------ | -------------------------------------------------------- |
| 内网录制     | `http://<工作机地址>:4010/record/<session-id>/v1`        |
| 内网回放     | `http://<工作机地址>:4010/replay/<trace-id>/v1`          |
| 经平台 nginx | `https://<已验证公网入口>/aimock/record/<session-id>/v1` |

所有模型请求使用 `Authorization: Bearer <下游 API key>`；`model` 使用环境变量中的完整 ID。
`/healthz` 不需鉴权，其他接口需要。没有暴露记录查询、原始数据下载或 AIMock 控制接口。
这里的公网 URL 是模板；内网监听成功不能当作公网发布成功，必须验证平台端口映射和 TLS。

也支持固定 `/v1/chat/completions` 加以下头：

| Header             | 作用                                                  |
| ------------------ | ----------------------------------------------------- |
| `X-Test-Id`        | 录制会话 ID；回放时可用于区分独立运行                 |
| `X-AIMock-Mode`    | `record`（默认）或 `replay`                           |
| `X-AIMock-Trace`   | 使用固定路径回放时指定 trace                          |
| `X-AIMock-Step`    | 显式指定步骤，从 0 开始                               |
| `X-AIMock-Attempt` | 重试分支，默认 0                                      |
| `X-AIMock-Strict`  | 回放默认验证完整请求指纹；设为 `0` 可显式允许内容漂移 |

未指定 step 时使用请求历史中的 assistant 消息数，适合本次验证的顺序 pi 会话。
会压缩历史、并行分支、或重复使用 session ID 的调用方必须显式提供 step/attempt。
不使用全局游标；重试不会隐式推进，多个 Agent 可以独立复用同一个 trace。

回放指纹覆盖 model、完整 messages、tools 和生成参数；仅忽略 `stream`、`stream_options`。
不同 cwd、时间、工具输出或参数会产生 409。允许漂移时用 `X-AIMock-Drift` 响应头标记。
工具仍由 Agent 真实执行；任务工作目录、初始文件和 verifier 需要调用方保持一致。

pi 自定义 provider 使用 `api: "openai-completions"`，关闭不支持的兼容选项：

```json
{
  "providers": {
    "aimock": {
      "baseUrl": "http://<地址>:4010/record/<session-id>/v1",
      "api": "openai-completions",
      "apiKey": "$AIMOCK_API_KEY",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false,
        "supportsStore": false
      },
      "models": [
        {
          "id": "<YICLOUD_QWEN_MODEL>",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 40960,
          "maxTokens": 4096
        }
      ]
    }
  }
}
```

## 公网反向代理

已有 YiCloud nginx 8000 server 时，`install-nginx-route.py` 会备份配置、校验语法并添加
`/aimock/` 路由，保留 `/vscode/`。与 `nginx-location.conf` 放在同目录后执行：

```bash
sudo python3 deploy/yicloud/install-nginx-route.py
curl http://127.0.0.1:8000/aimock/healthz
```

外层公网服务需将 HTTPS 请求转发到这个端口，保留 Authorization、会话头、路径和 SSE。
本配置关闭 nginx 响应缓冲、请求缓冲和 gzip，流式超时 300 秒。公网发布后必须从外部验证
健康检查、无 key 返回 401、携 key 的真实 Agent 录制和 SSE 增量到达。

## 存储与时间筛选

默认根目录固定到 `/mnt/shared-storage-gpfs2/df4-hicache/aimock-v1`：

```text
records/<UTC 日期>/<SHA256(session-id)>/<时间戳-UUID>/
    request.json       完整请求，包括工具定义和历史工具结果
    response.raw       原始 JSON 或 SSE 字节
    frames.json        HTTP 数据块到达时间和长度
    fixture.json       成功回答对应的原生 AIMock fixture
    metadata.json      会话、步骤、attempt、开始/结束时间、状态、工具名、指纹
traces/<trace-id>/manifest.json
receipts/              验证结果，独立于业务录制
```

每次请求独立写文件，metadata 原子替换。文件/目录默认 600/700；不保存 Authorization。
未结束流、取消、损坏 SSE、非 200 或超限回答保留原始证据，标记为不可导出。
正常完成的上游错误仍原样返回 status/body/Retry-After。存储写入错误会中断请求，不假装录制成功。
单请求默认最多保存 64 MiB 响应、16 MiB 请求、20 万数据块；超限响应继续转发但录制不可回放。

在工作机上查询或导出，时间范围为 **[from, to)**，支持带时区的 ISO 时间：

```bash
NODE=/opt/aimock/runtime/node_modules/node/bin/node
"$NODE" /opt/aimock/deploy/ctl.mjs list --session run-001 \
  --from 2026-10-20T11:00:00+08:00 --to 2026-10-20T12:00:00+08:00
"$NODE" /opt/aimock/deploy/ctl.mjs export --session run-001 \
  --from 2026-10-20T11:00:00+08:00 --to 2026-10-20T12:00:00+08:00
```

导出创建新的不可变 manifest，不修改录制。一个 manifest 只包含一个 session；
同一步/attempt 的重复同指纹请求选择首个完整结果，不同指纹明确报错。
导出要求调用方确认本次会话已结束；活跃会话的后续请求不会进入已有 manifest。

按日期和会话目录缩小查询范围，回放用 manifest 直接定位文件。
每 worker 默认只缓存 512 条热 fixture、256 份 manifest；在途选择期间的 pin 可以暂时超过热缓存数。
原生 AIMock 仍扫描热 fixture，尚未验收海量独立 trace 的存储索引性能。

## 回放时间与观测

原始字节和 HTTP 块时序被保留。默认回放通过 AIMock 重新生成 SSE，使用零延迟；
不会逐帧、逐 token 复现原始流，也不会复现原始 HTTP 块边界。
可通过 systemd 环境变量设置 `AIMOCK_REPLAY_TTFT_MS` 和 `AIMOCK_REPLAY_CHUNKS_PER_SECOND`，
重启服务生效。后者对应 AIMock `tps` 的 chunk 间隔，不能当成真实 token/s。
`/metrics` 需下游 key，带 pid 标签，返回接收请求 worker 的指标，不是全机聚合值。

## 验证

```bash
cd deploy/yicloud
npm ci
npm test
```

集成测试在独立临时目录和双 worker 网关运行，检查持续转发、并发会话隔离、原始 429/
Retry-After、原始工具结果、tool-call ID/参数/usage、严格漂移拒绝、缺步拒绝、时间筛选、
损坏流排除和歧义分支拒绝。运行环境使用 Node 22。

`probe-upstream.py` 验证真实模型流式/非流式 tool calls；`pi-smoke.py` 启动三个简单独立
pi 任务；`pi-replay-smoke.py` 审计隔离并使用真实 pi 严格回放。两者不会调用或更改 suites。
测试任务只要求读取文件、修复加法和运行断言，不能代表完整 Tmax 或其他真实 benchmark 成功率。

`replay-bench.mjs RECEIPT_DIR 10000` 使用三个真实 trace 的第 0 步做单机 burst，核对每个
回答的 tool-call ID 和参数。2026-10-20 的 128/512/2048/10000 请求均通过，10000 请求
约 4 秒。客户端与服务同机、默认零延迟、没有公网链路；不代表 10000 活跃长流、持续 SLO
或大轨迹库容量。原始测试和失败记录留在共享存储 receipts，不提交到仓库。
