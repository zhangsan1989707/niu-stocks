const test = require('node:test');
const assert = require('node:assert/strict');
const { reportFrom, market, detectPatterns, murphyIndicators } = require('../server');
const { candleStats } = require('../lib/patterns');

// --- 生成模拟 K 线数据 ---
function makeUpTrend(n = 80) {
  return Array.from({ length: n }, (_, i) => {
    const close = 10 + i * 0.15;
    return { date: `2026-01-${String(i % 28 + 1).padStart(2, '0')}`, open: close - 0.1, close, high: close + 0.2, low: close - 0.25, volume: 1000 + i * 10 };
  });
}
function makeDownTrend(n = 80) {
  return Array.from({ length: n }, (_, i) => {
    const close = 30 - i * 0.15;
    return { date: `2026-01-${String(i % 28 + 1).padStart(2, '0')}`, open: close + 0.1, close, high: close + 0.25, low: close - 0.2, volume: 1000 + i * 10 };
  });
}
function makeDoji(n = 80) {
  return Array.from({ length: n }, (_, i) => {
    const mid = 20 + Math.sin(i * 0.1) * 0.3;
    return { date: `2026-01-${String(i % 28 + 1).padStart(2, '0')}`, open: mid, close: mid + 0.001, high: mid + 0.5, low: mid - 0.5, volume: 1000 };
  });
}
function makeBullishEngulfing() {
  const base = makeUpTrend(40);
  base[38] = { date: '2026-02-10', open: 16.5, close: 16.0, high: 16.6, low: 15.9, volume: 1200 };
  base[39] = { date: '2026-02-11', open: 15.8, close: 16.8, high: 16.9, low: 15.7, volume: 1500 };
  return base;
}
function makeBearishEngulfing() {
  const base = makeUpTrend(40);
  base[38] = { date: '2026-02-10', open: 16.0, close: 16.5, high: 16.6, low: 15.9, volume: 1200 };
  base[39] = { date: '2026-02-11', open: 16.7, close: 15.9, high: 16.8, low: 15.8, volume: 1500 };
  return base;
}

// === P0-1: 29 种蜡烛形态识别测试 ===

test('P0-1: 上升趋势应命中看涨形态', () => {
  const candles = makeBullishEngulfing();
  const patterns = detectPatterns(candles);
  assert.ok(patterns.length > 0, '上升趋势应至少命中 1 种形态');
  const hasBull = patterns.some(p => p.dir === 'bull');
  assert.ok(hasBull, '应包含看涨形态');
});

test('P0-1: 看跌吞没应被正确识别', () => {
  const candles = makeBearishEngulfing();
  const patterns = detectPatterns(candles);
  const hasBearishEngulfing = patterns.some(p => p.name === '看跌吞没');
  assert.ok(hasBearishEngulfing, '应识别出看跌吞没');
});

test('P0-1: 看涨吞没应被正确识别', () => {
  const candles = makeBullishEngulfing();
  const patterns = detectPatterns(candles);
  const hasBullishEngulfing = patterns.some(p => p.name === '看涨吞没');
  assert.ok(hasBullishEngulfing, '应识别出看涨吞没');
});

test('P0-1: 十字星数据应命中中性形态', () => {
  const candles = makeDoji(80);
  const patterns = detectPatterns(candles);
  const hasDoji = patterns.some(p => p.name.includes('十字'));
  assert.ok(hasDoji, '应识别出十字星系列形态');
});

test('P0-1: 形态返回正确的数据结构', () => {
  const candles = makeUpTrend(80);
  const patterns = detectPatterns(candles);
  patterns.forEach(p => {
    assert.ok(p.name, '形态应有 name');
    assert.ok(['bull', 'bear', 'neutral'].includes(p.dir), 'dir 应为 bull/bear/neutral');
    assert.ok(typeof p.weight === 'number' && p.weight > 0, 'weight 应为正数');
  });
});

test('P0-1: 数据不足时返回空数组', () => {
  assert.deepEqual(detectPatterns([]), []);
  assert.deepEqual(detectPatterns([{ date: '2026-01-01', open: 10, close: 10.1, high: 10.2, low: 9.9, volume: 100 }]), []);
});

// === P0-2: K 线图增强测试（通过 reportFrom 的 chart 字段验证） ===

test('P0-2: 报告应包含增强图表数据 chart 字段', () => {
  const candles = makeUpTrend(80);
  const q = { code: '002594', name: '示例股', price: 19.5, volumeRatio: 1.8, turnoverPct: 3 };
  const result = reportFrom(q, candles);
  assert.ok(result.chart, '应包含 chart 字段');
  assert.ok(result.chart.bars, 'chart 应包含 bars');
  assert.ok(result.chart.bars.length <= 70, 'bars 最多 70 根');
  assert.ok(result.chart.ma60, 'chart 应包含 ma60 序列');
  assert.equal(result.chart.ma60.length, result.chart.bars.length, 'ma60 长度应与 bars 一致');
  assert.ok(typeof result.chart.support === 'number', 'chart 应包含 support');
  assert.ok(typeof result.chart.resistance === 'number', 'chart 应包含 resistance');
});

