/**
 * 基础工具函数
 * 从 server.js 提取的通用辅助方法
 */

const { join } = require('node:path');

const ROOT = __dirname ? require('node:path').resolve(__dirname, '../..') : process.cwd();
const DATA_DIR = join(ROOT, 'data');
const STATIC = join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function market(code) {
  return code.startsWith('6') || code.startsWith('9') ? 'sh'
    : code.startsWith('8') ? 'bj' : 'sz';
}

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
  return true;
}

function body(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => raw += chunk);
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(new Error('请求格式不正确')); }
    });
    req.on('error', reject);
  });
}

function route(path) {
  return path === '/' ? '/index.html' : path;
}

function log(method, path, status, ms) {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.log(`[${ts}] ${method} ${path} → ${status} (${ms}ms)`);
}

function logFallback(code, from, to, reason) {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.log(`[${ts}] [降级] ${code} ${from} → ${to}（${reason}）`);
}

/**
 * 并发批量执行
 */
async function batchRun(items, fn, concurrency = 3) {
  const results = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      try { results[i] = { status: 'fulfilled', value: await fn(items[i]) }; }
      catch (e) { results[i] = { status: 'rejected', reason: e }; }
    }
  });
  await Promise.all(workers);
  return results;
}

module.exports = { ROOT, DATA_DIR, STATIC, MIME, number, market, json, body, route, log, logFallback, batchRun };
