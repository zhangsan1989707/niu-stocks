const http = require('node:http');
const { readFile, writeFile, mkdir } = require('node:fs/promises');
const { createHash, createHmac, randomUUID, timingSafeEqual } = require('node:crypto');
const { join, extname } = require('node:path');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DATA_DIR = join(ROOT, 'data');
const DB_FILE = join(DATA_DIR, 'local.json');
const SECRET = process.env.APP_SECRET || 'replace-this-local-secret-before-deploying';
const STATIC = join(ROOT, 'public');
const STOCKS = [
  ['600519', '贵州茅台'], ['000858', '五粮液'], ['002594', '比亚迪'], ['601138', '工业富联'],
  ['000021', '深科技'], ['600392', '盛和资源'], ['603197', '保隆科技'], ['300308', '中际旭创'],
  ['688981', '中芯国际'], ['002475', '立讯精密'], ['601127', '赛力斯'], ['600036', '招商银行'],
];
const type = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

async function loadDb() {
  await mkdir(DATA_DIR, { recursive: true });
  try { return JSON.parse(await readFile(DB_FILE, 'utf8')); }
  catch { return { users: [], feedback: [], favorites: [] }; }
}
async function saveDb(db) { await writeFile(DB_FILE, JSON.stringify(db, null, 2)); }
function json(res, status, data) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); }
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function parseCookies(req) { return Object.fromEntries((req.headers.cookie || '').split(';').map(x => x.trim().split('=')).filter(x => x.length === 2)); }
function sign(value) { return createHmac('sha256', SECRET).update(value).digest('hex'); }
function currentUser(req, db) {
  const token = parseCookies(req).shs; if (!token) return null;
  const [id, sig] = token.split('.');
  if (!id || !sig || !timingSafeEqual(Buffer.from(sign(id)), Buffer.from(sig))) return null;
  return db.users.find(user => user.id === id) || null;
}
function setSession(res, user) { res.setHeader('set-cookie', `shs=${user.id}.${sign(user.id)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`); }
function body(req) { return new Promise((resolve, reject) => { let raw = ''; req.on('data', chunk => raw += chunk); req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('请求格式不正确')); } }); req.on('error', reject); }); }
function market(code) { return code.startsWith('6') || code.startsWith('9') ? 'sh' : code.startsWith('8') ? 'bj' : 'sz'; }
function number(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
async function requestText(url, encoding = 'utf-8') { const response = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 StockHealthStation/1.0' }, signal: AbortSignal.timeout(8000) }); if (!response.ok) throw new Error(`行情服务返回 ${response.status}`); return new TextDecoder(encoding).decode(await response.arrayBuffer()); }
async function tencentQuote(code) {
  const text = await requestText(`https://qt.gtimg.cn/q=${market(code)}${code}`, 'gbk');
  const values = (text.match(/"([^"]*)"/) || [, ''])[1].split('~');
  if (values.length < 50 || !values[1]) throw new Error('未找到该股票');
  return { code, name: values[1], price: number(values[3]), previousClose: number(values[4]), open: number(values[5]), volume: number(values[6]), high: number(values[33]), low: number(values[34]), change: number(values[31]), changePct: number(values[32]), amountWan: number(values[37]), turnoverPct: number(values[38]), pe: number(values[39]), marketCapYi: number(values[44]), pb: number(values[46]), volumeRatio: number(values[49]), updatedAt: values[30] || '', source: '腾讯财经' };
}
async function eastmoneyQuote(code) {
  const secid = `${market(code) === 'sh' ? 1 : 0}.${code}`;
  const text = await requestText(`https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fltt=2&invt=2&fields=f57,f58,f43,f44,f45,f46,f47,f48,f50,f51,f52,f116,f162,f167,f168,f170`);
  const data = JSON.parse(text).data;
  if (!data?.f58) throw new Error('备用行情源未找到该股票');
  return { code, name: data.f58, price: number(data.f43), previousClose: number(data.f60), open: number(data.f46), volume: number(data.f47), high: number(data.f44), low: number(data.f45), change: number(data.f51), changePct: number(data.f170), amountWan: number(data.f48) / 10000, turnoverPct: number(data.f168), pe: number(data.f162), marketCapYi: number(data.f116) / 1e8, pb: number(data.f167), volumeRatio: number(data.f50), updatedAt: new Date().toISOString(), source: '东方财富' };
}
async function quote(code) { try { return await tencentQuote(code); } catch { return eastmoneyQuote(code); } }
async function tencentKlines(code) {
  const prefix = market(code);
  const text = await requestText(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${prefix}${code},day,,,320,qfq`);
  const payload = JSON.parse(text).data?.[`${prefix}${code}`];
  const rows = payload?.qfqday || payload?.day || [];
  if (!rows.length) throw new Error('K线数据暂不可用');
  return rows.map(row => ({ date: row[0], open: number(row[1]), close: number(row[2]), high: number(row[3]), low: number(row[4]), volume: number(row[5]) }));
}
async function eastmoneyKlines(code) {
  const secid = `${market(code) === 'sh' ? 1 : 0}.${code}`;
  const text = await requestText(`https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56&klt=101&fqt=1&beg=0&end=20500000&lmt=320`);
  const rows = JSON.parse(text).data?.klines || [];
  if (!rows.length) throw new Error('备用K线源暂不可用');
  return rows.map(row => { const x = row.split(','); return { date:x[0], open:number(x[1]), close:number(x[2]), high:number(x[3]), low:number(x[4]), volume:number(x[5]) }; });
}
async function klines(code) { try { return await tencentKlines(code); } catch { return eastmoneyKlines(code); } }
function average(values, count) { const subset = values.slice(-count); return subset.length ? subset.reduce((a, b) => a + b, 0) / subset.length : 0; }
function ema(values, days) { const k = 2 / (days + 1); return values.reduce((acc, value) => acc.length ? [...acc, value * k + acc.at(-1) * (1 - k)] : [value], []); }
function reportFrom(quoteData, candles) {
  const closes = candles.map(x => x.close), volumes = candles.map(x => x.volume), last = candles.at(-1);
  const ma20 = average(closes, 20), ma60 = average(closes, 60), ma5 = average(closes, 5);
  const fast = ema(closes, 6), slow = ema(closes, 13), macd = fast.map((x, i) => x - slow[i]), signal = ema(macd, 5);
  const diff = macd.at(-1), dea = signal.at(-1); const changes = closes.slice(-15).map((x, i, arr) => i ? x - arr[i - 1] : 0).slice(1);
  const gains = changes.map(x => Math.max(x, 0)), losses = changes.map(x => Math.max(-x, 0)); const rsi = average(gains, 14) / (average(losses, 14) || .0001); const rsiValue = 100 - 100 / (1 + rsi);
  const recentHigh = Math.max(...candles.slice(-60).map(x => x.high)); const support = Math.min(...candles.slice(-20).map(x => x.low));
  const bullish = last.close >= ma60, macdUp = diff >= dea, healthy = bullish && macdUp;
  let score = 50 + (bullish ? 15 : -15) + (last.close >= ma20 ? 8 : -8) + (macdUp ? 9 : -9) + (quoteData.volumeRatio >= 1.5 ? 5 : 0) + (rsiValue > 70 ? -4 : rsiValue < 30 ? 2 : 0);
  if (last.close < support * .985) score = Math.min(score, 22); score = Math.max(0, Math.min(100, Math.round(score)));
  const status = score >= 80 ? '健康' : score >= 65 ? '偏好' : score >= 45 ? '中性' : score >= 25 ? '偏弱' : '危险';
  const checks = [
    ['趋势背景', bullish ? '上升趋势' : '趋势偏弱', bullish], ['生命线 MA60', `${last.close >= ma60 ? '站上' : '跌破'} ${ma60.toFixed(2)}`, last.close >= ma60],
    ['关键支撑', `${support.toFixed(2)} ${last.close >= support ? '暂未跌破' : '已跌破'}`, last.close >= support], ['MA5 / MA20', ma5 >= ma20 ? '短期均线偏多' : '短期均线偏空', ma5 >= ma20],
    ['成交量 / 量价', `量比 ${quoteData.volumeRatio.toFixed(2)}（≥1.5 算放量）`, quoteData.volumeRatio >= 1.5], ['MACD 金死叉', macdUp ? '金叉 · 多头占优' : '死叉 · 需谨慎', macdUp],
    ['RSI', `${rsiValue.toFixed(1)} · ${rsiValue > 70 ? '超买提醒' : rsiValue < 30 ? '超卖关注' : '中性区间'}`, rsiValue <= 70], ['60日高点回撤', `${((1 - last.close / recentHigh) * 100).toFixed(1)}%`, last.close / recentHigh > .7]
  ];
  return { quote: quoteData, candles, score, status, metrics: { ma20, ma60, ma5, macd: diff, signal: dea, rsi: rsiValue, support, recentHigh }, checks, summary: healthy ? '趋势与动量保持偏强，暂未出现明显破位信号。' : '当前技术面存在分歧，建议结合下一交易日量价变化确认。' };
}
async function stockReport(code) { const normalized = String(code).replace(/\D/g, '').padStart(6, '0'); const [q, k] = await Promise.all([quote(normalized), klines(normalized)]); return reportFrom(q, k); }
function route(path) { return path === '/' ? '/index.html' : path; }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`); const db = await loadDb(); const user = currentUser(req, db);
  try {
    if (req.method === 'GET' && url.pathname === '/api/session') return json(res, 200, { user: user && { id: user.id, phone: user.phone } });
    if (req.method === 'POST' && url.pathname === '/api/register') { const { phone, password } = await body(req); if (!/^1\d{10}$/.test(phone || '') || String(password || '').length < 6) return json(res, 400, { error: '请输入有效手机号和至少 6 位密码' }); if (db.users.some(x => x.phone === phone)) return json(res, 409, { error: '该手机号已注册' }); const next = { id: randomUUID(), phone, passwordHash: hash(password), createdAt: new Date().toISOString() }; db.users.push(next); await saveDb(db); setSession(res, next); return json(res, 201, { user: { id: next.id, phone } }); }
    if (req.method === 'POST' && url.pathname === '/api/login') { const { phone, password } = await body(req); const account = db.users.find(x => x.phone === phone && x.passwordHash === hash(password || '')); if (!account) return json(res, 401, { error: '手机号或密码不正确' }); setSession(res, account); return json(res, 200, { user: { id: account.id, phone: account.phone } }); }
    if (req.method === 'POST' && url.pathname === '/api/logout') { res.setHeader('set-cookie', 'shs=; HttpOnly; Path=/; Max-Age=0'); return json(res, 200, { ok: true }); }
    if (req.method === 'GET' && url.pathname === '/api/stocks/search') { const q = (url.searchParams.get('q') || '').trim(); const matches = STOCKS.filter(x => x[0].includes(q) || x[1].includes(q)).slice(0, 8).map(([code, name]) => ({ code, name })); if (/^\d{6}$/.test(q) && !matches.some(x => x.code === q)) { try { const current = await quote(q); matches.unshift({ code: q, name: current.name }); } catch {} } return json(res, 200, { stocks: matches }); }
    if (req.method === 'GET' && /^\/api\/stocks\/\d{6}\/report$/.test(url.pathname)) return json(res, 200, await stockReport(url.pathname.split('/')[3]));
    if (req.method === 'GET' && url.pathname === '/api/screen') { const reports = await Promise.allSettled(STOCKS.slice(0, 8).map(([code]) => stockReport(code))); const candidates = reports.filter(x => x.status === 'fulfilled').map(x => x.value).filter(x => x.score >= 60).sort((a,b) => b.score - a.score).map(x => ({ code: x.quote.code, name: x.quote.name, price: x.quote.price, changePct: x.quote.changePct, score: x.score, volumeRatio: x.quote.volumeRatio, status: x.status })); return json(res, 200, { updatedAt: new Date().toISOString(), candidates }); }
    if (url.pathname === '/api/favorites') { if (!user) return json(res, 401, { error: '请先登录' }); if (req.method === 'GET') return json(res, 200, { favorites: db.favorites.filter(x => x.userId === user.id) }); const { code, name } = await body(req); if (!/^\d{6}$/.test(code || '')) return json(res, 400, { error: '股票代码不正确' }); if (!db.favorites.some(x => x.userId === user.id && x.code === code)) { db.favorites.push({ id: randomUUID(), userId: user.id, code, name, createdAt: new Date().toISOString() }); await saveDb(db); } return json(res, 201, { ok: true }); }
    if (req.method === 'DELETE' && /^\/api\/favorites\/\d{6}$/.test(url.pathname)) { if (!user) return json(res, 401, { error: '请先登录' }); db.favorites = db.favorites.filter(x => !(x.userId === user.id && x.code === url.pathname.split('/').at(-1))); await saveDb(db); return json(res, 200, { ok: true }); }
    if (url.pathname === '/api/feedback') { if (req.method === 'GET') return json(res, 200, { feedback: db.feedback.slice(-30).reverse() }); const { message } = await body(req); if (!String(message || '').trim() || message.length > 500) return json(res, 400, { error: '反馈内容需为 1–500 字' }); db.feedback.push({ id: randomUUID(), message: message.trim(), author: user ? user.phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2') : '匿名用户', createdAt: new Date().toISOString() }); await saveDb(db); return json(res, 201, { ok: true }); }
    if (req.method === 'GET') { const file = join(STATIC, route(url.pathname)); if (!file.startsWith(STATIC)) return json(res, 403, { error: 'Forbidden' }); try { const content = await readFile(file); res.writeHead(200, { 'content-type': type[extname(file)] || 'application/octet-stream' }); return res.end(content); } catch { const html = await readFile(join(STATIC, 'index.html')); res.writeHead(200, { 'content-type': type['.html'] }); return res.end(html); } }
    json(res, 404, { error: 'Not found' });
  } catch (error) { json(res, 502, { error: error.message || '服务暂不可用，请稍后重试' }); }
});
if (require.main === module) server.listen(PORT, () => console.log(`牛股体检站运行于 http://localhost:${PORT}`));

module.exports = { reportFrom, hash, market };