test('P0-2: chart bars 应包含 o/c/h/l/v 字段', () => {
  const candles = makeUpTrend(80);
  const result = reportFrom({ code: '002594', name: '测试', price: 20, volumeRatio: 1.5, turnoverPct: 2 }, candles);
  const bar = result.chart.bars[0];
  ['d', 'o', 'c', 'h', 'l', 'v'].forEach(k => assert.ok(k in bar, `bar 应包含字段 ${k}`));
});

// === P0-3: 扩大选股扫描范围测试 ===

test('P0-3: 市场前缀按沪深北代码返回', () => {
  assert.equal(market('600519'), 'sh');
  assert.equal(market('002594'), 'sz');
  assert.equal(market('832000'), 'bj');
  assert.equal(market('688981'), 'sh');
  assert.equal(market('300308'), 'sz');
});

// === P0-4: 数据缓存测试 ===

test('P0-4: Cache 基本存取', () => {
  const { Cache } = require('../lib/helpers');
  const c = new Cache();
  c.set('test:key', { value: 42 });
  const result = c.get('test:key');
  assert.deepEqual(result, { value: 42 });
});

test('P0-4: Cache 未命中返回 null', () => {
  const { Cache } = require('../lib/helpers');
  const c = new Cache();
  assert.equal(c.get('nonexistent'), null);
});

test('P0-4: Cache 清空', () => {
  const { Cache } = require('../lib/helpers');
  const c = new Cache();
  c.set('a', 1); c.set('b', 2);
  c.clear();
  assert.equal(c.size(), 0);
});

// === P1-1: 墨菲摆动指标组测试 ===

test('P1-1: 摆动指标组返回 7 项指标', () => {
  const candles = makeUpTrend(80);
  const result = murphyIndicators(candles);
  assert.equal(result.ok, true);
  assert.equal(result.factors.length, 7, '应返回 7 项指标');
  const names = result.factors.map(f => f.name);
  ['KDJ-K', 'KDJ-D', 'KDJ-J', 'RSI-6', 'RSI-12', 'WR', 'CCI'].forEach(name => {
    assert.ok(names.includes(name), `应包含 ${name}`);
  });
});

test('P1-1: 上升趋势 lean 应为偏多或中性', () => {
  const candles = makeUpTrend(80);
  const result = murphyIndicators(candles);
  assert.ok(['偏多', '中性'].includes(result.lean), `上升趋势 lean 应为偏多或中性，实际: ${result.lean}`);
});

test('P1-1: 摆动指标组 pts 在 ±10 范围内', () => {
  const candles = makeUpTrend(80);
  const result = murphyIndicators(candles);
  assert.ok(result.pts >= -10 && result.pts <= 10, `pts 应在 ±10 范围内，实际: ${result.pts}`);
});

test('P1-1: 数据不足时返回 ok=false', () => {
  const result = murphyIndicators([{ open: 10, close: 10.1, high: 10.2, low: 9.9, volume: 100 }]);
  assert.equal(result.ok, false);
});

// === P1-2: 四方会诊测试 ===

test('P1-2: 报告应包含四方会诊 consult 字段', () => {
  const candles = makeUpTrend(80);
  const result = reportFrom({ code: '002594', name: '测试', price: 20, volumeRatio: 1.5, turnoverPct: 2 }, candles);
  assert.ok(result.consult, '应包含 consult 字段');
  assert.ok(result.consult.L1, '应包含 L1');
  assert.ok(result.consult.L2, '应包含 L2');
  assert.ok(result.consult.L3, '应包含 L3');
  assert.ok(result.consult.L4, '应包含 L4');
  assert.ok(result.consult.verdict, '应包含 verdict');
  assert.ok(['green', 'red', 'yellow', 'neutral'].includes(result.consult.cls), 'cls 应为有效值');
});

test('P1-2: 上升趋势四方会诊应有偏多方向', () => {
  const candles = makeUpTrend(80);
  const result = reportFrom({ code: '002594', name: '测试', price: 20, volumeRatio: 1.5, turnoverPct: 2 }, candles);
  const sides = [result.consult.L1, result.consult.L2, result.consult.L3, result.consult.L4];
  const bulls = sides.filter(s => s.includes('偏多')).length;
  assert.ok(bulls >= 1, '上升趋势应至少有 1 方偏多');
});

// === P1-3: 一键全测 / 报告完整性测试 ===

