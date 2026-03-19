const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

class WorkspaceManager {
  constructor() {
    this.basePath = process.env.WORKSPACE_BASE || './workspaces';
    this.templatePath = './workspace-template';
  }

  async initialize() {
    // 确保基础目录存在
    if (!fs.existsSync(this.basePath)) {
      fs.mkdirSync(this.basePath, { recursive: true });
    }

    // 创建工作空间模板
    await this.createTemplate();
  }

  async createTemplate() {
    const templateDir = this.templatePath;
    
    if (!fs.existsSync(templateDir)) {
      fs.mkdirSync(templateDir, { recursive: true });
      
      // 创建标准工作空间结构
      const dirs = [
        'memory',
        'skills',
        'data',
        'temp',
        'config'
      ];
      
      for (const dir of dirs) {
        fs.mkdirSync(path.join(templateDir, dir), { recursive: true });
      }

      // 创建基础配置文件
      fs.writeFileSync(
        path.join(templateDir, 'config', 'settings.json'),
        JSON.stringify({
          version: '1.0.0',
          createdAt: new Date().toISOString(),
          maxFileSize: '10MB',
          maxStorage: '100MB'
        }, null, 2)
      );

      // 创建空的 MEMORY.md
      fs.writeFileSync(
        path.join(templateDir, 'memory', 'MEMORY.md'),
        '# Memory\n\nUser-specific memory storage.\n'
      );

      // 创建 .gitignore
      fs.writeFileSync(
        path.join(templateDir, '.gitignore'),
        'temp/\ndata/cache/\n*.log\n'
      );
    }
  }

  getWorkspacePath(userId) {
    // 使用用户ID的哈希作为目录名，避免特殊字符
    const hash = Buffer.from(String(userId)).toString('base64').replace(/[/+=]/g, '_');
    return path.join(this.basePath, `user_${hash}`);
  }

  async createWorkspace(userId) {
    const workspacePath = this.getWorkspacePath(userId);
    
    // 如果已存在，直接返回
    if (fs.existsSync(workspacePath)) {
      return { path: workspacePath, existed: true };
    }

    // 从模板复制
    await this.copyTemplate(this.templatePath, workspacePath);
    
    // 创建用户专属配置
    const userConfig = {
      userId,
      workspaceId: uuidv4(),
      createdAt: new Date().toISOString(),
      permissions: ['read', 'write', 'execute'],
      allowedSkills: ['*'], // 默认允许所有技能
      restrictedPaths: ['../', '/etc', '/root']
    };

    fs.writeFileSync(
      path.join(workspacePath, 'config', 'user.json'),
      JSON.stringify(userConfig, null, 2)
    );

    // 创建隔离标记
    fs.writeFileSync(
      path.join(workspacePath, '.isolated'),
      `ISOLATED_WORKSPACE\nUser: ${userId}\nCreated: ${new Date().toISOString()}\n`
    );

    return { path: workspacePath, existed: false };
  }

  async copyTemplate(src, dest) {
    const entries = fs.readdirSync(src, { withFileTypes: true });
    
    fs.mkdirSync(dest, { recursive: true });
    
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      
      if (entry.isDirectory()) {
        await this.copyTemplate(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  async getStatus(userId) {
    const workspacePath = this.getWorkspacePath(userId);
    
    if (!fs.existsSync(workspacePath)) {
      return { exists: false, path: workspacePath };
    }

    // 计算目录大小
    const stats = await this.getDirectoryStats(workspacePath);
    
    return {
      exists: true,
      path: workspacePath,
      size: this.formatBytes(stats.size),
      sizeBytes: stats.size,
      fileCount: stats.fileCount,
      lastAccessed: stats.lastAccessed
    };
  }

  async getDirectoryStats(dirPath) {
    let size = 0;
    let fileCount = 0;
    let lastAccessed = new Date(0);

    const traverse = (currentPath) => {
      const entries = fs.readdirSync(currentPath, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name);
        
        if (entry.isDirectory()) {
          traverse(fullPath);
        } else {
          const stats = fs.statSync(fullPath);
          size += stats.size;
          fileCount++;
          if (stats.atime > lastAccessed) {
            lastAccessed = stats.atime;
          }
        }
      }
    };

    traverse(dirPath);
    
    return { size, fileCount, lastAccessed };
  }

  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  async resetWorkspace(userId) {
    const workspacePath = this.getWorkspacePath(userId);
    
    // 备份旧数据（可选）
    const backupPath = `${workspacePath}_backup_${Date.now()}`;
    if (fs.existsSync(workspacePath)) {
      fs.renameSync(workspacePath, backupPath);
    }

    // 重新创建
    return this.createWorkspace(userId);
  }

  async deleteWorkspace(userId) {
    const workspacePath = this.getWorkspacePath(userId);
    
    if (fs.existsSync(workspacePath)) {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }

    return { deleted: true };
  }

  // 验证路径安全（防止目录遍历）
  isPathSafe(userId, requestedPath) {
    const workspacePath = this.getWorkspacePath(userId);
    const resolvedPath = path.resolve(requestedPath);
    
    // 确保请求的路径在工作空间内
    return resolvedPath.startsWith(workspacePath);
  }
}

module.exports = WorkspaceManager;
