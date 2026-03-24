/**
 * In-memory Rate Limiter
 *
 * Enforces three constraints per Telegram user:
 *  1. Concurrency   – max 1 active OpenClaw request at a time
 *  2. Per-minute     – max 10 messages within a rolling 60-second window
 *  3. Per-hour       – max 60 messages within a rolling 3600-second window
 */

const MAX_CONCURRENT = 1;
const MAX_PER_MINUTE = 10;
const MAX_PER_HOUR = 60;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

class RateLimiter {
  constructor() {
    this.active = new Map();
    this.timestamps = new Map();

    this._cleanupTimer = setInterval(() => this._cleanup(), CLEANUP_INTERVAL_MS);
    if (this._cleanupTimer.unref) this._cleanupTimer.unref();
  }

  /**
   * @param {number|string} userId
   * @returns {{ ok: boolean, reason?: string }}
   */
  canProcess(userId) {
    const id = String(userId);

    const concurrent = this.active.get(id) || 0;
    if (concurrent >= MAX_CONCURRENT) {
      return { ok: false, reason: '⏳ 请等待上一条消息处理完成后再发送。' };
    }

    const now = Date.now();
    const ts = this.timestamps.get(id) || [];

    const oneMinuteAgo = now - 60_000;
    const recentMinute = ts.filter(t => t > oneMinuteAgo);
    if (recentMinute.length >= MAX_PER_MINUTE) {
      return { ok: false, reason: `⚠️ 发送过于频繁，每分钟最多 ${MAX_PER_MINUTE} 条消息，请稍后再试。` };
    }

    const oneHourAgo = now - 3600_000;
    const recentHour = ts.filter(t => t > oneHourAgo);
    if (recentHour.length >= MAX_PER_HOUR) {
      return { ok: false, reason: `⚠️ 已达到每小时 ${MAX_PER_HOUR} 条消息限制，请稍后再试。` };
    }

    return { ok: true };
  }

  startRequest(userId) {
    const id = String(userId);
    this.active.set(id, (this.active.get(id) || 0) + 1);
    const ts = this.timestamps.get(id) || [];
    ts.push(Date.now());
    this.timestamps.set(id, ts);
  }

  endRequest(userId) {
    const id = String(userId);
    const current = this.active.get(id) || 0;
    if (current <= 1) {
      this.active.delete(id);
    } else {
      this.active.set(id, current - 1);
    }
  }

  _cleanup() {
    const oneHourAgo = Date.now() - 3600_000;
    for (const [id, ts] of this.timestamps.entries()) {
      const filtered = ts.filter(t => t > oneHourAgo);
      if (filtered.length === 0) {
        this.timestamps.delete(id);
      } else {
        this.timestamps.set(id, filtered);
      }
    }
  }

  destroy() {
    clearInterval(this._cleanupTimer);
  }
}

module.exports = RateLimiter;
