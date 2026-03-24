# OpenClaw Multi-Tenant Telegram Bot — 项目分析报告

> 分析时间: 2026-03-23  
> 项目状态: **未完全开发完成**（存在两套并行架构，多处代码不一致）

---

## 一、项目概述

本项目是一个**多租户 Telegram Bot**，目标是为每个 Telegram 用户提供独立的 OpenClaw AI 工作空间。用户通过 Telegram 机器人发送消息，系统将消息路由到 OpenClaw Gateway 进行 AI 处理，并返回结果。

**技术栈:**
- **运行环境:** Node.js（纯 JavaScript，无 TypeScript）
- **Telegram 框架:** Telegraf v4（长轮询模式）
- **数据库:** SQLite（better-sqlite3）
- **HTTP 客户端:** Axios
- **文件操作:** fs-extra
- **环境变量:** dotenv
- **日志库:** winston（已声明依赖但未实际使用）
- **Web 框架:** Express（已声明依赖但未实际使用）
- **其他:** uuid（仅在未启用的 services 层使用）

---

## 二、项目结构

```
openclaw-telegram-multiuser/
├── server/
│   ├── index.js                    # 主入口（活跃代码路径）
│   ├── database.js                 # 数据库管理（better-sqlite3）
│   ├── workspaceManager.js         # 工作空间管理
│   ├── tokenQuotaManager.js        # Token 配额管理
│   ├── openclawClient.js           # OpenClaw Gateway 客户端
│   ├── bot.js                      # ⚠️ 备选 Bot 实现（未接入）
│   └── services/                   # ⚠️ 备选服务层（未接入）
│       ├── userManager.js          #    用户管理（使用 sqlite3 包）
│       ├── sessionManager.js       #    会话管理（spawn 子进程模式）
│       ├── workspaceManager.js     #    工作空间管理（模板复制模式）
│       └── tokenQuotaManager.js    #    配额管理（使用 sqlite3 包）
├── scripts/
│   ├── setup.js                    # 项目初始化脚本
│   └── admin.js                    # 管理员 CLI 工具
├── data/
│   ├── config.json                 # 等级配置（setup.js 生成，但未被主程序读取）
│   └── bot.log                     # 日志文件
├── .env.example                    # 环境变量模板
├── .gitignore
├── package.json
├── package-lock.json
└── README.md
```

---

## 三、Git 历史

项目仅有 **2 次提交**，说明处于非常早期的开发阶段：

| 提交 | 说明 |
|------|------|
| `f38aaee` | 多租户 Telegram Bot - OpenClaw 集成（初始提交） |
| `718d55a` | 添加 .gitignore |

仅有 `master` 一个分支，无其他开发分支。

---

## 四、核心架构分析

### 4.1 活跃代码路径（实际运行的代码）

```
npm start → server/index.js (MultiTenantBot)
                ├── server/database.js         (SQLite 数据库)
                ├── server/tokenQuotaManager.js (配额管理)
                ├── server/workspaceManager.js  (工作空间管理)
                └── server/openclawClient.js    (OpenClaw API 客户端)
```

**主入口 `server/index.js`** 定义了 `MultiTenantBot` 类，启动流程：
1. 加载 dotenv 环境变量
2. 初始化 SQLite 数据库
3. 初始化 TokenQuotaManager
4. 初始化 WorkspaceManager
5. 通过 Telegraf 长轮询启动 Bot

### 4.2 未接入的备选代码路径

```
server/bot.js (TelegramBot 类，未被任何入口引用)
    ├── server/services/userManager.js
    ├── server/services/sessionManager.js
    ├── server/services/workspaceManager.js
    └── server/services/tokenQuotaManager.js
```

这是一套**完全独立的实现**，设计理念不同（进程隔离模式 vs HTTP API 模式），但从未被连接到主入口。

---

## 五、模块详细分析

### 5.1 数据库模块 (`server/database.js`)

