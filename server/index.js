/**
 * OpenClaw Multi-Tenant Telegram Bot
 * 
 * Architecture:
 * - Single Telegram Bot shared by all users
 * - Each user gets isolated workspace and OpenClaw session
 * - Routes messages to OpenClaw Gateway API
 * - Tracks token usage per user
 */

const { Telegraf } = require('telegraf');
const path = require('path');
const Database = require('./database');
const WorkspaceManager = require('./workspaceManager');
const TokenQuotaManager = require('./tokenQuotaManager');
const OpenClawClient = require('./openclawClient');
const AgentManager = require('./agentManager');
const StreamHandler = require('./streamHandler');
const RateLimiter = require('./rateLimiter');

class MultiTenantBot {
  constructor() {
    const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL || 'http://localhost:18789';
    const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN || '';
    const gatewayWsUrl = gatewayUrl.replace(/^http/, 'ws');

    this.config = {
      botToken: process.env.BOT_TOKEN,
      openclawGatewayUrl: gatewayUrl,
      openclawGatewayToken: gatewayToken,
      openclawGatewayWsUrl: gatewayWsUrl,
      workspaceBase: process.env.WORKSPACE_BASE || path.join(process.env.HOME || '/root', '.openclaw/multiuser-workspaces'),
      dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'multiuser.db'),
      adminIds: (process.env.ADMIN_IDS || '').split(',').filter(Boolean).map(Number),
      enableStreaming: (process.env.ENABLE_STREAMING || 'true').toLowerCase() !== 'false'
    };

    this.bot = new Telegraf(this.config.botToken);
    this.db = new Database(this.config.dbPath);
    this.workspace = new WorkspaceManager(this.config.workspaceBase);
    this.quota = null;
    this.openclaw = new OpenClawClient({
      gatewayUrl: this.config.openclawGatewayUrl,
      gatewayToken: this.config.openclawGatewayToken
    });
    this.agentManager = new AgentManager({
      gatewayWsUrl: this.config.openclawGatewayWsUrl,
      gatewayToken: this.config.openclawGatewayToken,
      workspaceBase: this.config.workspaceBase
    });
    this.streamHandler = new StreamHandler();
    this.rateLimiter = new RateLimiter();

