/**
 * 文件存储层 — 带并发写入保护
 * P1-2: data/ 目录下所有 JSON 文件读写加 per-file 写锁队列，防止竞态写入
 */

const { readFile, writeFile, mkdir } = require('node:fs/promises');
const { join } = require('node:path');
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
  return enqueueWrite(filePath, async () => {
    if (ensureDir) {
      const dir = join(filePath, '..');
      await mkdir(dir, { recursive: true });
    }
    await writeFile(filePath, JSON.stringify(data, null, 2));
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

// --- Portfolio ---
const PORTFOLIO_FILE = join(DATA_DIR, 'portfolio.json');

async function loadPortfolio() {
  await mkdir(DATA_DIR, { recursive: true });
  return readJson(PORTFOLIO_FILE, { positions: [], trades: [] });
}

async function savePortfolio(pf) {
  await writeJson(PORTFOLIO_FILE, pf);
}

// --- Alerts ---
const ALERTS_FILE = join(DATA_DIR, 'alerts.json');

async function loadAlerts() {
  return readJson(ALERTS_FILE, { rules: [], pending: [] });
}

async function saveAlerts(a) {
  await writeJson(ALERTS_FILE, a);
}

// --- Notes ---
const NOTES_DIR = join(DATA_DIR, 'notes');
const NOTES_FILE = join(NOTES_DIR, 'notes.json');

async function loadNotes() {
  return readJson(NOTES_FILE, { notes: [] });
}

async function saveNotes(n) {
  await writeJson(NOTES_FILE, n, true);
}

// --- Config ---
const CONFIG_FILE = join(DATA_DIR, 'config.json');
const defaultConfig = { macdFast: 6, macdSlow: 13, macdSignal: 5, volumeRatioThreshold: 1.5, healthScoreThreshold: 60, ma60Period: 60 };

async function loadConfig() {
  const cfg = await readJson(CONFIG_FILE, null);
  return { ...defaultConfig, ...(cfg || {}) };
}

async function saveConfig(cfg) {
  await writeJson(CONFIG_FILE, cfg);
}

// --- Check History ---
const CHECK_HISTORY_DIR = join(DATA_DIR, 'check-history');

// --- Fav History ---
const FAV_HISTORY_DIR = join(DATA_DIR, 'fav-history');

module.exports = {
  readJson, writeJson, enqueueWrite,
  loadDb, saveDb,
  loadPortfolio, savePortfolio,
  loadAlerts, saveAlerts,
  loadNotes, saveNotes,
  loadConfig, saveConfig, defaultConfig,
  DB_FILE, PORTFOLIO_FILE, ALERTS_FILE, NOTES_FILE, CONFIG_FILE,
  CHECK_HISTORY_DIR, FAV_HISTORY_DIR,
};
