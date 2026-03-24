# 架构方案评估报告：SaaS 后端接管 Telegram + OpenClaw 作为执行引擎

> 评估时间: 2026-03-23
> 基于 OpenClaw 官方文档（docs.openclaw.ai）深度分析

---

## 一、你的方案概述

```
Telegram 用户
    │
    ▼
┌─────────────────────────────┐
│   你的 SaaS 后端             │
│   (接收 Webhook / 长轮询)    │
│   计费 / 风控 / 鉴权         │
└─────────────────────────────┘
    │  POST /v1/responses
    │  x-openclaw-agent-id: tenant_123
    │  x-openclaw-session-key: user_888
    ▼
┌─────────────────────────────┐
│   OpenClaw Gateway          │
│   (纯粹的多租户执行引擎)      │
│   工具调用 / 记忆检索 / AI    │
└─────────────────────────────┘
    │  SSE 流式返回
    ▼
┌─────────────────────────────┐
│   你的 SaaS 后端             │
│   解析 SSE → 发送到 Telegram │
└─────────────────────────────┘
```

核心主张：
1. SaaS 后端接管 Telegram Webhook，OpenClaw 不直连 Telegram
2. 通过 `POST /v1/responses` + HTTP Header 精准路由到租户的 Agent 和 Session
3. 完全掌控计费/风控，在消耗 LLM Token 之前拦截

---

## 二、与 OpenClaw 官方文档的逐项验证

### 2.1 `POST /v1/responses` 端点 — 确认存在且功能完备

**文档确认：** OpenClaw Gateway 提供了 OpenResponses 兼容的 `POST /v1/responses` 端点。

**关键细节：**
- 此端点 **默认禁用**，必须在配置中显式启用：
```json5
{
  gateway: {
    http: {
      endpoints: {
        responses: { enabled: true }
      }
    }
  }
}
```
- 与 Gateway 的 WebSocket 端口复用（默认 `18789`）
- 底层执行路径与 `openclaw agent` 完全一致，享有相同的路由/权限/配置

**结论：可行，需要在 OpenClaw 配置中显式启用。**

### 2.2 `x-openclaw-agent-id` Header — 确认支持

**文档确认：** 有两种方式选择智能体：
1. **Header 方式：** `x-openclaw-agent-id: <agentId>`（默认值 `main`）
2. **Model 字段编码：** `model: "openclaw:<agentId>"` 或 `model: "agent:<agentId>"`

你方案中使用 `x-openclaw-agent-id: tenant_123` 是完全合规的。

**结论：完全可行。**

### 2.3 `x-openclaw-session-key` Header — 确认支持

**文档确认：** `x-openclaw-session-key: <key>` 提供对会话路由的完全控制。

此外，如果请求包含 `user` 字符串字段，Gateway 会从中派生稳定的会话键，实现重复调用共享会话。

**两种 Session 隔离策略：**
- **显式 key：** `x-openclaw-session-key: user_888`（你完全掌控 key 格式）
- **user 字段派生：** 请求体中的 `"user": "user_888"` 自动生成稳定 key

**结论：完全可行。推荐使用 `x-openclaw-session-key` 以获得最大控制力。**

### 2.4 SSE 流式返回 — 确认支持

**文档确认：** 设置 `"stream": true` 接收 Server-Sent Events：
- `Content-Type: text/event-stream`
- 事件类型包括：`response.created`、`response.output_text.delta`、`response.completed`、`response.failed` 等
- 以 `data: [DONE]` 结束

**结论：完全可行。你的后端解析 SSE delta 事件后可实时推送到 Telegram。**

### 2.5 请求结构兼容性 — 确认 OpenAI 风格

**文档确认的支持项：**
| 功能 | 支持状态 |
|------|---------|
| `input`（字符串或 item 数组） | ✅ |
| `instructions`（系统提示注入） | ✅ |
| `tools`（客户端函数工具） | ✅ |
| `tool_choice` | ✅ |
| `stream` | ✅ |
| `max_output_tokens` | ✅ |
| `user`（会话路由） | ✅ |
| `input_image`（base64/URL） | ✅ JPEG/PNG/GIF/WebP，≤10MB |
| `input_file`（base64/URL） | ✅ text/md/html/csv/json/pdf，≤5MB |
| `function_call_output`（工具回调） | ✅ |

**结论：完全兼容 OpenAI Responses API 风格，你的后端代码编写非常标准。**

