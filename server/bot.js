const { Telegraf, session } = require('telegraf');
const UserManager = require('./services/userManager');
const SessionManager = require('./services/sessionManager');
const TokenQuotaManager = require('./services/tokenQuotaManager');
const WorkspaceManager = require('./services/workspaceManager');

class TelegramBot {
  constructor() {
    this.bot = new Telegraf(process.env.BOT_TOKEN);
    this.userManager = new UserManager();
    this.sessionManager = new SessionManager();
    this.quotaManager = new TokenQuotaManager();
    this.workspaceManager = new WorkspaceManager();
    
    this.setupMiddleware();
    this.setupCommands();
    this.setupActions();
  }

  // 中间件：用户隔离和配额检查
  setupMiddleware() {
    // 会话中间件 - 基于 user_id
    this.bot.use(session({
      getSessionKey: (ctx) => `tg:${ctx.from?.id}`,
      store: this.sessionManager.getStore()
    }));

    // 用户初始化中间件
    this.bot.use(async (ctx, next) => {
      if (!ctx.from) return next();
      
      const userId = ctx.from.id;
      
      // 1. 获取或创建用户
      let user = await this.userManager.getUser(userId);
      if (!user) {
        user = await this.userManager.createUser({
          telegramId: userId,
          username: ctx.from.username,
          firstName: ctx.from.first_name,
          createdAt: new Date()
        });
        
        // 2. 为用户创建独立 workspace
        await this.workspaceManager.createWorkspace(userId);
      }
      
      // 3. 检查 Token 配额
      const quota = await this.quotaManager.getQuota(userId);
      if (quota.remaining <= 0) {
        return ctx.reply('❌ 你的 Token 配额已用完，请联系管理员充值');
      }
      
      // 4. 将用户信息附加到上下文
      ctx.state.user = user;
      ctx.state.quota = quota;
      ctx.state.workspacePath = this.workspaceManager.getWorkspacePath(userId);
      
      return next();
    });

    // Token 使用统计中间件
    this.bot.use(async (ctx, next) => {
      const startTime = Date.now();
      
      await next();
      
      // 估算 Token 使用量（基于消息长度和处理时间）
      const messageLength = ctx.message?.text?.length || 0;
      const processingTime = Date.now() - startTime;
      const estimatedTokens = this.estimateTokenUsage(messageLength, processingTime);
      
      // 记录使用量
      await this.quotaManager.consumeTokens(ctx.from.id, estimatedTokens);
    });
  }

  estimateTokenUsage(messageLength, processingTime) {
    // 简化的估算模型
    const baseTokens = 100; // 系统开销
    const charTokens = Math.ceil(messageLength / 4); // 大约 4 字符 = 1 token
    const timeTokens = Math.ceil(processingTime / 100); // 处理时间开销
    return baseTokens + charTokens + timeTokens;
  }

  setupCommands() {
    // /start - 启动
    this.bot.command('start', async (ctx) => {
      const userId = ctx.from.id;
      const workspaceStatus = await this.workspaceManager.getStatus(userId);
      
      await ctx.reply(`
🚀 欢迎使用 OpenClaw 分身！

👤 你的用户ID: \`${userId}\`
📁 Workspace: ${workspaceStatus.path}
💰 Token 配额: ${ctx.state.quota.remaining}/${ctx.state.quota.total}

✨ 功能：
• 独立的工作空间
• 数据完全隔离
• 安全的对话环境

开始使用，直接发送消息给我！
      `, { parse_mode: 'Markdown' });
    });

    // /status - 查看状态
    this.bot.command('status', async (ctx) => {
      const userId = ctx.from.id;
      const quota = await this.quotaManager.getQuota(userId);
      const workspace = await this.workspaceManager.getStatus(userId);
      
      await ctx.reply(`
📊 你的状态

👤 用户ID: \`${userId}\`
📁 Workspace: \`${workspace.path}\`
💾 已用空间: ${workspace.size}

💰 Token 配额
• 总量: ${quota.total}
• 已用: ${quota.used}
• 剩余: ${quota.remaining}
• 今日: ${quota.dailyUsed}/${quota.dailyLimit}

📝 消息统计
• 总消息: ${quota.messageCount}
• 平均消耗: ${quota.avgTokensPerMessage} tokens/消息
      `, { parse_mode: 'Markdown' });
    });

    // /reset - 重置工作空间
    this.bot.command('reset', async (ctx) => {
      const userId = ctx.from.id;
      
      await ctx.reply('⚠️ 确定要重置你的工作空间吗？所有数据将被清除。', {
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ 确认重置', callback_data: 'confirm_reset' },
            { text: '❌ 取消', callback_data: 'cancel_reset' }
          ]]
        }
      });
    });

    // /quota - 充值配额
    this.bot.command('quota', async (ctx) => {
      await ctx.reply(`
💰 Token 配额充值

当前等级: ${ctx.state.quota.tier}
剩余配额: ${ctx.state.quota.remaining}

充值选项:
• 100K tokens - 0.01 ETH
• 500K tokens - 0.04 ETH  
• 1M tokens - 0.07 ETH
• 无限额度 - 0.5 ETH/月

请联系管理员充值
      `);
    });

    // 主消息处理器 - 转发到用户的独立会话
    this.bot.on('message', async (ctx) => {
      const userId = ctx.from.id;
      const messageText = ctx.message.text;
      
      // 记录用户消息
      await this.userManager.addMessage(userId, {
        role: 'user',
        content: messageText,
        timestamp: new Date()
      });
      
      // 发送到用户的独立 OpenClaw 会话
      const response = await this.sessionManager.processMessage(userId, messageText, {
        workspacePath: ctx.state.workspacePath,
        quota: ctx.state.quota
      });
      
      // 记录 AI 回复
      await this.userManager.addMessage(userId, {
        role: 'assistant',
        content: response.text,
        tokensUsed: response.tokensUsed,
        timestamp: new Date()
      });
      
      // 发送回复给用户
      await ctx.reply(response.text, {
        parse_mode: response.parseMode || 'Markdown'
      });
    });
  }

  setupActions() {
    // 确认重置
    this.bot.action('confirm_reset', async (ctx) => {
      await ctx.answerCbQuery();
      const userId = ctx.from.id;
      
      await this.workspaceManager.resetWorkspace(userId);
      await this.userManager.clearHistory(userId);
      
      await ctx.editMessageText('✅ 工作空间已重置，所有数据已清除');
    });

    // 取消重置
    this.bot.action('cancel_reset', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageText('❌ 已取消重置');
    });
  }

  async launch() {
    // 启动前初始化
    await this.workspaceManager.initialize();
    await this.sessionManager.initialize();
    
    // 启动 bot
    await this.bot.launch();
    console.log('🤖 Multi-user Telegram Bot is running...');
    
    // 优雅退出
    process.once('SIGINT', () => this.bot.stop('SIGINT'));
    process.once('SIGTERM', () => this.bot.stop('SIGTERM'));
  }
}

module.exports = TelegramBot;