**引擎:** better-sqlite3（同步 API）

**数据表设计:**

| 表名 | 用途 | 主键 |
|------|------|------|
| `users` | 用户信息 | `telegram_id` |
| `token_usage` | 每日 Token 使用记录 | 自增 ID，`UNIQUE(telegram_id, date)` |
| `quotas` | 用户配额信息 | `telegram_id` |
| `message_history` | 消息审计日志 | 自增 ID |
| `installed_skills` | 已安装技能 | 自增 ID，`UNIQUE(telegram_id, skill_name)` |

**`users` 表字段:**
- `telegram_id` (INTEGER PK)、`username`、`first_name`、`last_name`
- `created_at`、`last_active`
- `tier` (默认 'free')、`is_banned` (默认 0)
- `message_count`、`session_count`

**特性:**
- 启用 WAL 模式提高并发性能
- 提供 `getGlobalStats()` 全局统计
- 提供 `getUserDetails()` 包含用户、配额、近30天使用、技能等全部信息
- camelCase 到 snake_case 的字段名映射

### 5.2 OpenClaw 客户端 (`server/openclawClient.js`)

**通信协议:** JSON-RPC 2.0 over HTTP POST

**API 方法:**

| 方法 | 用途 |
|------|------|
| `agent` | 核心对话接口，发送消息并等待 AI 回复 |
| `sessions.history` | 获取会话历史 |
| `sessions.reset` | 清除会话 |
| `skills.install` | 安装技能 |
| `skills.list` | 获取技能列表 |
| `health` | 健康检查 |

**会话标识:** `telegram:{userId}` 格式

**容错机制:**
- HTTP 超时 120 秒，agent 调用参数中设置 60 秒超时
- 连接失败时自动降级到 `mockChat()` 模拟响应
- `installSkill()` 失败时静默返回模拟成功

**响应解析:** 兼容多种返回格式（`text`、`response`、`terminal`、`output`、纯字符串、JSON 序列化）

### 5.3 工作空间管理 (`server/workspaceManager.js`)

**设计:** 每个用户在文件系统上拥有独立目录

**目录命名:** `user_{base64(telegram_id)}`，特殊字符替换为 `_`

**目录结构:**
```
user_{hash}/
├── AGENTS.md          # 工作空间说明
├── SOUL.md            # AI 人格定义
├── USER.md            # 用户信息
├── MEMORY.md          # 长期记忆
├── .gitignore
├── memory/            # 每日记忆（按日期命名 .md 文件）
├── skills/            # 已安装技能
├── data/              # 数据存储
├── temp/              # 临时文件
├── config/            # 配置
└── canvas/            # 画布
```

**重置机制:** 旧目录移动到备份路径，重新创建，24 小时后删除备份

**安全:** `isSafePath()` 防止目录遍历攻击

### 5.4 Token 配额管理 (`server/tokenQuotaManager.js`)

**等级配置（硬编码在 JS 中）:**

| 等级 | 每日限额 | 总限额 |
|------|---------|--------|
| free | 10,000 | 100,000 |
| basic | 50,000 | 500,000 |
| pro | 200,000 | 2,000,000 |
| vip | 1,000,000 | 10,000,000 |
| unlimited | ∞ | ∞ |

**核心功能:**
- `getQuotaInfo()` — 获取配额信息，含每日自动重置逻辑
- `consumeTokens()` — 消费 Token，双重检查（总量 + 每日）
- `addQuota()` — 管理员增加配额
- `upgradeTier()` — 升级用户等级
- `hasEnoughQuota()` — 预检查配额是否充足

### 5.5 Telegram Bot 命令 (`server/index.js`)

| 命令 | 功能 |
|------|------|
| `/start` | 欢迎消息 + 配额概要 + 命令列表 |
| `/status` | 用户状态、工作空间信息、Token 统计 |
| `/skills` | 技能列表和安装说明 |
| `/reset` | 重置工作空间（带确认按钮） |
| `/help` | 帮助信息 |
| `/admin` | 管理员面板（需 ADMIN_IDS 权限） |

