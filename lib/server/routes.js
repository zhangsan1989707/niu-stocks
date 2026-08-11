/**
 * API 路由处理器
 * 所有 /api/* 路由的逻辑，从原 server.js 提取
 */

const { randomUUID } = require('node:crypto');
const { readFile, writeFile, mkdir, readdir } = require('node:fs/promises');
const { join } = require('node:path');
const { json, body, log, batchRun, number, DATA_DIR } = require('./utils');
const { loadDb, saveDb, updateDb, loadPortfolio, savePortfolio, updatePortfolio, loadAlerts, saveAlerts, updateAlerts, loadNotes, saveNotes, updateNotes, loadConfig, saveConfig, updateConfig, validateConfig, readJson, writeJson, FAV_HISTORY_DIR, CHECK_HISTORY_DIR } = require('./store');
const { quote, klines, remoteSearch, getIndices, checkHistory } = require('./market');
const { stockReport, stockReportWithHistory, calcPosition, runBacktest } = require('./report');
const { loadStocks, addStock, removeStock, getSector, SECTOR_MAP } = require('./stocks');
const { validateHealthScore } = require('./validate');

async function evaluateAlerts() {
  const snapshot = await loadAlerts();
  const codes = [...new Set(snapshot.rules.filter(rule => rule.enabled).map(rule => rule.code))];
  if (!codes.length) return snapshot;
  const results = await batchRun(codes, async code => {
    try { const q = await quote(code); return { code, price: q.price, changePct: q.changePct }; }
    catch { return null; }
  }, 3);
  const priceMap = {};
  results.forEach(result => { if (result.status === 'fulfilled' && result.value) priceMap[result.value.code] = result.value; });
  return updateAlerts(alerts => {
    for (const rule of alerts.rules.filter(rule => rule.enabled)) {
      const quoteData = priceMap[rule.code];
      if (!quoteData || !quoteData.price) continue;
      const current = rule.type === 'price' ? quoteData.price : quoteData.changePct;
      const triggered = rule.condition === '>=' ? current >= rule.value : current <= rule.value;
      if (!triggered) continue;
      const exists = alerts.pending.find(item => item.ruleId === rule.id && Date.now() - new Date(item.time).getTime() < 300000);
      if (!exists) alerts.pending.push({ id: randomUUID(), ruleId: rule.id, code: rule.code, name: rule.name, type: rule.type, price: quoteData.price, changePct: quoteData.changePct, message: `${rule.name} ${rule.type === 'price' ? '价格' : '涨跌幅'} ${rule.condition} ${rule.value}（当前 ${rule.type === 'price' ? quoteData.price.toFixed(2) : quoteData.changePct.toFixed(2) + '%'}）`, time: new Date().toISOString(), read: false });
    }
    return alerts;
  });
}

/**
 * 处理所有 API 路由
 * @returns {boolean} true 表示已处理
 */
