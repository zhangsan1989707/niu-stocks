/**
 * 29 种蜡烛形态识别
 * 基于《日本蜡烛图技术》经典形态定义
 */

/**
 * 检测单根 K 线的实体大小和上下影线
 */
function candleStats(c) {
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low || 0.0001;
  const upperShadow = c.high - Math.max(c.open, c.close);
  const lowerShadow = Math.min(c.open, c.close) - c.low;
  const isBull = c.close >= c.open;
  const bodyPct = body / range;
  const isDoji = bodyPct < 0.1;       // 实体极小 → 十字星
  const isSmallBody = bodyPct < 0.3 && bodyPct >= 0.1;
  return { body, range, upperShadow, lowerShadow, isBull, isDoji, isSmallBody, bodyPct };
}

/**
 * 检测吞没形态：当前 K 线实体完全覆盖前一根实体
 */
function isEngulfing(prev, curr) {
  const prevBody = Math.abs(prev.close - prev.open);
  const currBody = Math.abs(curr.close - curr.open);
  if (currBody <= prevBody) return null;
  const prevBull = prev.close >= prev.open;
  const currBull = curr.close >= curr.open;
  if (prevBull && !currBull) return { name: '看跌吞没', dir: 'bear', weight: 3 };
  if (!prevBull && currBull) return { name: '看涨吞没', dir: 'bull', weight: 3 };
  return null;
}

/**
 * 乌云盖顶：上升趋势中，前一根阳线后，当前 K 线开盘高于前一根最高价，
 * 收盘深入前一根实体下半部
 */
function isDarkCloudCover(prev, curr) {
  if (prev.close < prev.open) return null; // 前一根须为阳线
  if (curr.close >= curr.open) return null; // 当前须为阴线
  const prevMid = (prev.open + prev.close) / 2;
  if (curr.open > prev.high && curr.close < prevMid && curr.close > prev.open) {
    return { name: '乌云盖顶', dir: 'bear', weight: 2 };
  }
  return null;
}

/**
 * 刺透形态：下降趋势中，前一根阴线后，当前 K 线开盘低于前一根最低价，
 * 收收盘深入前一根实体上半部
 */
function isPiercing(prev, curr) {
  if (prev.close > prev.open) return null; // 前一根须为阴线
  if (curr.close <= curr.open) return null; // 当前须为阳线
  const prevMid = (prev.open + prev.close) / 2;
  if (curr.open < prev.low && curr.close > prevMid && curr.close < prev.open) {
    return { name: '刺透形态', dir: 'bull', weight: 2 };
  }
  return null;
}

/**
 * 反击线：两根 K 线收盘价相同但方向相反
 */
function isCounterattack(prev, curr) {
  const prevBull = prev.close >= prev.open;
  const currBull = curr.close >= curr.open;
  if (prevBull === currBull) return null;
  if (Math.abs(prev.close - curr.close) / (prev.close || 1) < 0.002) {
    return prevBull
      ? { name: '看跌反击线', dir: 'bear', weight: 2 }
      : { name: '看涨反击线', dir: 'bull', weight: 2 };
  }
  return null;
}

/**
 * 锤子线：下降趋势中，小实体居于高位，下影线 ≥ 2 倍实体，无/极短上影线
 */
function isHammer(c, prevCandle) {
  if (prevCandle && prevCandle.close < prevCandle.open) { // 前一根须阴线（下降趋势）
    const s = candleStats(c);
    if (s.lowerShadow >= 2 * s.body && s.upperShadow <= s.body * 0.5 && !s.isDoji) {
      return { name: '锤子线', dir: 'bull', weight: 2 };
    }
  }
  // 无前一根趋势参照时也检测
  const s = candleStats(c);
  if (s.lowerShadow >= 2 * s.body && s.upperShadow <= s.body * 0.5 && !s.isDoji) {
    return { name: '锤子线', dir: 'bull', weight: 2 };
  }
  return null;
}

/**
 * 上吊线：上升趋势中，小实体居于高位，下影线长，上影线短
 */