**消息处理流程:**
1. 中间件：用户自动注册、工作空间创建、配额加载
2. 配额检查（剩余为 0 则拒绝）
3. 技能安装命令检测（`install skill <name>`）
4. 发送"处理中"提示 → 调用 OpenClaw `agent` → 删除提示
5. 记录 Token 消耗 → 分段发送长消息（≤4000 字符/段）

### 5.6 管理工具

**CLI 管理脚本 (`scripts/admin.js`):**
- 查看用户列表（最近 50 个）
- 查看用户详情
- 增加配额
- 升级等级
- 封禁/解封
- 全局统计
- 重置用户数据

**初始化脚本 (`scripts/setup.js`):**
- 检查 BOT_TOKEN 配置
- 创建必要目录
- 初始化 SQLite 数据库
- 生成 `data/config.json` 默认配置

---

## 六、关键问题与 Bug

### 6.1 架构层面问题

#### 问题 1: 两套并行架构未整合
`server/index.js` 和 `server/bot.js` 是两套独立实现：

| 维度 | index.js（活跃） | bot.js（未接入） |
|------|-----------------|-----------------|
| DB 驱动 | better-sqlite3 | sqlite3（未在 package.json 中声明） |
| AI 交互 | HTTP JSON-RPC (OpenClawClient) | spawn 子进程 (SessionManager) |
| 会话管理 | 无显式会话 | Telegraf session() 中间件 |
| 工作空间 | 直接创建 + 种子文件 | 模板复制 + UUID |
| Token 计量 | 基于 Gateway 返回值 | 基于消息长度 + 处理时间估算 |

`bot.js` 的 `services/` 依赖 `sqlite3` 包，但 `package.json` 只声明了 `better-sqlite3`，直接运行会报错。

#### 问题 2: 未使用的依赖
| 依赖 | 状态 |
|------|------|
| `express` | 在 `index.js` 中 require 但从未使用 |
| `winston` | 在 `package.json` 中声明但代码全部使用 `console.log` |
| `uuid` | 仅 `services/workspaceManager.js` 使用（该文件未接入） |
| `Markup` | 从 Telegraf 导入但未使用 |
| `fs` (fs-extra) | 在 `index.js` 中 require 但未使用 |

#### 问题 3: `data/config.json` 未被加载
`setup.js` 生成的 `config.json` 包含等级配置和功能开关，但 `index.js` **从未读取此文件**。等级限制硬编码在 `tokenQuotaManager.js` 中，两处数据可能不同步。

### 6.2 功能层面问题

#### 问题 4: 封禁功能未生效
数据库中有 `is_banned` 字段，`admin.js` 可以封禁用户，但 **`index.js` 的中间件没有检查 `is_banned`**，被封禁的用户仍然可以正常使用 Bot。

#### 问题 5: 管理员子命令未注册
`/admin` 命令的回复中提示了 `/admin_quota`、`/admin_ban`、`/admin_info` 三个管理员命令，但这些命令**未在代码中注册处理函数**，发送这些命令不会有任何效果。

#### 问题 6: 非文本消息处理不完整
`/help` 中声明支持"发送文件"和"链接"，但 `bot.on('message')` 处理器明确只接受文本消息，其他类型消息会收到"暂不支持"的提示。

#### 问题 7: Gateway URL 默认值不一致
- `openclawClient.js` 构造函数默认值: `http://localhost:18789`
- `index.js` 传入值: `process.env.OPENCLAW_GATEWAY || 'http://localhost:3000'`
- `.env.example` 示例值: `http://localhost:3000`

虽然 `index.js` 的值会覆盖构造函数默认值，但代码存在误导性。

#### 问题 8: PORT 环境变量无效
`.env.example` 中声明了 `PORT=3001`，但代码中没有任何 Express 服务器启动逻辑，`PORT` 变量未被使用。

