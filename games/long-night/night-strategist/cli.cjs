#!/usr/bin/env node
'use strict';
/**
 * part2 — pure CLI inference for one 长夜 game.
 *
 * Commands:
 *   init     create a session (settings are stored as a journal message)
 *   append   add raw bot text, optionally infer in the same run
 *   undo     drop the last message (or one by id)
 *   status   cheap summary, no inference
 *   infer    run the constraint search and print report + suggestion
 *   export   dump the journal as JSON
 *   import   load a journal JSON (v2) into a session
 *   list     list stored sessions
 *   classify tell whether a piece of text is 长夜 material (used by part1)
 *
 * Output is JSON when --json is passed (part1 does), human text otherwise.
 * Exit codes: 0 ok, 2 usage/validation, 3 inference failed.
 */
const fs = require('node:fs');
const path = require('node:path');

const K = require('./kernel.cjs');
const store = require('./store.cjs');
const { buildReport, renderText, renderQQ } = require('./report.cjs');
const { buildReview } = require('./review.cjs');
const cache = require('./cache.cjs');

function parseArgs(argv) {
  const args = { _: [], json: false, format: null };
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) { args._.push(token); continue; }
    const name = token.slice(2);
    if (name === 'json') { args.json = true; continue; }
    if (name === 'force' || name === 'infer' || name === 'stdin' || name === 'silent' || name === 'dark' || name === 'help') { args[name] = true; continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { args[name] = true; continue; }
    args[name] = next;
    i++;
  }
  return args;
}

function ok(data) { return { ok: true, ...data }; }

function fail(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

function emit(payload, args, text) {
  if (args.json || args.format === 'json') process.stdout.write(JSON.stringify(payload) + '\n');
  else if (text != null) process.stdout.write(text + '\n');
  else process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
}

function openSession(id) {
  if (!id) throw new K.UsageError('缺少 --session', 'NO_SESSION');
  const journal = store.load(id);
  if (!journal) throw new K.UsageError(`会话不存在：${id}（先 init）`, 'SESSION_NOT_FOUND');
  return journal;
}

function readPayload(args) {
  if (args.text != null) return String(args.text);
  if (args.file) return fs.readFileSync(String(args.file), 'utf8');
  if (args.stdin) return fs.readFileSync(0, 'utf8');
  throw new K.UsageError('缺少输入：--text / --file / --stdin', 'NO_INPUT');
}

function parseInput(args) {
  const raw = readPayload(args);
  if (args.stdin && raw.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.text === 'string') return parsed;
    } catch { /* plain text */ }
  }
  return { text: raw };
}

/**
 * Report without running the search. Used by `review` on games that never got a
 * trajectory: the constraint engine would spend its whole budget on an empty
 * board and still prove nothing.
 */
function quickReport(journal) {
  const status = K.quickStatus(journal);
  const built = K.build(journal);
  const view = built.views[built.self] || built.views[0];
  return {
    ok: true,
    self: status.self,
    settings: {
      mode: status.mode, modeName: status.modeName, players: status.players, size: status.size,
      pool: status.pool, poolCount: status.poolCount, poolSource: status.poolSource,
      exitCount: status.exitCount, event: status.event, silent: status.silent,
    },
    progress: {
      messages: status.messages, rounds: status.rounds, pendingRounds: status.pendingRounds,
      ambiguities: status.ambiguities, segment: view.model.active, segments: view.model.segments.length,
    },
    status: null,
    position: null,
    blocks: { determined: [], candidatesHere: [], poolSize: status.poolCount },
    maps: { count: 0, complete: false },
    verification: { status: 'skipped' },
    suggestion: { ok: false, reason: '这局没有可推理的行动轨迹，跳过地图搜索。', moves: [], warnings: [] },
    questions: [],
    advice: [],
    probes: [],
    quick: true,
  };
}

