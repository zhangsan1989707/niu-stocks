/**
 * 多周期分析 — P2-3
 * 将日线聚合为周线/月线，在各周期上运行关键指标，
 * 判断日/周/月三个级别的趋势是否共振
 */

const { average, ema } = require('../helpers');

/**
 * 将日K线聚合为周K线
 * 按自然周（周一到周日）聚合
 */
function toWeekly(daily) {
  if (!daily || daily.length === 0) return [];
  const weeks = [];
  let cur = null;

  for (const d of daily) {
    const date = new Date(d.date);
    const dayOfWeek = date.getDay(); // 0=周日, 1=周一
    // ISO 周一 = 1，周日归到上周
    const weekStart = new Date(date);
    const offset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    weekStart.setDate(date.getDate() + offset);
    const weekKey = `${weekStart.getFullYear()}-${String(weekStart.getMonth() + 1).padStart(2, '0')}-${String(weekStart.getDate()).padStart(2, '0')}`;

    if (!cur || cur._key !== weekKey) {
      if (cur) delete cur._key;
      cur = { date: weekKey, open: d.open, close: d.close, high: d.high, low: d.low, volume: d.volume, _key: weekKey };
      weeks.push(cur);
    } else {
      cur.close = d.close;
      cur.high = Math.max(cur.high, d.high);
      cur.low = Math.min(cur.low, d.low);
      cur.volume += d.volume;
    }
  }
  if (cur) delete cur._key;
  return weeks;
}

/**
 * 将日K线聚合为月K线
 */
function toMonthly(daily) {
  if (!daily || daily.length === 0) return [];
  const months = [];
  let cur = null;

  for (const d of daily) {
    const date = new Date(d.date);
    const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

    if (!cur || cur._key !== monthKey) {
      if (cur) delete cur._key;
      cur = { date: monthKey, open: d.open, close: d.close, high: d.high, low: d.low, volume: d.volume, _key: monthKey };
      months.push(cur);
    } else {
      cur.close = d.close;
      cur.high = Math.max(cur.high, d.high);
      cur.low = Math.min(cur.low, d.low);
      cur.volume += d.volume;
    }
  }
  if (cur) delete cur._key;
  return months;
}

/**
 * 在单个周期上运行关键指标
 * 返回该周期的趋势判断
 */
function analyzePeriod(candles, label) {
  if (!candles || candles.length < 30) {
    return { label, sufficient: false, note: '数据不足' };
  }

  const closes = candles.map(c => c.close);
  const last = candles[candles.length - 1];

  const ma5 = average(closes, Math.min(5, closes.length));
  const ma10 = average(closes, Math.min(10, closes.length));
  const ma20 = average(closes, Math.min(20, closes.length));

  const fast = ema(closes, 6);
  const slow = ema(closes, 13);
  const macd = fast.map((x, i) => x - slow[i]);
  const signal = ema(macd, 5);
  const macdUp = macd[macd.length - 1] >= signal[signal.length - 1];
  const prevMacdUp = macd[macd.length - 2] >= signal[signal.length - 2];
  const macdCross = macdUp !== prevMacdUp ? (macdUp ? '金叉' : '死叉') : (macdUp ? '多头' : '空头');

  const aboveMA = last.close >= ma20;
  const maAlign = ma5 >= ma10 && ma10 >= ma20 ? '多头排列' : ma5 <= ma10 && ma10 <= ma20 ? '空头排列' : '交叉排列';

  // RSI(14)
  const changes = closes.slice(-15).map((x, i, arr) => i ? x - arr[i - 1] : 0).slice(1);
  const gains = changes.map(x => Math.max(x, 0));
  const losses = changes.map(x => Math.max(-x, 0));
  const rsiVal = average(gains, 14) / (average(losses, 14) || 0.0001);
  const rsi = Math.round((100 - 100 / (1 + rsiVal)) * 10) / 10;

  // 综合判断
  let trend;
  if (aboveMA && macdUp) trend = '偏多';
  else if (!aboveMA && !macdUp) trend = '偏空';
  else trend = '中性';

  return {
    label,
    sufficient: true,
    close: Math.round(last.close * 100) / 100,
    ma5: Math.round(ma5 * 100) / 100,
    ma20: Math.round(ma20 * 100) / 100,
    macdCross,
    macdUp,
    aboveMA,
    maAlign,
    rsi,
    trend,
  };
}

/**
 * 多周期综合分析
 * @param {Array} dailyCandles - 日K线数据
 * @returns {Object} 多周期分析结果
 */
function multiPeriodAnalysis(dailyCandles) {
  if (!dailyCandles || dailyCandles.length < 30) {
    return { ok: true, sufficient: false, note: '数据不足，至少需要 30 根日K线' };
  }

  const weekly = toWeekly(dailyCandles);
  const monthly = toMonthly(dailyCandles);

  const dayResult = analyzePeriod(dailyCandles, '日线');
  const weekResult = analyzePeriod(weekly, '周线');
  const monthResult = analyzePeriod(monthly, '月线');

  const periods = [dayResult, weekResult, monthResult];
  const validPeriods = periods.filter(p => p.sufficient);

  if (validPeriods.length < 2) {
    return { ok: true, sufficient: false, note: '周线/月线数据不足', periods };
  }

  const bulls = validPeriods.filter(p => p.trend === '偏多').length;
  const bears = validPeriods.filter(p => p.trend === '偏空').length;
  const neutrals = validPeriods.length - bulls - bears;

  let alignment, verdict, cls;
  if (bulls === validPeriods.length) {
    alignment = '全面看多';
    verdict = `${validPeriods.length} 个周期全部偏多，趋势高度共振，多头信号可信度较高。`;
    cls = 'green';
  } else if (bears === validPeriods.length) {
    alignment = '全面看空';
    verdict = `${validPeriods.length} 个周期全部偏空，下跌趋势共振，风险较高。`;
    cls = 'red';
  } else if (bulls > bears && bulls >= 2) {
    alignment = '多数偏多';
    verdict = `多数周期偏多（${bulls}多/${bears}空/${neutrals}中），大方向偏多但存在级别分歧。`;
    cls = 'green';
  } else if (bears > bulls && bears >= 2) {
    alignment = '多数偏空';
    verdict = `多数周期偏空（${bulls}多/${bears}空/${neutrals}中），大方向偏空但存在级别分歧。`;
    cls = 'red';
  } else {
    alignment = '多空分歧';
    verdict = '各周期方向不一致，常见于趋势转折期，建议等待方向明朗后再操作。';
    cls = 'yellow';
  }

  return {
    ok: true,
    sufficient: true,
    periods,
    bulls,
    bears,
    neutrals,
    alignment,
    verdict,
    cls,
    disclaimer: '多周期分析基于技术指标，仅供参考，不构成投资建议。',
  };
}

module.exports = { toWeekly, toMonthly, analyzePeriod, multiPeriodAnalysis };
