'use strict';
/**
 * Inference result cache.
 *
 * A report is a pure function of (journal, budget, kernel version), so the key
 * is a hash of exactly those inputs: any new message, edit, pool change, budget
 * change or vendor update misses the cache. Files live under data/cache/ and
 * are pruned to the newest N entries.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const store = require('./store.cjs');
const { DATA, KERNEL_DIR } = require('./kernel.cjs');

const SCHEMA = 126;
const MAX_ENTRIES = 200;

function kernelFingerprint() {
  const hash = crypto.createHash('sha256');
  for (const name of fs.readdirSync(KERNEL_DIR).sort()) {
    if (!name.endsWith('.js')) continue;
    hash.update(name);
    hash.update(fs.readFileSync(path.join(KERNEL_DIR, name)));
  }
  hash.update(String(SCHEMA));
  hash.update(DATA.sha256 || '');
  return hash.digest('hex').slice(0, 16);
}

const FINGERPRINT = kernelFingerprint();

function cacheDir() {
  return path.join(store.dataDir(), 'cache');
}

function keyFor({ journal, budgetMs, heartbeatPaddingRound=null }) {
  const payload = {
    fingerprint: FINGERPRINT,
    openingSeed: require('./opening-random.cjs').seedFor(journal),
    budgetMs: Number(budgetMs) || 0,
    heartbeatPaddingRound,
    base: journal.base,
    view: journal.view,
    messages: journal.messages,
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32);
}

function entryPath(key) {
  return path.join(cacheDir(), `${key}.json`);
}

function get(key) {
  const file = entryPath(key);
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || data.schema !== SCHEMA || !data.report) return null;
    return { report: data.report, cachedAt: data.cachedAt || null, fingerprint: data.fingerprint };
  } catch {
    return null;
  }
}

function set(key, report) {
  const dir = cacheDir();
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `${key}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ schema: SCHEMA, fingerprint: FINGERPRINT, cachedAt: new Date().toISOString(), report }));
  fs.renameSync(tmp, entryPath(key));
  prune();
  return true;
}

function prune() {
  const dir = cacheDir();
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
  if (files.length <= MAX_ENTRIES) return;
  const stats = files.map((name) => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
  for (const item of stats.slice(MAX_ENTRIES)) {
    try { fs.unlinkSync(path.join(dir, item.name)); } catch { /* ignore */ }
  }
}

function clear() {
  const dir = cacheDir();
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try { fs.unlinkSync(path.join(dir, name)); count++; } catch { /* ignore */ }
  }
  for(const item of require('./stage-cache.cjs').files()){
    try{fs.unlinkSync(item.file);count++;}catch{}
  }
  return count;
}

function stats() {
  const dir = cacheDir();
  if (!fs.existsSync(dir)) return { entries: 0, bytes: 0, fingerprint: FINGERPRINT };
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
  const bytes = files.reduce((sum, name) => sum + fs.statSync(path.join(dir, name)).size, 0);
  const stages=require('./stage-cache.cjs').files();
  return { entries: files.length+stages.length, stageEntries:stages.length, bytes:bytes+stages.reduce((sum,s)=>sum+s.size,0), fingerprint: FINGERPRINT };
}

module.exports = { keyFor, get, set, clear, stats, cacheDir, FINGERPRINT };
