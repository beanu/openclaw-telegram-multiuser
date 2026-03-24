/**
 * SQLite Database Module
 * 
 * 管理用户数据、配额和消息统计
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs-extra');

class DatabaseManager {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
  }

  async initialize() {
    // 确保目录存在
    await fs.ensureDir(path.dirname(this.dbPath));
    
    // 打开数据库
    this.db = new Database(this.dbPath);
    
    // 启用 WAL 模式提高并发性能
    this.db.pragma('journal_mode = WAL');
    
    // 创建表
    this.createTables();
    
    console.log(`[DB] Database initialized: ${this.dbPath}`);
  }

  createTables() {
    // 用户表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        telegram_id INTEGER PRIMARY KEY,
        username TEXT,
        first_name TEXT,
        last_name TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        last_active TEXT DEFAULT (datetime('now')),
        tier TEXT DEFAULT 'free',
        is_banned INTEGER DEFAULT 0,
        message_count INTEGER DEFAULT 0,
        session_count INTEGER DEFAULT 0
      )
    `);

    // Token 使用记录表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS token_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id INTEGER NOT NULL,
        date TEXT DEFAULT (date('now')),
        tokens_used INTEGER DEFAULT 0,
        message_count INTEGER DEFAULT 0,
        FOREIGN KEY (telegram_id) REFERENCES users(telegram_id),
        UNIQUE(telegram_id, date)
      )
    `);

    // 总配额表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS quotas (
        telegram_id INTEGER PRIMARY KEY,
        total_quota INTEGER DEFAULT 100000,
        used_quota INTEGER DEFAULT 0,
        daily_limit INTEGER DEFAULT 10000,
        daily_used INTEGER DEFAULT 0,
        daily_reset_date TEXT DEFAULT (date('now')),
        FOREIGN KEY (telegram_id) REFERENCES users(telegram_id)
      )
    `);

    // 消息历史表（可选，用于审计）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS message_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT,
        tokens_used INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (telegram_id) REFERENCES users(telegram_id)
      )
    `);

    // 技能安装表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS installed_skills (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id INTEGER NOT NULL,
        skill_name TEXT NOT NULL,
        installed_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (telegram_id) REFERENCES users(telegram_id),
        UNIQUE(telegram_id, skill_name)
      )
    `);

    // 创建索引
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_token_usage_user_date ON token_usage(telegram_id, date);
      CREATE INDEX IF NOT EXISTS idx_message_history_user ON message_history(telegram_id);
      CREATE INDEX IF NOT EXISTS idx_users_created ON users(created_at);
    `);

    // Migration: add agent_id column if missing
    try {
      this.db.exec(`ALTER TABLE users ADD COLUMN agent_id TEXT`);
    } catch (e) {
      // Column already exists -- safe to ignore
    }

    // Migration: add model and session_key columns to message_history if missing
    for (const col of ['model TEXT', 'session_key TEXT']) {
      try {
        this.db.exec(`ALTER TABLE message_history ADD COLUMN ${col}`);
      } catch (e) {
        // Column already exists
      }
    }
  }

  // ==================== 用户操作 ====================

  createUser(userData) {
    const stmt = this.db.prepare(`
      INSERT INTO users (telegram_id, username, first_name, last_name)
      VALUES (?, ?, ?, ?)
    `);
    
    stmt.run(
      userData.telegramId,
      userData.username || null,
      userData.firstName || null,
      userData.lastName || null
    );

    // 创建配额记录
    this.db.prepare(`
      INSERT INTO quotas (telegram_id) VALUES (?)
    `).run(userData.telegramId);

    return this.getUser(userData.telegramId);
  }

  getUser(telegramId) {
    return this.db.prepare(`
      SELECT * FROM users WHERE telegram_id = ?
    `).get(telegramId);
  }

  updateUser(telegramId, updates) {
    // 列名映射 (camelCase -> snake_case)
    const columnMap = {
      lastActive: 'last_active',
      firstName: 'first_name',
      lastName: 'last_name',
      messageCount: 'message_count',
      sessionCount: 'session_count',
      isBanned: 'is_banned'
    };

    const fields = [];
    const values = [];
    
    for (const [key, value] of Object.entries(updates)) {
      const dbColumn = columnMap[key] || key;
      fields.push(`${dbColumn} = ?`);
      values.push(value);
    }
    
    if (fields.length === 0) return;
    
    const stmt = this.db.prepare(`
      UPDATE users SET ${fields.join(', ')}
      WHERE telegram_id = ?
    `);
    
    stmt.run(...values, telegramId);
  }

  incrementMessageCount(telegramId) {
    this.db.prepare(`
      UPDATE users SET message_count = message_count + 1
      WHERE telegram_id = ?
    `).run(telegramId);
  }

  setAgentId(telegramId, agentId) {
    this.db.prepare(`
      UPDATE users SET agent_id = ? WHERE telegram_id = ?
    `).run(agentId, telegramId);
  }

  getAgentId(telegramId) {
    const row = this.db.prepare(`
      SELECT agent_id FROM users WHERE telegram_id = ?
    `).get(telegramId);
    return row?.agent_id || null;
  }

  recordMessage(telegramId, role, content, tokensUsed = 0, model = null, sessionKey = null) {
    const truncated = content && content.length > 500 ? content.slice(0, 500) : (content || '');
    this.db.prepare(`
      INSERT INTO message_history (telegram_id, role, content, tokens_used, model, session_key)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(telegramId, role, truncated, tokensUsed, model, sessionKey);
  }

  clearHistory(telegramId) {
    this.db.prepare(`DELETE FROM message_history WHERE telegram_id = ?`).run(telegramId);
    this.db.prepare(`DELETE FROM token_usage WHERE telegram_id = ?`).run(telegramId);
    this.db.prepare(`
      UPDATE quotas SET used_quota = 0, daily_used = 0
      WHERE telegram_id = ?
    `).run(telegramId);
  }

  banUser(telegramId) {
    this.db.prepare(`UPDATE users SET is_banned = 1 WHERE telegram_id = ?`).run(telegramId);
  }

  unbanUser(telegramId) {
    this.db.prepare(`UPDATE users SET is_banned = 0 WHERE telegram_id = ?`).run(telegramId);
  }

  deleteUser(telegramId) {
    const del = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM installed_skills WHERE telegram_id = ?`).run(telegramId);
      this.db.prepare(`DELETE FROM message_history WHERE telegram_id = ?`).run(telegramId);
      this.db.prepare(`DELETE FROM token_usage WHERE telegram_id = ?`).run(telegramId);
      this.db.prepare(`DELETE FROM quotas WHERE telegram_id = ?`).run(telegramId);
      this.db.prepare(`DELETE FROM users WHERE telegram_id = ?`).run(telegramId);
    });
    del();
  }

  // ==================== Token 使用 ====================

  recordTokenUsage(telegramId, tokens) {
    // 更新每日使用记录
    this.db.prepare(`
      INSERT INTO token_usage (telegram_id, tokens_used, message_count)
      VALUES (?, ?, 1)
      ON CONFLICT(telegram_id, date) DO UPDATE SET
        tokens_used = tokens_used + ?,
        message_count = message_count + 1
    `).run(telegramId, tokens, tokens);

    // 更新总配额
    this.db.prepare(`
      UPDATE quotas 
      SET used_quota = used_quota + ?,
          daily_used = daily_used + ?
      WHERE telegram_id = ?
    `).run(tokens, tokens, telegramId);
  }

  resetDailyQuota() {
    this.db.prepare(`
      UPDATE quotas 
      SET daily_used = 0, daily_reset_date = date('now')
      WHERE daily_reset_date < date('now')
    `).run();
  }

  addQuota(telegramId, amount) {
    this.db.prepare(`
      UPDATE quotas SET total_quota = total_quota + ?
      WHERE telegram_id = ?
    `).run(amount, telegramId);
  }

  getQuota(telegramId) {
    return this.db.prepare(`
      SELECT * FROM quotas WHERE telegram_id = ?
    `).get(telegramId);
  }

  /**
   * 创建配额记录
   */
  createQuota(telegramId) {
    this.db.prepare(`
      INSERT OR IGNORE INTO quotas (telegram_id) VALUES (?)
    `).run(telegramId);
  }

  // ==================== 统计 ====================

  getGlobalStats() {
    const totalUsers = this.db.prepare('SELECT COUNT(*) as count FROM users').get().count;
    
    const activeUsers = this.db.prepare(`
      SELECT COUNT(*) as count FROM users 
      WHERE last_active >= datetime('now', '-7 days')
    `).get().count;

    const todayActive = this.db.prepare(`
      SELECT COUNT(DISTINCT telegram_id) as count FROM token_usage
      WHERE date = date('now')
    `).get().count;

    const totalMessages = this.db.prepare('SELECT SUM(message_count) as count FROM users').get().count || 0;
    
    const totalTokens = this.db.prepare('SELECT SUM(used_quota) as count FROM quotas').get().count || 0;
    
    const todayMessages = this.db.prepare(`
      SELECT SUM(message_count) as count FROM token_usage
      WHERE date = date('now')
    `).get().count || 0;

    return {
      totalUsers,
      activeUsers,
      todayActive,
      totalMessages,
      totalTokens,
      todayMessages
    };
  }

  getUserDetails(telegramId) {
    const user = this.getUser(telegramId);
    if (!user) return null;

    const quota = this.getQuota(telegramId);
    
    const recentUsage = this.db.prepare(`
      SELECT * FROM token_usage
      WHERE telegram_id = ?
      ORDER BY date DESC
      LIMIT 30
    `).all(telegramId);

    const installedSkills = this.db.prepare(`
      SELECT skill_name FROM installed_skills
      WHERE telegram_id = ?
    `).all(telegramId).map(s => s.skill_name);

    return {
      user,
      quota,
      recentUsage,
      installedSkills
    };
  }

  // ==================== Token Quota 辅助方法 ====================

  /**
   * 获取今日使用详情
   */
  getTodayUsage(telegramId) {
    return this.db.prepare(`
      SELECT tokens_used, message_count
      FROM token_usage
      WHERE telegram_id = ? AND date = date('now')
    `).get(telegramId);
  }

  /**
   * 重置每日配额
   */
  resetDailyQuotaForUser(telegramId, today) {
    this.db.prepare(`
      UPDATE quotas 
      SET daily_used = 0, daily_reset_date = ?
      WHERE telegram_id = ?
    `).run(today, telegramId);
  }

  /**
   * 减少每日已用量
   */
  decreaseDailyUsed(telegramId, amount) {
    this.db.prepare(`
      UPDATE quotas 
      SET daily_used = MAX(0, daily_used - ?)
      WHERE telegram_id = ?
    `).run(amount, telegramId);
  }

  /**
   * 重置用户配额
   */
  resetUserQuota(telegramId) {
    this.db.prepare(`
      UPDATE quotas 
      SET used_quota = 0, daily_used = 0, daily_reset_date = date('now')
      WHERE telegram_id = ?
    `).run(telegramId);
  }

  /**
   * 获取使用统计
   */
  getUsageStats(telegramId, days = 30) {
    const safeDays = parseInt(days, 10) || 30;
    return this.db.prepare(`
      SELECT 
        date,
        tokens_used,
        message_count,
        CASE 
          WHEN message_count > 0 THEN ROUND(CAST(tokens_used AS FLOAT) / message_count, 2)
          ELSE 0
        END as avg_tokens_per_message
      FROM token_usage
      WHERE telegram_id = ? AND date >= date('now', '-' || ? || ' days')
      ORDER BY date DESC
    `).all(telegramId, safeDays);
  }
}

module.exports = DatabaseManager;