### 2.6 认证机制 — 确认 Bearer Token

**文档确认：**
- `Authorization: Bearer <GATEWAY_TOKEN>`
- 支持 `token` 和 `password` 两种认证模式
- 可通过 `OPENCLAW_GATEWAY_TOKEN` 环境变量配置

**结论：完全可行。**

---

## 三、方案优势评估（你的判断均正确）

### 3.1 极致的掌控力 — **正确**

这是此方案最大的优势。通过你的 SaaS 后端作为唯一入口：

- **计费拦截：** 余额不足时直接拒绝，零 LLM Token 消耗
- **风控：** 敏感词过滤、频率限制、内容审核均在请求到达 OpenClaw 之前完成
- **鉴权：** 完全自定义的用户体系，不依赖 OpenClaw 的 pairing/allowlist 机制
- **审计：** 所有请求/响应经过你的后端，便于日志记录和合规

这在 OpenClaw 原生 Telegram 方案中是做不到的。OpenClaw 的原生 Telegram 通道设计目标是"个人 AI 助手"，其访问控制（pairing、allowlist）面向的是"谁可以跟我的 bot 说话"，而非"SaaS 多租户计费"场景。

### 3.2 完美兼容 — **正确**

OpenResponses API 的设计本身就是对齐 OpenAI Responses API 的，支持：
- 结构化 item 输入（文本/图片/文件/工具回调）
- 函数工具定义和回调循环
- SSE 流式传输
- Usage 统计（当底层 LLM 返回 token 计数时）

你的后端代码可以用任何 OpenAI SDK 或标准 HTTP 库编写。

### 3.3 避免冲突 — **正确，且非常重要**

OpenClaw 原生的渠道路由依赖一套复杂的绑定机制：
```json5
bindings: [
  { agentId: "home", match: { channel: "whatsapp", accountId: "personal" } },
  { agentId: "work", match: { channel: "whatsapp", accountId: "biz" } },
]
```
这套 bindings 系统的设计目标是"少量智能体 × 多渠道"的个人使用场景。对于 SaaS 多租户（可能数百甚至数千个租户），维护 bindings 路由表既复杂又脆弱。

通过 HTTP Header 动态指定 `agent-id` 和 `session-key`，完全绕过了 bindings 系统，简洁可靠。

---

## 四、关键考量与潜在挑战

### 4.1 Agent 动态创建问题（重要）

**问题：** OpenClaw 的 Agent 是通过 **配置文件或 CLI** 创建的，目前没有公开的 HTTP API 动态创建 Agent。

```bash
# 创建新 Agent 需要 CLI
openclaw agents add tenant_123
```

或在 `openclaw.json` 中静态声明：
```json5
{
  agents: {
    list: [
      { id: "tenant_123", workspace: "~/.openclaw/workspace-tenant_123" },
      { id: "tenant_456", workspace: "~/.openclaw/workspace-tenant_456" },
    ]
  }
}
```

**对 SaaS 的影响：**
- 每当有新租户注册时，你需要修改 `openclaw.json` 并触发配置热重载
- 或者通过 RPC `config.patch` 动态更新配置（Gateway 支持 `config.patch` RPC）
- 大量 Agent 可能影响 Gateway 启动时间和内存占用

**建议的两种策略：**

**策略 A：少量共享 Agent + 多 Session（推荐起步方案）**
```
不为每个租户创建独立 Agent。
而是创建少量 Agent（如 "default"、"pro"、"enterprise"），
通过 x-openclaw-session-key 区分每个用户，
通过 instructions 字段注入每租户的个性化提示。
```

```bash
curl -sS http://127.0.0.1:18789/v1/responses \
  -H 'Authorization: Bearer <TOKEN>' \
  -H 'x-openclaw-agent-id: default' \
  -H 'x-openclaw-session-key: tenant_123:user_888' \
  -d '{
    "model": "openclaw",
    "instructions": "你是租户123的专属助手，名叫小明...",
    "input": "帮我查一下昨天的报表",
    "stream": true,
    "user": "tenant_123:user_888"
  }'
```

**优点：** 无需动态创建 Agent，Session 自动创建
**缺点：** 所有租户共享同一工作区文件（AGENTS.md/SOUL.md），无法实现工作区级别的隔离

**策略 B：每租户独立 Agent（完全隔离方案）**
```
每个租户一个独立 Agent，拥有独立的：
- 工作区（文件、记忆、技能）
- 会话存储
- 认证配置
```

