/**
 * 智能选股引擎测试 — v0.0.5
 * 覆盖：硬过滤 / RPS 横截面 / 五路信号 / 风险否决 / 聚合评分 / 快照映射 / 配置校验
 * 全部为纯函数测试，不触网。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  daysSinceList, hardFilter, rpsMap,
  computeStrategySignals, riskVetoes, finalizeScore, SCREEN_WEIGHTS,
} = require('../lib/server/screen-engine');
const { mapRow, validRow, PAGE_SIZE } = require('../lib/server/universe');
const { validateConfig } = require('../lib/server/store');

const CFG = {
  macdFast: 6, macdSlow: 13, macdSignal: 5, ma60Period: 60,
  screenMinAmount: 1e8, screenMinListDays: 60, screenRpsMin: 85,
  screenMaxCandidates: 150, screenTopK: 10, screenMaxChg60d: 120,
};

const NOW = new Date(2026, 6, 1); // 2026-07-01

function okStock(overrides = {}) {
  return {
    code: '600519', name: '贵州茅台', price: 1500, changePct: 1,
    amount: 5e9, turnoverPct: 0.5, volumeRatio: 1.1,
    chg60d: 20, chgYtd: 15, listDate: '20010827',
    ...overrides,
  };
}

function makeCandles(n, { trend = 'up', base = 20, vol = 1000 } = {}) {
  return Array.from({ length: n }, (_, i) => {
    const close = trend === 'up' ? base + i * 0.2 : trend === 'down' ? base * 2 - i * 0.2 : base;
    return {
      date: `2026-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String(i % 28 + 1).padStart(2, '0')}`,
      open: close - 0.05, close, high: close + 0.1, low: close - 0.15,
      volume: vol + i * 5,
    };
  });
}

const emptyReport = { patterns: [], murphy: { pts: 0 }, patterns_classic: { pts: 0 }, is_powei: false };

// --- daysSinceList ---

test('daysSinceList：YYYYMMDD 正确换算天数', () => {
  assert.equal(daysSinceList('20260601', NOW), 30);
  assert.equal(daysSinceList('20260701', NOW), 0);
});

test('daysSinceList：非法格式返回 Infinity（不误杀无上市日期的股票由配置决定）', () => {
  assert.equal(daysSinceList('', NOW), Infinity);
  assert.equal(daysSinceList('2026-07-01', NOW), Infinity);
});

// --- hardFilter ---

test('hardFilter：正常股票通过', () => {
  const r = hardFilter(okStock(), CFG, NOW);
  assert.equal(r.pass, true);
});

test('hardFilter：停牌/无成交剔除', () => {
  assert.equal(hardFilter(okStock({ price: 0, amount: 0 }), CFG, NOW).reason, '停牌/无成交');
});

test('hardFilter：ST/退市股剔除', () => {
  assert.equal(hardFilter(okStock({ name: '*ST海润' }), CFG, NOW).reason, 'ST/退市风险');
  assert.equal(hardFilter(okStock({ name: '退市博元' }), CFG, NOW).reason, 'ST/退市风险');
});

test('hardFilter：成交额低于门槛剔除', () => {
  assert.equal(hardFilter(okStock({ amount: 5e7 }), CFG, NOW).reason, '成交额不足');
});

test('hardFilter：次新股剔除', () => {
  assert.equal(hardFilter(okStock({ listDate: '20260601' }), CFG, NOW).reason, '次新股');
});

test('hardFilter：60日涨幅过热剔除', () => {
  assert.equal(hardFilter(okStock({ chg60d: 150 }), CFG, NOW).reason, '60日涨幅过热');
});

test('hardFilter：边界值不误杀（恰好等于阈值应通过）', () => {
  assert.equal(hardFilter(okStock({ amount: CFG.screenMinAmount, chg60d: CFG.screenMaxChg60d, listDate: '20260502' }), CFG, NOW).pass, true);
});

// --- rpsMap ---

test('rpsMap：百分位排名 0-100', () => {
  const stocks = [
    { code: 'a', chg60d: 10 }, { code: 'b', chg60d: 20 }, { code: 'c', chg60d: 30 },
    { code: 'd', chg60d: 40 }, { code: 'e', chg60d: 50 },
  ];
  const m = rpsMap(stocks, 'chg60d');
  assert.equal(m.get('a'), 0);
  assert.equal(m.get('c'), 50);
  assert.equal(m.get('e'), 100);
});

test('rpsMap：缺失值不参与排名', () => {
  const stocks = [{ code: 'a', chg60d: 10 }, { code: 'b' }, { code: 'c', chg60d: 30 }];
  const m = rpsMap(stocks, 'chg60d');
  assert.equal(m.has('b'), false);
  assert.equal(m.get('a'), 0);
  assert.equal(m.get('c'), 100);
});

test('rpsMap：单只股票不除零', () => {
  const m = rpsMap([{ code: 'a', chg60d: 5 }], 'chg60d');
  assert.equal(m.get('a'), 0);
});

// --- computeStrategySignals ---

test('computeStrategySignals：上升趋势五路信号偏多', () => {
  const candles = makeCandles(90, { trend: 'up' });
  const sig = computeStrategySignals(candles, CFG, emptyReport);
  assert.equal(sig.trend.conf, 1); // 站上MA60 + 站上MA20 + MACD多头
  assert.equal(sig.breakout.conf, 1); // 收盘创20日新高且收阳
  assert.ok(sig.pattern.conf === 0); // 无形态输入
});

test('computeStrategySignals：下降趋势趋势信号为 -1', () => {
  const candles = makeCandles(90, { trend: 'down' });
  const sig = computeStrategySignals(candles, CFG, emptyReport);
  assert.equal(sig.trend.conf, -1);
  assert.equal(sig.breakout.conf, -0.5); // 收盘跌破20日低点
});

test('computeStrategySignals：形态分映射到 pattern 置信度并封顶 ±1', () => {
  const candles = makeCandles(90, { trend: 'flat' });
  const bullish = { patterns: [{ dir: 'bull', weight: 20 }], murphy: { pts: 10 }, patterns_classic: { pts: 10 }, is_powei: false };
  const sig = computeStrategySignals(candles, CFG, bullish);
  assert.equal(sig.pattern.conf, 1); // (12+10+10)/15 > 1 → clip
});

// --- riskVetoes ---

test('riskVetoes：破位一票否决', () => {
  const candles = makeCandles(90, { trend: 'up' });
  const vetoes = riskVetoes(candles, { is_powei: true, powei_reason: '收盘跌破MA60' });
  assert.ok(vetoes.includes('收盘跌破MA60'));
});

test('riskVetoes：距60日高点回撤超30%否决', () => {
  const candles = makeCandles(90, { trend: 'up' });
  const peak = candles[candles.length - 2].high;
  candles[candles.length - 1] = { ...candles[candles.length - 1], close: peak * 0.6, open: peak * 0.65, high: peak * 0.66, low: peak * 0.58 };
  const vetoes = riskVetoes(candles, emptyReport);
  assert.ok(vetoes.some(v => v.includes('回撤')));
});

test('riskVetoes：健康股票无否决', () => {
  const candles = makeCandles(90, { trend: 'up' });
  assert.deepEqual(riskVetoes(candles, emptyReport), []);
});

// --- finalizeScore ---

test('finalizeScore：全多 100 / 全空 0 / 中性 50', () => {
  const all = c => ({ trend: c, rps: c, breakout: c, volcross: c, pattern: c });
  assert.equal(finalizeScore(all(1)), 100);
  assert.equal(finalizeScore(all(-1)), 0);
  assert.equal(finalizeScore(all(0)), 50);
});

test('finalizeScore：缺失信号按剩余权重归一化', () => {
  const score = finalizeScore({ trend: 1, rps: 1 }, SCREEN_WEIGHTS);
  assert.equal(score, 100);
});

test('finalizeScore：越界置信度先裁剪', () => {
  assert.equal(finalizeScore({ trend: 5, rps: -5 }), finalizeScore({ trend: 1, rps: -1 }));
  assert.equal(finalizeScore({ trend: 5, rps: 5, breakout: 5, volcross: 5, pattern: 5 }), 100);
});

test('finalizeScore：无任何有效信号返回中性 50', () => {
  assert.equal(finalizeScore({}), 50);
});

// --- universe mapRow / validRow ---

test('mapRow：东财字段正确映射', () => {
  const s = mapRow({
    f12: '600519', f13: 1, f14: '贵州茅台', f2: 1500.5, f3: 1.2, f6: 5e9,
    f8: 0.5, f10: 1.1, f20: 2e12, f21: 2e12, f24: 15.5, f25: 20.1, f26: 20010827,
  });
  assert.equal(s.code, '600519');
  assert.equal(s.market, 'sh');
  assert.equal(s.name, '贵州茅台');
  assert.equal(s.price, 1500.5);
  assert.equal(s.amount, 5e9);
  assert.equal(s.chg60d, 15.5);
  assert.equal(s.listDate, '20010827');
});

test('validRow：只保留沪深A股代码段且有成交', () => {
  assert.equal(validRow({ code: '600519', price: 10 }), true);
  assert.equal(validRow({ code: '300750', price: 10 }), true);
  assert.equal(validRow({ code: '002594', price: 10 }), true);
  assert.equal(validRow({ code: '830799', price: 10 }), false); // 北交所
  assert.equal(validRow({ code: '600519', price: 0 }), false);  // 停牌
});

test('PAGE_SIZE：服务端单页上限为 100', () => {
  assert.equal(PAGE_SIZE, 100);
});

// --- validateConfig 新增字段 ---

test('validateConfig：智能选股参数合法值通过', () => {
  const { errors, config } = validateConfig({ screenRpsMin: 90, screenTopK: 15, screenMinAmount: 2e8 });
  assert.equal(errors.length, 0);
  assert.equal(config.screenRpsMin, 90);
});

test('validateConfig：越界与非整数被拒', () => {
  assert.ok(validateConfig({ screenRpsMin: 200 }).errors.length > 0);
  assert.ok(validateConfig({ screenRpsMin: 10 }).errors.length > 0);
  assert.ok(validateConfig({ screenTopK: 2.5 }).errors.length > 0);
  assert.ok(validateConfig({ screenMaxCandidates: 10 }).errors.length > 0);
  assert.ok(validateConfig({ screenMinListDays: 0 }).errors.length > 0);
  assert.ok(validateConfig({ screenMaxChg60d: 600 }).errors.length > 0);
});

test('validateConfig：默认配置包含全部智能选股字段', () => {
  const { merged } = validateConfig({});
  for (const key of ['screenMinAmount', 'screenMinListDays', 'screenRpsMin', 'screenMaxCandidates', 'screenTopK', 'screenMaxChg60d']) {
    assert.ok(Number.isFinite(merged[key]), `缺少默认值：${key}`);
  }
});