function isHangingMan(c, prevCandle) {
  if (prevCandle && prevCandle.close >= prevCandle.open) { // 前一根须阳线（上升趋势）
    const s = candleStats(c);
    if (s.lowerShadow >= 2 * s.body && s.upperShadow <= s.body * 0.5 && !s.isDoji) {
      return { name: '上吊线', dir: 'bear', weight: 2 };
    }
  }
  const s = candleStats(c);
  if (s.lowerShadow >= 2 * s.body && s.upperShadow <= s.body * 0.5 && !s.isDoji) {
    return { name: '上吊线', dir: 'bear', weight: 1 };
  }
  return null;
}

/**
 * 倒锤子：下降趋势中，小实体居于低位，上影线长，无/极短下影线
 */
function isInvertedHammer(c, prevCandle) {
  const s = candleStats(c);
  if (s.upperShadow >= 2 * s.body && s.lowerShadow <= s.body * 0.5 && !s.isDoji) {
    return { name: '倒锤子', dir: 'bull', weight: 1 };
  }
  return null;
}

/**
 * 流星线：上升趋势中，小实体居于低位，上影线长，无/极短下影线
 */
function isShootingStar(c, prevCandle) {
  const s = candleStats(c);
  if (s.upperShadow >= 2 * s.body && s.lowerShadow <= s.body * 0.5 && !s.isDoji) {
    return { name: '流星线', dir: 'bear', weight: 2 };
  }
  return null;
}

/**
 * 十字系列检测
 */
function detectDoji(c, candles, idx) {
  const s = candleStats(c);
  if (!s.isDoji) return null;

  const prev = idx > 0 ? candles[idx - 1] : null;
  const inUptrend = prev && prev.close >= prev.open;

  // 墓碑十字：开盘收盘在最低点附近，上影线很长
  if (s.upperShadow > 2 * s.body && s.lowerShadow < s.body * 0.3) {
    return { name: '墓碑十字', dir: 'bear', weight: 2 };
  }
  // 蜻蜓十字：开盘收盘在最高点附近，下影线很长
  if (s.lowerShadow > 2 * s.body && s.upperShadow < s.body * 0.3) {
    return { name: '蜻蜓十字', dir: 'bull', weight: 2 };
  }
  // 顶部十字星：上升趋势后出现十字星
  if (inUptrend) {
    return { name: '顶部十字星', dir: 'bear', weight: 1 };
  }
  // 底部十字星：下降趋势后出现十字星
  if (prev && prev.close < prev.open) {
    return { name: '底部十字星', dir: 'bull', weight: 1 };
  }
  // 普通十字星
  return { name: '十字星', dir: 'neutral', weight: 1 };
}

/**
 * 高位小实体：高位出现实体很小的 K 线
 */
function detectHighSmallBody(c, candles, idx) {
  if (idx < 5) return null;
  const s = candleStats(c);
  if (!s.isSmallBody) return null;
  const recent5 = candles.slice(Math.max(0, idx - 5), idx);
  const avgClose = recent5.reduce((a, b) => a + b.close, 0) / recent5.length;
  if (c.close > avgClose * 1.02) {
    return { name: '高位小实体', dir: 'neutral', weight: 1 };
  }
  return null;
}

/**
 * 孕线：当前 K 线实体完全在前一根实体范围内
 */
function detectHarami(prev, curr) {
  const prevBody = Math.abs(prev.close - prev.open);
  const currBody = Math.abs(curr.close - curr.open);
  if (currBody >= prevBody) return null;

  const prevHigh = Math.max(prev.open, prev.close);
  const prevLow = Math.min(prev.open, prev.close);
  const currHigh = Math.max(curr.open, curr.close);
  const currLow = Math.min(curr.open, curr.close);

  if (currHigh <= prevHigh && currLow >= prevLow) {
    const prevBull = prev.close >= prev.open;
    const s = candleStats(curr);
    if (s.isDoji) {
      return { name: '十字孕线', dir: 'bear', weight: 2 };
    }
    return prevBull
      ? { name: '看跌孕线', dir: 'bear', weight: 1 }
      : { name: '看涨孕线', dir: 'bull', weight: 1 };
  }
  return null;
}

/**
 * 黄昏星：三根 K 线，阳线 + 小实体（跳空高开）+ 阴线（深入第一根实体）
 */
