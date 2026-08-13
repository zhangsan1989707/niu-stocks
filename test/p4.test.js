const test = require('node:test');
const assert = require('node:assert/strict');
const { runBacktest } = require('../lib/server/report');

test('P4: 回测输出完整绩效指标', async () => {
  const r = await runBacktest('600519', 250, 'macd');
  assert.equal(r.ok, true);
  // 核心指标字段
  ['signalCount', 'closedTrades', 'winRate', 'totalReturn', 'maxDrawdown', 'cagr', 'sharpe', 'profitFactor', 'turnover', 'equityCurve', 'benchCurve'].forEach(k => {
    assert.ok(k in r, `缺少字段 ${k}`);
  });
  // 净值曲线结构
  assert.ok(Array.isArray(r.equityCurve) && r.equityCurve.length >= 2, '净值曲线至少 2 点');
  r.equityCurve.forEach(p => {
    assert.ok(typeof p.date === 'string');
    assert.ok(typeof p.value === 'number' && p.value > 0);
  });
  // 指标合理性
  assert.ok(typeof r.totalReturn === 'number');
  if (r.cagr != null) assert.ok(typeof r.cagr === 'number');
  if (r.sharpe != null) assert.ok(typeof r.sharpe === 'number');
});

test('P4: 三策略均输出净值曲线', async () => {
  for (const s of ['macd', 'huichun', 'breakout']) {
    const r = await runBacktest('600519', 120, s);
    assert.equal(r.ok, true, `${s} 应成功`);
    assert.ok(r.equityCurve.length >= 2, `${s} 应有净值曲线`);
    assert.equal(r.strategy, s);
  }
});
