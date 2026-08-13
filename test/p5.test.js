const test = require('node:test');
const assert = require('node:assert/strict');
const { runPortfolioBacktest, getMarketRegime } = require('../lib/server/portfolio-backtest');

test('P5: 组合回测返回完整结构', async () => {
  const r = await runPortfolioBacktest({ topN: 5, holdDays: 2 });
  assert.equal(r.ok, true);
  ['topN', 'holdDays', 'days', 'trades', 'closedTrades', 'dailyValues'].forEach(k => {
    assert.ok(k in r, `缺少字段 ${k}`);
  });
  assert.equal(r.topN, 5);
  assert.equal(r.holdDays, 2);
  assert.ok(Array.isArray(r.trades));
  assert.ok(Array.isArray(r.dailyValues));
  // 净值点结构
  r.dailyValues.forEach(d => {
    assert.ok(typeof d.date === 'string');
    assert.ok(typeof d.nav === 'number' && d.nav > 0);
  });
  // 指标可选但类型正确
  if (r.totalReturn != null) assert.ok(typeof r.totalReturn === 'number');
  if (r.winRate != null) assert.ok(typeof r.winRate === 'number');
});

test('P5: 市场状态返回牛/震荡/熊', async () => {
  const r = await getMarketRegime();
  assert.equal(r.ok, true);
  assert.ok(['bull', 'range', 'bear', 'unknown'].includes(r.regime), `regime 应为有效值，实际 ${r.regime}`);
  if (r.regime !== 'unknown') {
    assert.ok(r.note, '含说明');
    assert.ok(typeof r.indexClose === 'number');
    assert.ok(typeof r.ma60 === 'number');
  }
});
