/**
 * 文件存储层 — 带并发写入保护
 * P1-2: data/ 目录下所有 JSON 文件读写加 per-file 写锁队列，防止竞态写入
 */

const { readFile, writeFile, mkdir, rename } = require('node:fs/promises');
const { join, dirname } = require('node:path');
const { randomUUID } = require('node:crypto');
const { DATA_DIR } = require('./utils');

// --- per-file 写队列 ---
const _writeQueues = new Map();

/**
 * 将写入操作加入 per-file 队列串行执行
 * 同一文件的多次写入会排队执行，避免并发覆盖
 */
function enqueueWrite(filePath, writeFn) {
  if (!_writeQueues.has(filePath)) {
    _writeQueues.set(filePath, Promise.resolve());
  }
  const queue = _writeQueues.get(filePath);
  const task = queue.then(writeFn, writeFn);
  // 链式排队，失败也不中断后续任务
  _writeQueues.set(filePath, task.catch(() => {}));
  return task;
}

async function writeJsonDirect(filePath, data, ensureDir = false) {
  if (ensureDir) await mkdir(dirname(filePath), { recursive: true });
  const tempFile = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempFile, JSON.stringify(data, null, 2));
  await rename(tempFile, filePath);
}

/**
 * 安全读取 JSON 文件
 * @param {string} filePath - 绝对路径
 * @param {*} defaultValue - 读取失败时的默认值
 * @returns {Promise<*>}
 */
async function readJson(filePath, defaultValue) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return defaultValue;
  }
}

/**
 * 安全写入 JSON 文件（带并发保护）
 * @param {string} filePath - 绝对路径
 * @param {*} data - 要序列化的数据
 * @param {boolean} ensureDir - 是否确保目录存在
 */
async function writeJson(filePath, data, ensureDir = false) {
  return enqueueWrite(filePath, () => writeJsonDirect(filePath, data, ensureDir));
}

function updateJson(filePath, defaultValue, update, ensureDir = false) {
  return enqueueWrite(filePath, async () => {
    const current = await readJson(filePath, structuredClone(defaultValue));
    const next = await update(current);
    await writeJsonDirect(filePath, next, ensureDir);
    return next;
  });
}

// --- DB (local.json) ---
const DB_FILE = join(DATA_DIR, 'local.json');
let _dbCache = null, _dbCacheTime = 0;

async function loadDb() {
  if (_dbCache && Date.now() - _dbCacheTime < 1000) return _dbCache;
  await mkdir(DATA_DIR, { recursive: true });
  try { _dbCache = JSON.parse(await readFile(DB_FILE, 'utf8')); }
  catch { _dbCache = { favorites: [] }; }
  _dbCacheTime = Date.now();
  return _dbCache;
}

async function saveDb(db) {
  _dbCache = db;
  _dbCacheTime = Date.now();
  await writeJson(DB_FILE, db);
}

async function updateDb(update) {
  const db = await updateJson(DB_FILE, { favorites: [] }, update);
  _dbCache = db; _dbCacheTime = Date.now();
  return db;
}

// --- Portfolio ---
const PORTFOLIO_FILE = join(DATA_DIR, 'portfolio.json');

async function loadPortfolio() {
  await mkdir(DATA_DIR, { recursive: true });
  return readJson(PORTFOLIO_FILE, { positions: [], trades: [] });
}

async function savePortfolio(pf) {
  await writeJson(PORTFOLIO_FILE, pf);
}

const updatePortfolio = update => updateJson(PORTFOLIO_FILE, { positions: [], trades: [] }, update);

// --- Alerts ---
const ALERTS_FILE = join(DATA_DIR, 'alerts.json');

async function loadAlerts() {
  return readJson(ALERTS_FILE, { rules: [], pending: [] });
}

async function saveAlerts(a) {
  await writeJson(ALERTS_FILE, a);
}

const updateAlerts = update => updateJson(ALERTS_FILE, { rules: [], pending: [] }, update);

// --- Notes ---
const NOTES_DIR = join(DATA_DIR, 'notes');
const NOTES_FILE = join(NOTES_DIR, 'notes.json');

async function loadNotes() {
  return readJson(NOTES_FILE, { notes: [] });
}

async function saveNotes(n) {
  await writeJson(NOTES_FILE, n, true);
}

const updateNotes = update => updateJson(NOTES_FILE, { notes: [] }, update, true);

