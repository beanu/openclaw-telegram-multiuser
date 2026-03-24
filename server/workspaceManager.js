/**
 * Workspace Manager
 * 
 * Provides path resolution, info, reset, and delete for per-user
 * OpenClaw workspaces. Workspace creation and bootstrap file seeding
 * are handled by `openclaw agents add --workspace <path>`.
 */

const path = require('path');
const fs = require('fs-extra');

class WorkspaceManager {
  constructor(basePath) {
    this.basePath = basePath;
  }

  async initialize() {
    await fs.ensureDir(this.basePath);
    console.log(`[WORKSPACE] Base path: ${this.basePath}`);
  }

  /**
   * 获取用户工作空间路径
   */
  getPath(userId) {
    return path.join(this.basePath, `user_${String(userId)}`);
  }

  /**
   * 重置工作空间（删除后由下次 agent 请求重新初始化）
   */
  async reset(userId) {
    const workspacePath = this.getPath(userId);

    if (await fs.pathExists(workspacePath)) {
      await fs.remove(workspacePath);
    }

    console.log(`[WORKSPACE] Reset for user ${userId}`);
  }

  /**
   * 获取工作空间信息
   */
  async getInfo(userId) {
    const workspacePath = this.getPath(userId);
    
    if (!await fs.pathExists(workspacePath)) {
      return {
        exists: false,
        path: workspacePath,
        shortPath: '未创建',
        size: '0 B',
        fileCount: 0,
        skills: []
      };
    }

    const stats = await this.calculateSize(workspacePath);
    
    const skillsPath = path.join(workspacePath, 'skills');
    let skills = [];
    if (await fs.pathExists(skillsPath)) {
      skills = (await fs.readdir(skillsPath))
        .filter(f => !f.startsWith('.'));
    }

    return {
      exists: true,
      path: workspacePath,
      shortPath: `.../user_${String(userId)}`,
      size: this.formatBytes(stats.size),
      sizeBytes: stats.size,
      fileCount: stats.fileCount,
      skills
    };
  }

  /**
   * 计算目录大小
   */
  async calculateSize(dirPath) {
    let size = 0;
    let fileCount = 0;

    async function traverse(currentPath) {
      const entries = await fs.readdir(currentPath, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name);
        
        if (entry.isDirectory()) {
          await traverse(fullPath);
        } else {
          const stats = await fs.stat(fullPath);
          size += stats.size;
          fileCount++;
        }
      }
    }

    await traverse(dirPath);
    
    return { size, fileCount };
  }

  /**
   * 格式化字节大小
   */
  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  /**
   * 检查路径是否安全（防止目录遍历）
   */
  isSafePath(userId, requestedPath) {
    const workspacePath = this.getPath(userId);
    const resolvedPath = path.resolve(requestedPath);
    return resolvedPath.startsWith(workspacePath);
  }

  /**
   * 删除工作空间
   */
  async delete(userId) {
    const workspacePath = this.getPath(userId);
    await fs.remove(workspacePath);
    console.log(`[WORKSPACE] Deleted for user ${userId}`);
  }
}

module.exports = WorkspaceManager;
