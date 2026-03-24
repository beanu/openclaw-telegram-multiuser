/**
 * OpenClaw Client
 *
 * Communicates with OpenClaw Gateway via the OpenResponses API (POST /v1/responses).
 * Each request is routed to a specific agent/session using HTTP headers.
 */

const axios = require('axios');

class OpenClawClient {
  constructor(config) {
    this.gatewayUrl = config.gatewayUrl;
    this.gatewayToken = config.gatewayToken;

    this.client = axios.create({
      baseURL: this.gatewayUrl,
      headers: {
        'Content-Type': 'application/json',
        ...(this.gatewayToken ? { 'Authorization': `Bearer ${this.gatewayToken}` } : {})
      },
      timeout: 120000
    });
  }

  /**
   * Send a message to a specific OpenClaw agent and return the assistant reply.
   *
   * @param {string} agentId   - OpenClaw agent id (e.g. "user_123456")
   * @param {string} sessionKey - Session scope within the agent (e.g. "tg:123456")
   * @param {string} input     - User message text
   * @param {object} [options]
   * @param {string} [options.instructions] - System-level instructions (SOUL.md + USER.md)
   * @param {number} [options.maxOutputTokens] - Limit output length
   * @returns {{ text: string, tokensUsed: number, model: string }}
   */
  async chat(agentId, sessionKey, input, options = {}) {
    const body = {
      model: 'openclaw',
      input,
      stream: false,
      user: sessionKey
    };

    if (options.instructions) {
      body.instructions = options.instructions;
    }
    if (options.maxOutputTokens) {
      body.max_output_tokens = options.maxOutputTokens;
    }

    const headers = {
      'x-openclaw-agent-id': agentId,
      'x-openclaw-session-key': sessionKey
    };

    const response = await this.client.post('/v1/responses', body, { headers });
    const data = response.data;

    const text = this._extractText(data);
    const tokensUsed = data.usage?.total_tokens || 0;
    const model = data.model || 'openclaw';

    return { text, tokensUsed, model };
  }

  /**
   * Extract assistant reply text from the OpenResponses output array.
   */
  _extractText(data) {
    if (!data.output || !Array.isArray(data.output)) {
      return '(无响应)';
    }

    const parts = [];
    for (const item of data.output) {
      if (item.type === 'message' && Array.isArray(item.content)) {
        for (const block of item.content) {
          if (block.type === 'output_text' && block.text) {
            parts.push(block.text);
          }
        }
      }
    }

    return parts.join('\n') || '(无响应)';
  }

  /**
   * Stream a message to a specific OpenClaw agent via SSE.
   * Yields parsed SSE event objects: { type, data }.
   *
   * @param {string} agentId
   * @param {string} sessionKey
   * @param {string} input
   * @param {object} [options]
   * @param {string} [options.instructions]
   * @param {number} [options.maxOutputTokens]
   * @yields {{ type: string, data: object }}
   */
  async *chatStream(agentId, sessionKey, input, options = {}) {
    const body = {
      model: 'openclaw',
      input,
      stream: true,
      user: sessionKey
    };

    if (options.instructions) {
      body.instructions = options.instructions;
    }
    if (options.maxOutputTokens) {
      body.max_output_tokens = options.maxOutputTokens;
    }

    const headers = {
      'x-openclaw-agent-id': agentId,
      'x-openclaw-session-key': sessionKey
    };

    const response = await this.client.post('/v1/responses', body, {
      headers,
      responseType: 'stream',
      timeout: 0
    });

    for await (const event of this._parseSSE(response.data)) {
      yield event;
    }
  }

  /**
   * Parse an SSE byte stream into structured event objects.
   * Handles the standard SSE wire format: event/data lines separated by blank lines.
   */
  async *_parseSSE(stream) {
    let buffer = '';

    for await (const chunk of stream) {
      buffer += chunk.toString();

      let boundaryIndex;
      while ((boundaryIndex = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, boundaryIndex);
        buffer = buffer.slice(boundaryIndex + 2);

        let eventType = 'message';
        let dataLines = [];

        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) {
            eventType = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            const raw = line.slice(5).trim();
            if (raw === '[DONE]') return;
            dataLines.push(raw);
          }
        }

        if (dataLines.length === 0) continue;

        const joined = dataLines.join('\n');
        try {
          yield { type: eventType, data: JSON.parse(joined) };
        } catch {
          yield { type: eventType, data: joined };
        }
      }
    }
  }

  /**
   * Quick connectivity check against the Gateway.
   */
  async healthCheck() {
    try {
      const response = await this.client.post('/v1/responses', {
        model: 'openclaw',
        input: 'ping',
        stream: false
      }, { timeout: 10000 });

      return { status: 'ok', model: response.data?.model };
    } catch (error) {
      return { status: 'unavailable', error: error.message };
    }
  }
}

module.exports = OpenClawClient;