async function runInfer(journal, args, sessionId) {
  const budgetMs = Number(args.budget) || 15000;
  const heartbeatPaddingRound=Number(args['heartbeat-padding-round'])||null;
  const key = args.refresh ? null : cache.keyFor({ journal, budgetMs, heartbeatPaddingRound });
  if (key) {
    const hit = cache.get(key);
    if (hit) {
      return {
        built: K.build(journal),
        team: null,
        report: { ...hit.report, session: sessionId, elapsedMs: 0, cached: true, cachedAt: hit.cachedAt },
      };
    }
  }
  const started = Date.now();
  const stageCache=args.refresh?null:require('./stage-cache.cjs').create();
  const { built, team } = await K.infer(journal, { budgetMs,stageCache });
  const report = buildReport({ journal, built, team, heartbeatPaddingRound });
  report.session = sessionId;
  report.elapsedMs = Date.now() - started;
  report.generatedAt = new Date().toISOString();
  report.cached = false;
  if(stageCache)report.stageCache=stageCache.metrics;
  if (key) {
    try { cache.set(key, report); } catch { /* a cache write must never fail a request */ }
  }
  return { built, team, report };
}

const commands = {
  async init(args) {
    const id = args.session;
    if (!id) throw new K.UsageError('缺少 --session', 'NO_SESSION');
    const existing = store.load(id);
    if (existing && !args.force) {
      return { code: 2, payload: fail('SESSION_EXISTS', `会话 ${id} 已存在；要覆盖请加 --force`, { session: id }) };
    }
    let journal = K.newJournal();
    journal = K.configure(journal, args);
    const text = K.settingsTextFor(journal, { self: args.self != null ? Number(args.self) : null });
    if (text) journal = K.append(journal, text, { view: Number(args.self || 0), force: true }).journal;
    journal.meta = {
      group: args.group || null,
      self: Number(args.self || 0),
      title: args.title || null,
      source: args.source || 'cli',
    };
    store.save(id, journal);
    const status = K.quickStatus(journal);
    return { code: 0, payload: ok({ session: id, status }), text: renderStatus(id, status) };
  },

  async append(args) {
    const id = args.session;
    const journal = openSession(id);
    const input = parseInput(args);
    const view = input.view != null ? Number(input.view) : Number(args.view ?? journal.meta?.self ?? journal.view ?? 0);
    const result = K.append(journal, input.text, { view, force: !!args.force });
    if (!result.duplicate) store.save(id, result.journal);
    const status = K.quickStatus(result.journal);
    if (!args.infer) {
      return {
        code: 0,
        payload: ok({ session: id, id: result.id, duplicate: !!result.duplicate, type: result.type, counts: result.counts, warnings: result.warnings, status }),
        text: `${result.duplicate ? '（重复，已忽略）' : '已录入'} ${result.type || ''}\n` + renderStatus(id, status),
      };
    }
    const { report } = await runInfer(result.journal, args, id);
    report.accepted = { duplicate: !!result.duplicate, type: result.type, counts: result.counts, warnings: result.warnings };
    return { code: 0, payload: ok(report), text: renderText(report) };
  },

  async undo(args) {
    const id = args.session;
    const journal = openSession(id);
    const next = K.removeMessage(journal, args.id);
    store.save(id, next);
    const status = K.quickStatus(next);
    return { code: 0, payload: ok({ session: id, removed: args.id || '最后一条', status }), text: `已撤销 ${args.id || '最后一条'}\n` + renderStatus(id, status) };
  },

  async status(args) {
    const id = args.session;
    const journal = openSession(id);
    const status = K.quickStatus(journal);
    return { code: 0, payload: ok({ session: id, status }), text: renderStatus(id, status) };
  },

  async infer(args) {
    const id = args.session;
    const journal = openSession(id);
    const { report } = await runInfer(journal, args, id);
    return { code: 0, payload: ok(report), text: renderText(report) };
  },

  async export(args) {
    const id = args.session;
    const journal = openSession(id);
    const payload = { version: 2, base: journal.base, messages: journal.messages, view: journal.view, meta: journal.meta };
    if (args.out) {
      fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
      fs.writeFileSync(String(args.out), JSON.stringify(payload, null, 2));
      return { code: 0, payload: ok({ session: id, out: args.out, messages: journal.messages.length }), text: `已导出到 ${args.out}` };
    }
    return { code: 0, payload: ok({ session: id, journal: payload }), text: JSON.stringify(payload, null, 2) };
  },

  async import(args) {
    const id = args.session;
    if (!id) throw new K.UsageError('缺少 --session', 'NO_SESSION');
    const raw = fs.readFileSync(String(args.file || args._[0]), 'utf8');
    const parsed = JSON.parse(raw);
    const journal = parsed.version === 2 ? parsed : parsed.journal;
    if (!journal || journal.version !== 2) throw new K.UsageError('不是 v2 存档', 'BAD_IMPORT');
    if (!journal.base || !Array.isArray(journal.messages)) throw new K.UsageError('存档缺少 base 或 messages', 'BAD_IMPORT');
    K.E.validateState(journal.base);
    K.build(journal); // validate messages
    store.save(id, { ...journal, meta: journal.meta || {} });
    const status = K.quickStatus(journal);
    return { code: 0, payload: ok({ session: id, status }), text: `已导入 ${journal.messages.length} 条消息\n` + renderStatus(id, status) };
  },

  async list() {
    const rows = store.list();
    const text = rows.length
      ? rows.map((row) => `${row.id}  ${row.broken ? '（损坏）' : `${row.messages} 条消息 · 回合 ${row.rounds.join('/') || '—'}`}`).join('\n')
      : '（没有会话）';
    return { code: 0, payload: ok({ sessions: rows }), text };
  },

  async classify(args) {
    const input = parseInput(args);
    const parsed = K.M.inspect(String(input.text));
    const relevant = Object.keys(parsed.counts).length > 0 && parsed.type !== '附注';
    const payload = ok({ relevant, type: parsed.type, counts: parsed.counts, privateInput: !!parsed.privateInput, warnings: parsed.warnings || [] });
    return { code: 0, payload, text: `${relevant ? '相关' : '无关'}：${parsed.type}` };
  },

  async cache(args) {
    if (args.clear) {
      const removed = cache.clear();
      return { code: 0, payload: ok({ cleared: removed }), text: `已清理 ${removed} 条推理缓存` };
    }
    const info = cache.stats();
    return { code: 0, payload: ok(info), text: `推理缓存 ${info.entries} 条 · ${(info.bytes / 1024).toFixed(1)} KB · 内核指纹 ${info.fingerprint}` };
  },

  async 'pool-read'(args) {
    const file = args.image || args._[1];
    if (!file) throw new K.UsageError('缺少 --image <开局图>', 'NO_IMAGE');
    if (!fs.existsSync(String(file))) throw new K.UsageError(`找不到图片：${file}`, 'NO_IMAGE');
    const { readPool } = require('./pool-image.cjs');
    let pool;
    if (args.mode) {
      const mode = K.MODE_KEYS[args.mode] || String(args.mode).toUpperCase();
      if (!K.DATA.modes[mode]) throw new K.UsageError(`未知模式: ${args.mode}`);
      pool = K.DATA.modes[mode];
    }
    if (args.pool) pool = K.normalizePool(args.pool);
    const expanded=!!(args.expanded || args.session&&store.load(String(args.session))?.base?.config?.expandedPool);
    const result = readPool(fs.readFileSync(String(file)), { pool, expanded });
    // Crazy mode hides two special blocks: the sheet cannot show which ones, so
    // treat every special as possible (same rule the web tool uses).
    if (pool && pool.some((id) => /^S/.test(id))) {
      const specials = pool.filter((id) => /^S/.test(id));
      const hidden = specials.filter((id) => !result.ids.includes(id));
      if (hidden.length) {
        result.ids = [...result.ids, ...hidden];
        result.pool = result.ids.join(' ');
        result.specialsUnknown = hidden;
        result.warnings.push(`疯狂模式有 ${hidden.length} 个特殊区块是隐藏的，已按“全部特殊块都可能”处理：${hidden.join(' ')}。`);
      }
    }
    if (args.session) {
      const journal = openSession(String(args.session));
      const usable = result.ok && (result.confidence !== 'low' || args.force);
      if (usable) {
        const view = journal.meta && journal.meta.self != null ? Number(journal.meta.self) : 0;
        const applied = K.append(journal, `区块池：${result.pool}`, { view, force: true });
        store.save(String(args.session), applied.journal);
        result.applied = String(args.session);
      }
    }
    const text = result.ok
      ? `区块池 ${result.ids.length} 块（把握：${result.confidence}）：${result.pool}${result.applied ? `\n已写入会话 ${result.applied}` : ''}${result.warnings.length ? '\n注意：' + result.warnings.join('；') : ''}`
      : `读不出区块池：${result.warnings.join('；') || '未知原因'}`;
    return { code: result.ok ? 0 : 2, payload: ok(result), text };
  },

  async qq(args) {
    const id = args.session;
    const journal = openSession(id);
    const { report } = await runInfer(journal, args, id);
    const qqText = renderQQ(report, { limit: Number(args.limit) || 900 });
    return { code: 0, payload: ok({ qqText, report }), text: qqText };
  },

  async review(args) {
    const id = args.session;
    const journal = openSession(id);
    const prebuilt = K.build(journal);
    const selfView = prebuilt.views[prebuilt.self] || prebuilt.views[0];
    const hasTrajectory = !!(selfView && selfView.steps && selfView.steps.length);
    let built = prebuilt;
    let report;
    if (args.quick || !hasTrajectory) {
      report = quickReport(journal);
    } else {
      ({ built, report } = await runInfer(journal, args, id));
    }
    const review = buildReview({ journal, report, built });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const out = args.out === false ? null : path.resolve(String(args.out || path.join(store.dataDir(), 'reviews', `${id}-${stamp}.md`)));
    if (out) {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, review.markdown);
    }
    return {
      code: 0,
      payload: ok({ session: id, out, summary: review.summary, result: review.result, rounds: review.rounds, markdown: review.markdown }),
      text: out ? `${review.summary}\n\n复盘文件：${out}\n\n${review.markdown}` : review.markdown,
    };
  },
};

