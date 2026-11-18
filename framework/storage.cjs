'use strict';
/**
 * Session store: one journal per game, as JSON on disk.
 *
 * Layout: <data>/sessions/<sessionId>.json
 *   { version:2, base, messages, view, meta:{ group, self, title, createdAt, updatedAt, source } }
 *
 * The data root is resolved on every call (LN_DATA_DIR wins) so tests can point
 * it somewhere else without reloading the module. Writes are atomic.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function dataDir() {
  return path.resolve(process.env.LN_DATA_DIR || path.join(ROOT, 'data'));
}

function sessionDir() {
  return path.join(dataDir(), 'sessions');
}

function ensureDir() {
  fs.mkdirSync(sessionDir(), { recursive: true });
}

function assertId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    throw new Error(`非法会话名: ${id}（只允许字母、数字、下划线和连字符）`);
  }
}

function sessionPath(id) {
  assertId(id);
  return path.join(sessionDir(), `${id}.json`);
}

function load(id) {
  const file = sessionPath(id);
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8');
  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new Error(`会话 ${id} 的存档不是合法 JSON: ${error.message}`);
  }
  if (!data || data.version !== 2 || !data.base || !Array.isArray(data.messages)) {
    throw new Error(`会话 ${id} 的存档格式不认识（需要 version:2）`);
  }
  return data;
}

function save(id, journal) {
  ensureDir();
  const now = new Date().toISOString();
  const data = {
    version: 2,
    base: journal.base,
    messages: journal.messages,
    view: journal.view || 0,
    meta: {
      ...(journal.meta || {}),
      openingSeed: journal.meta?.openingSeed || require('node:crypto').randomBytes(16).toString('hex'),
      updatedAt: now,
      createdAt: (journal.meta && journal.meta.createdAt) || now,
    },
  };
  const file = sessionPath(id);
  require('./atomic-file.cjs').writeAtomic(file,JSON.stringify(data,null,2));
  return data.meta;
}

function remove(id) {
  const file = sessionPath(id);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

/** Move a finished game out of the way so a new one can reuse the id. */
function archive(id) {
  const file = sessionPath(id);
  if (!fs.existsSync(file)) return null;
  ensureDir();
  const dest = path.join(sessionDir(), `${id}.archive-${Date.now()}.json`);
  fs.renameSync(file, dest);
  return dest;
}

function list() {
  ensureDir();
  return fs
    .readdirSync(sessionDir())
    .filter((name) => name.endsWith('.json') && !name.includes('.archive-'))
    .map((name) => {
      const id = name.slice(0, -5);
      try {
        const data = JSON.parse(fs.readFileSync(path.join(sessionDir(), name), 'utf8'));
        return { id, messages: data.messages.length, meta: data.meta || {}, rounds: countRounds(data.messages) };
      } catch {
        return { id, broken: true };
      }
    })
    .sort((a, b) => String(b.meta.updatedAt || '').localeCompare(String(a.meta.updatedAt || '')));
}

function countRounds(messages) {
  const rounds = new Set();
  for (const m of messages) for (const hit of String(m.text).matchAll(/第\s*(\d+)\s*回合/g)) rounds.add(Number(hit[1]));
  return [...rounds].sort((a, b) => a - b);
}

module.exports = { ROOT, dataDir, sessionDir, load, save, remove, archive, list, sessionPath, countRounds };
