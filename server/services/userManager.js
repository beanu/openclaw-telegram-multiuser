const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

class UserManager {
  constructor() {
    this.dbPath = process.env.DB_PATH || './data/users.db';
    this.db = null;
  }

  async initialize() {
    // 确保数据目录存在
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new sqlite3.Database(this.dbPath);
    
    // 创建表
    await this.run(`
      CREATE TABLE IF NOT EXISTS users (
        telegram_id INTEGER PRIMARY KEY,
        username TEXT,
        first_name TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_active DATETIME DEFAULT CURRENT_TIMESTAMP,
        tier TEXT DEFAULT 'free',
        total_tokens INTEGER DEFAULT 0,
        used_tokens INTEGER DEFAULT 0,
        daily_used INTEGER DEFAULT 0,
        daily_reset_date DATE DEFAULT CURRENT_DATE,
        message_count INTEGER DEFAULT 0
      )
    `);

    await this.run(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id INTEGER,
        role TEXT,
        content TEXT,
        tokens_used INTEGER DEFAULT 0,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (telegram_id) REFERENCES users(telegram_id)
      )
    `);

    await this.run(`
      CREATE TABLE IF NOT EXISTS workspaces (
        telegram_id INTEGER PRIMARY KEY,
        path TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_accessed DATETIME DEFAULT CURRENT_TIMESTAMP,
        size_bytes INTEGER DEFAULT 0,
        file_count INTEGER DEFAULT 0,
        FOREIGN KEY (telegram_id) REFERENCES users(telegram_id)
      )
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

  all(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }

  async createUser(userData) {
    await this.run(`
      INSERT INTO users (telegram_id, username, first_name)
      VALUES (?, ?, ?)
    `, [userData.telegramId, userData.username, userData.firstName]);

    return this.getUser(userData.telegramId);
  }

  async getUser(telegramId) {
    return this.get(`
      SELECT * FROM users WHERE telegram_id = ?
    `, [telegramId]);
  }

  async updateUser(telegramId, updates) {
    const fields = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const values = Object.values(updates);
    
    await this.run(`
      UPDATE users SET ${fields}, last_active = CURRENT_TIMESTAMP
      WHERE telegram_id = ?
    `, [...values, telegramId]);

    return this.getUser(telegramId);
  }

  async addMessage(telegramId, message) {
    await this.run(`
      INSERT INTO messages (telegram_id, role, content, tokens_used)
      VALUES (?, ?, ?, ?)
    `, [telegramId, message.role, message.content, message.tokensUsed || 0]);

    // 更新用户消息计数
    await this.run(`
      UPDATE users SET message_count = message_count + 1
      WHERE telegram_id = ?
    `, [telegramId]);
  }

  async getMessageHistory(telegramId, limit = 50) {
    return this.all(`
      SELECT * FROM messages
      WHERE telegram_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `, [telegramId, limit]);
  }

  async clearHistory(telegramId) {
    await this.run(`
      DELETE FROM messages WHERE telegram_id = ?
    `, [telegramId]);
  }

  async getStats(telegramId) {
    return this.get(`
      SELECT 
        COUNT(*) as total_messages,
        SUM(tokens_used) as total_tokens,
        AVG(tokens_used) as avg_tokens
      FROM messages
      WHERE telegram_id = ?
    `, [telegramId]);
  }
}

module.exports = UserManager;
