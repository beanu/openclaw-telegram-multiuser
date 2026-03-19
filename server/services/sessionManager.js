const { spawn } = require('child_process');
const path = require('path');
const EventEmitter = require('events');

class SessionManager extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map(); // userId -> session
    this.openclawPath = process.env.OPENCLAW_PATH || '/app/openclaw';
  }

  async initialize() {
    // 初始化会话存储（可以用 Redis）
    console.log('SessionManager initialized');
  }

  getStore() {
    // 返回 Telegraf 会话存储适配器
    return {
      get: async (key) => {
        return this.sessions.get(key);
      },
      set: async (key, value) => {
        this.sessions.set(key, value);
      },
      delete: async (key) => {
        this.sessions.delete(key);
      }
    };
  }

  async processMessage(userId, message, context) {
    // 检查是否已有活跃会话
    let session = this.sessions.get(`session:${userId}`);
    
    if (!session) {
      // 创建新的 OpenClaw 会话
      session = await this.createSession(userId, context.workspacePath);
      this.sessions.set(`session:${userId}`, session);
    }

    // 更新会话最后活动时间
    session.lastActivity = Date.now();

    // 发送消息到 OpenClaw 处理
    const response = await this.sendToOpenClaw(session, message, context);
    
    return response;
  }

  async createSession(userId, workspacePath) {
    const sessionId = `tg_${userId}_${Date.now()}`;
    
    // 启动隔离的 OpenClaw 进程
    const openclawProcess = spawn('node', [
      path.join(this.openclawPath, 'bin/openclaw'),
      'session',
      '--workspace', workspacePath,
      '--session-id', sessionId,
      '--mode', 'isolated'
    ], {
      env: {
        ...process.env,
        OPENCLAW_USER_ID: String(userId),
        OPENCLAW_ISOLATED: 'true'
      },
      cwd: workspacePath
    });

    const session = {
      id: sessionId,
      userId,
      workspacePath,
      process: openclawProcess,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      messageCount: 0
    };

    // 处理进程输出
    openclawProcess.stdout.on('data', (data) => {
      this.emit('response', { sessionId, data: data.toString() });
    });

    openclawProcess.stderr.on('data', (data) => {
      console.error(`OpenClaw session ${sessionId} error:`, data.toString());
    });

    openclawProcess.on('close', (code) => {
      console.log(`OpenClaw session ${sessionId} closed with code ${code}`);
      this.sessions.delete(`session:${userId}`);
      this.emit('closed', { sessionId, code });
    });

    return session;
  }

  async sendToOpenClaw(session, message, context) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('OpenClaw response timeout'));
      }, 60000); // 60秒超时

      const responseHandler = ({ sessionId, data }) => {
        if (sessionId === session.id) {
          clearTimeout(timeout);
          this.off('response', responseHandler);
          
          try {
            const parsed = JSON.parse(data);
            resolve({
              text: parsed.text || parsed.response || data,
              tokensUsed: parsed.tokensUsed || 0,
              parseMode: parsed.parseMode
            });
          } catch {
            resolve({
              text: data,
              tokensUsed: 0
            });
          }
        }
      };

      this.on('response', responseHandler);

      // 发送消息到 OpenClaw 进程
      session.process.stdin.write(JSON.stringify({
        type: 'message',
        content: message,
        context: {
          quota: context.quota,
          timestamp: new Date().toISOString()
        }
      }) + '\n');

      session.messageCount++;
    });
  }

  async closeSession(userId) {
    const session = this.sessions.get(`session:${userId}`);
    if (session) {
      session.process.kill('SIGTERM');
      this.sessions.delete(`session:${userId}`);
    }
  }

  async cleanupInactiveSessions(maxInactiveTime = 30 * 60 * 1000) { // 30分钟
    const now = Date.now();
    
    for (const [key, session] of this.sessions.entries()) {
      if (now - session.lastActivity > maxInactiveTime) {
        console.log(`Cleaning up inactive session: ${session.id}`);
        await this.closeSession(session.userId);
      }
    }
  }

  getActiveSessionCount() {
    return this.sessions.size;
  }

  getSessionStats() {
    const stats = {
      total: this.sessions.size,
      byUser: {}
    };

    for (const [key, session] of this.sessions.entries()) {
      stats.byUser[session.userId] = {
        messageCount: session.messageCount,
        uptime: Date.now() - session.createdAt,
        lastActivity: session.lastActivity
      };
    }

    return stats;
  }
}

module.exports = SessionManager;
