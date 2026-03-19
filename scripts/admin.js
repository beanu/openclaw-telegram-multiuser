#!/usr/bin/env node

/**
 * Admin Script
 * 
 * 管理用户和配额
 */

const path = require('path');
const readline = require('readline');
require('dotenv').config();

const Database = require('../server/database');
const TokenQuotaManager = require('../server/tokenQuotaManager');
const WorkspaceManager = require('../server/workspaceManager');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'multiuser.db');
const workspaceBase = process.env.WORKSPACE_BASE || path.join(process.env.HOME, '.openclaw/multiuser-workspaces');

const db = new Database(dbPath);
const quota = new TokenQuotaManager(db);
const workspace = new WorkspaceManager(workspaceBase);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function prompt(question) {
  return new Promise(resolve => rl.question(question, resolve));
}

async function main() {
  await db.initialize();
  await workspace.initialize();

  console.log('🔧 OpenClaw Multi-Tenant Admin\n');

  while (true) {
    console.log('\n=== 管理菜单 ===');
    console.log('1. 查看用户列表');
    console.log('2. 查看用户详情');
    console.log('3. 增加用户配额');
    console.log('4. 升级用户等级');
    console.log('5. 封禁/解封用户');
    console.log('6. 查看全局统计');
    console.log('7. 重置用户数据');
    console.log('0. 退出');

    const choice = await prompt('\n选择操作: ');

    switch (choice) {
      case '1':
        await listUsers();
        break;
      case '2':
        await showUserDetails();
        break;
      case '3':
        await addQuota();
        break;
      case '4':
        await upgradeTier();
        break;
      case '5':
        await toggleBan();
        break;
      case '6':
        await showStats();
        break;
      case '7':
        await resetUser();
        break;
      case '0':
        console.log('👋 再见！');
        process.exit(0);
      default:
        console.log('❌ 无效选择');
    }
  }
}

async function listUsers() {
  const users = db.db.prepare(`
    SELECT u.*, q.used_quota, q.total_quota
    FROM users u
    LEFT JOIN quotas q ON u.telegram_id = q.telegram_id
    ORDER BY u.last_active DESC
    LIMIT 50
  `).all();

  console.log('\n👥 用户列表 (最近50个):');
  console.log('-'.repeat(80));
  console.log('ID'.padEnd(15) + '用户名'.padEnd(20) + '等级'.padEnd(10) + '配额'.padEnd(15) + '状态');
  console.log('-'.repeat(80));
  
  for (const user of users) {
    const status = user.is_banned ? '🚫 封禁' : '✅ 正常';
    const quotaStr = `${user.used_quota || 0}/${user.total_quota || 0}`;
    console.log(
      String(user.telegram_id).padEnd(15) +
      (user.username || 'N/A').padEnd(20) +
      (user.tier || 'free').padEnd(10) +
      quotaStr.padEnd(15) +
      status
    );
  }
}

async function showUserDetails() {
  const userId = await prompt('输入用户 ID: ');
  const details = await db.getUserDetails(parseInt(userId));
  
  if (!details) {
    console.log('❌ 用户不存在');
    return;
  }

  console.log('\n📊 用户详情:');
  console.log(JSON.stringify(details, null, 2));
}

async function addQuota() {
  const userId = await prompt('输入用户 ID: ');
  const amount = await prompt('增加配额数量: ');
  
  await quota.addQuota(parseInt(userId), parseInt(amount));
  console.log('✅ 配额已增加');
}

async function upgradeTier() {
  const userId = await prompt('输入用户 ID: ');
  console.log('可用等级: free, basic, pro, vip, unlimited');
  const tier = await prompt('新等级: ');
  
  try {
    await quota.upgradeTier(parseInt(userId), tier);
    console.log('✅ 等级已更新');
  } catch (error) {
    console.log('❌', error.message);
  }
}

async function toggleBan() {
  const userId = await prompt('输入用户 ID: ');
  const user = db.getUser(parseInt(userId));
  
  if (!user) {
    console.log('❌ 用户不存在');
    return;
  }

  if (user.is_banned) {
    db.unbanUser(parseInt(userId));
    console.log('✅ 用户已解封');
  } else {
    db.banUser(parseInt(userId));
    console.log('✅ 用户已封禁');
  }
}

async function showStats() {
  const stats = db.getGlobalStats();
  
  console.log('\n📊 全局统计:');
  console.log('-'.repeat(40));
  console.log(`总用户数: ${stats.totalUsers}`);
  console.log(`活跃用户(7天): ${stats.activeUsers}`);
  console.log(`今日活跃: ${stats.todayActive}`);
  console.log(`总消息数: ${stats.totalMessages}`);
  console.log(`总Token消耗: ${stats.totalTokens}`);
  console.log(`今日消息: ${stats.todayMessages}`);
}

async function resetUser() {
  const userId = await prompt('输入用户 ID: ');
  const confirm = await prompt('确认重置? (yes/no): ');
  
  if (confirm.toLowerCase() !== 'yes') {
    console.log('❌ 已取消');
    return;
  }

  await workspace.reset(parseInt(userId));
  db.clearHistory(parseInt(userId));
  console.log('✅ 用户数据已重置');
}

main().catch(err => {
  console.error('❌ 错误:', err);
  process.exit(1);
});
