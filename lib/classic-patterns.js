/**
 * 经典图表形态识别
 * 头肩顶/底、双顶/底、三重顶/底、三角形、矩形（箱体）
 * 基于局部极值点（zigzag）判断
 */

/**
 * Zigzag 算法：找出局部极值点（峰和谷）
 * @param {Array<{close,high,low}>} candles
 * @param {number} threshold - 最小波动幅度（默认 3%）
 * @returns {Array<{index, price, type: 'peak'|'valley'}>}
 */
function zigzag(candles, threshold = 0.03) {
  if (candles.length < 5) return [];
  const pivots = [];
  // 找初始方向
  let startIdx = 0;
  let startHigh = candles[0].high;
  let startLow = candles[0].low;
  let dir = 0; // 1=找峰, -1=找谷

  // 先确定初始趋势
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].high > startLow * (1 + threshold)) { dir = 1; break; }
    if (candles[i].low < startHigh * (1 - threshold)) { dir = -1; break; }
    if (candles[i].high > startHigh) startHigh = candles[i].high;
    if (candles[i].low < startLow) startLow = candles[i].low;
    startIdx = i;
  }
  if (dir === 0) return [{ index: 0, price: startHigh, type: 'peak' }];

  // 初始极值点
  if (dir === 1) {
    pivots.push({ index: startIdx, price: startLow, type: 'valley' });
  } else {
    pivots.push({ index: startIdx, price: startHigh, type: 'peak' });
  }

  let currentPrice = dir === 1 ? startHigh : startLow;
  let currentIndex = startIdx;

  for (let i = startIdx + 1; i < candles.length; i++) {
    if (dir === 1) {
      // 找峰
      if (candles[i].high > currentPrice) {
        currentPrice = candles[i].high;
        currentIndex = i;
      } else if (candles[i].low < currentPrice * (1 - threshold)) {
        // 确认峰，转向
        pivots.push({ index: currentIndex, price: currentPrice, type: 'peak' });
        dir = -1;
        currentPrice = candles[i].low;
        currentIndex = i;
      }
    } else {
      // 找谷
      if (candles[i].low < currentPrice) {
        currentPrice = candles[i].low;
        currentIndex = i;
      } else if (candles[i].high > currentPrice * (1 + threshold)) {
        // 确认谷，转向
        pivots.push({ index: currentIndex, price: currentPrice, type: 'valley' });
        dir = 1;
        currentPrice = candles[i].high;
        currentIndex = i;
      }
    }
  }
  // 加最后一个未确认的极值
  if (pivots.length === 0 || pivots[pivots.length - 1].index !== currentIndex) {
    pivots.push({ index: currentIndex, price: currentPrice, type: dir === 1 ? 'peak' : 'valley' });
  }
  return pivots;
}

/**
 * 检测头肩顶
 * 峰-更高峰-峰（中间最高），左右肩大致对称
 */
function detectHeadShouldersTop(pivots) {
  if (pivots.length < 5) return null;
  // 取最后 5 个极值点，找 3 峰 2 谷模式
  const peaks = pivots.filter(p => p.type === 'peak').slice(-3);
  const valleys = pivots.filter(p => p.type === 'valley').slice(-2);
  if (peaks.length < 3 || valleys.length < 2) return null;

  const [left, head, right] = peaks;
  // 头部最高，左右肩低于头部
  if (head.price > left.price && head.price > right.price &&
      left.price > head.price * 0.9 && right.price > head.price * 0.9) {
    // 颈线 = 两谷连线
    const neckline = Math.min(valleys[0].price, valleys[1].price);
    const confirmed = pivots[pivots.length - 1].type === 'valley' &&
                      pivots[pivots.length - 1].price < neckline;
    return {
      name: '头肩顶',
      dir: 'bear',
      confirmed,
      plain: confirmed ? `头部 ${head.price.toFixed(2)}，颈线 ${neckline.toFixed(2)} 已跌破` : `头部 ${head.price.toFixed(2)}，颈线 ${neckline.toFixed(2)} 成型中`,
      pts: confirmed ? -10 : -3
    };
  }
  return null;
}

/**
 * 检测头肩底
 * 谷-更低谷-谷（中间最低），左右肩大致对称
 */
function detectHeadShouldersBottom(pivots) {
  if (pivots.length < 5) return null;
  const valleys = pivots.filter(p => p.type === 'valley').slice(-3);
  const peaks = pivots.filter(p => p.type === 'peak').slice(-2);
  if (valleys.length < 3 || peaks.length < 2) return null;

  const [left, head, right] = valleys;
  if (head.price < left.price && head.price < right.price &&
      left.price < head.price * 1.1 && right.price < head.price * 1.1) {
    const neckline = Math.max(peaks[0].price, peaks[1].price);
    const confirmed = pivots[pivots.length - 1].type === 'peak' &&
                      pivots[pivots.length - 1].price > neckline;
    return {
      name: '头肩底',
      dir: 'bull',
      confirmed,
      plain: confirmed ? `头部 ${head.price.toFixed(2)}，颈线 ${neckline.toFixed(2)} 已突破` : `头部 ${head.price.toFixed(2)}，颈线 ${neckline.toFixed(2)} 成型中`,
      pts: confirmed ? 10 : 3
    };
  }
  return null;
}

