# OpenClaw Multi-Tenant Telegram Bot

多租户 Telegram Bot，为每个用户提供独立的 OpenClaw 工作空间。

## 架构

```
┌─────────────────────────────────────────┐
│         Telegram Bot (共用)              │
│         @your_bot_name                   │
└─────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────┐
│         用户识别层 (user_id)             │
│         Middleware 拦截                   │
└─────────────────────────────────────────┘
                    │
        ┌───────────┼───────────┐
        ▼           ▼           ▼
   ┌─────────┐ ┌─────────┐ ┌─────────┐
   │ User A  │ │ User B  │ │ User C  │
   │ 123456  │ │ 789012  │ │ 345678  │
   └─────────┘ └─────────┘ └─────────┘
        │           │           │
        ▼           ▼           ▼
   ┌─────────┐ ┌─────────┐ ┌─────────┐
   │workspace│ │workspace│ │workspace│
   │ /user_A │ │ /user_B │ │ /user_C │
   └─────────┘ └─────────┘ └─────────┘
        │           │           │
        └───────────┼───────────┘
                    ▼
         ┌──────────────────┐
         │  OpenClaw API    │
         │  (Gateway)       │
         └──────────────────┘
```

## 特性

- ✅ **用户隔离** - 每个用户独立工作空间
- ✅ **配额控制** - Token 使用量统计和限制
- ✅ **技能系统** - 可安装各种扩展技能
- ✅ **多等级** - Free/Basic/Pro/VIP 等级
- ✅ **管理面板** - 用户管理和统计

## 快速开始

### 1. 安装依赖

```bash
cd openclaw-telegram-multiuser
npm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env 填入配置
```

### 3. 运行设置脚本

```bash
npm run setup
```

### 4. 启动服务

```bash
npm start
```

## 配置

### 环境变量

| 变量 | 说明 | 必填 |
|------|------|------|
| `BOT_TOKEN` | Telegram Bot Token | ✅ |
| `OPENCLAW_GATEWAY` | OpenClaw Gateway URL | ❌ |
| `OPENCLAW_API_KEY` | OpenClaw API Key | ❌ |
| `WORKSPACE_BASE` | 工作空间根目录 | ❌ |
| `DB_PATH` | 数据库路径 | ❌ |
| `ADMIN_IDS` | 管理员 ID (逗号分隔) | ❌ |

### Token 配额等级

| 等级 | 每日限额 | 总限额 |
|------|---------|--------|
| free | 10K | 100K |
| basic | 50K | 500K |
| pro | 200K | 2M |
| vip | 1M | 10M |
| unlimited | 无限 | 无限 |

## 使用方法

### 用户命令

| 命令 | 说明 |
|------|------|
| `/start` | 开始使用 |
| `/status` | 查看状态和配额 |
| `/skills` | 技能管理 |
| `/reset` | 重置工作空间 |
| `/help` | 帮助信息 |

### 管理员命令

| 命令 | 说明 |
|------|------|
| `/admin` | 管理面板 |

或使用 CLI:

```bash
npm run admin
```

## 项目结构

```
openclaw-telegram-multiuser/
├── server/
│   ├── index.js              # 主入口
│   ├── database.js           # 数据库管理
│   ├── workspaceManager.js   # 工作空间管理
│   ├── tokenQuotaManager.js  # 配额管理
│   └── openclawClient.js     # OpenClaw 客户端
├── scripts/
│   ├── setup.js              # 初始化脚本
│   └── admin.js              # 管理脚本
├── data/                     # 数据目录
├── .env.example
└── package.json
```

## 与 OpenClaw 集成

### 方式1: Gateway API

如果 OpenClaw Gateway 运行中，会自动通过 API 处理消息。

### 方式2: 模拟模式

Gateway 不可用时，会返回模拟响应（用于测试）。

### 方式3: 直接集成

可以修改 `openclawClient.js` 直接调用 OpenClaw SDK。

## 开发

```bash
# 开发模式（自动重启）
npm run dev

# 查看日志
tail -f data/multiuser.db

# 管理用户
npm run admin
```

## 许可证

MIT
