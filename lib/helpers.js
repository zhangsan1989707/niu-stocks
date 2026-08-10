/**
 * 共享辅助函数
 */

function average(values, count) {
  const subset = values.slice(-count);
  return subset.length ? subset.reduce((a, b) => a + b, 0) / subset.length : 0;
}

function ema(values, days) {
  const k = 2 / (days + 1);
  return values.reduce((acc, value) =>
    acc.length ? [...acc, value * k + acc[acc.length - 1] * (1 - k)] : [value], []);
}

/**
 * 简单内存缓存
 * TTL 根据市场状态自动切换：盘中 30s，盘后 300s
 */
class Cache {
  constructor() {
    this.store = new Map();
  }

  static isMarketOpen() {
    const now = new Date();
    const day = now.getDay(); // 0=周日, 6=周六
    if (day === 0 || day === 6) return false;
    const h = now.getHours();
    const m = now.getMinutes();
    const minutes = h * 60 + m;
    // 9:30 - 11:30, 13:00 - 15:00
    return (minutes >= 570 && minutes <= 690) || (minutes >= 780 && minutes <= 900);
  }

  key(...parts) {
    return parts.join(':');
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    const ttl = Cache.isMarketOpen() ? 30000 : 300000;
    if (Date.now() - entry.timestamp > ttl) {
      this.store.delete(key);
      return null;
    }
    return entry.data;
  }

  set(key, data) {
    this.store.set(key, { data, timestamp: Date.now() });
  }

  clear() {
    this.store.clear();
  }

  size() {
    return this.store.size;
  }
}

module.exports = { average, ema, Cache };
