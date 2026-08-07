const test = require('node:test');
const assert = require('node:assert/strict');
const { reportFrom, hash, verifyHash, market } = require('../server');

const candles = Array.from({ length: 80 }, (_, index) => {
  const close = 10 + index * .12;
  return { date: `2026-01-${String(index % 28 + 1).padStart(2, '0')}`, open: close - .1, close, high: close + .2, low: close - .25, volume: 1000 + index * 10 };
});

test('市场前缀按沪深北代码返回', () => {
  assert.equal(market('600519'), 'sh');
  assert.equal(market('002594'), 'sz');
  assert.equal(market('832000'), 'bj');
});

test('报告引擎为上升趋势生成完整评分和校验项', () => {
  const result = reportFrom({ code: '002594', name: '示例股', price: 19.5, volumeRatio: 1.8, turnoverPct: 3 }, candles);
  assert.equal(result.candles.length, 80);
  assert.equal(result.checks.length, 8);
  assert.ok(result.score >= 65);
  assert.ok(result.metrics.ma60 > 0);
});

test('密码以随机加盐 scrypt 保存并可正确验证', () => {
  const stored = hash('password123');
  assert.notEqual(stored, 'password123');
  assert.ok(verifyHash('password123', stored));
  assert.equal(verifyHash('wrong-password', stored), false);
});