function isEveningStar(candles, idx) {
  if (idx < 2) return null;
  const first = candles[idx - 2];
  const second = candles[idx - 1];
  const third = candles[idx];

  if (!(first.close >= first.open)) return null; // 第一根须阳线
  if (Math.abs(second.close - second.open) / (first.close - first.open + 0.0001) > 0.5) return null; // 第二根小实体
  if (second.close > first.close && !(third.close <= curr_open(first))) {} // 跳空条件放宽
  if (third.close >= third.open) return null; // 第三根须阴线
  if (third.close < (first.open + first.close) / 2) {
    return { name: '黄昏星', dir: 'bear', weight: 3 };
  }
  return null;
}

function curr_open(c) { return c.open; }

/**
 * 启明星：三根 K 线，阴线 + 小实体（跳空低开）+ 阳线（深入第一根实体）
 */
function isMorningStar(candles, idx) {
  if (idx < 2) return null;
  const first = candles[idx - 2];
  const second = candles[idx - 1];
  const third = candles[idx];

  if (!(first.close < first.open)) return null; // 第一根须阴线
  if (Math.abs(second.close - second.open) / (first.open - first.close + 0.0001) > 0.5) return null; // 第二根小实体
  if (third.close <= third.open) return null; // 第三根须阳线
  if (third.close > (first.open + first.close) / 2) {
    return { name: '启明星', dir: 'bull', weight: 3 };
  }
  return null;
}

/**
 * 三只乌鸦：连续三根阴线，每根收盘价递减
 */
function isThreeBlackCrows(candles, idx) {
  if (idx < 2) return null;
  const c1 = candles[idx - 2], c2 = candles[idx - 1], c3 = candles[idx];
  if (c1.close >= c1.open || c2.close >= c2.open || c3.close >= c3.open) return null;
  if (c2.close < c1.close && c3.close < c2.close) {
    return { name: '三只乌鸦', dir: 'bear', weight: 3 };
  }
  return null;
}

/**
 * 白色三兵：连续三根阳线，每根收盘价递增
 */
function isThreeWhiteSoldiers(candles, idx) {
  if (idx < 2) return null;
  const c1 = candles[idx - 2], c2 = candles[idx - 1], c3 = candles[idx];
  if (c1.close < c1.open || c2.close < c2.open || c3.close < c3.open) return null;
  if (c2.close > c1.close && c3.close > c2.close) {
    return { name: '白色三兵', dir: 'bull', weight: 3 };
  }
  return null;
}

/**
 * 上升三法：阳 + 三根小阴 + 阳，整体在第一根阳线范围内
 */
function isRisingThreeMethods(candles, idx) {
  if (idx < 4) return null;
  const c1 = candles[idx - 4], c5 = candles[idx];
  if (!(c1.close >= c1.open) || !(c5.close >= c5.open)) return null;
  const c1High = Math.max(c1.open, c1.close);
  const c1Low = Math.min(c1.open, c1.close);
  for (let i = 1; i <= 3; i++) {
    const c = candles[idx - 4 + i];
    if (c.close >= c.open) return null; // 中间三根须阴线
    if (c.close > c1High || c.open < c1Low) return null; // 须在第一根范围内
  }
  if (c5.close > c1.close) {
    return { name: '上升三法', dir: 'bull', weight: 2 };
  }
  return null;
}

/**
 * 下降三法：阴 + 三根小阳 + 阴，整体在第一根阴线范围内
 */
function isFallingThreeMethods(candles, idx) {
  if (idx < 4) return null;
  const c1 = candles[idx - 4], c5 = candles[idx];
  if (!(c1.close < c1.open) || !(c5.close < c5.open)) return null;
  const c1High = Math.max(c1.open, c1.close);
  const c1Low = Math.min(c1.open, c1.close);
  for (let i = 1; i <= 3; i++) {
    const c = candles[idx - 4 + i];
    if (c.close < c.open) return null; // 中间三根须阳线
    if (c.close > c1High || c.open < c1Low) return null;
  }
  if (c5.close < c1.close) {
    return { name: '下降三法', dir: 'bear', weight: 2 };
  }
  return null;
}

/**
 * 平头顶：连续两根 K 线最高价相同
 */
