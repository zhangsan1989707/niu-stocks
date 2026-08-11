/**
 * 体检分有效性验证 — P2-2
 * 对比历史体检评分与后续实际涨跌的相关性
 */

const { readFile, readdir, mkdir } = require('node:fs/promises');
const { join } = require('node:path');
const { CHECK_HISTORY_DIR } = require('./store');
const { klines } = require('./market');

/**
 * 计算体检分有效性
 * 取历史体检记录，对比体检后 N 天的实际涨跌
 * @param {number} forwardDays - 向前看几天（5/10/20）
 * @returns {Promise<Object>}
 */
async function validateHealthScore(forwardDays = 5) {
  // 读取所有历史体检记录
  await mkdir(CHECK_HISTORY_DIR, { recursive: true });
  const files = (await readdir(CHECK_HISTORY_DIR)).filter(f => f.endsWith('.json')).sort();
  if (files.length < 2) {
    return { ok: true, message: '历史体检记录不足，需要至少 2 天的数据', samples: 0, historyDays: files.length, minimumHistoryDays: forwardDays + 1 };
  }

  // 不取最后 forwardDays 天的记录（因为没有足够的后续数据）
  const usableFiles = files.slice(0, -forwardDays);
  if (usableFiles.length === 0) {
    return { ok: true, message: `需要至少 ${forwardDays + 1} 天的历史数据`, samples: 0, historyDays: files.length, minimumHistoryDays: forwardDays + 1 };
  }

  const samples = [];
  // 最多保留半年数据，兼顾样本代表性和接口压力。
  const recentFiles = usableFiles.slice(-180);

  for (const f of recentFiles) {
    const dateStr = f.replace('.json', '');
    try {
      const dayData = JSON.parse(await readFile(join(CHECK_HISTORY_DIR, f), 'utf8'));
      for (const [code, info] of Object.entries(dayData)) {
        try {
          // 获取该股票的 K线数据
          const k = await klines(code);
          // 找到体检日期在 K线中的位置
          const idx = k.findIndex(c => c.date === dateStr);
          if (idx < 0 || idx + forwardDays >= k.length) continue;

          const entryClose = k[idx].close;
          const exitClose = k[idx + forwardDays].close;
          const forwardReturn = ((exitClose - entryClose) / entryClose) * 100;

          samples.push({
            code,
            name: info.name,
            date: dateStr,
            health: info.health,
            light: info.light,
            forwardReturn: Math.round(forwardReturn * 100) / 100,
          });
        } catch {}
      }
    } catch {}
  }

  if (samples.length === 0) {
    return { ok: true, message: '无法获取足够的数据进行验证', samples: 0, historyDays: files.length, minimumHistoryDays: forwardDays + 1 };
  }

  // 按体检分分组统计
  const groups = {
    green: { name: '绿灯（≥65）', samples: [], avgReturn: 0, winRate: 0 },
    yellow: { name: '黄灯（45-64）', samples: [], avgReturn: 0, winRate: 0 },
    red: { name: '红灯（<45）', samples: [], avgReturn: 0, winRate: 0 },
  };

  for (const s of samples) {
    const group = s.health >= 65 ? 'green' : s.health >= 45 ? 'yellow' : 'red';
    groups[group].samples.push(s);
  }

  for (const [key, g] of Object.entries(groups)) {
    if (g.samples.length > 0) {
      g.avgReturn = Math.round(g.samples.reduce((s, x) => s + x.forwardReturn, 0) / g.samples.length * 100) / 100;
      g.winRate = Math.round(g.samples.filter(x => x.forwardReturn > 0).length / g.samples.length * 1000) / 10;
    }
    g.count = g.samples.length;
    delete g.samples; // 不返回明细，减小响应体
  }

  // 计算总体相关性（Spearman 简化版：分高→涨的概率）
  const totalWinRate = Math.round(samples.filter(s => s.forwardReturn > 0).length / samples.length * 1000) / 10;

  return {
    ok: true,
    forwardDays,
    historyDays: files.length,
    minimumHistoryDays: forwardDays + 1,
    samples: samples.length,
    totalWinRate,
    reliable: samples.length >= 30,
    reliabilityNote: samples.length >= 30 ? '样本达到最低观察门槛，可作初步参考。' : `当前仅 ${samples.length} 条样本，低于 30 条最低观察门槛，不应据此调整策略。`,
    groups,
    detail: samples.slice(-20).reverse(), // 最近 20 条明细
    disclaimer: '历史有效性不代表未来表现，仅供参考。',
  };
}

module.exports = { validateHealthScore };
