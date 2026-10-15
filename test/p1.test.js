const test = require('node:test');
const assert = require('node:assert/strict');
const { klines } = require('../lib/server/market');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');
const { DATA_DIR } = require('../lib/server/utils');

test('P1: K线磁盘缓存写入并命中', { skip: process.env.RUN_LIVE_MARKET_TESTS !== '1' }, async () => {
  const k = await klines('600519');
  assert.ok(k.length >= 100, '应有足够 K 线');
  // 磁盘文件存在且结构正确
  const disk = JSON.parse(await readFile(join(DATA_DIR, 'kline', 'k_600519.json'), 'utf8'));
  assert.equal(disk.key, 'k_600519');
  assert.ok(Array.isArray(disk.candles));
  assert.equal(disk.candles.length, k.length);
  assert.ok(disk.candles[disk.candles.length - 1].close > 0);
});
