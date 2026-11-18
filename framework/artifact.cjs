'use strict';
/**
 * Dashboard artifact: one JSON per game under <data>/dash/<session>.json.
 *
 * It is written by part1 as messages land, so the board is a pure reader: no
 * inference, no commands, nothing that could change the game state. The raw
 * journal itself stays in data/sessions/ and can be imported by part2 for a
 * replay (`night-strategist/cli.cjs review --session …`).
 */
const fs = require('node:fs');
const path = require('node:path');

const store = require('./storage.cjs');

const MAX_MESSAGES = 300;
const updates = new (require('node:events').EventEmitter)();
updates.setMaxListeners(100);
const MAX_REPORT_MOVES = 4;

function dir() {
  return path.join(store.dataDir(), 'dash');
}

function file(session) {
  return path.join(dir(), `${session}.json`);
}

function empty(session) {
  return {
    session,
    updatedAt: new Date().toISOString(),
    settings: {},
    pool: null,
    messages: [],
    private: [],
    report: null,
    review: null,
  };
}

function load(session) {
  try {
    const raw = fs.readFileSync(file(session), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Start a clean board slate for a brand-new game (same session id, new match). */
function reset(session) {
  return save(session, empty(session));
}

function save(session, data) {
  fs.mkdirSync(dir(), { recursive: true });
  data.session = session;
  data.updatedAt = new Date().toISOString();
  require('./game.cjs').module('night-strategist/atomic-file.cjs').writeAtomic(file(session),JSON.stringify(data));
  updates.emit('change', session);
  return data;
}

function update(session, mutate) {
  const data = { ...empty(session), ...load(session) };
  mutate(data);
  return save(session, data);
}

function setSettings(session, settings) {
  return update(session, (data) => {
    data.settings = { ...(data.settings || {}), ...settings };
  });
}

function addMessage(session, message) {
  return update(session, (data) => {
    data.messages.push({
      at: new Date().toISOString(),
      id: message.id || null,
      view: message.view == null ? null : Number(message.view),
      type: message.type || '内容',
      private: !!message.private,
      text: String(message.text || '').slice(0, 2000),
    });
    if (data.messages.length > MAX_MESSAGES) data.messages = data.messages.slice(-MAX_MESSAGES);
    if (message.private) {
      data.private.push({ at: new Date().toISOString(), text: String(message.text || '').slice(0, 2000) });
      if (data.private.length > 100) data.private = data.private.slice(-100);
    }
  });
}

function setPool(session, pool) {
  return update(session, (data) => {
    data.pool = {
      at: new Date().toISOString(),
      ids: (pool.ids || []).map(String),
      confidence: pool.confidence || null,
      texture: pool.texture || null,
      image: pool.image || null,
      source: pool.source || 'image',
      tiles: (pool.tiles || []).slice(0, 40),
    };
  });
}

function setReport(session, report) {
  if (!report) return null;
  const suggestion = report.suggestion || {};
  const trimMove = (move) => (move ? {
    direction: move.direction,
    label: move.label,
    arrow: move.arrow,
    score: move.score,
    risks: (move.risks || []).slice(0, 3),
    gains: (move.gains || []).slice(0, 3),
    reasons: (move.reasons || []).slice(0, 3),
  } : null);
  return update(session, (data) => {
    data.decisions = data.decisions || [];
    data.decisions.push({ at: new Date().toISOString(), report });
    data.report = {
      at: report.generatedAt || new Date().toISOString(),
      elapsedMs: report.elapsedMs || 0,
      cached: !!report.cached,
      self: report.self,
      position: report.position || null,
      blocks: report.blocks || null,
      maps: report.maps || null,
      progress: report.progress || null,
      text: String(report.text || report.qqText || '').slice(0, 4000),
      board: report.board || null,
      players: report.players || [],
      slots: (report.slots || []).slice(0, 12),
      questions: (report.questions || []).slice(0, 10),
      confidence: suggestion.confidence || null,
      decision: suggestion.bayes || suggestion.calculation || null,
      tactic: suggestion.tactic || null,
      primary: trimMove(suggestion.primary),
      alternatives: (suggestion.alternatives || []).slice(0, 2).map(trimMove),
      plan: suggestion.plan || null,
      warnings: (suggestion.warnings || []).slice(0, 4),
    };
  });
}

function setReview(session, review) {
  return update(session, (data) => {
    data.review = {
      at: new Date().toISOString(),
      path: review.path || null,
      summary: String(review.summary || '').slice(0, 2000),
      result: review.result || null,
    };
  });
}

function list() {
  try {
    fs.mkdirSync(dir(), { recursive: true });
    return fs.readdirSync(dir())
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(dir(), name), 'utf8'));
          return {
            ...data,
            messages: data.messages || [],
            private: data.private || [],
            report: data.report || null,
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  } catch {
    return [];
  }
}

module.exports = { updates, load, save, reset, list, setSettings, addMessage, setPool, setReport, setReview, file, dir, MAX_REPORT_MOVES };