// --- Config ---
const CONFIG_FILE = join(DATA_DIR, 'config.json');
const defaultConfig = {
  macdFast: 6, macdSlow: 13, macdSignal: 5, volumeRatioThreshold: 1.5, healthScoreThreshold: 60, ma60Period: 60,
  // 智能选股 v0.0.5
  screenMinAmount: 1e8,      // 成交额门槛（元），低于此值视为流动性不足直接剔除
  screenMinListDays: 60,     // 上市天数门槛，次新股剔除
  screenRpsMin: 85,          // RPS60 相对强度百分位门槛
  screenMaxCandidates: 150,  // 进入 K 线精析的候选上限
  screenTopK: 10,            // 最终输出 TopK
  screenMaxChg60d: 120,      // 60 日累计涨幅过热阈值（%），超过视为风险剔除
};

function validateConfig(input) {
  const rules = {
    macdFast: { label: 'MACD 快线', min: 2, max: 50, integer: true },
    macdSlow: { label: 'MACD 慢线', min: 3, max: 100, integer: true },
    macdSignal: { label: 'MACD 信号线', min: 2, max: 50, integer: true },
    volumeRatioThreshold: { label: '量比阈值', min: 0.01, max: 100 },
    healthScoreThreshold: { label: '健康分门槛', min: 0, max: 100 },
    ma60Period: { label: '生命线周期', min: 5, max: 250, integer: true },
    screenMinAmount: { label: '成交额门槛', min: 1e6, max: 1e11 },
    screenMinListDays: { label: '上市天数门槛', min: 1, max: 1000, integer: true },
    screenRpsMin: { label: 'RPS 门槛', min: 50, max: 99 },
    screenMaxCandidates: { label: '候选股上限', min: 20, max: 400, integer: true },
    screenTopK: { label: 'TopK 数量', min: 3, max: 30, integer: true },
    screenMaxChg60d: { label: '60日过热阈值', min: 20, max: 500 },
  };
  const config = {}, errors = [];
  for (const [key, value] of Object.entries(input || {})) {
    const rule = rules[key];
    if (!rule) { errors.push(`不支持的配置项：${key}`); continue; }
    const number = Number(value);
    if (!Number.isFinite(number) || number < rule.min || number > rule.max || (rule.integer && !Number.isInteger(number))) {
      errors.push(`${rule.label}应为${rule.min}至${rule.max}${rule.integer ? '的整数' : '的数值'}`);
      continue;
    }
    config[key] = number;
  }
  const merged = { ...defaultConfig, ...config };
  if ('macdFast' in config || 'macdSlow' in config) {
    const fast = 'macdFast' in config ? config.macdFast : defaultConfig.macdFast;
    const slow = 'macdSlow' in config ? config.macdSlow : defaultConfig.macdSlow;
    if (fast >= slow) errors.push('MACD 快线必须小于慢线');
  }
  return { config, merged, errors };
}

async function loadConfig() {
  const cfg = await readJson(CONFIG_FILE, null);
  return { ...defaultConfig, ...(cfg || {}) };
}

async function saveConfig(cfg) {
  await writeJson(CONFIG_FILE, cfg);
}

const updateConfig = update => updateJson(CONFIG_FILE, defaultConfig, current => update({ ...defaultConfig, ...current }));

// --- Check History ---
const CHECK_HISTORY_DIR = join(DATA_DIR, 'check-history');

// --- Fav History ---
const FAV_HISTORY_DIR = join(DATA_DIR, 'fav-history');

// --- Portfolio Net Value History（净值曲线，P2-12）---
const PORTFOLIO_HISTORY_FILE = join(DATA_DIR, 'portfolio-history.json');

async function loadPortfolioHistory() {
  return readJson(PORTFOLIO_HISTORY_FILE, { days: {} });
}

async function savePortfolioHistory(ph) {
  await writeJson(PORTFOLIO_HISTORY_FILE, ph);
}

// 记录当日总市值（同一天用最新值覆盖）
async function recordNetValue(totalValue) {
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return updateJson(PORTFOLIO_HISTORY_FILE, { days: {} }, ph => {
    ph.days[today] = { date: today, totalValue: Math.round(totalValue * 100) / 100, updatedAt: new Date().toISOString() };
    return ph;
  });
}

// --- Screen History（智能选股每日名单，前向回验的数据基础）---
const SCREEN_HISTORY_DIR = join(DATA_DIR, 'screen-history');

module.exports = {
  readJson, writeJson, updateJson, enqueueWrite,
  loadDb, saveDb, updateDb,
  loadPortfolio, savePortfolio, updatePortfolio,
  loadAlerts, saveAlerts, updateAlerts,
  loadNotes, saveNotes, updateNotes,
  loadConfig, saveConfig, updateConfig, validateConfig, defaultConfig,
  DB_FILE, PORTFOLIO_FILE, ALERTS_FILE, NOTES_FILE, CONFIG_FILE,
  CHECK_HISTORY_DIR, FAV_HISTORY_DIR, SCREEN_HISTORY_DIR,
  PORTFOLIO_HISTORY_FILE, loadPortfolioHistory, savePortfolioHistory, recordNetValue,
};