#### 问题 9: 技能安装仅记录在文件系统
`installed_skills` 数据库表存在，但 `handleSkillInstall()` 方法仅调用 `openclaw.installSkill()`，并未将技能记录写入数据库。`/skills` 命令从文件系统 `skills/` 目录读取已安装技能，与数据库不同步。

### 6.3 代码质量问题

#### 问题 10: 错误处理不够健壮
- `sendLongMessage()` 使用 Markdown 解析，但未处理 Markdown 格式错误导致的 Telegram API 报错
- `updateUser()` 方法在 `lastActive` 传入时会额外拼接一个 `last_active = datetime('now')`，导致 SQL 参数绑定可能出问题（`values` 数组中已有 `lastActive` 的值，但 `WHERE` 子句前又多了一个无参数的字段）
- 数据库操作均为同步调用但方法签名标注为 `async`，不影响功能但有误导性

#### 问题 11: 日志系统缺失
声明了 `winston` 依赖但完全未使用，所有日志通过 `console.log/error` 输出，无日志级别、无日志文件写入、无结构化日志。

#### 问题 12: 无优雅退出处理
`index.js` 中 `bot.launch()` 后无 SIGINT/SIGTERM 处理（`bot.js` 中有但未接入），强制退出可能导致数据库写入不完整。

#### 问题 13: SQL 注入风险
`database.js` 的 `getUsageStats()` 方法使用模板字符串拼接 `days` 参数到 SQL 中：
```javascript
WHERE telegram_id = ? AND date >= date('now', '-${days} days')
```
虽然当前调用场景中 `days` 为数字，但缺乏类型校验。

---

## 七、数据流图

```
用户发送消息 (Telegram)
        │
        ▼
  Telegraf 接收 Update
        │
        ▼
  ┌─────────────────────────┐
  │      用户中间件           │
  │  1. getUser / createUser │
  │  2. 创建工作空间          │
  │  3. 更新 last_active     │
  │  4. 加载配额信息          │
  └─────────────────────────┘
        │
        ▼
  ┌─────────────────────────┐
  │    消息类型判断           │
  │  命令 → 对应处理器       │
  │  文本 → 继续处理         │
  │  其他 → 拒绝             │
  └─────────────────────────┘
        │
        ▼
  ┌─────────────────────────┐
  │    配额检查              │
  │  remaining <= 0 → 拒绝  │
  └─────────────────────────┘
        │
        ▼
  ┌─────────────────────────┐
  │  OpenClaw Gateway       │
  │  JSON-RPC: agent        │
  │  ┌─────────────────┐    │
  │  │ 成功 → 返回结果  │    │
  │  │ 连接失败 → 模拟  │    │
  │  └─────────────────┘    │
  └─────────────────────────┘
        │
        ▼
  ┌─────────────────────────┐
  │    后处理               │
  │  1. 记录 Token 消耗     │
  │  2. 消息计数 +1         │
  │  3. 分段发送回复         │
  └─────────────────────────┘
```

---

## 八、环境变量一览

| 变量 | 说明 | 必填 | 默认值 |
|------|------|:----:|--------|
| `BOT_TOKEN` | Telegram Bot Token | ✅ | 无 |
| `OPENCLAW_GATEWAY` | OpenClaw Gateway URL | ❌ | `http://localhost:3000` |
| `OPENCLAW_API_KEY` | OpenClaw API Key | ❌ | 无 |
| `WORKSPACE_BASE` | 工作空间根目录 | ❌ | `~/.openclaw/multiuser-workspaces` |
| `DB_PATH` | SQLite 数据库路径 | ❌ | `./data/multiuser.db` |
| `ADMIN_IDS` | 管理员 Telegram ID（逗号分隔） | ❌ | 空 |
| `PORT` | 服务端口 | ❌ | **未使用** |

---

## 九、开发完成度评估

### 已完成的功能 ✅