    this.setupMiddleware();
    this.setupCommands();
    this.setupErrorHandling();
  }

  // ==================== 中间件 ====================

  setupMiddleware() {
    // 用户初始化中间件
    this.bot.use(async (ctx, next) => {
      if (!ctx.from) return next();

      const userId = ctx.from.id;
      
      let user = await this.db.getUser(userId);
      if (!user) {
        user = await this.db.createUser({
          telegramId: userId,
          username: ctx.from.username,
          firstName: ctx.from.first_name,
          lastName: ctx.from.last_name
        });

        const agentId = `user_${userId}`;
        try {
          await this.agentManager.createAgent(agentId);
        } catch (err) {
          console.error(`[AGENT] Failed to provision agent for new user ${userId}:`, err.message);
        }
        this.db.setAgentId(userId, agentId);

        console.log(`[NEW USER] ${userId} (@${ctx.from.username}) agent=${agentId}`);
      }

      if (user && user.is_banned) {
        return ctx.reply('❌ 你的账号已被封禁，请联系管理员。');
      }

      await this.db.updateUser(userId, { lastActive: new Date().toISOString() });

      const quotaInfo = await this.quota.getQuotaInfo(userId);
      const agentId = user.agent_id || this.db.getAgentId(userId) || `user_${userId}`;

      ctx.state.user = user;
      ctx.state.quota = quotaInfo;
      ctx.state.agentId = agentId;
      ctx.state.workspacePath = this.workspace.getPath(userId);

      return next();
    });
  }

  // ==================== 命令 ====================

  setupCommands() {
    // /start - 欢迎
    this.bot.command('start', async (ctx) => {
      const user = ctx.state.user;
      const quota = ctx.state.quota;

      await ctx.reply(
        `🚀 *欢迎使用 OpenClaw 分身！*\n\n` +
        `👤 用户ID: \`${ctx.from.id}\`\n` +
        `💰 Token 配额: ${this.formatNumber(quota.remaining)} / ${this.formatNumber(quota.total)}\n\n` +
        `✨ *功能特点：*\n` +
        `• 📁 独立工作空间 - 你的数据完全隔离\n` +
        `• 🔒 隐私保护 - 只有你能访问你的对话\n` +
        `• 🤖 AI 助手 - 智能对话、代码、分析\n` +
        `• 🛠️ 技能系统 - 可安装各种扩展技能\n\n` +
        `📝 *常用命令：*\n` +
        `/status - 查看状态和配额\n` +
        `/skills - 管理技能\n` +
        `/reset - 重置工作空间\n` +
        `/help - 帮助信息\n\n` +
        `直接发送消息即可开始对话！`,
        { parse_mode: 'Markdown' }
      );
    });

    // /status - 状态
    this.bot.command('status', async (ctx) => {
      const user = ctx.state.user;
      const quota = ctx.state.quota;
      const workspace = await this.workspace.getInfo(ctx.from.id);

      await ctx.reply(
        `📊 *你的状态*\n\n` +
        `👤 用户ID: \`${ctx.from.id}\`\n` +
        `📅 注册时间: ${new Date(user.createdAt).toLocaleDateString('zh-CN')}\n` +
        `⏰ 最后活跃: ${new Date(user.lastActive).toLocaleString('zh-CN')}\n\n` +
        `📁 *工作空间*\n` +
        `• 路径: \`${workspace.shortPath}\`\n` +
        `• 大小: ${workspace.size}\n` +
        `• 文件数: ${workspace.fileCount}\n\n` +
        `💰 *Token 配额*\n` +
        `• 总量: ${this.formatNumber(quota.total)}\n` +
        `• 已用: ${this.formatNumber(quota.used)}\n` +
        `• 剩余: ${this.formatNumber(quota.remaining)}\n` +
        `• 今日: ${this.formatNumber(quota.dailyUsed)} / ${this.formatNumber(quota.dailyLimit)}\n\n` +
        `📝 *消息统计*\n` +
        `• 总消息数: ${user.messageCount || 0}\n` +
        `• 会话数: ${user.sessionCount || 0}`,
        { parse_mode: 'Markdown' }
      );
    });

    // /skills - 技能管理
    this.bot.command('skills', async (ctx) => {
      const workspace = await this.workspace.getInfo(ctx.from.id);
      
      await ctx.reply(
        `🛠️ *技能管理*\n\n` +
        `当前已安装技能:\n` +
        (workspace.skills.length > 0 
          ? workspace.skills.map(s => `• ${s}`).join('\n')
          : '• 无（发送技能名称安装）') +
        `\n\n` +
        `📝 *安装技能：*\n` +
        `发送 \`install skill <技能名>\`\n\n` +
        `📦 *可用技能：*\n` +
        `• binance-spot - 币安现货交易\n` +
        `• okx-dex-swap - OKX DEX 兑换\n` +
        `• crypto-price - 加密货币价格\n` +
        `• weather - 天气查询`,
        { parse_mode: 'Markdown' }
      );
    });

    // /reset - 重置工作空间
    this.bot.command('reset', async (ctx) => {
      await ctx.reply(
        '⚠️ *确认重置*\n\n这将清除所有数据，包括：\n• 对话历史\n• 已安装技能\n• 自定义配置\n\n确定要重置吗？',
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '✅ 确认重置', callback_data: 'confirm_reset' }],
              [{ text: '❌ 取消', callback_data: 'cancel_reset' }]
            ]
          }
        }
      );
    });

    // /help - 帮助
    this.bot.command('help', async (ctx) => {
      await ctx.reply(
        `❓ *帮助中心*\n\n` +
        `*基础命令：*\n` +
        `/start - 开始使用\n` +
        `/status - 查看状态\n` +
        `/skills - 技能管理\n` +
        `/reset - 重置工作空间\n` +
        `/help - 显示帮助\n\n` +
        `*高级功能：*\n` +
        `• 发送文件 - AI 可以分析和处理\n` +
        `• 代码块 - AI 可以编写和解释代码\n` +
        `• 链接 - AI 可以获取网页内容\n\n` +
        `*配额说明：*\n` +
        `• 免费用户: 10K/天, 100K 总量\n` +
        `• 升级配额请联系管理员\n\n` +
        `*隐私说明：*\n` +
        `• 每个用户的数据完全隔离\n` +
        `• 对话记录仅你自己可见\n` +
        `• 工作空间独立存储`,
        { parse_mode: 'Markdown' }
      );
    });

    // /admin - 管理员命令
    this.bot.command('admin', async (ctx) => {
      if (!this.config.adminIds.includes(ctx.from.id)) {
        return ctx.reply('❌ 无权限');
      }

      const stats = await this.db.getGlobalStats();

      await ctx.reply(
        `🔧 *管理员面板*\n\n` +
        `👥 *用户统计*\n` +
        `• 总用户数: ${stats.totalUsers}\n` +
        `• 活跃用户(7天): ${stats.activeUsers}\n` +
        `• 今日活跃: ${stats.todayActive}\n\n` +
        `📊 *使用统计*\n` +
        `• 总消息数: ${this.formatNumber(stats.totalMessages)}\n` +
        `• 总Token消耗: ${this.formatNumber(stats.totalTokens)}\n` +
        `• 今日消息: ${this.formatNumber(stats.todayMessages)}\n\n` +
        `*管理员命令：*\n` +
        `/admin_quota <user_id> <amount> - 增加配额\n` +
        `/admin_ban <user_id> - 封禁用户\n` +
        `/admin_info <user_id> - 查看用户详情`,
        { parse_mode: 'Markdown' }
      );
    });

    // /admin_quota - 增加配额
    this.bot.command('admin_quota', async (ctx) => {
      if (!this.config.adminIds.includes(ctx.from.id)) {
        return ctx.reply('❌ 无权限');
      }

      const args = (ctx.message.text || '').split(/\s+/).slice(1);
      if (args.length < 2) {
        return ctx.reply('用法: /admin_quota <user_id> <amount>');
      }

      const targetId = parseInt(args[0], 10);
      const amount = parseInt(args[1], 10);
      if (isNaN(targetId) || isNaN(amount) || amount <= 0) {
        return ctx.reply('❌ 参数无效。user_id 和 amount 必须为正整数。');
      }

      const targetUser = await this.db.getUser(targetId);
      if (!targetUser) {
        return ctx.reply(`❌ 用户 ${targetId} 不存在`);
      }

      const newQuota = await this.quota.addQuota(targetId, amount);
      await ctx.reply(
        `✅ 已为用户 ${targetId} 增加 ${this.formatNumber(amount)} Token 配额\n` +
        `当前剩余: ${this.formatNumber(newQuota.remaining)}`,
      );
    });

    // /admin_ban - 封禁/解封用户
    this.bot.command('admin_ban', async (ctx) => {
      if (!this.config.adminIds.includes(ctx.from.id)) {
        return ctx.reply('❌ 无权限');
      }

      const args = (ctx.message.text || '').split(/\s+/).slice(1);
      if (args.length < 1) {
        return ctx.reply('用法: /admin_ban <user_id>');
      }

      const targetId = parseInt(args[0], 10);
      if (isNaN(targetId)) {
        return ctx.reply('❌ user_id 必须为整数');
      }

      const targetUser = await this.db.getUser(targetId);
      if (!targetUser) {
        return ctx.reply(`❌ 用户 ${targetId} 不存在`);
      }

      if (targetUser.is_banned) {
        await this.db.unbanUser(targetId);
        await ctx.reply(`✅ 用户 ${targetId} 已解封`);
      } else {
        await this.db.banUser(targetId);
        await ctx.reply(`✅ 用户 ${targetId} 已封禁`);
      }
    });

    // /admin_info - 查看用户详情
    this.bot.command('admin_info', async (ctx) => {
      if (!this.config.adminIds.includes(ctx.from.id)) {
        return ctx.reply('❌ 无权限');
      }

      const args = (ctx.message.text || '').split(/\s+/).slice(1);
      if (args.length < 1) {
        return ctx.reply('用法: /admin_info <user_id>');
      }

      const targetId = parseInt(args[0], 10);
      if (isNaN(targetId)) {
        return ctx.reply('❌ user_id 必须为整数');
      }

      const details = await this.db.getUserDetails(targetId);
      if (!details) {
        return ctx.reply(`❌ 用户 ${targetId} 不存在`);
      }

      const { user, quota, recentUsage, installedSkills } = details;
      const last7days = recentUsage.slice(0, 7);
      const recentTokens = last7days.reduce((sum, r) => sum + (r.tokens_used || 0), 0);

      await ctx.reply(
        `👤 *用户详情: ${targetId}*\n\n` +
        `用户名: @${user.username || '无'}\n` +
        `姓名: ${user.first_name || ''} ${user.last_name || ''}\n` +
        `等级: ${user.tier}\n` +
        `状态: ${user.is_banned ? '🚫 已封禁' : '✅ 正常'}\n` +
        `注册时间: ${user.created_at}\n` +
        `最后活跃: ${user.last_active}\n` +
        `消息数: ${user.message_count}\n\n` +
        `💰 *配额*\n` +
        `总量: ${this.formatNumber(quota?.total_quota || 0)}\n` +
        `已用: ${this.formatNumber(quota?.used_quota || 0)}\n` +
        `今日: ${this.formatNumber(quota?.daily_used || 0)} / ${this.formatNumber(quota?.daily_limit || 0)}\n\n` +
        `📊 *近7天 Token*: ${this.formatNumber(recentTokens)}\n` +
        `🛠️ *技能*: ${installedSkills.length > 0 ? installedSkills.join(', ') : '无'}`,
        { parse_mode: 'Markdown' }
      );
    });

    // 处理普通消息
    this.bot.on('message', async (ctx) => {
      const userId = ctx.from.id;
      const text = ctx.message.text;

      // 检查是否是安装技能命令（仅文本）
      if (text && text.toLowerCase().startsWith('install skill ')) {
        const skillName = text.slice(14).trim();
        return this.handleSkillInstall(ctx, skillName);
      }

      // 构建 OpenResponses input
      const input = await this.buildInput(ctx);
      if (input === null) {
        return ctx.reply('⚠️ 暂不支持处理此类型消息，请发送文本、图片或文档。');
      }

      // 速率限制
      const rateCheck = this.rateLimiter.canProcess(userId);
      if (!rateCheck.ok) {
        return ctx.reply(rateCheck.reason);
      }

      // 检查配额
      if (ctx.state.quota.remaining <= 0) {
        return ctx.reply('❌ 你的 Token 配额已用完，请联系管理员充值。');
      }

      // 预请求配额估算
      const inputLength = typeof input === 'string' ? input.length : JSON.stringify(input).length;
      const estimatedTokens = Math.ceil(inputLength / 2) + 500;
      const quotaCheck = await this.quota.hasEnoughQuota(userId, estimatedTokens);
      if (!quotaCheck.ok) {
        const remaining = quotaCheck.totalOk ? quotaCheck.dailyRemaining : quotaCheck.remaining;
        return ctx.reply(
          `❌ 配额不足\n\n` +
          `预计需要: ~${this.formatNumber(estimatedTokens)} tokens\n` +
          `当前剩余: ${this.formatNumber(remaining)} tokens\n\n` +
          `请联系管理员增加配额。`
        );
      }

      const agentId = ctx.state.agentId;
      const user = ctx.state.user;
      const sessionKey = `tg:${userId}:${user.session_count || 0}`;

      this.rateLimiter.startRequest(userId);

      if (this.config.enableStreaming) {
        await ctx.sendChatAction('typing');

        try {
          const stream = this.openclaw.chatStream(agentId, sessionKey, input);

          const { fullText, usage } = await this.streamHandler.handleStream(ctx, stream);

          let tokensUsed = usage?.total_tokens || 0;
          if (!tokensUsed) {
            tokensUsed = Math.ceil((inputLength + (fullText || '').length) / 2);
          }
          await this.quota.consumeTokens(userId, tokensUsed);
          await this.db.incrementMessageCount(userId);

          const inputSummary = typeof input === 'string' ? input : (input.find(i => i.text)?.text || '[media]');
          this.db.recordMessage(userId, 'user', inputSummary, 0, null, sessionKey);
          this.db.recordMessage(userId, 'assistant', fullText, tokensUsed, 'openclaw', sessionKey);

        } catch (error) {
          console.error(`[ERROR] User ${userId} (stream):`, error.message);
          await ctx.reply(
            `❌ 处理失败: ${error.message}\n\n` +
            `请稍后重试，如果问题持续请联系管理员。`
          );
        } finally {
          this.rateLimiter.endRequest(userId);
        }
      } else {
        const processingMsg = await ctx.reply('🤖 正在处理中...');

        try {
          const response = await this.openclaw.chat(agentId, sessionKey, input);

          await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id).catch(() => {});

          let tokensUsed = response.tokensUsed || 0;
          if (!tokensUsed) {
            tokensUsed = Math.ceil((inputLength + (response.text || '').length) / 2);
          }
          await this.quota.consumeTokens(userId, tokensUsed);
          await this.db.incrementMessageCount(userId);

          const inputSummary = typeof input === 'string' ? input : (input.find(i => i.text)?.text || '[media]');
          this.db.recordMessage(userId, 'user', inputSummary, 0, null, sessionKey);
          this.db.recordMessage(userId, 'assistant', response.text, tokensUsed, response.model, sessionKey);

          if (response.text) {
            await this.sendLongMessage(ctx, response.text);
          }

        } catch (error) {
          console.error(`[ERROR] User ${userId}:`, error.message);
          await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id).catch(() => {});
          await ctx.reply(
            `❌ 处理失败: ${error.message}\n\n` +
            `请稍后重试，如果问题持续请联系管理员。`
          );
        } finally {
          this.rateLimiter.endRequest(userId);
        }
      }
    });
  }

  // ==================== 回调处理 ====================

  setupErrorHandling() {
    // 确认重置
    this.bot.action('confirm_reset', async (ctx) => {
      await ctx.answerCbQuery();
      const userId = ctx.from.id;

      await this.workspace.reset(userId);
      await this.db.clearHistory(userId);

      const user = this.db.getUser(userId);
      const newCount = (user.session_count || 0) + 1;
      this.db.updateUser(userId, { sessionCount: newCount });

      await ctx.editMessageText(
        `✅ 工作空间已重置完成！\n会话已刷新 (session #${newCount})`
      );
    });

    // 取消重置
    this.bot.action('cancel_reset', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageText('❌ 已取消重置');
    });

    // 全局错误处理
    this.bot.catch((err, ctx) => {
      console.error(`[BOT ERROR]`, err);
      ctx.reply('❌ 系统错误，请稍后重试').catch(() => {});
    });
  }

  // ==================== 辅助方法 ====================

  /**
   * Convert a Telegram message into an OpenResponses `input` value.
   * Returns a string for plain text, an array of input items for media,
   * or null if the message type is unsupported.
   */
  async buildInput(ctx) {
    const msg = ctx.message;

    if (msg.text) {
      return msg.text;
    }

    if (msg.photo) {
      const photo = msg.photo[msg.photo.length - 1];
      const fileLink = await ctx.telegram.getFileLink(photo.file_id);
      const items = [
        { type: 'input_image', image_url: fileLink.href }
      ];
      if (msg.caption) {
        items.push({ type: 'input_text', text: msg.caption });
      }
      return items;
    }

    if (msg.document) {
      const mime = msg.document.mime_type || '';
      const supportedMimes = [
        'text/plain', 'text/markdown', 'text/html', 'text/csv',
        'application/json', 'application/pdf'
      ];
      const isSupported = supportedMimes.includes(mime) || mime.startsWith('image/');
      if (!isSupported) {
        return null;
      }

      const fileLink = await ctx.telegram.getFileLink(msg.document.file_id);
      const filename = msg.document.file_name || 'file';

      if (mime.startsWith('image/')) {
        const items = [
          { type: 'input_image', image_url: fileLink.href }
        ];
        if (msg.caption) {
          items.push({ type: 'input_text', text: msg.caption });
        }
        return items;
      }

      const items = [
        { type: 'input_file', filename, file_url: fileLink.href }
      ];
      if (msg.caption) {
        items.push({ type: 'input_text', text: msg.caption });
      }
      return items;
    }

    return null;
  }

  async handleSkillInstall(ctx, skillName) {
    // Skill installation is now managed by OpenClaw agent workspaces.
    // This handler is kept as a placeholder for future implementation.
    await ctx.reply(`⚠️ 技能安装功能正在迁移中，请稍后再试。`);
  }

  async sendLongMessage(ctx, text, maxLength = 4000) {
    if (text.length <= maxLength) {
      try {
        return await ctx.reply(text, { parse_mode: 'Markdown' });
      } catch (e) {
        return await ctx.reply(text);
      }
    }

    const parts = [];
    let remaining = text;
    
    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        parts.push(remaining);
        break;
      }

      let splitIndex = remaining.lastIndexOf('\n\n', maxLength);
      if (splitIndex === -1 || splitIndex < maxLength / 2) {
        splitIndex = remaining.lastIndexOf('. ', maxLength);
      }
      if (splitIndex === -1 || splitIndex < maxLength / 2) {
        splitIndex = maxLength;
      } else {
        splitIndex += 2;
      }

      parts.push(remaining.slice(0, splitIndex));
      remaining = remaining.slice(splitIndex);
    }

    for (const part of parts) {
      try {
        await ctx.reply(part, { parse_mode: 'Markdown' });
      } catch (e) {
        await ctx.reply(part);
      }
    }
  }

  formatNumber(num) {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toString();
  }

  // ==================== 启动 ====================

  async start() {
    // 初始化数据库
    await this.db.initialize();

    // 初始化配额管理器 (需要数据库先初始化)
    this.quota = new TokenQuotaManager(this.db);

    // 初始化工作空间管理器
    await this.workspace.initialize();

    console.log('🤖 Multi-tenant Telegram Bot starting...');
    console.log(`📁 Workspace base: ${this.config.workspaceBase}`);
    console.log(`🔗 OpenClaw gateway: ${this.config.openclawGatewayUrl}`);
    console.log(`📡 Streaming: ${this.config.enableStreaming ? 'enabled' : 'disabled'}`);

    // 启动 bot (这个会阻塞，保持长轮询)
    await this.bot.launch();

    process.once('SIGINT', () => this.bot.stop('SIGINT'));
    process.once('SIGTERM', () => this.bot.stop('SIGTERM'));
  }
}

// 启动
async function main() {
  require('dotenv').config();
  
  const bot = new MultiTenantBot();
  await bot.start();
}

main().catch(console.error);