function renderStatus(id, status) {
  const lines = [
    `会话 ${id} · 本人 ${status.self}号 · ${status.modeName} ${status.players}人 · ${status.size}×${status.size}`,
    `消息 ${status.messages} 条 · 回合 ${status.rounds.join('/') || '—'} · 区块池 ${status.poolCount} 块${status.poolReady ? '' : '（未录入，无法推理）'}`,
  ];
  if (status.pendingRounds.length) lines.push(`待补本人四墙：第 ${status.pendingRounds.join('、')} 回合`);
  if (status.ambiguities) lines.push(`待定分支：${status.ambiguities} 处`);
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv);
  const name = args._[0];
  if (!name || args.help) {
    process.stdout.write('用法: node night-strategist/cli.cjs <init|append|undo|status|infer|qq|review|pool-read|export|import|list|classify|cache> [选项]\n');
    return 0;
  }
  const command = commands[name];
  if (!command) {
    emit(fail('UNKNOWN_COMMAND', `未知命令: ${name}`), args);
    return 2;
  }
  try {
    if (name === 'classify') {
      const out = await command(args, true);
      process.stdout.write(JSON.stringify(out.payload) + '\n');
      return 0;
    }
    const out = await command(args);
    emit(out.payload, args, out.text);
    return out.code;
  } catch (error) {
    const code = error.code || 'ERROR';
    const status = ['NEED_POOL', 'NO_SESSION', 'SESSION_NOT_FOUND', 'USAGE', 'BAD_IMPORT', 'EMPTY', 'TOO_LONG'].includes(code) ? 2 : 3;
    if (args.json || args.format === 'json') process.stdout.write(JSON.stringify(fail(code, error.message)) + '\n');
    else process.stderr.write(`[${code}] ${error.message}\n`);
    return status;
  }
}

// Large decision reports exceed a pipe's buffer. Exiting immediately after
// write() can truncate JSON even with exit code 0; flush both streams first.
function finish(code) {
  let pending=2;
  const flushed=()=>{if(--pending===0)process.exit(code);};
  process.stdout.write('',flushed);
  process.stderr.write('',flushed);
}
main().then(finish).catch((error) => {
  process.stderr.write(`fatal: ${error && error.stack ? error.stack : error}\n`);
  finish(3);
});
