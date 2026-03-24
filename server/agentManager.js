/**
 * Agent Manager
 *
 * Manages OpenClaw agent lifecycle (per-tenant independent agents)
 * by shelling out to the `openclaw` CLI.
 *
 * The CLI operates on the local config (~/.openclaw/openclaw.json).
 * Gateway URL/token are configured there, not passed per-command.
 */

const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const EXEC_TIMEOUT = 30000;

class AgentManager {
  constructor(config) {
    this.workspaceBase = config.workspaceBase || '~/.openclaw/multiuser-workspaces';
  }

  /**
   * Create a new agent via `openclaw agents add`.
   * Workspace is created at WORKSPACE_BASE/<agentId>.
   * Idempotent: returns true even if the agent already exists.
   */
  async createAgent(agentId) {
    const workspacePath = `${this.workspaceBase}/${agentId}`;
    const args = [
      'agents', 'add', agentId,
      '--workspace', workspacePath
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
   * Delete an agent via `openclaw agents delete`.
   */
  async deleteAgent(agentId) {
    const args = ['agents', 'delete', agentId];

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
   * List all agents via `openclaw agents list`.
   */
  async listAgents() {
    const args = ['agents', 'list'];

    try {
      const { stdout } = await execFileAsync('openclaw', args, { timeout: EXEC_TIMEOUT });
      return stdout.trim();
    } catch (error) {
      console.error('[AGENT] Failed to list agents:', error.stderr || error.message);
      return '';
    }
  }
}

module.exports = AgentManager;