/**
 * 检测双顶
 * 两个相近高度的峰，中间有一个谷
 */
function detectDoubleTop(pivots) {
  const peaks = pivots.filter(p => p.type === 'peak').slice(-2);
  const valleys = pivots.filter(p => p.type === 'valley').slice(-1);
  if (peaks.length < 2 || valleys.length < 1) return null;

  const [p1, p2] = peaks;
  const tolerance = 0.02; // 2% 容差
  if (Math.abs(p1.price - p2.price) / Math.max(p1.price, p2.price) < tolerance) {
    const neckline = valleys[0].price;
    const confirmed = pivots[pivots.length - 1].price < neckline &&
                      pivots[pivots.length - 1].type === 'valley';
    return {
      name: '双顶',
      dir: 'bear',
      confirmed,
      plain: confirmed ? `双顶 ${p1.price.toFixed(2)}/${p2.price.toFixed(2)}，颈线 ${neckline.toFixed(2)} 已跌破` : `双顶 ${p1.price.toFixed(2)}/${p2.price.toFixed(2)}，颈线 ${neckline.toFixed(2)} 成型中`,
      pts: confirmed ? -10 : -3
    };
  }
  return null;
}

/**
 * 检测双底
 * 两个相近高度的谷，中间有一个峰
 */
function detectDoubleBottom(pivots) {
  const valleys = pivots.filter(p => p.type === 'valley').slice(-2);
  const peaks = pivots.filter(p => p.type === 'peak').slice(-1);
  if (valleys.length < 2 || peaks.length < 1) return null;

  const [v1, v2] = valleys;
  const tolerance = 0.02;
  if (Math.abs(v1.price - v2.price) / Math.max(v1.price, v2.price) < tolerance) {
    const neckline = peaks[0].price;
    const confirmed = pivots[pivots.length - 1].price > neckline;
    return {
      name: '双底',
      dir: 'bull',
      confirmed,
      plain: confirmed ? `双底 ${v1.price.toFixed(2)}/${v2.price.toFixed(2)}，颈线 ${neckline.toFixed(2)} 已突破` : `双底 ${v1.price.toFixed(2)}/${v2.price.toFixed(2)}，颈线 ${neckline.toFixed(2)} 成型中`,
      pts: confirmed ? 10 : 3
    };
  }
  return null;
}

/**
 * 检测三重顶
 * 三个相近高度的峰
 */
function detectTripleTop(pivots) {
  const peaks = pivots.filter(p => p.type === 'peak').slice(-3);
  if (peaks.length < 3) return null;
  const tolerance = 0.025;
  const avg = (peaks[0].price + peaks[1].price + peaks[2].price) / 3;
  if (peaks.every(p => Math.abs(p.price - avg) / avg < tolerance)) {
    const lastValley = pivots.filter(p => p.type === 'valley').slice(-1)[0];
    const neckline = lastValley ? lastValley.price : avg * 0.97;
    const confirmed = pivots[pivots.length - 1].price < neckline;
    return {
      name: '三重顶',
      dir: 'bear',
      confirmed,
      plain: confirmed ? `三重顶 ${avg.toFixed(2)}，颈线 ${neckline.toFixed(2)} 已跌破` : `三重顶 ${avg.toFixed(2)}，成型中`,
      pts: confirmed ? -10 : -3
    };
  }
  return null;
}

/**
 * 检测三重底
 * 三个相近高度的谷
 */
function detectTripleBottom(pivots) {
  const valleys = pivots.filter(p => p.type === 'valley').slice(-3);
  if (valleys.length < 3) return null;
  const tolerance = 0.025;
  const avg = (valleys[0].price + valleys[1].price + valleys[2].price) / 3;
  if (valleys.every(v => Math.abs(v.price - avg) / avg < tolerance)) {
    const lastPeak = pivots.filter(p => p.type === 'peak').slice(-1)[0];
    const neckline = lastPeak ? lastPeak.price : avg * 1.03;
    const confirmed = pivots[pivots.length - 1].price > neckline;
    return {
      name: '三重底',
      dir: 'bull',
      confirmed,
      plain: confirmed ? `三重底 ${avg.toFixed(2)}，颈线 ${neckline.toFixed(2)} 已突破` : `三重底 ${avg.toFixed(2)}，成型中`,
      pts: confirmed ? 10 : 3
    };
  }
  return null;
}

/**
 * 检测三角形（上升/下降/对称）
 * 峰逐渐降低，谷逐渐升高 → 对称三角形
 * 峰平齐，谷逐渐升高 → 上升三角形（偏多）
 * 谷平齐，峰逐渐降低 → 下降三角形（偏空）
 */
