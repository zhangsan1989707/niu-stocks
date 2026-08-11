const test = require('node:test');
const assert = require('node:assert/strict');

const { validateConfig } = require('../lib/server/store');
const { updateJson } = require('../lib/server/store');
const { reportFrom } = require('../server');

test('策略配置只接受已知且处于安全范围内的数值', () => {
  const result = validateConfig({ macdFast: 8, ma60Period: 90, healthScoreThreshold: 72, extra: 1 });
  assert.deepEqual(result.config, { macdFast: 8, ma60Period: 90, healthScoreThreshold: 72 });
  assert.deepEqual(result.errors, ['不支持的配置项：extra']);
});

test('策略配置拒绝会使指标失效的参数', () => {
  const result = validateConfig({ macdFast: 20, macdSlow: 13, volumeRatioThreshold: -1 });
  assert.ok(result.errors.some(x => x.includes('MACD 快线')));
  assert.ok(result.errors.some(x => x.includes('量比阈值')));
});

test('同一 JSON 文件的并发更新不会丢失写入', async () => {
  const { mkdtemp, rm } = require('node:fs/promises');
  const { join } = require('node:path');
  const os = require('node:os');
  const directory = await mkdtemp(join(os.tmpdir(), 'stock-store-test-'));
  const file = join(directory, 'state.json');
  await Promise.all(Array.from({ length: 10 }, () => updateJson(file, { count: 0 }, state => ({ count: state.count + 1 }))));
  const final = await updateJson(file, { count: 0 }, state => state);
  assert.equal(final.count, 10);
  await rm(directory, { recursive: true, force: true });
});

test('经典图表形态维度不会误报蜡烛形态数量', () => {
  const candles = Array.from({ length: 80 }, (_, i) => {
    const close = 10 + i * 0.15;
    return { date: `2026-01-${String(i + 1).padStart(2, '0')}`, open: close - 0.1, close, high: close + 0.2, low: close - 0.25, volume: 1000 };
  });
  const report = reportFrom({ code: '600519', name: '测试', price: 22, volumeRatio: 1, turnoverPct: 1 }, candles);
  const classic = report.scan_dims.find(item => item.key === 'patterns');
  assert.ok(!classic.note.includes('蜡烛形态'));
});
