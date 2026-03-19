#!/usr/bin/env node

/**
 * Setup Script
 * 
 * 初始化项目和数据库
 */

const path = require('path');
const fs = require('fs-extra');
require('dotenv').config();

const Database = require('../server/database');
const TokenQuotaManager = require('../server/tokenQuotaManager');
const WorkspaceManager = require('../server/workspaceManager');

async function setup() {
  console.log('🚀 OpenClaw Multi-Tenant Setup\n');

  // 1. 检查环境变量
  console.log('📋 检查配置...');
  
  if (!process.env.BOT_TOKEN || process.env.BOT_TOKEN === 'test_token_replace_with_real_one') {
    console.log('⚠️  BOT_TOKEN 未设置或使用测试值');
    console.log('   请在 .env 文件中设置真实的 BOT_TOKEN\n');
  } else {
    console.log('✅ BOT_TOKEN 已设置');
  }

  // 2. 创建必要目录
  console.log('\n📁 创建目录...');
  
  const dirs = [
    'data',
    path.join(process.env.HOME || '/root', '.openclaw/multiuser-workspaces')
  ];

  for (const dir of dirs) {
    await fs.ensureDir(dir);
    console.log(`  ✅ ${dir}`);
  }

  // 3. 初始化数据库
  console.log('\n💾 初始化数据库...');
  
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'multiuser.db');
  const db = new Database(dbPath);
  await db.initialize();
  
  console.log(`  ✅ 数据库已创建: ${dbPath}`);

  // 4. 创建默认配置文件
  console.log('\n📝 创建配置文件...');
  
  const configPath = path.join(__dirname, '..', 'data', 'config.json');
  const defaultConfig = {
    tiers: {
      free: { daily: 10000, total: 100000 },
      basic: { daily: 50000, total: 500000 },
      pro: { daily: 200000, total: 2000000 },
      vip: { daily: 1000000, total: 10000000 }
    },
    adminIds: [],
    features: {
      allowSignup: true,
      requireApproval: false,
      enableSkills: true
    }
  };

  await fs.writeJson(configPath, defaultConfig, { spaces: 2 });
  console.log(`  ✅ 配置文件: ${configPath}`);

  // 5. 完成
  console.log('\n✨ 设置完成！\n');
  console.log('下一步:');
  console.log('  1. npm install        # 安装依赖');
  console.log('  2. npm start          # 启动服务');
  console.log('  3. 找 @BotFather 获取 token');
  console.log('\n配置文件:');
  console.log(`  - ${configPath}`);
  console.log(`  - ${dbPath}`);
}

setup().catch(err => {
  console.error('❌ 设置失败:', err);
  process.exit(1);
});
