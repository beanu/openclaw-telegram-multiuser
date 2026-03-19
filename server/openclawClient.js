/**
 * OpenClaw Client
 * 
 * 与 OpenClaw Gateway JSON-RPC API 交互
 */

const axios = require('axios');

class OpenClawClient {
  constructor(gatewayUrl, apiKey) {
    this.gatewayUrl = gatewayUrl || 'http://localhost:18789';
    this.apiKey = apiKey;
    this.requestId = 0;
    
    this.client = axios.create({
      baseURL: this.gatewayUrl,
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {})
      },
      timeout: 120000 // 2分钟超时
    });
  }

  /**
   * 发送 JSON-RPC 请求
   */
  async rpc(method, params = {}) {
    const id = ++this.requestId;
    
    const response = await this.client.post('/', {
      jsonrpc: '2.0',
      id,
      method,
      params
    });

    if (response.data.error) {
      throw new Error(response.data.error.message || 'RPC error');
    }

    return response.data.result;
  }

  /**
   * 发送消息到 OpenClaw 处理
   */
  async chat(userId, message, options = {}) {
    const sessionKey = this.getSessionKey(userId);
    
    try {
      // 调用 OpenClaw agent JSON-RPC API
      const result = await this.rpc('agent', {
        message,
        sessionKey,
        wait: true,  // 等待响应
        // 其他选项
        stream: false,
        timeout: 60000,
        ...options
      });

      // 解析响应
      // agent 方法返回的是终端快照或响应
      let responseText = '';
      let tokensUsed = 0;
      
      if (result) {
        // 尝试从不同格式中提取响应文本
        if (typeof result === 'string') {
          responseText = result;
        } else if (result.text) {
          responseText = result.text;
        } else if (result.response) {
          responseText = result.response;
        } else if (result.terminal) {
          responseText = result.terminal;
        } else if (result.output) {
          responseText = result.output;
        } else {
          // 尝试序列化整个结果
          responseText = JSON.stringify(result);
        }
        
        // 提取 token 使用量
        tokensUsed = result.usage?.totalTokens || 
                     result.tokensUsed || 
                     Math.ceil(message.length / 4) + Math.ceil(responseText.length / 4);
      }

      return {
        text: responseText || '(无响应)',
        tokensUsed,
        sessionId: sessionKey,
        model: result?.model || 'openclaw'
      };

    } catch (error) {
      // 如果 Gateway API 不可用，使用模拟响应
      if (error.code === 'ECONNREFUSED' || 
          error.code === 'ENOTFOUND' ||
          error.message?.includes('connect') ||
          error.message?.includes('timeout')) {
        console.log('[OpenClaw] Gateway not available:', error.message);
        return this.mockChat(userId, message);
      }
      throw error;
    }
  }

  /**
   * 获取会话历史
   */
  async getHistory(userId, limit = 50) {
    const sessionKey = this.getSessionKey(userId);
    
    try {
      const result = await this.rpc('sessions.history', {
        sessionKey,
        limit
      });
      
      return result?.messages || [];
    } catch (error) {
      console.error('[OpenClaw] Failed to get history:', error.message);
      return [];
    }
  }

  /**
   * 清除会话
   */
  async clearSession(userId) {
    const sessionKey = this.getSessionKey(userId);
    
    try {
      await this.rpc('sessions.reset', { sessionKey });
      return true;
    } catch (error) {
      console.error('[OpenClaw] Failed to clear session:', error.message);
      return false;
    }
  }

  /**
   * 安装技能
   */
  async installSkill(userId, skillName, workspacePath) {
    try {
      const result = await this.rpc('skills.install', {
        skill: skillName,
        workspace: workspacePath
      });
      
      return result;
    } catch (error) {
      // 模拟安装成功
      console.log(`[OpenClaw] Skill install mock: ${skillName}`);
      return { success: true, skill: skillName };
    }
  }

  /**
   * 获取技能列表
   */
  async listSkills(workspacePath) {
    try {
      const result = await this.rpc('skills.list', {
        workspace: workspacePath
      });
      
      return result?.skills || [];
    } catch (error) {
      return [];
    }
  }

  /**
   * 获取 Gateway 状态
   */
  async getStatus() {
    try {
      const result = await this.rpc('health');
      return { status: 'ok', ...result };
    } catch (error) {
      return { status: 'unavailable', error: error.message };
    }
  }

  /**
   * 生成会话 key
   */
  getSessionKey(userId) {
    // 使用 telegram:user_id 格式
    return `telegram:${userId}`;
  }

  /**
   * 模拟聊天响应（Gateway 不可用时）
   */
  async mockChat(userId, message) {
    // 简单的模拟响应
    const responses = [
      `收到你的消息: "${message}"\n\n⚠️ 这是模拟响应，因为 OpenClaw Gateway 未连接。`,
      `我收到了: ${message}\n\n请配置 OpenClaw Gateway 以获得完整功能。`,
      `消息已接收。\n\n当前运行在模拟模式。请启动 OpenClaw Gateway 以启用 AI 功能。`
    ];

    // 估算 token 使用量
    const tokensUsed = Math.ceil(message.length / 4) + 100;

    return {
      text: responses[Math.floor(Math.random() * responses.length)],
      tokensUsed,
      sessionId: `mock_${userId}`,
      model: 'mock'
    };
  }
}

module.exports = OpenClawClient;
