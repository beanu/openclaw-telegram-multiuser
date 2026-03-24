/**
 * Agent Manager
 *
 * Manages OpenClaw agent lifecycle (Strategy B: per-tenant independent agents)
 * by shelling out to the `openclaw` CLI with remote Gateway credentials.
 */

const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const EXEC_TIMEOUT = 30000;

class AgentManager {
  constructor(config) {
    this.gatewayWsUrl = config.gatewayWsUrl;
    this.gatewayToken = config.gatewayToken;
    this.workspaceBase = config.workspaceBase || '~/.openclaw/multiuser-workspaces';
  }

  /**
   * Create a new agent on the remote Gateway.
   * Workspace is created at WORKSPACE_BASE/user_<agentId> by `openclaw agents add`.
   * Idempotent: returns true even if the agent already exists.
   */
  async createAgent(agentId) {
    const workspacePath = `${this.workspaceBase}/user_${agentId}`;
    const args = [
      'agents', 'add', agentId,
      '--workspace', workspacePath,
      '--url', this.gatewayWsUrl,
      '--token', this.gatewayToken
    ];

    try {
      const { stdout } = await execFileAsync('openclaw', args, { timeout: EXEC_TIMEOUT });
      console.log(`[AGENT] Created agent "${agentId}": ${stdout.trim()}`);
      return { created: true, agentId };
    } catch (error) {
      const msg = (error.stderr || error.message || '').toLowerCase();
      if (msg.includes('already exists') || msg.includes('duplicate')) {
        console.log(`[AGENT] Agent "${agentId}" already exists, skipping creation`);
        return { created: false, agentId, existed: true };
      }
      console.error(`[AGENT] Failed to create agent "${agentId}":`, error.stderr || error.message);
      throw new Error(`Agent creation failed: ${error.stderr || error.message}`);
    }
  }

  /**
   * Delete an agent from the remote Gateway.
   */
  async deleteAgent(agentId) {
    const args = [
      'agents', 'delete', agentId,
      '--url', this.gatewayWsUrl,
      '--token', this.gatewayToken
    ];

    try {
      const { stdout } = await execFileAsync('openclaw', args, { timeout: EXEC_TIMEOUT });
      console.log(`[AGENT] Deleted agent "${agentId}": ${stdout.trim()}`);
      return true;
    } catch (error) {
      console.error(`[AGENT] Failed to delete agent "${agentId}":`, error.stderr || error.message);
      return false;
    }
  }

  /**
   * List all agents on the remote Gateway.
   */
  async listAgents() {
    const args = [
      'agents', 'list', '--json',
      '--url', this.gatewayWsUrl,
      '--token', this.gatewayToken
    ];

    try {
      const { stdout } = await execFileAsync('openclaw', args, { timeout: EXEC_TIMEOUT });
      return JSON.parse(stdout);
    } catch (error) {
      console.error('[AGENT] Failed to list agents:', error.stderr || error.message);
      return [];
    }
  }
}

module.exports = AgentManager;
