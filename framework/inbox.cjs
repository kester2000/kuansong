'use strict';
/**
 * Received-message log for the dashboard.
 *
 * Append-only JSONL under <data>/messages.jsonl, trimmed to the newest records
 * so a busy group cannot grow it without bound. The dashboard reads the tail.
 */
const fs = require('node:fs');
const path = require('node:path');

const store = require('./storage.cjs');

const KEEP = 4000;
const MAX_BYTES = 4 * 1024 * 1024;

function file() {
  return path.join(store.dataDir(), 'messages.jsonl');
}

function append(record) {
  const line = JSON.stringify(record) + '\n';
  try {
    fs.mkdirSync(store.dataDir(), { recursive: true });
    fs.appendFileSync(file(), line);
    const stat = fs.statSync(file());
    if (stat.size > MAX_BYTES) trim();
  } catch {
    /* logging must never break message handling */
  }
}

function trim() {
  try {
    const lines = fs.readFileSync(file(), 'utf8').split('\n').filter(Boolean);
    fs.writeFileSync(file(), lines.slice(-Math.floor(KEEP / 2)).join('\n') + '\n');
  } catch { /* ignore */ }
}

function tail(limit = 80) {
  try {
    if (!fs.existsSync(file())) return [];
    const lines = fs.readFileSync(file(), 'utf8').split('\n').filter(Boolean);
    return lines.slice(-limit).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean).reverse();
  } catch {
    return [];
  }
}

function count() {
  try {
    if (!fs.existsSync(file())) return 0;
    return fs.readFileSync(file(), 'utf8').split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

function clear() {
  try {
    if (fs.existsSync(file())) fs.unlinkSync(file());
    return true;
  } catch {
    return false;
  }
}

module.exports = { append, tail, count, clear, file };
