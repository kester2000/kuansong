'use strict';
/**
 * Keep the pictures the game bot posts (the opening block-pool sheet, and any
 * later image), so a human can read the pool or check a board later.
 *
 * OneBot image segments carry `url` (http/data) and `file`. We accept all three
 * shapes: data: URL, http(s) URL (short timeout) and a local path. Every saved
 * file is appended to data/images/index.jsonl so it can be traced back to the
 * message that carried it.
 */
const fs = require('node:fs');
const path = require('node:path');

const store = require('./storage.cjs');

const MAX_BYTES = 8 * 1024 * 1024;
const EXT_BY_TYPE = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };

function extensionOf(contentType, hint) {
  if (contentType && EXT_BY_TYPE[contentType.split(';')[0].trim()]) return EXT_BY_TYPE[contentType.split(';')[0].trim()];
  const match = String(hint || '').match(/\.(png|jpe?g|gif|webp)(?:[?#]|$)/i);
  if (match) return '.' + match[1].toLowerCase().replace('jpeg', 'jpg');
  return '.img';
}

async function bytesOf(data) {
  const url = typeof data.url === 'string' ? data.url : '';
  if (url.startsWith('data:')) {
    const match = url.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
    if (!match) return null;
    const contentType = match[1] || '';
    const raw = match[2] ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3]));
    return raw.length ? { bytes: raw, contentType, hint: '' } : null;
  }
  if (/^https?:\/\//i.test(url)) {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > MAX_BYTES) return null;
    return { bytes: buffer, contentType: response.headers.get('content-type') || '', hint: url };
  }
  if (typeof data.file === 'string' && fs.existsSync(data.file)) {
    const buffer = fs.readFileSync(data.file);
    if (!buffer.length || buffer.length > MAX_BYTES) return null;
    return { bytes: buffer, contentType: '', hint: data.file };
  }
  return null;
}

async function saveEventImages(event, options = {}) {
  const segments = Array.isArray(event.message) ? event.message.filter((segment) => segment && segment.type === 'image') : [];
  return saveImageData(segments.map((segment) => segment.data || {}), event, options);
}

/** Save a list of image payloads ({url}|{file}|{dataUrl}) for one message. */
async function saveImageData(payloads, event, options = {}) {
  const segments = (payloads || []).map((data) => ({ type: 'image', data }));
  if (!segments.length) return [];
  const dir = path.join(store.dataDir(), 'images');
  fs.mkdirSync(dir, { recursive: true });
  const saved = [];
  for (let index = 0; index < segments.length; index++) {
    const data = segments[index].data || {};
    let material;
    try {
      material = await bytesOf(data);
    } catch (error) {
      if (options.logger) options.logger(`图片下载失败: ${error.message}`);
      continue;
    }
    if (!material) continue;
    const ext = extensionOf(material.contentType, material.hint || data.file);
    const base = `${event.group_id || 'private'}-${event.message_id || Date.now()}-${index}`;
    const file = path.join(dir, base + ext);
    try {
      fs.writeFileSync(file, material.bytes);
    } catch (error) {
      if (options.logger) options.logger(`图片保存失败: ${error.message}`);
      continue;
    }
    const record = {
      at: new Date().toISOString(),
      groupId: event.group_id || null,
      userId: event.user_id || null,
      messageId: event.message_id || null,
      file,
      bytes: material.bytes.length,
      source: typeof data.url === 'string' && data.url.startsWith('http') ? 'url' : data.url ? 'data' : 'file',
    };
    try {
      fs.appendFileSync(path.join(dir, 'index.jsonl'), JSON.stringify(record) + '\n');
    } catch { /* index is best effort */ }
    saved.push(file);
  }
  return saved;
}

function listImages(limit = 50) {
  const index = path.join(store.dataDir(), 'images', 'index.jsonl');
  if (!fs.existsSync(index)) return [];
  const lines = fs.readFileSync(index, 'utf8').trim().split('\n').filter(Boolean);
  return lines.slice(-limit).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean).reverse();
}

module.exports = { saveEventImages, saveImageData, listImages, extensionOf };