function detectTriangle(pivots) {
  const peaks = pivots.filter(p => p.type === 'peak').slice(-3);
  const valleys = pivots.filter(p => p.type === 'valley').slice(-3);
  if (peaks.length < 2 || valleys.length < 2) return null;

  const peaksDescending = peaks.every((p, i, arr) => i === 0 || p.price < arr[i - 1].price * 1.005);
  const valleysAscending = valleys.every((v, i, arr) => i === 0 || v.price > arr[i - 1].price * 0.995);
  const peaksFlat = peaks.every(p => Math.abs(p.price - peaks[0].price) / peaks[0].price < 0.02);
  const valleysFlat = valleys.every(v => Math.abs(v.price - valleys[0].price) / valleys[0].price < 0.02);

  const last = pivots[pivots.length - 1];
  const lastPrice = last.price;

  if (peaksFlat && valleysAscending) {
    // 上升三角形：峰平齐，谷升高 → 偏多
    const confirmed = lastPrice > peaks[0].price;
    return {
      name: '上升三角形',
      dir: 'bull',
      confirmed,
      plain: confirmed ? `突破上沿 ${peaks[0].price.toFixed(2)}` : `上沿 ${peaks[0].price.toFixed(2)}，下沿上升中`,
      pts: confirmed ? 8 : 3
    };
  }
  if (valleysFlat && peaksDescending) {
    // 下降三角形：谷平齐，峰降低 → 偏空
    const confirmed = lastPrice < valleys[0].price;
    return {
      name: '下降三角形',
      dir: 'bear',
      confirmed,
      plain: confirmed ? `跌破下沿 ${valleys[0].price.toFixed(2)}` : `下沿 ${valleys[0].price.toFixed(2)}，上沿下降中`,
      pts: confirmed ? -8 : -3
    };
  }
  if (peaksDescending && valleysAscending) {
    // 对称三角形
    const confirmed = last.type === 'peak' ? lastPrice > peaks[0].price : lastPrice < valleys[0].price;
    const dir = last.type === 'peak' ? 'bull' : 'bear';
    return {
      name: '对称三角形',
      dir: confirmed ? dir : 'neutral',
      confirmed,
      plain: confirmed ? `已突破` : `收敛中，峰降谷升`,
      pts: confirmed ? (dir === 'bull' ? 5 : -5) : 0
    };
  }
  return null;
}

/**
 * 检测矩形/箱体
 * 价格在水平区间内反复震荡，峰和谷各自大致平齐
 */
function detectRectangle(pivots) {
  const peaks = pivots.filter(p => p.type === 'peak').slice(-2);
  const valleys = pivots.filter(p => p.type === 'valley').slice(-2);
  if (peaks.length < 2 || valleys.length < 2) return null;

  const tolerance = 0.03;
  const peaksFlat = Math.abs(peaks[0].price - peaks[1].price) / Math.max(peaks[0].price, peaks[1].price) < tolerance;
  const valleysFlat = Math.abs(valleys[0].price - valleys[1].price) / Math.max(valleys[0].price, valleys[1].price) < tolerance;

  if (peaksFlat && valleysFlat) {
    const upper = (peaks[0].price + peaks[1].price) / 2;
    const lower = (valleys[0].price + valleys[1].price) / 2;
    const last = pivots[pivots.length - 1];
    const confirmed = last.price > upper || last.price < lower;
    const dir = last.price > upper ? 'bull' : last.price < lower ? 'bear' : 'neutral';
    return {
      name: '矩形/箱体',
      dir: confirmed ? dir : 'neutral',
      confirmed,
      plain: confirmed ? `突破${dir === 'bull' ? '上沿' : '下沿'} ${dir === 'bull' ? upper.toFixed(2) : lower.toFixed(2)}` : `箱体 ${lower.toFixed(2)}-${upper.toFixed(2)} 震荡`,
      pts: confirmed ? (dir === 'bull' ? 5 : dir === 'bear' ? -5 : 0) : 0
    };
  }
  return null;
}

/**
 * 主函数：检测经典图表形态
 * @param {Array<{open,close,high,low,volume}>} candles
 * @returns {{ok:boolean, patterns:Array, pts:number}}
 */
function detectClassicPatterns(candles) {
  if (!candles || candles.length < 30) {
    return { ok: false, patterns: [], pts: 0 };
  }

  const pivots = zigzag(candles, 0.05);
  if (pivots.length < 4) {
    return { ok: true, patterns: [], pts: 0 };
  }

  const detectors = [
    detectHeadShouldersTop,
    detectHeadShouldersBottom,
    detectDoubleTop,
    detectDoubleBottom,
    detectTripleTop,
    detectTripleBottom,
    detectTriangle,
    detectRectangle,
  ];

  const results = [];
  const seen = new Set();

  for (const fn of detectors) {
    const result = fn(pivots);
    if (result && !seen.has(result.name)) {
      results.push(result);
      seen.add(result.name);
    }
  }

  // 组内封顶 ±12
  let pts = results.reduce((s, r) => s + r.pts, 0);
  pts = Math.max(-12, Math.min(12, pts));

  return { ok: true, patterns: results, pts };
}

module.exports = { detectClassicPatterns, zigzag };