function isTweezerTop(prev, curr) {
  if (Math.abs(prev.high - curr.high) / (prev.high || 1) < 0.002) {
    return { name: '平头顶', dir: 'bear', weight: 1 };
  }
  return null;
}

/**
 * 平头底：连续两根 K 线最低价相同
 */
function isTweezerBottom(prev, curr) {
  if (Math.abs(prev.low - curr.low) / (prev.low || 1) < 0.002) {
    return { name: '平头底', dir: 'bull', weight: 1 };
  }
  return null;
}

/**
 * 向上跳空缺口：当前最低价高于前一根最高价
 */
function isUpGap(prev, curr) {
  if (curr.low > prev.high) {
    return { name: '向上跳空缺口', dir: 'bull', weight: 2 };
  }
  return null;
}

/**
 * 向下跳空缺口：当前最高价低于前一根最低价
 */
function isDownGap(prev, curr) {
  if (curr.high < prev.low) {
    return { name: '向下跳空缺口', dir: 'bear', weight: 2 };
  }
  return null;
}

/**
 * 主函数：扫描最近 N 根 K 线，返回命中的所有形态
 * @param {Array<{date,open,close,high,low,volume}>} candles
 * @returns {Array<{name,dir,weight}>}
 */
function detectPatterns(candles) {
  if (!candles || candles.length < 2) return [];
  const len = candles.length;
  const results = [];
  const seen = new Set(); // 去重：同一种形态在同一位置只取一次

  // 只检测最后 5 根 K 线（大部分形态最多需要 5 根）
  const startIdx = Math.max(0, len - 5);

  for (let i = startIdx; i < len; i++) {
    const c = candles[i];
    const prev = i > 0 ? candles[i - 1] : null;
    const s = candleStats(c);

    // --- 双 K 线形态 ---
    if (prev) {
      const two = [
        isEngulfing(prev, c),
        isDarkCloudCover(prev, c),
        isPiercing(prev, c),
        isCounterattack(prev, c),
        isUpGap(prev, c),
        isDownGap(prev, c),
        isTweezerTop(prev, c),
        isTweezerBottom(prev, c),
        detectHarami(prev, c),
      ];
      for (const r of two) {
        if (r && !seen.has(r.name)) {
          results.push(r);
          seen.add(r.name);
        }
      }

      // 锤子线/上吊线（需要前一根判断趋势）
      const hammer = isHammer(c, prev);
      if (hammer && !seen.has(hammer.name)) { results.push(hammer); seen.add(hammer.name); }

      const hanging = isHangingMan(c, prev);
      if (hanging && !seen.has(hanging.name)) { results.push(hanging); seen.add(hanging.name); }
    }

    // --- 单 K 线形态 ---
    const inverted = isInvertedHammer(c, prev);
    if (inverted && !seen.has(inverted.name)) { results.push(inverted); seen.add(inverted.name); }

    const shooting = isShootingStar(c, prev);
    if (shooting && !seen.has(shooting.name)) { results.push(shooting); seen.add(shooting.name); }

    const doji = detectDoji(c, candles, i);
    if (doji && !seen.has(doji.name)) { results.push(doji); seen.add(doji.name); }

    const highSmall = detectHighSmallBody(c, candles, i);
    if (highSmall && !seen.has(highSmall.name)) { results.push(highSmall); seen.add(highSmall.name); }

    // --- 三 K 线形态 ---
    if (i >= 2) {
      const three = [
        isEveningStar(candles, i),
        isMorningStar(candles, i),
        isThreeBlackCrows(candles, i),
        isThreeWhiteSoldiers(candles, i),
      ];
      for (const r of three) {
        if (r && !seen.has(r.name)) {
          results.push(r);
          seen.add(r.name);
        }
      }
    }

    // --- 五 K 线形态 ---
    if (i >= 4) {
      const five = [
        isRisingThreeMethods(candles, i),
        isFallingThreeMethods(candles, i),
      ];
      for (const r of five) {
        if (r && !seen.has(r.name)) {
          results.push(r);
          seen.add(r.name);
        }
      }
    }
  }

  return results;
}

module.exports = { detectPatterns, candleStats, PATTERNS_TOTAL: 29 };
