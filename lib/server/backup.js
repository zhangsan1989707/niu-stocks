/**
 * 数据备份模块
 * 将 DATA_DIR 下的运行数据定期打包为 tar.gz 存到 DATA_DIR/backups/
 * 仅保留最近 N 份，防止 Volume 存储无限增长
 */

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { join, basename } = require('node:path');
const { readdir, mkdir, unlink, stat } = require('node:fs/promises');
const { DATA_DIR } = require('./utils');

const execFileAsync = promisify(execFile);

const BACKUP_DIR = join(DATA_DIR, 'backups');
const KEEP = 7; // 保留最近 7 份

/**
 * 执行一次备份：把整个 DATA_DIR 打包到 backups/，文件名含时间戳
 * @returns {Promise<string|null>} 备份文件路径，失败返回 null
 */
async function runBackup() {
  try {
    await mkdir(BACKUP_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const out = join(BACKUP_DIR, `backup-${ts}.tar.gz`);
    // 打包 DATA_DIR 下所有内容，排除 backups 自身避免递归
    await execFileAsync('tar', ['-czf', out, '-C', DATA_DIR, '--exclude', 'backups', '.']);
    await pruneBackups();
    console.log(`[backup] 数据备份完成：${basename(out)}`);
    return out;
  } catch (error) {
    console.error('[backup] 备份失败：', error.message);
    return null;
  }
}

/**
 * 清理旧备份，仅保留最近 KEEP 份
 */
async function pruneBackups() {
  try {
    const names = (await readdir(BACKUP_DIR))
      .filter(f => f.startsWith('backup-') && f.endsWith('.tar.gz'));
    const metas = [];
    for (const f of names) {
      const p = join(BACKUP_DIR, f);
      const s = await stat(p).catch(() => null);
      if (s) metas.push({ f, p, mtime: s.mtimeMs });
    }
    metas.sort((a, b) => b.mtime - a.mtime);
    for (const x of metas.slice(KEEP)) {
      await unlink(x.p).catch(() => {});
    }
  } catch (error) {
    console.error('[backup] 清理旧备份失败：', error.message);
  }
}

/**
 * 列出已有备份
 */
async function listBackups() {
  try {
    return (await readdir(BACKUP_DIR))
      .filter(f => f.startsWith('backup-') && f.endsWith('.tar.gz'))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

module.exports = { runBackup, listBackups, BACKUP_DIR };
