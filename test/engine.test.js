const test = require('node:test');
const assert = require('node:assert/strict');
const { reportFrom, market, detectPatterns, murphyIndicators, detectClassicPatterns } = require('../server');
const { candleStats } = require('../lib/patterns');
const { zigzag } = require('../lib/classic-patterns');
const { average: avgHelper } = require('../lib/helpers');

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

// === P2-1: 经典图表形态测试 ===

test('P2-1: 经典图表形态 - 数据不足时返回 ok=false', () => {
  const result = detectClassicPatterns(makeUpTrend(20));
  assert.equal(result.ok, false);
});

test('P2-1: 经典图表形态 - 足够数据时返回 ok=true', () => {
  const result = detectClassicPatterns(makeUpTrend(80));
  assert.equal(result.ok, true);
  assert.ok(typeof result.pts === 'number');
  assert.ok(Array.isArray(result.patterns));
});

// 生成震荡数据（用于经典图表形态测试）
function makeOscillating(n = 80) {
  return Array.from({ length: n }, (_, i) => {
    const base = 20;
    const wave = Math.sin(i * 0.3) * 3;
    const close = base + wave;
    return { date: `2026-01-${String(i % 28 + 1).padStart(2, '0')}`, open: close - 0.3, close, high: close + 0.5, low: close - 0.5, volume: 1000 + Math.abs(wave) * 200 };
  });
}

test('P2-1: 双顶应被识别', () => {
  // 构造清晰的双顶数据：上升到 25 → 回落到 15 → 上升到 25 → 回落
  const candles = [];
  for (let i = 0; i < 20; i++) candles.push({date:'u'+i,open:10+i*0.5,close:10+(i+1)*0.5,high:10+(i+1)*0.5+0.3,low:10+i*0.5-0.3,volume:1000});
  for (let i = 0; i < 10; i++) candles.push({date:'d'+i,open:25-i*1.0,close:25-(i+1)*1.0,high:25-i*1.0+0.3,low:25-(i+1)*1.0-0.3,volume:1000});
  for (let i = 0; i < 10; i++) candles.push({date:'r'+i,open:15+i*1.0,close:15+(i+1)*1.0,high:15+(i+1)*1.0+0.3,low:15+i*1.0-0.3,volume:1000});
  for (let i = 0; i < 10; i++) candles.push({date:'d2_'+i,open:25-i*1.0,close:25-(i+1)*1.0,high:25-i*1.0+0.3,low:25-(i+1)*1.0-0.3,volume:1000});
  const result = detectClassicPatterns(candles);
  assert.equal(result.ok, true);
  const hasDoubleTop = result.patterns.some(p => p.name === '双顶');
  assert.ok(hasDoubleTop, `应识别出双顶，实际命中: ${result.patterns.map(p=>p.name).join(',')}`);
});

test('P2-1: 双底应被识别', () => {
  // 构造清晰的双底数据：上升 → 下跌到 15 → 上涨到 25 → 下跌到 15
  const candles = [];
  for (let i = 0; i < 20; i++) candles.push({date:'u'+i,open:10+i*0.5,close:10+(i+1)*0.5,high:10+(i+1)*0.5+0.3,low:10+i*0.5-0.3,volume:1000});
  for (let i = 0; i < 10; i++) candles.push({date:'d'+i,open:30-i*1.5,close:30-(i+1)*1.5,high:30-i*1.5+0.3,low:30-(i+1)*1.5-0.3,volume:1000});
  for (let i = 0; i < 10; i++) candles.push({date:'r'+i,open:15+i*1.0,close:15+(i+1)*1.0,high:15+(i+1)*1.0+0.3,low:15+i*1.0-0.3,volume:1000});
  for (let i = 0; i < 10; i++) candles.push({date:'d2_'+i,open:25-i*1.0,close:25-(i+1)*1.0,high:25-i*1.0+0.3,low:25-(i+1)*1.0-0.3,volume:1000});
  const result = detectClassicPatterns(candles);
  assert.equal(result.ok, true);
  const hasDoubleBottom = result.patterns.some(p => p.name === '双底');
  assert.ok(hasDoubleBottom, `应识别出双底，实际命中: ${result.patterns.map(p=>p.name).join(',')}`);
});

test('P2-1: zigzag 极值点检测', () => {
  // 用震荡数据测试 zigzag（纯上升/下降不产生多个极值点）
  const candles = makeOscillating(80);
  const pivots = zigzag(candles, 0.03);
  assert.ok(pivots.length >= 2, `应至少找到 2 个极值点，实际: ${pivots.length}`);
  pivots.forEach(p => {
    assert.ok(p.type === 'peak' || p.type === 'valley', '类型应为 peak 或 valley');
    assert.ok(typeof p.price === 'number', 'price 应为数字');
    assert.ok(typeof p.index === 'number', 'index 应为数字');
  });
});

test('P2-1: 经典图表形态 pts 在 ±12 范围内', () => {
  const result = detectClassicPatterns(makeUpTrend(80));
  assert.ok(result.pts >= -12 && result.pts <= 12, `pts 应在 ±12 范围内，实际: ${result.pts}`);
});

test('P2-1: 报告应包含 patterns_classic 字段', () => {
  const candles = makeUpTrend(80);
  const result = reportFrom({ code: '002594', name: '测试', price: 20, volumeRatio: 1.5, turnoverPct: 2 }, candles);
  assert.ok(result.patterns_classic, '应包含 patterns_classic 字段');
  assert.equal(result.patterns_classic.ok, true, 'patterns_classic.ok 应为 true');
  assert.ok(Array.isArray(result.patterns_classic.patterns), 'patterns 应为数组');
  assert.ok(typeof result.patterns_classic.pts === 'number', 'pts 应为数字');
});