async function handleApi(req, res, url, start) {
  const method = req.method;

  // --- 搜索 ---
  if (method === 'GET' && url.pathname === '/api/stocks/search') {
    const q = (url.searchParams.get('q') || '').trim();
    const stocks = await loadStocks();
    const matches = stocks.filter(x => x[0].includes(q) || x[1].includes(q)).slice(0, 8).map(([code, name]) => ({ code, name }));
    if (/^\d{6}$/.test(q) && !matches.some(x => x.code === q)) {
      try { const current = await quote(q); matches.unshift({ code: q, name: current.name }); } catch {}
    }
    if (matches.length < 3 && !/^\d{6}$/.test(q)) {
      const remote = await remoteSearch(q);
      for (const r of remote) {
        if (!matches.some(x => x.code === r.code)) matches.push(r);
        if (matches.length >= 8) break;
      }
    }
    log('GET', url.pathname, 200, Date.now() - start);
    return json(res, 200, { stocks: matches });
  }

  // --- 股票池管理 ---
  if (url.pathname === '/api/stocks') {
    if (method === 'GET') {
      const stocks = await loadStocks();
      log('GET', url.pathname, 200, Date.now() - start);
      return json(res, 200, { ok: true, stocks: stocks.map(([code, name]) => ({ code, name, sector: getSector(code) })) });
    }
    if (method === 'POST') {
      const { code, name } = await body(req);
      if (!/^\d{6}$/.test(code || '')) return json(res, 400, { error: '股票代码不正确' });
      const stocks = await addStock(code, name);
      log('POST', url.pathname, 201, Date.now() - start);
      return json(res, 201, { ok: true, stocks: stocks.map(([c, n]) => ({ code: c, name: n })) });
    }
    if (method === 'DELETE') {
      const code = url.searchParams.get('code');
      if (!code) return json(res, 400, { error: '缺少 code 参数' });
      const stocks = await removeStock(code);
      log('DELETE', url.pathname, 200, Date.now() - start);
      return json(res, 200, { ok: true, stocks: stocks.map(([c, n]) => ({ code: c, name: n })) });
    }
  }

  // --- 体检报告 ---
  if (method === 'GET' && /^\/api\/stocks\/\d{6}\/report$/.test(url.pathname)) {
    const code = url.pathname.split('/')[3];
    const result = await stockReportWithHistory(code);
    log('GET', url.pathname, 200, Date.now() - start);
    return json(res, 200, result);
  }

  // --- 历史体检记录 ---
  if (method === 'GET' && /^\/api\/stocks\/\d{6}\/history$/.test(url.pathname)) {
    const code = url.pathname.split('/')[3];
    const entries = await checkHistory(code);
    log('GET', url.pathname, 200, Date.now() - start);
    return json(res, 200, { ok: true, code, entries });
  }

  // --- 选股 ---
  if (method === 'GET' && url.pathname === '/api/screen') {
    const stocks = await loadStocks();
    const config = await loadConfig();
    const reports = await batchRun(stocks, ([code]) => stockReport(code), 3);
    const failed = reports.filter(x => x.status === 'rejected').length;
    const candidates = reports.filter(x => x.status === 'fulfilled').map(x => x.value)
      .filter(x => x.health >= config.healthScoreThreshold).sort((a, b) => b.health - a.health)
      .map(x => ({ code: x.code, name: x.name, price: x.quote.price, changePct: x.quote.changePct, score: x.health, volumeRatio: x.quote.volumeRatio, status: x.band, light: x.light }));
    log('GET', url.pathname, 200, Date.now() - start);
    return json(res, 200, { updatedAt: new Date().toISOString(), candidates, requested: stocks.length, failed, partial: failed > 0 });
  }

  if (method === 'GET' && url.pathname === '/api/screen/custom') {
    const codesParam = url.searchParams.get('codes') || '';
    const codes = [...new Set(codesParam.split(',').map(c => c.trim()).filter(c => /^\d{6}$/.test(c)))].slice(0, 20);
    if (!codes.length) { log('GET', url.pathname, 400, Date.now() - start); return json(res, 400, { error: '请提供有效的股票代码列表' }); }
    const reports = await batchRun(codes, code => stockReport(code), 3);
    const failed = reports.filter(x => x.status === 'rejected').length;
    const candidates = reports.filter(x => x.status === 'fulfilled').map(x => x.value)
      .sort((a, b) => b.health - a.health)
      .map(x => ({ code: x.code, name: x.name, price: x.quote.price, changePct: x.quote.changePct, score: x.health, volumeRatio: x.quote.volumeRatio, status: x.band, light: x.light, patterns: x.patterns }));
    log('GET', url.pathname, 200, Date.now() - start);
    return json(res, 200, { updatedAt: new Date().toISOString(), count: candidates.length, candidates, requested: codes.length, failed, partial: failed > 0 });
  }

  // --- 自选行情摘要 ---
  if (method === 'GET' && url.pathname === '/api/favreport') {
    const db = await loadDb();
    const favCodes = db.favorites.map(f => f.code);
    if (!favCodes.length) { log('GET', url.pathname, 200, Date.now() - start); return json(res, 200, { ok: true, date: new Date().toISOString().slice(0, 10), items: [], changes: [] }); }
    const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })();
    const historyFile = join(FAV_HISTORY_DIR, `${today}.json`);
    let todayData = await readJson(historyFile, null);
    if (!todayData) {
      const results = await batchRun(favCodes, code => stockReport(code).then(r => ({ code: r.code, name: r.name, light: r.light, health: r.health })), 3);
      todayData = { date: today, items: results.filter(r => r.status === 'fulfilled').map(r => r.value) };
      try { await mkdir(FAV_HISTORY_DIR, { recursive: true }); await writeJson(historyFile, todayData); } catch {}
    }
    const now = new Date();
    const yesterday = new Date(now.getTime() - 86400000);
    const yDate = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
    const yesterdayFile = join(FAV_HISTORY_DIR, `${yDate}.json`);
    const prevData = await readJson(yesterdayFile, null);
    let changes = [];
    if (prevData) {
      const prevMap = {};
      prevData.items.forEach(item => { prevMap[item.code] = item; });
      changes = todayData.items.filter(item => {
        const prev = prevMap[item.code];
        return prev && prev.light !== item.light;
      }).map(item => {
        const prev = prevMap[item.code];
        return { code: item.code, name: item.name, prev_light: prev.light, prev_score: prev.health, light: item.light, score: item.health };
      });
    }
    log('GET', url.pathname, 200, Date.now() - start);
    return json(res, 200, { ok: true, date: today, prev_date: prevData ? prevData.date : null, items: todayData.items, changes });
  }

  if (method === 'GET' && url.pathname === '/api/favorites/quotes') {
    const db = await loadDb();
    const favCodes = db.favorites.map(f => f.code);
    if (!favCodes.length) { log('GET', url.pathname, 200, Date.now() - start); return json(res, 200, { ok: true, items: [] }); }
    const results = await batchRun(favCodes, async code => {
      try { const q = await quote(code); const k = await klines(code); const closes = k.map(c => c.close).slice(-24); return { ok: true, code, name: q.name, last_close: q.price, change_pct: q.changePct, sparkline: closes, source: q.source }; }
      catch (e) { return { ok: false, code, error: e.message }; }
    }, 3);
    const items = results.map(r => r.status === 'fulfilled' ? r.value : { ok: false, code: '', error: r.reason?.message });
    log('GET', url.pathname, 200, Date.now() - start);
    return json(res, 200, { ok: true, items });
  }

  // --- 收藏管理 ---
  if (url.pathname === '/api/favorites') {
    if (method === 'GET') {
      const db = await loadDb();
      const groups = [...new Set(db.favorites.map(x => x.group || '默认').concat(['默认', '持仓', '观察', '候选']))];
      log('GET', url.pathname, 200, Date.now() - start);
      return json(res, 200, { favorites: db.favorites, groups });
    }
    const { code, name, group } = await body(req);
    if (!/^\d{6}$/.test(code || '')) return json(res, 400, { error: '股票代码不正确' });
    const db = await updateDb(current => {
      if (!current.favorites.some(x => x.code === code)) current.favorites.push({ id: randomUUID(), code, name, group: String(group || '默认'), createdAt: new Date().toISOString() });
      return current;
    });
    log('POST', url.pathname, 201, Date.now() - start);
    return json(res, 201, { ok: true, favorites: db.favorites });
  }
  if (method === 'PUT' && /^\/api\/favorites\/\d{6}$/.test(url.pathname)) {
    const { group } = await body(req);
    const code = url.pathname.split('/').at(-1);
    let found = false;
    await updateDb(current => { const fav = current.favorites.find(x => x.code === code); if (fav) { fav.group = String(group || '默认'); found = true; } return current; });
    if (!found) return json(res, 404, { error: '收藏不存在' });
    log('PUT', url.pathname, 200, Date.now() - start);
    return json(res, 200, { ok: true });
  }
  if (method === 'DELETE' && /^\/api\/favorites\/\d{6}$/.test(url.pathname)) {
    const code = url.pathname.split('/').at(-1);
    const db = await updateDb(current => { current.favorites = current.favorites.filter(x => x.code !== code); return current; });
    log('DELETE', url.pathname, 200, Date.now() - start);
    return json(res, 200, { ok: true, favorites: db.favorites });
  }

  // --- 持仓管理 ---
  if (url.pathname === '/api/portfolio') {
    if (method === 'GET') {
      const pf = await loadPortfolio();
      const codes = pf.positions.map(p => p.code);
      const quotes = {};
      if (codes.length) {
        const results = await batchRun([...new Set(codes)], async code => {
          try { const q = await quote(code); return { code, price: q.price, changePct: q.changePct }; }
          catch { return { code, price: null, changePct: null }; }
        }, 3);
        results.forEach(r => { if (r.status === 'fulfilled' && r.value) quotes[r.value.code] = r.value; });
      }
      const positions = pf.positions.map(p => {
        const q = quotes[p.code] || {};
        const calc = calcPosition(p, q.price);
        return { ...p, price: q.price ?? null, changePct: q.changePct ?? null, ...calc };
      });
      const totalCost = positions.reduce((s, p) => s + p.cost, 0);
      const totalValue = positions.reduce((s, p) => s + p.marketValue, 0);
      const totalPnl = totalValue - totalCost;
      const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;
      const todayPnl = positions.reduce((s, p) => s + (p.changePct != null ? p.cost * (p.changePct / 100) : 0), 0);
      log('GET', url.pathname, 200, Date.now() - start);
      return json(res, 200, { ok: true, positions, summary: { totalCost, totalValue, totalPnl, totalPnlPct, todayPnl, count: positions.length } });
    }
    const bodyData = await body(req);
    const { code, name, shares, costPrice, note, group } = bodyData;
    if (!/^\d{6}$/.test(String(code || ''))) return json(res, 400, { error: '股票代码不正确' });
    const sharesNum = Number(shares), costNum = Number(costPrice);
    if (!Number.isFinite(sharesNum) || sharesNum <= 0) return json(res, 400, { error: '持仓数量需为正数' });
    if (!Number.isFinite(costNum) || costNum <= 0) return json(res, 400, { error: '成本价需为正数' });
    await updatePortfolio(pf => {
      const existing = pf.positions.find(p => p.code === String(code));
      if (existing) {
        const totalShares = existing.shares + sharesNum;
        existing.costPrice = (existing.shares * existing.costPrice + sharesNum * costNum) / totalShares;
        existing.shares = totalShares;
        existing.note = note || existing.note;
      } else {
        pf.positions.push({ id: randomUUID(), code: String(code), name: String(name || code), shares: sharesNum, costPrice: costNum, note: String(note || ''), group: String(group || '持仓'), createdAt: new Date().toISOString() });
      }
      pf.trades.push({ id: randomUUID(), code: String(code), name: String(name || code), direction: 'buy', shares: sharesNum, price: costNum, amount: sharesNum * costNum, reason: String(note || ''), createdAt: new Date().toISOString() });
      return pf;
    });
    log('POST', url.pathname, 201, Date.now() - start);
    return json(res, 201, { ok: true });
  }
  if (method === 'PUT' && /^\/api\/portfolio\/[^/]+$/.test(url.pathname)) {
    const id = url.pathname.split('/').at(-1);
    const bodyData = await body(req);
    const { shares, costPrice, note, group } = bodyData;
    const sharesNum = shares == null ? null : Number(shares);
    const costNum = costPrice == null ? null : Number(costPrice);
    if (sharesNum != null && (!Number.isFinite(sharesNum) || sharesNum < 0)) return json(res, 400, { error: '持仓数量不能为负' });
    if (costNum != null && (!Number.isFinite(costNum) || costNum <= 0)) return json(res, 400, { error: '成本价需为正数' });
    let missing = false;
    await updatePortfolio(pf => {
    const pos = pf.positions.find(p => p.id === id);
    if (!pos) { missing = true; return pf; }
    if (sharesNum != null) {
      if (sharesNum === 0) {
        pf.trades.push({ id: randomUUID(), code: pos.code, name: pos.name, direction: 'sell', shares: pos.shares, price: pos.costPrice, amount: pos.shares * pos.costPrice, reason: '清仓', createdAt: new Date().toISOString() });
        pf.positions = pf.positions.filter(p => p.id !== id);
        return pf;
      }
      pos.shares = sharesNum;
    }
    if (costNum != null) pos.costPrice = costNum;
    if (note != null) pos.note = String(note);
    if (group != null) pos.group = String(group);
    return pf;
    });
    if (missing) return json(res, 404, { error: '持仓不存在' });
    log('PUT', url.pathname, 200, Date.now() - start);
    return json(res, 200, { ok: true });
  }
  if (method === 'DELETE' && /^\/api\/portfolio\/[^/]+$/.test(url.pathname)) {
    const id = url.pathname.split('/').at(-1);
    await updatePortfolio(pf => { pf.positions = pf.positions.filter(p => p.id !== id); return pf; });
    log('DELETE', url.pathname, 200, Date.now() - start);
    return json(res, 200, { ok: true });
  }
  if (method === 'GET' && url.pathname === '/api/portfolio/trades') {
    const pf = await loadPortfolio();
    log('GET', url.pathname, 200, Date.now() - start);
    return json(res, 200, { ok: true, trades: pf.trades.slice(-50).reverse() });
  }

  // --- 大盘指数 ---
  if (method === 'GET' && url.pathname === '/api/indices') {
    try {
      const result = await getIndices();
      log('GET', url.pathname, 200, Date.now() - start);
      if (!result.indices.some(idx => idx.available !== false)) return json(res, 503, { error: '指数行情暂不可用', indices: result.indices });
      return json(res, 200, { ok: true, ...result });
    } catch (e) { log('GET', url.pathname, 502, Date.now() - start); return json(res, 502, { error: '指数获取失败' }); }
  }

  // --- 提醒系统 ---
  if (url.pathname === '/api/alerts') {
    if (method === 'GET') {
      const a = await loadAlerts();
      log('GET', url.pathname, 200, Date.now() - start);
      return json(res, 200, { ok: true, ...a, unreadCount: a.pending.filter(item => !item.read).length });
    }
    if (method === 'POST') {
      const { code, name, type, condition, value } = await body(req);
      if (!/^\d{6}$/.test(String(code || ''))) return json(res, 400, { error: '股票代码不正确' });
      if (!['price', 'pct'].includes(type)) return json(res, 400, { error: '提醒类型不正确' });
      if (!['>=', '<='].includes(condition || '>=')) return json(res, 400, { error: '触发条件不正确' });
      if (!Number.isFinite(Number(value))) return json(res, 400, { error: '阈值必须是数字' });
      await updateAlerts(a => { a.rules.push({ id: randomUUID(), code, name: name || code, type, condition: condition || '>=', value: Number(value), enabled: true, createdAt: new Date().toISOString() }); return a; });
      log('POST', url.pathname, 201, Date.now() - start);
      return json(res, 201, { ok: true });
    }
  }
  if (method === 'DELETE' && /^\/api\/alerts\/[^/]+$/.test(url.pathname)) {
    const id = url.pathname.split('/').at(-1);
    await updateAlerts(a => { a.rules = a.rules.filter(r => r.id !== id); a.pending = a.pending.filter(p => p.ruleId !== id); return a; });
    log('DELETE', url.pathname, 200, Date.now() - start);
    return json(res, 200, { ok: true });
  }
  if (method === 'GET' && url.pathname === '/api/alerts/pending') {
    const a = await evaluateAlerts();
    const unread = a.pending.filter(p => !p.read);
    log('GET', url.pathname, 200, Date.now() - start);
    return json(res, 200, { ok: true, pending: a.pending.slice(-20).reverse(), unreadCount: unread.length });
  }
  if (method === 'PUT' && url.pathname === '/api/alerts/readall') {
    await updateAlerts(a => { a.pending.forEach(p => p.read = true); return a; });
    return json(res, 200, { ok: true });
  }

  // --- 决策笔记 ---
  if (url.pathname === '/api/notes') {
    if (method === 'GET') {
      const n = await loadNotes();
      log('GET', url.pathname, 200, Date.now() - start);
      return json(res, 200, { ok: true, notes: n.notes.slice(-50).reverse() });
    }
    if (method === 'POST') {
      const { code, name, direction, reason, result, lesson } = await body(req);
      if (!code || !direction) return json(res, 400, { error: '缺少代码或方向' });
      await updateNotes(n => { n.notes.push({ id: randomUUID(), code, name: name || code, direction, reason: String(reason || ''), result: String(result || ''), lesson: String(lesson || ''), createdAt: new Date().toISOString() }); return n; });
      log('POST', url.pathname, 201, Date.now() - start);
      return json(res, 201, { ok: true });
    }
  }
  if (method === 'DELETE' && /^\/api\/notes\/[^/]+$/.test(url.pathname)) {
    const id = url.pathname.split('/').at(-1);
    await updateNotes(n => { n.notes = n.notes.filter(x => x.id !== id); return n; });
    return json(res, 200, { ok: true });
  }

  // --- 策略配置 ---
  if (url.pathname === '/api/config') {
    if (method === 'GET') {
      const cfg = await loadConfig();
      return json(res, 200, { ok: true, config: cfg });
    }
    if (method === 'PUT') {
      const bodyData = await body(req);
      let cfg;
      try {
        cfg = await updateConfig(config => {
          const checked = validateConfig({ ...config, ...bodyData });
          if (checked.errors.length) throw new Error(checked.errors.join('；'));
          return { ...config, ...checked.config };
        });
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
      return json(res, 200, { ok: true, config: cfg });
    }
  }

  // --- 板块热度 ---
  if (method === 'GET' && url.pathname === '/api/sectors') {
    const stocks = await loadStocks();
    const sectors = {};
    stocks.forEach(([code, name]) => {
      const sector = getSector(code);
      if (!sectors[sector]) sectors[sector] = [];
      sectors[sector].push(code);
    });
    const results = await batchRun(Object.entries(sectors), async ([sector, codes]) => {
      const quotes = await batchRun(codes.slice(0, 5), async code => {
        try { const q = await quote(code); return { code, changePct: q.changePct }; } catch { return null; }
      }, 3);
      const valid = quotes.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
      const avgPct = valid.length ? valid.reduce((s, q) => s + q.changePct, 0) / valid.length : 0;
      return { sector, count: codes.length, avgPct: Math.round(avgPct * 100) / 100, codes };
    }, 3);
    const data = results.map(r => r.status === 'fulfilled' ? r.value : null).filter(Boolean).sort((a, b) => b.avgPct - a.avgPct);
    log('GET', url.pathname, 200, Date.now() - start);
    return json(res, 200, { ok: true, sectors: data });
  }

  // --- 回测 ---
  if (method === 'GET' && url.pathname === '/api/backtest') {
    const code = url.searchParams.get('code') || '600519';
    const days = Math.min(Number(url.searchParams.get('days')) || 120, 300);
    try {
      const result = await runBacktest(code, days);
      log('GET', url.pathname, 200, Date.now() - start);
      return json(res, 200, result);
    } catch (e) { log('GET', url.pathname, 502, Date.now() - start); return json(res, 502, { error: '回测失败：' + e.message }); }
  }

  // --- 体检分有效性验证 ---
  if (method === 'GET' && url.pathname === '/api/validate') {
    const forwardDays = Math.min(Math.max(Number(url.searchParams.get('days')) || 5, 1), 20);
    try {
      const result = await validateHealthScore(forwardDays);
      log('GET', url.pathname, 200, Date.now() - start);
      return json(res, 200, result);
    } catch (e) { log('GET', url.pathname, 502, Date.now() - start); return json(res, 502, { error: '验证失败：' + e.message }); }
  }

  return false; // 未匹配任何路由
}

module.exports = { handleApi, evaluateAlerts };