通过 `config.patch` RPC 或直接编辑 `openclaw.json` 动态添加 Agent：
```bash
openclaw gateway call config.patch --params '{
  "raw": "{ agents: { list: [... existing ..., { id: \"tenant_789\", workspace: \"~/.openclaw/workspaces/tenant_789\" }] } }",
  "baseHash": "<current_hash>"
}'
```

**优点：** 完全隔离，每租户有独立的记忆/技能/人格
**缺点：** 需要自动化 Agent 生命周期管理，资源消耗随租户数线性增长

### 4.2 放弃 OpenClaw 原生 Telegram 功能

接管 Telegram 意味着你放弃了 OpenClaw 原生 Telegram 通道的以下功能，需要自行实现：

| 原生功能 | 你需要自行实现？ |
|---------|:-----------:|
| 长轮询 / Webhook | ✅ 是 |
| Markdown → Telegram HTML 转换 | ✅ 是 |
| 长消息自动分段（4000字符限制） | ✅ 是 |
| 草稿流式传输（typing 效果） | ✅ 是（或简化处理） |
| 内联按钮 / 键盘 | ✅ 是 |
| 贴纸接收/发送 | ✅ 是（如需要） |
| 反应通知 | ✅ 是（如需要） |
| 媒体上传/下载 | ✅ 是 |
| 群组管理（提及门控等） | ✅ 是（如需要） |
| 原生命令注册（/status, /reset） | ✅ 是 |
| 自动重试（429/网络错误） | ✅ 是 |

**评估：** 这些功能大部分用 Telegraf/grammY 框架很容易实现，是合理的工程投入。核心价值在于你获得了对 Telegram 交互层的完全控制权。

### 4.3 Token 用量追踪

**文档确认：** OpenResponses API 的响应中会包含 `usage` 字段（当底层 LLM 提供商返回 token 计数时）。

```json
{
  "usage": {
    "input_tokens": 150,
    "output_tokens": 320,
    "total_tokens": 470
  }
}
```

但需注意：
- 在 SSE 流式模式下，`usage` 通常在最后的 `response.completed` 事件中返回
- 如果 OpenClaw 内部执行了多轮工具调用，最终的 `usage` 可能是累计值
- 如果底层提供商不报告 token 数，`usage` 可能为空

**建议：** 你的后端应同时记录 OpenClaw 返回的 `usage` 和自己的 token 估算值，取较大者计费。

### 4.4 沙箱隔离（安全层面）

如果不同租户使用不同 Agent，OpenClaw 提供每 Agent 的沙箱隔离：

```json5
{
  agents: {
    list: [
      {
        id: "tenant_123",
        sandbox: {
          mode: "all",
          scope: "agent"
        },
        tools: {
          allow: ["read", "exec"],
          deny: ["write", "edit"]
        }
      }
    ]
  }
}
```

**这意味着：** 你可以为不同等级的租户配置不同的安全策略（工具权限、沙箱隔离级别）。

---

## 五、推荐的最终架构

综合以上分析，推荐以下分层架构：

```
┌───────────────────────────────────────────────────┐
│                Telegram Bot API                    │
│            (Webhook → 你的公网端点)                 │
└───────────────────────────────────────────────────┘
                        │
                        ▼
┌───────────────────────────────────────────────────┐
│             SaaS 后端 (Node.js / Express)          │
│                                                    │
│  ┌──────────┐ ┌──────────┐ ┌───────────────────┐  │
│  │ 用户鉴权  │ │ 配额计费  │ │ 风控 / 内容审核   │  │
│  └──────────┘ └──────────┘ └───────────────────┘  │
│                                                    │
│  ┌──────────────────────────────────────────────┐  │
│  │           Telegram 消息处理层                  │  │
│  │  - Webhook 接收                               │  │
│  │  - 消息格式转换 (text/image/file → items)     │  │
│  │  - 长消息分段                                  │  │
│  │  - 流式 typing 效果                            │  │
│  │  - 内联键盘 / 命令处理                         │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
│  ┌──────────────────────────────────────────────┐  │
│  │            数据库 (PostgreSQL / SQLite)        │  │
│  │  - 用户表 (telegram_id, tenant_id, tier)      │  │
│  │  - 配额表 (token_usage, billing)              │  │
│  │  - 会话映射表 (user → agent_id + session_key) │  │
│  │  - 审计日志                                    │  │
│  └──────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────┘
          │
          │  POST /v1/responses
          │  Authorization: Bearer <GATEWAY_TOKEN>
          │  x-openclaw-agent-id: <agent_id>
          │  x-openclaw-session-key: <tenant:user>
          │  Body: { model, input/items, instructions, stream, user }
          ▼
┌───────────────────────────────────────────────────┐
│           OpenClaw Gateway (本地/远程)              │
│                                                    │
│  ┌──────────────────────────────────────────────┐  │
│  │  OpenResponses API (POST /v1/responses)      │  │
│  │  - 需要在配置中启用                            │  │
│  │  - Bearer Token 认证                          │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
│  ┌──────────────────────────────────────────────┐  │
│  │  多 Agent 路由                                │  │
│  │  Agent A: default (共享型，按 session 隔离)   │  │
│  │  Agent B: pro     (高级功能，更多工具)         │  │
│  │  Agent C: tenant_x (独立工作区，完全隔离)     │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
│  ┌──────────────────────────────────────────────┐  │
│  │  执行引擎                                     │  │
│  │  - LLM 调用 (Claude/GPT/自定义)               │  │
│  │  - 工具执行 (exec/read/write/browser)         │  │
│  │  - 记忆检索 (MEMORY.md + 每日记忆)             │  │
│  │  - Skills 执行                                │  │
│  │  - 沙箱隔离 (可选 Docker)                      │  │
│  └──────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────┘
```