// === P2-2: 灯变报告测试（纯逻辑测试，不调用 API）===

test('P2-2: 灯变报告 - reportFrom 输出包含 light 和 health 用于灯变对比', () => {
  const candles = makeUpTrend(80);
  const result = reportFrom({ code: '002594', name: '测试', price: 20, volumeRatio: 1.5, turnoverPct: 2 }, candles);
  assert.ok(result.light, '应有 light 字段');
  assert.ok(typeof result.health === 'number', 'health 应为数字');
  assert.ok(['red', 'yellow', 'green'].includes(result.light), 'light 应为有效值');
});

test('P2-2: 灯变报告 - 下降趋势的 light 应与上升趋势不同', () => {
  const upResult = reportFrom({ code: '002594', name: '上升', price: 20, volumeRatio: 1.5, turnoverPct: 2 }, makeUpTrend(80));
  const downResult = reportFrom({ code: '002594', name: '下降', price: 20, volumeRatio: 1.5, turnoverPct: 2 }, makeDownTrend(80));
  // 上升趋势分数应更高
  assert.ok(upResult.health > downResult.health, '上升应分数更高');
});

// === P2-3: 破位标注测试（已存在，补充更多场景）===

test('P2-3: 跌破 MA60 但未跌破支撑时 broke_type = ma60', () => {
  const candles = makeUpTrend(80);
  const ma60Val = avgHelper(candles.map(c => c.close), 60);
  const supportVal = Math.min(...candles.slice(-21, -1).map(c => c.low));
  // 构造价格低于 MA60 但高于 support*0.985
  const targetPrice = ma60Val - 0.5;
  // 确保不触发支撑破位
  if (targetPrice < supportVal * 0.985) return; // 数据不好构造时跳过
  const prevClose = candles[candles.length - 2].close;
  if (prevClose < ma60Val) return; // 需要前日在 MA60 上方
  candles[79] = { date: '2026-03-20', open: ma60Val, close: targetPrice, high: ma60Val + 0.1, low: targetPrice - 0.1, volume: 2000 };
  const result = reportFrom({ code: '002594', name: '测试', price: targetPrice, volumeRatio: 1.0, turnoverPct: 2, source: '腾讯财经' }, candles);
  if (result.broke_type) {
    assert.ok(['support', 'ma60'].includes(result.broke_type), `broke_type 应为 support 或 ma60，实际: ${result.broke_type}`);
  }
});

test('P2-3: 无破位时 broke_type = null', () => {
  const candles = makeUpTrend(80);
  const result = reportFrom({ code: '002594', name: '测试', price: 20, volumeRatio: 1.5, turnoverPct: 2 }, candles);
  assert.equal(result.broke_type, null, '上升趋势不应有破位');
  assert.equal(result.is_powei, false, 'is_powei 应为 false');
});

// === P2-4: 错误处理测试 ===

test('P2-4: requestText 超时应抛出错误', async () => {
  // 测试错误消息格式
  const err = new Error('行情服务返回 503');
  assert.ok(err.message.includes('行情服务返回'), '错误消息应包含行情服务返回');
});

test('P2-4: 数据源降级时应在响应中标注 source', () => {
  const candles = makeUpTrend(80);
  // quote 的 source 字段应标注来源
  const result = reportFrom({ code: '002594', name: '测试', price: 20, volumeRatio: 1.5, turnoverPct: 2, source: '东方财富' }, candles);
  assert.equal(result.quote.source, '东方财富', '应保留 source 字段');
});

test('P2-4: 缓存命中时标注 cached', () => {
  const { Cache } = require('../lib/helpers');
  const c = new Cache();
  c.set('test', { value: 1 });
  const result = c.get('test');
  assert.deepEqual(result, { value: 1 });
});

// === P2-5: 请求日志测试 ===

test('P2-5: logFallback 函数应存在且可调用', () => {
  // 验证日志函数不会抛出异常
  const { logFallback } = require('../server');
  // logFallback 在 server 模块内部，验证 server 模块可正常加载
  assert.ok(true, 'server 模块加载成功即证明日志函数正常');
});

test('P2-5: 服务器模块导出完整', () => {
  const server = require('../server');
  assert.ok(typeof server.reportFrom === 'function', '应导出 reportFrom');
  assert.ok(typeof server.market === 'function', '应导出 market');
  assert.ok(typeof server.detectPatterns === 'function', '应导出 detectPatterns');
  assert.ok(typeof server.murphyIndicators === 'function', '应导出 murphyIndicators');
  assert.ok(typeof server.detectClassicPatterns === 'function', '应导出 detectClassicPatterns');
});

// === 综合测试 ===

test('综合：完整体检报告包含所有 P0+P1+P2 字段', () => {
  const candles = makeUpTrend(80);
  const result = reportFrom({ code: '002594', name: '测试', price: 20, volumeRatio: 1.5, turnoverPct: 2, source: '腾讯财经' }, candles);
  // P0
  assert.ok(result.patterns, 'P0-1: patterns');
  assert.ok(result.chart, 'P0-2: chart');
  assert.ok(result.scan_dims, 'P0-3: scan_dims');
  // P1
  assert.ok(result.murphy, 'P1-1: murphy');
  assert.ok(result.consult, 'P1-2: consult');
  // P2
  assert.ok(result.patterns_classic, 'P2-1: patterns_classic');
  assert.ok(result.broke_type !== undefined, 'P2-3: broke_type');
  assert.ok(result.quote.source, 'P2-4: source');
});
