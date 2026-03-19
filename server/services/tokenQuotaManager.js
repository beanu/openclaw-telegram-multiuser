const sqlite3 = require('sqlite3').verbose();

class TokenQuotaManager {
  constructor() {
    this.dbPath = process.env.DB_PATH || './data/users.db';
    this.db = null;
    
    // 默认配额配置
    this.tiers = {
      free: { daily: 10000, total: 100000 },
      basic: { daily: 50000, total: 500000 },
      pro: { daily: 200000, total: 2000000 },
      unlimited: { daily: Infinity, total: Infinity }
    };
  }

  async initialize() {
    this.db = new sqlite3.Database(this.dbPath);
    
    // 创建配额记录表
    await this.run(`
      CREATE TABLE IF NOT EXISTS token_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id INTEGER,
        date DATE DEFAULT CURRENT_DATE,
        tokens_used INTEGER DEFAULT 0,
        message_count INTEGER DEFAULT 0,
        FOREIGN KEY (telegram_id) REFERENCES users(telegram_id)
      )
    `);

    // 创建索引
    await this.run(`
      CREATE INDEX IF NOT EXISTS idx_usage_user_date 
      ON token_usage(telegram_id, date)
    `);
  }

  run(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function(err) {
        if (err) reject(err);
        else resolve({ id: this.lastID, changes: this.changes });
      });
    });
  }

  get(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }

  async getQuota(telegramId) {
    const user = await this.get(`
      SELECT tier, total_tokens, used_tokens, daily_used, daily_reset_date
      FROM users WHERE telegram_id = ?
    `, [telegramId]);

    if (!user) return null;

    const tier = this.tiers[user.tier] || this.tiers.free;
    
    // 检查是否需要重置每日配额
    const today = new Date().toISOString().split('T')[0];
    if (user.daily_reset_date !== today) {
      await this.run(`
        UPDATE users 
        SET daily_used = 0, daily_reset_date = ?
        WHERE telegram_id = ?
      `, [today, telegramId]);
      user.daily_used = 0;
    }

    // 获取今日使用详情
    const todayUsage = await this.get(`
      SELECT tokens_used, message_count
      FROM token_usage
      WHERE telegram_id = ? AND date = CURRENT_DATE
    `, [telegramId]);

    return {
      tier: user.tier,
      total: tier.total,
      used: user.used_tokens,
      remaining: tier.total - user.used_tokens,
      dailyLimit: tier.daily,
      dailyUsed: user.daily_used,
      dailyRemaining: tier.daily === Infinity ? Infinity : tier.daily - user.daily_used,
      todayTokens: todayUsage?.tokens_used || 0,
      todayMessages: todayUsage?.message_count || 0
    };
  }

  async consumeTokens(telegramId, tokens) {
    const quota = await this.getQuota(telegramId);
    
    if (!quota) throw new Error('User not found');
    
    // 检查配额
    if (quota.remaining < tokens) {
      throw new Error('Insufficient token quota');
    }
    
    if (quota.dailyRemaining !== Infinity && quota.dailyRemaining < tokens) {
      throw new Error('Daily token limit exceeded');
    }

    // 更新用户总使用量
    await this.run(`
      UPDATE users 
      SET used_tokens = used_tokens + ?, daily_used = daily_used + ?
      WHERE telegram_id = ?
    `, [tokens, tokens, telegramId]);

    // 更新今日使用记录
    await this.run(`
      INSERT INTO token_usage (telegram_id, date, tokens_used, message_count)
      VALUES (?, CURRENT_DATE, ?, 1)
      ON CONFLICT(telegram_id, date) DO UPDATE SET
        tokens_used = tokens_used + ?,
        message_count = message_count + 1
    `, [telegramId, tokens, tokens]);

    return {
      consumed: tokens,
      remaining: quota.remaining - tokens,
      dailyRemaining: quota.dailyRemaining === Infinity ? Infinity : quota.dailyRemaining - tokens
    };
  }

  async addQuota(telegramId, tokens, type = 'total') {
    if (type === 'total') {
      await this.run(`
        UPDATE users SET total_tokens = total_tokens + ?
        WHERE telegram_id = ?
      `, [tokens, telegramId]);
    } else if (type === 'daily') {
      // 临时增加每日配额（当日有效）
      await this.run(`
        UPDATE users SET daily_used = MAX(0, daily_used - ?)
        WHERE telegram_id = ?
      `, [tokens, telegramId]);
    }

    return this.getQuota(telegramId);
  }

  async upgradeTier(telegramId, newTier) {
    if (!this.tiers[newTier]) {
      throw new Error('Invalid tier');
    }

    await this.run(`
      UPDATE users SET tier = ?
      WHERE telegram_id = ?
    `, [newTier, telegramId]);

    return this.getQuota(telegramId);
  }

  async getUsageStats(telegramId, days = 30) {
    return this.all(`
      SELECT 
        date,
        tokens_used,
        message_count,
        ROUND(CAST(tokens_used AS FLOAT) / message_count, 2) as avg_tokens_per_message
      FROM token_usage
      WHERE telegram_id = ? AND date >= date('now', '-${days} days')
      ORDER BY date DESC
    `, [telegramId]);
  }

  async getGlobalStats() {
    return this.get(`
      SELECT 
        COUNT(DISTINCT telegram_id) as total_users,
        SUM(tokens_used) as total_tokens_consumed,
        SUM(message_count) as total_messages,
        AVG(tokens_used) as avg_tokens_per_user
      FROM token_usage
      WHERE date = CURRENT_DATE
    `);
  }
}

module.exports = TokenQuotaManager;
