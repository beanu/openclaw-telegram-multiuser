/**
 * Token Quota Manager
 * 
 * 管理每个用户的 Token 配额
 */

class TokenQuotaManager {
  constructor(db) {
    this.db = db;
    
    // 配额等级配置
    this.tiers = {
      free: {
        daily: 10000,      // 每日 10K
        total: 100000      // 总量 100K
      },
      basic: {
        daily: 50000,      // 每日 50K
        total: 500000      // 总量 500K
      },
      pro: {
        daily: 200000,     // 每日 200K
        total: 2000000     // 总量 2M
      },
      vip: {
        daily: 1000000,    // 每日 1M
        total: 10000000    // 总量 10M
      },
      unlimited: {
        daily: Infinity,
        total: Infinity
      }
    };
  }

  /**
   * 获取用户配额信息
   */
  async getQuotaInfo(telegramId) {
    let quota = this.db.getQuota(telegramId);
    
    // 如果不存在，创建默认配额
    if (!quota) {
      this.db.createQuota(telegramId);
      quota = this.db.getQuota(telegramId);
    }

    // 检查是否需要重置每日配额
    const today = new Date().toISOString().split('T')[0];
    if (quota.daily_reset_date !== today) {
      this.db.resetDailyQuotaForUser(telegramId, today);
      quota.daily_used = 0;
    }

    // 获取用户等级
    const user = this.db.getUser(telegramId);
    const tier = user?.tier || 'free';
    const tierConfig = this.tiers[tier] || this.tiers.free;

    // 计算剩余配额
    const totalRemaining = tierConfig.total === Infinity 
      ? Infinity 
      : Math.max(0, tierConfig.total - quota.used_quota);
    
    const dailyRemaining = tierConfig.daily === Infinity
      ? Infinity
      : Math.max(0, tierConfig.daily - quota.daily_used);

    // 获取今日使用详情
    const todayUsage = this.db.getTodayUsage(telegramId);

    return {
      tier,
      tierConfig,
      total: tierConfig.total,
      used: quota.used_quota,
      remaining: totalRemaining,
      dailyLimit: tierConfig.daily,
      dailyUsed: quota.daily_used,
      dailyRemaining: dailyRemaining,
      todayTokens: todayUsage?.tokens_used || 0,
      todayMessages: todayUsage?.message_count || 0
    };
  }

  /**
   * 消耗 Token
   */
  async consumeTokens(telegramId, tokens) {
    const quotaInfo = await this.getQuotaInfo(telegramId);
    
    // 检查总配额
    if (quotaInfo.remaining !== Infinity && quotaInfo.remaining < tokens) {
      throw new Error(`配额不足。剩余: ${quotaInfo.remaining}, 需要: ${tokens}`);
    }

    // 检查每日配额
    if (quotaInfo.dailyRemaining !== Infinity && quotaInfo.dailyRemaining < tokens) {
      throw new Error(`今日配额不足。剩余: ${quotaInfo.dailyRemaining}, 需要: ${tokens}`);
    }

    // 记录使用
    this.db.recordTokenUsage(telegramId, tokens);

    return {
      consumed: tokens,
      remaining: quotaInfo.remaining === Infinity 
        ? Infinity 
        : quotaInfo.remaining - tokens,
      dailyRemaining: quotaInfo.dailyRemaining === Infinity
        ? Infinity
        : quotaInfo.dailyRemaining - tokens
    };
  }

  /**
   * 增加配额（管理员操作）
   */
  async addQuota(telegramId, amount, type = 'total') {
    if (type === 'total') {
      this.db.addQuota(telegramId, amount);
    } else if (type === 'daily') {
      // 减少今日已用量 = 增加今日可用量
      this.db.decreaseDailyUsed(telegramId, amount);
    }

    return this.getQuotaInfo(telegramId);
  }

  /**
   * 升级用户等级
   */
  async upgradeTier(telegramId, newTier) {
    if (!this.tiers[newTier]) {
      throw new Error(`无效的等级: ${newTier}. 可选: ${Object.keys(this.tiers).join(', ')}`);
    }

    this.db.updateUser(telegramId, { tier: newTier });

    return this.getQuotaInfo(telegramId);
  }

  /**
   * 检查配额是否足够
   */
  async hasEnoughQuota(telegramId, tokens) {
    const quotaInfo = await this.getQuotaInfo(telegramId);
    
    const totalOk = quotaInfo.remaining === Infinity || quotaInfo.remaining >= tokens;
    const dailyOk = quotaInfo.dailyRemaining === Infinity || quotaInfo.dailyRemaining >= tokens;
    
    return {
      ok: totalOk && dailyOk,
      totalOk,
      dailyOk,
      remaining: quotaInfo.remaining,
      dailyRemaining: quotaInfo.dailyRemaining
    };
  }

  /**
   * 获取使用统计
   */
  async getUsageStats(telegramId, days = 30) {
    return this.db.getUsageStats(telegramId, days);
  }

  /**
   * 重置用户配额（管理员操作）
   */
  async resetQuota(telegramId) {
    this.db.resetUserQuota(telegramId);
    return this.getQuotaInfo(telegramId);
  }

  /**
   * 获取等级配置
   */
  getTierConfig(tier) {
    return this.tiers[tier] || this.tiers.free;
  }

  /**
   * 获取所有等级
   */
  getAllTiers() {
    return Object.entries(this.tiers).map(([name, config]) => ({
      name,
      daily: config.daily,
      total: config.total,
      dailyFormatted: config.daily === Infinity ? '无限' : this.formatNumber(config.daily),
      totalFormatted: config.total === Infinity ? '无限' : this.formatNumber(config.total)
    }));
  }

  formatNumber(num) {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toString();
  }
}

module.exports = TokenQuotaManager;
