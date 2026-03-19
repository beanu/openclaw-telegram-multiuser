/**
 * OpenClaw Multi-Tenant Telegram Bot
 * 
 * Architecture:
 * - Single Telegram Bot shared by all users
 * - Each user gets isolated workspace and OpenClaw session
 * - Routes messages to OpenClaw Gateway API
 * - Tracks token usage per user
 */

const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const path = require('path');
const fs = require('fs-extra');
const Database = require('./database');
const WorkspaceManager = require('./workspaceManager');
const TokenQuotaManager = require('./tokenQuotaManager');
const OpenClawClient = require('./openclawClient');

class MultiTenantBot {
  constructor() {
    // 配置
    this.config = {
      botToken: process.env.BOT_TOKEN,
      openclawGateway: process.env.OPENCLAW_GATEWAY || 'http://localhost:3000',
      openclawApiKey: process.env.OPENCLAW_API_KEY,
      workspaceBase: process.env.WORKSPACE_BASE || path.join(process.env.HOME || '/root', '.openclaw/multiuser-workspaces'),
      dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'multiuser.db'),
      adminIds: (process.env.ADMIN_IDS || '').split(',').filter(Boolean).map(Number)
    };

    // 初始化组件 (数据库和配额管理器在 start() 中初始化)
    this.bot = new Telegraf(this.config.botToken);
    this.db = new Database(this.config.dbPath);
    this.workspace = new WorkspaceManager(this.config.workspaceBase);
    this.quota = null; // 在 initialize 后创建
    this.openclaw = new OpenClawClient(this.config.openclawGateway, this.config.openclawApiKey);

    // 用户会话缓存
    this.userSessions = new Map();

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
      
      // 获取或创建用户
      let user = await this.db.getUser(userId);
      if (!user) {
        user = await this.db.createUser({
          telegramId: userId,
          username: ctx.from.username,
          firstName: ctx.from.first_name,
          lastName: ctx.from.last_name
        });

        // 创建工作空间
        await this.workspace.create(userId);
        
        console.log(`[NEW USER] ${userId} (@${ctx.from.username})`);
      }

      // 更新最后活跃时间
      await this.db.updateUser(userId, { lastActive: new Date().toISOString() });

      // 检查配额
      const quotaInfo = await this.quota.getQuotaInfo(userId);

      // 附加到上下文
      ctx.state.user = user;
      ctx.state.quota = quotaInfo;
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

    // 处理普通消息
    this.bot.on('message', async (ctx) => {
      // 跳过非文本消息的简单处理
      if (!ctx.message.text) {
        return ctx.reply('⚠️ 暂不支持处理此类型消息，请发送文本。');
      }

      const userId = ctx.from.id;
      const text = ctx.message.text;

      // 检查配额
      if (ctx.state.quota.remaining <= 0) {
        return ctx.reply('❌ 你的 Token 配额已用完，请联系管理员充值。');
      }

      // 检查是否是安装技能命令
      if (text.toLowerCase().startsWith('install skill ')) {
        const skillName = text.slice(14).trim();
        return this.handleSkillInstall(ctx, skillName);
      }

      // 发送"正在处理"提示
      const processingMsg = await ctx.reply('🤖 正在处理中...');

      try {
        // 发送到 OpenClaw 处理
        const response = await this.openclaw.chat(userId, text, {
          workspacePath: ctx.state.workspacePath,
          user: ctx.state.user
        });

        // 删除处理提示
        await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id).catch(() => {});

        // 记录使用量
        await this.quota.consumeTokens(userId, response.tokensUsed || 0);
        await this.db.incrementMessageCount(userId);

        // 发送回复
        if (response.text) {
          // 长消息分段发送
          await this.sendLongMessage(ctx, response.text);
        }

      } catch (error) {
        console.error(`[ERROR] User ${userId}:`, error.message);
        
        await ctx.telegram.deleteMessage(ctx.chat.id, processingMsg.message_id).catch(() => {});
        
        await ctx.reply(
          `❌ 处理失败: ${error.message}\n\n` +
          `请稍后重试，如果问题持续请联系管理员。`
        );
      }
    });
  }

  // ==================== 回调处理 ====================

  setupErrorHandling() {
    // 确认重置
    this.bot.action('confirm_reset', async (ctx) => {
      await ctx.answerCbQuery();
      const userId = ctx.from.id;

      // 重置工作空间
      await this.workspace.reset(userId);
      await this.db.clearHistory(userId);

      await ctx.editMessageText('✅ 工作空间已重置完成！');
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

  async handleSkillInstall(ctx, skillName) {
    const userId = ctx.from.id;
    const workspacePath = ctx.state.workspacePath;

    try {
      // 调用 OpenClaw 安装技能
      await this.openclaw.installSkill(userId, skillName, workspacePath);
      
      await ctx.reply(`✅ 技能 \`${skillName}\` 安装成功！`, { parse_mode: 'Markdown' });
    } catch (error) {
      await ctx.reply(`❌ 技能安装失败: ${error.message}`);
    }
  }

  async sendLongMessage(ctx, text, maxLength = 4000) {
    if (text.length <= maxLength) {
      return ctx.reply(text, { parse_mode: 'Markdown' });
    }

    // 分段发送
    const parts = [];
    let remaining = text;
    
    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        parts.push(remaining);
        break;
      }

      // 找到合适的分割点
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
      await ctx.reply(part, { parse_mode: 'Markdown' });
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
    console.log(`🔗 OpenClaw gateway: ${this.config.openclawGateway}`);

    // 启动 bot (这个会阻塞，保持长轮询)
    await this.bot.launch();
  }
}

// 启动
async function main() {
  require('dotenv').config();
  
  const bot = new MultiTenantBot();
  await bot.start();
}

main().catch(console.error);