### OpenClaw 最小必要配置

```json5
// ~/.openclaw/openclaw.json
{
  // 不启用任何渠道 — Telegram 由你的后端接管
  channels: {},

  // 启用 HTTP OpenResponses 端点
  gateway: {
    port: 18789,
    auth: {
      mode: "token",
      token: "${OPENCLAW_GATEWAY_TOKEN}"
    },
    http: {
      endpoints: {
        responses: { enabled: true }
      }
    }
  },

  // Agent 配置
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-sonnet-4-5",
        fallbacks: ["openai/gpt-4o"]
      }
    },
    list: [
      {
        id: "default",
        default: true,
        workspace: "~/.openclaw/workspaces/default"
      },
      {
        id: "pro",
        workspace: "~/.openclaw/workspaces/pro",
        model: { primary: "anthropic/claude-opus-4-5" }
      }
    ]
  },

  // 会话配置 — 使用 per-channel-peer 确保不同 session-key 独立
  session: {
    dmScope: "per-channel-peer",
    reset: {
      mode: "idle",
      idleMinutes: 1440
    }
  }
}
```

---

## 六、结论与评级

| 维度 | 评级 | 说明 |
|------|:----:|------|
| 技术可行性 | ⭐⭐⭐⭐⭐ | 所有涉及的 API 和 Header 均已被官方文档确认支持 |
| 架构合理性 | ⭐⭐⭐⭐⭐ | 关注点分离清晰，SaaS 后端做业务层，OpenClaw 做 AI 执行层 |
| 掌控力 | ⭐⭐⭐⭐⭐ | 所有 Telegram 消息先经过你的后端，完全可控 |
| 扩展性 | ⭐⭐⭐⭐ | 单 Gateway 适合中小规模；大规模需多 Gateway 实例 + 负载均衡 |
| 实现复杂度 | ⭐⭐⭐ | 需自行实现 Telegram 消息处理层，但有成熟框架可用 |
| 功能完整度 | ⭐⭐⭐⭐ | 放弃 OpenClaw 原生 TG 功能，但大部分可用 Telegraf/grammY 补回 |

### 最终判定：**方案完全可行且架构优秀**

你的核心见解 — "不要让 OpenClaw 直接连 Telegram，把它当纯执行引擎" — 是针对 SaaS 多租户场景的正确架构决策。OpenClaw 的原生渠道系统是为"个人 AI 助手"设计的，而非 SaaS 平台。通过 HTTP API 解耦后，你获得了计费拦截、风控前置、动态路由的能力，同时仍享有 OpenClaw 强大的 AI 执行能力（工具调用、记忆系统、沙箱隔离）。

### 下一步行动建议

1. **启用 OpenClaw Gateway 的 OpenResponses 端点并验证连通性**
2. **搭建 SaaS 后端骨架，接收 Webhook**
3. **实现基础消息转发链路：Telegram → 后端 → OpenClaw → 后端 → Telegram**
4. **在此基础上逐步添加计费/鉴权/风控/流式传输等业务层**
5. **选择策略 B（独立 Agent）**
