/**
 * 牛股体检站 — 服务入口
 * v0.0.3: 重构为模块化架构，server.js 仅负责 HTTP 服务和路由分发
 */

const http = require('node:http');
const { readFile } = require('node:fs/promises');
const { join, extname } = require('node:path');

const { STATIC, MIME, json, body, route, log, logFallback, market, number } = require('./lib/server/utils');
const { handleApi, evaluateAlerts } = require('./lib/server/routes');
const { maybeRunDailyScreen } = require('./lib/server/screen-engine');
const { reportFrom, stockReport, stockReportWithHistory, calcPosition, runBacktest } = require('./lib/server/report');
const { loadStocks, addStock, removeStock, getSector } = require('./lib/server/stocks');
const { getIndices, quote, klines, remoteSearch, checkHistory } = require('./lib/server/market');

// 从 lib/ 透传导出（保持测试兼容）
const { detectPatterns, candleStats } = require('./lib/patterns');
const { murphyIndicators } = require('./lib/indicators');
const { detectClassicPatterns } = require('./lib/classic-patterns');
const { average, ema, Cache } = require('./lib/helpers');

const PORT = Number(process.env.PORT || 4317);

const server = http.createServer(async (req, res) => {
  const start = Date.now();
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    // API 路由
    if (url.pathname.startsWith('/api/')) {
      const handled = await handleApi(req, res, url, start);
      if (handled) return;
      return json(res, 404, { error: 'API 未找到' });
    }

    // 静态文件
    if (req.method === 'GET') {
      const file = join(STATIC, route(url.pathname));
      if (!file.startsWith(STATIC)) return json(res, 403, { error: 'Forbidden' });
      try {
        const content = await readFile(file);
        res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
        return res.end(content);
      } catch {
        const html = await readFile(join(STATIC, 'index.html'));
        res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' });
        return res.end(html);
      }
    }

    log(req.method, url.pathname, 404, Date.now() - start);
    json(res, 404, { error: 'Not found' });
  } catch (error) {
    const ms = Date.now() - start;
    const status = error.message?.includes('timeout') || error.name === 'TimeoutError' ? 504
      : error.message?.includes('未找到') ? 404
      : error.message?.includes('请求格式') ? 400
      : error.message?.includes('请求体过大') ? 413
      : 502;
    log(req.method, url.pathname, status, ms);
    const errMsg = status === 504 ? '行情服务响应超时，请稍后重试'
      : status === 404 ? error.message
      : status === 400 || status === 413 ? error.message
      : error.message || '服务暂不可用，请稍后重试';
    json(res, status, { error: errMsg, source: 'error' });
  }
});

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => console.log(`牛股体检站运行于 http://localhost:${PORT}`));
  setInterval(() => evaluateAlerts().catch(error => console.error('提醒检查失败：', error.message)), 60000).unref();
  // 每日自动选股：交易日 15:35 后自动跑一次（引擎内部幂等判断）
  const screenTick = () => maybeRunDailyScreen().catch(error => console.error('[smart-screen] 自动选股失败：', error.message));
  setTimeout(screenTick, 30000).unref();
  setInterval(screenTick, 300000).unref();
}

// 保持与原 server.js 完全一致的导出（测试兼容）
module.exports = {
  reportFrom, market, detectPatterns, murphyIndicators, detectClassicPatterns, calcPosition,
  // 透传
  candleStats, average, ema, Cache,
  stockReport, stockReportWithHistory, runBacktest,
  loadStocks, addStock, removeStock, getSector,
  getIndices, quote, klines, remoteSearch, checkHistory,
  logFallback, number,
};
