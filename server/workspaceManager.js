/**
 * Workspace Manager
 * 
 * 管理每个用户的独立工作空间
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
    // 使用 user_id 的 base64 编码作为目录名
    const safeName = Buffer.from(String(userId)).toString('base64').replace(/[/+=]/g, '_');
    return path.join(this.basePath, `user_${safeName}`);
  }

  /**
   * 创建用户工作空间
   */
  async create(userId) {
    const workspacePath = this.getPath(userId);
    
    if (await fs.pathExists(workspacePath)) {
      return { path: workspacePath, existed: true };
    }

    // 创建目录结构
    const dirs = [
      'memory',
      'skills',
      'data',
      'temp',
      'config',
      'canvas'
    ];

    for (const dir of dirs) {
      await fs.ensureDir(path.join(workspacePath, dir));
    }

    // 创建基础文件
    await this.createBaseFiles(workspacePath, userId);

    console.log(`[WORKSPACE] Created for user ${userId}: ${workspacePath}`);
    
    return { path: workspacePath, existed: false };
  }

  /**
   * 创建基础文件
   */
  async createBaseFiles(workspacePath, userId) {
    // AGENTS.md - 工作空间说明
    const agentsMd = `# AGENTS.md

## 关于

这是一个 OpenClaw 多租户工作空间。

- 用户ID: ${userId}
- 创建时间: ${new Date().toISOString()}

## 规则

- 所有文件仅在此工作空间内有效
- 定期备份重要数据
- 遵守使用条款

## Memory

- \`memory/\` - 每日记忆
- \`MEMORY.md\` - 长期记忆
`;

    // SOUL.md - 人格定义
    const soulMd = `# SOUL.md

## 人格

你是一个友好的 AI 助手，为用户提供帮助。

## 风格

- 专业但亲切
- 简洁但完整
- 乐于助人

## 语言

根据用户语言自动切换（中文/英文）。
`;

    // USER.md - 用户信息
    const userMd = `# USER.md

## 用户信息

- Telegram ID: ${userId}
- 注册时间: ${new Date().toISOString()}

## 偏好

待用户配置...
`;

    // MEMORY.md - 长期记忆
    const memoryMd = `# MEMORY.md

## 长期记忆

开始记录重要信息...
`;

    // .gitignore
    const gitignore = `temp/
data/cache/
*.log
.env
*.key
`;

    await fs.writeFile(path.join(workspacePath, 'AGENTS.md'), agentsMd);
    await fs.writeFile(path.join(workspacePath, 'SOUL.md'), soulMd);
    await fs.writeFile(path.join(workspacePath, 'USER.md'), userMd);
    await fs.writeFile(path.join(workspacePath, 'MEMORY.md'), memoryMd);
    await fs.writeFile(path.join(workspacePath, '.gitignore'), gitignore);

    // 创建今日记忆文件
    const today = new Date().toISOString().split('T')[0];
    await fs.writeFile(
      path.join(workspacePath, 'memory', `${today}.md`),
      `# ${today}\n\n## 今日记录\n`
    );
  }

  /**
   * 重置工作空间
   */
  async reset(userId) {
    const workspacePath = this.getPath(userId);
    
    // 备份旧数据
    const backupPath = `${workspacePath}_backup_${Date.now()}`;
    if (await fs.pathExists(workspacePath)) {
      await fs.move(workspacePath, backupPath);
    }

    // 创建新的工作空间
    await this.create(userId);

    // 删除备份（可选：可以保留一段时间）
    setTimeout(async () => {
      await fs.remove(backupPath).catch(() => {});
    }, 24 * 60 * 60 * 1000); // 24小时后删除

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

    // 计算大小和文件数
    const stats = await this.calculateSize(workspacePath);
    
    // 获取已安装技能
    const skillsPath = path.join(workspacePath, 'skills');
    let skills = [];
    if (await fs.pathExists(skillsPath)) {
      skills = (await fs.readdir(skillsPath))
        .filter(f => !f.startsWith('.'));
    }

    return {
      exists: true,
      path: workspacePath,
      shortPath: `.../user_${Buffer.from(String(userId)).toString('base64').replace(/[/+=]/g, '_').slice(-8)}`,
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