- [x] 项目基本骨架和启动流程
- [x] SQLite 数据库设计和初始化
- [x] 用户自动注册（首次消息时创建）
- [x] 每用户独立文件系统工作空间
- [x] Token 配额系统（总量 + 每日限制）
- [x] 多等级配额配置（free/basic/pro/vip/unlimited）
- [x] OpenClaw Gateway JSON-RPC 客户端
- [x] Gateway 不可用时的模拟响应降级
- [x] Bot 基础命令（/start, /status, /skills, /reset, /help）
- [x] 重置工作空间（带确认交互）
- [x] 长消息分段发送
- [x] 管理员面板基础展示（/admin）
- [x] CLI 管理工具（scripts/admin.js）
- [x] 项目初始化脚本（scripts/setup.js）

### 未完成 / 需修复的功能 ❌

- [ ] 封禁用户功能（数据库有字段，但中间件未检查）
- [ ] 管理员子命令（/admin_quota, /admin_ban, /admin_info 未注册）
- [ ] 技能安装与数据库同步（installed_skills 表未被写入）
- [ ] 非文本消息处理（文件、图片、链接等）
- [ ] 日志系统（winston 已引入但未使用）
- [ ] Express HTTP 服务器（依赖已声明但未使用，可能计划用于 Webhook 或管理 API）
- [ ] 优雅退出（SIGINT/SIGTERM 处理）
- [ ] config.json 动态配置加载
- [ ] 两套架构的整合或清理
- [ ] 单元测试 / 集成测试
- [ ] Docker 容器化部署
- [ ] Webhook 模式支持（当前仅长轮询）
- [ ] 用户等级付费升级流程（/quota 命令在 bot.js 中有原型但未接入）
- [ ] 会话超时和清理机制
- [ ] 速率限制 / 防刷机制

### 完成度估计: **约 50-60%**

核心骨架已搭建完毕，基本的用户注册、消息转发、配额管理功能可用。但管理功能不完整、两套架构未整合、多处声明的功能未实现、缺少生产环境所需的日志/测试/部署/安全措施。

---

## 十、改进建议

### 优先级 P0（必须修复）

1. **移除或整合 `server/bot.js` 和 `server/services/`** — 避免维护混乱
2. **实现封禁检查** — 在中间件中加入 `is_banned` 判断
3. **注册管理员子命令** — 实现 `/admin_quota`、`/admin_ban`、`/admin_info`
4. **添加优雅退出** — 处理 SIGINT/SIGTERM 信号

### 优先级 P1（应当完善）

5. **集成 winston 日志系统** — 替换所有 `console.log`
6. **从 config.json 读取配置** — 等级配置不应硬编码
7. **修复 SQL 注入隐患** — 参数化 `getUsageStats` 中的 `days` 参数
8. **清理未使用的依赖** — 移除 `express`、`uuid` 的无效 require，或实现对应功能
9. **sendLongMessage Markdown 降级** — Markdown 解析失败时回退到纯文本

### 优先级 P2（建议实现）

10. **添加 Webhook 模式** — 利用已声明的 Express 实现 Webhook 接收
11. **实现非文本消息处理** — 文件上传、图片分析等
12. **添加自动化测试** — 至少覆盖数据库和配额管理逻辑
13. **Docker 化** — 添加 Dockerfile 和 docker-compose.yml
14. **会话管理** — 实现不活跃会话的自动清理
15. **速率限制** — 防止单用户频繁请求

---

## 十一、总结

本项目是一个设计思路清晰但开发尚未完成的多租户 Telegram AI Bot。核心架构——用户隔离、独立工作空间、Token 配额系统、OpenClaw 集成——已经基本成型，具备最小可运行的原型能力。

主要遗留问题在于：存在两套并行的未整合实现、多项声明的功能未实际接入、缺少生产部署必需的日志/测试/安全措施。建议先清理架构（移除未使用代码），再逐步完善管理功能和生产级特性。