test('P1-3: 报告包含完整的自选测试字段', () => {
  const candles = makeUpTrend(80);
  const result = reportFrom({ code: '002594', name: '测试', price: 20, volumeRatio: 1.5, turnoverPct: 2 }, candles);
  assert.ok(result.health >= 0 && result.health <= 100, 'health 应在 0-100');
  assert.ok(result.light, '应有 light 字段');
  assert.ok(result.band, '应有 band 字段');
  assert.ok(result.trend, '应有 trend 字段');
  assert.ok(result.scan_dims, '应有 scan_dims');
  assert.ok(result.factors, '应有 factors');
  assert.ok(result.murphy, '应有 murphy');
  assert.ok(result.patterns, '应有 patterns');
  assert.equal(result.pat_scanned, 29, 'pat_scanned 应为 29');
});

// === P1-4: 自选行情 sparkline 测试 ===

test('P1-4: chart 数据可用于 sparkline', () => {
  const candles = makeUpTrend(80);
  const result = reportFrom({ code: '002594', name: '测试', price: 20, volumeRatio: 1.5, turnoverPct: 2 }, candles);
  const closes = result.chart.bars.map(b => b.c);
  assert.ok(closes.length >= 2, '应有至少 2 个收盘价用于 sparkline');
});

// === P1-5: 体检动画数据兼容性测试 ===

test('P1-5: 报告数据结构兼容 playScanAnim', () => {
  const candles = makeUpTrend(80);
  const result = reportFrom({ code: '002594', name: '测试', price: 20, volumeRatio: 1.5, turnoverPct: 2 }, candles);
  // playScanAnim 需要的字段
  assert.ok(result.patterns, '需 patterns 字段');
  assert.ok(result.scan_dims, '需 scan_dims 字段');
  assert.ok(result.factors, '需 factors 字段');
  assert.ok(Array.isArray(result.scan_dims), 'scan_dims 应为数组');
  result.scan_dims.forEach(d => {
    assert.ok(d.key, '维度应有 key');
    assert.ok(d.name, '维度应有 name');
    assert.ok(d.note !== undefined, '维度应有 note');
  });
});

// === P2-3: 破位检测测试 ===

test('P2-3: 跌破支撑时 broke_type = support', () => {
  const candles = makeUpTrend(80);
  // 计算 reportFrom 内部会用的 support = min(最近20根low)
  const recent20Lows = candles.slice(-20).map(c => c.low);
  const support = Math.min(...recent20Lows);
  // 最后一根大幅跌破 support*0.985
  const crashClose = support * 0.90;
  candles[79] = { date: '2026-03-20', open: support * 0.98, close: crashClose, high: support * 0.99, low: crashClose - 0.1, volume: 5000 };
  const result = reportFrom({ code: '002594', name: '测试', price: crashClose, volumeRatio: 2.0, turnoverPct: 5 }, candles);
  assert.equal(result.broke_type, 'support', `应检测到跌破支撑，support=${support}, close=${crashClose}, broke_type=${result.broke_type}`);
  assert.ok(result.is_powei, 'is_powei 应为 true');
  assert.ok(result.health <= 22, `破位时分数应被压低到 ≤22，实际: ${result.health}`);
});

// === 综合：报告引擎测试 ===

test('报告引擎为上升趋势生成完整评分和校验项', () => {
  const candles = makeUpTrend(80);
  const result = reportFrom({ code: '002594', name: '示例股', price: 19.5, volumeRatio: 1.8, turnoverPct: 3 }, candles);
  assert.equal(result.candles.length, 80);
  assert.ok(result.scan_dims.length === 12, '应有 12 项校验');
  assert.ok(result.health >= 65, '上升趋势健康分应 ≥ 65');
  assert.ok(result.metrics.ma60 > 0, 'MA60 应大于 0');
  assert.ok(result.murphy.ok, '摆动指标组应为 ok');
  assert.ok(result.consult, '应有四方会诊');
  assert.ok(result.chart.bars.length > 0, '应有图表数据');
});

test('下降趋势健康分应低于上升趋势', () => {
  const upCandles = makeUpTrend(80);
  const downCandles = makeDownTrend(80);
  const upResult = reportFrom({ code: '002594', name: '上升', price: 20, volumeRatio: 1.5, turnoverPct: 2 }, upCandles);
  const downResult = reportFrom({ code: '002594', name: '下降', price: 20, volumeRatio: 1.5, turnoverPct: 2 }, downCandles);
  assert.ok(upResult.health > downResult.health, '上升趋势分数应高于下降趋势');
});

// === 边界数据测试 ===

test('边界：K线不足 60 根时 MA60 仍应计算（用可用数据）', () => {
  const candles = makeUpTrend(30);
  const result = reportFrom({ code: '002594', name: '新股', price: 15, volumeRatio: 1.0, turnoverPct: 1 }, candles);
  assert.ok(result.metrics.ma60 > 0, 'MA60 应使用可用数据计算');
  assert.ok(result.health >= 0 && result.health <= 100, 'health 应在有效范围');
});

test('边界：数据不足时摆动指标返回 ok=false', () => {
  const candles = makeUpTrend(10);
  const result = murphyIndicators(candles);
  assert.equal(result.ok, false);
  assert.equal(result.factors.length, 0);
});
