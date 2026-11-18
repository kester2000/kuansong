#!/usr/bin/env node
'use strict';
/**
 * Offline end-to-end harness: a fake OneBot server plays a scripted 长夜 session
 * against part1, so the whole pipeline (filter -> session -> part2 -> reply) can
 * be exercised without QQ or SnowLuma.
 *
 *   node game-steward/mock.cjs                # built-in 2-player scenario
 *   node game-steward/mock.cjs --scenario x.json --mode auto
 *   node game-steward/mock.cjs --keep         # keep session files for inspection
 */
const fs = require('node:fs');
const path = require('node:path');

const { MiniWsServer } = require('./mini-ws.cjs');
const { OneBotClient } = require('./onebot.cjs');
const { Part2Client } = require('./part2-client.cjs');
const { LongNightBot } = require('./bot.cjs');
const { StateStore } = require('./state.cjs');
const { loadConfig, ROOT } = require('./config.cjs');

const BOT_ID = '900001';
const ME_ID = '100001';
const OTHER_ID = '100002';
const GROUP_ID = '700001';

const SCENARIO = [
  { from: 'bot', text: '[提示] 本局游戏人数为 2 人，逃生舱数量为 1 个。请留意私信发送的开局墙壁信息\n\n【区块模式】经典\n本局可能出现的区块详见下图所示：\n[图片]' },
  { from: 'bot', private: true, text: '【开局】\n您所在位置的四周墙壁信息，按照 上下左右 顺序分别是：\n空空空空' },
  { from: 'bot', text: '区块池：1 2 3 4 5 6 7 8 9 10 11 12 E1' },
  { from: 'bot', text: '[1号]玩家本回合的完整行动轨迹：\n[→沙沙][←沙沙]↓(↓撞)' },
  { from: 'human', text: '#宽松' },
];

function eventFor(step, index) {
  const base = {
    time: Math.floor(Date.now() / 1000),
    self_id: Number(ME_ID),
    post_type: 'message',
    message_id: 1000 + index,
    font: 0,
  };
  const message = [];
  if (step.imageFile) message.push({ type: 'image', data: { file: step.imageFile } });
  else if (step.image) message.push({ type: 'image', data: { url: step.image, file: 'mock-image.png' } });
  if (step.at) message.push({ type: 'at', data: { qq: String(step.at) } });
  if (step.text) message.push({ type: 'text', data: { text: step.text } });
  if (step.private) {
    return {
      ...base,
      message_type: 'private',
      sub_type: 'friend',
      user_id: Number(BOT_ID),
      message,
      raw_message: step.text || '',
      sender: { user_id: Number(BOT_ID), nickname: '长夜机器人', sex: 'unknown', age: 0 },
    };
  }
  const user = step.from === 'bot' ? BOT_ID : step.from === 'self' ? ME_ID : OTHER_ID;
  return {
    ...base,
    message_type: 'group',
    sub_type: 'normal',
    group_id: Number(GROUP_ID),
    group_name: '长夜测试群',
    user_id: Number(user),
    message,
    raw_message: step.text || '',
    sender: {
      user_id: Number(user),
      nickname: step.from === 'bot' ? '长夜机器人' : step.from === 'self' ? '我' : '队友',
      card: step.from === 'bot' ? '' : step.from === 'self' ? '我' : '队友',
      role: 'member',
      sex: 'unknown',
      age: 0,
    },
    anonymous: null,
  };
}

async function runMock(options = {}) {
  const mode = options.mode || 'command';
  const scenario = options.scenario || SCENARIO;
  const quiet = !!options.quiet;
  const dataDir = options.dataDir || require('node:fs').mkdtempSync(path.join(require('node:os').tmpdir(), 'kuansong-mock-'));
  fs.mkdirSync(dataDir, { recursive: true });
  process.env.LN_DATA_DIR = dataDir; // part2's store resolves this lazily

  const config = loadConfig(null);
  if (options.overrides) {
    const merge = (base, patch) => {
      const out = { ...base };
      for (const [key, value] of Object.entries(patch)) {
        out[key] = value && typeof value === "object" && !Array.isArray(value) && base[key] && typeof base[key] === "object"
          ? merge(base[key], value) : value;
      }
      return out;
    };
    Object.assign(config, merge(config, options.overrides));
  }
  config.onebot.url = 'ws://placeholder/';
  config.behavior.mode = mode;
  config.behavior.debounceMs = options.debounceMs == null ? 250 : options.debounceMs;
  config.behavior.inferBudgetMs = options.budgetMs || 8000;
  config.paths.state = path.join(dataDir, 'state.json');
  config.part2.timeoutMs = 180000;
  config.reply.throttleMs = 0;
  config.groups = [GROUP_ID];

  for (const file of ['state.json']) {
    const target = path.resolve(dataDir, file);
    if (fs.existsSync(target)) fs.unlinkSync(target);
  }
  const sessionDir = path.join(dataDir, 'sessions');
  if (fs.existsSync(sessionDir)) {
    for (const name of fs.readdirSync(sessionDir)) {
      if (name.startsWith(`g${GROUP_ID}`)) fs.unlinkSync(path.join(sessionDir, name));
    }
  }

  const server = new MiniWsServer();
  const url = await server.listen(0);
  config.onebot.url = url;

  const replies = [];
  const actions = [];
  server.on('message', (raw, client) => {
    let payload;
    try { payload = JSON.parse(raw); } catch { return; }
    if (!payload || !payload.action) return;
    actions.push(payload);
    const data = payload.action === 'get_login_info'
      ? { user_id: Number(ME_ID), nickname: '我' }
      : { message_id: 9000 + actions.length };
    server.send(client, JSON.stringify({ status: 'ok', retcode: 0, data, echo: payload.echo }));
    if (payload.action === 'send_group_msg' || payload.action === 'send_private_msg') {
      const message = payload.params.message;
      const text = (Array.isArray(message) ? message : [])
        .filter((segment) => segment.type === 'text')
        .map((segment) => segment.data.text)
        .join('');
      replies.push({ action: payload.action, groupId: payload.params.group_id, userId: payload.params.user_id, text, segments: Array.isArray(message) ? message : [] });
      if (options.onReply) options.onReply({ action: payload.action, text, broadcast: (ev) => server.broadcast(JSON.stringify(ev)) });
    }
  });

  const state = new StateStore(config.paths.state);
  state.load();
  const logger = quiet ? Object.assign(() => {}, { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }) : console.log;
  const part2 = new Part2Client({ node: config.part2.node, cli: config.part2.cli, timeoutMs: config.part2.timeoutMs });
  const client = new OneBotClient({ url, accessToken: '', timeoutMs: 10000, reconnect: false, logger });
  const bot = new LongNightBot({
    config, part2, state,
    send: async ({ type, groupId, userId, message }) => {
      if (type === 'group') await client.sendGroup(groupId, message);
      else await client.sendPrivate(userId, message);
    },
    logger,
  });
  client.on('event', (event) => bot.onEvent(event).catch((error) => { if (!quiet) console.error('处理失败', error); }));

  await client.connect();
  bot.selfId = ME_ID;
  bot.selfNames.add('我');

  if (options.fixture) {
    const imported = await part2.run(['import', '--session', `g${GROUP_ID}`, '--file', path.resolve(options.fixture), '--json'], { timeoutMs: 60000 });
    if (!imported.json || !imported.json.ok) throw new Error(`导入夹具失败: ${(imported.json && imported.json.message) || imported.stderr}`);
    const journal = JSON.parse(fs.readFileSync(path.resolve(options.fixture), 'utf8'));
    const selfNumber = (() => {
      for (const message of journal.messages) {
        const hit = String(message.text).match(/我是\s*(\d)\s*号/);
        if (hit) return Number(hit[1]);
      }
      return 0;
    })();
    state.setGroup(GROUP_ID, { session: `g${GROUP_ID}`, self: selfNumber });
    state.data.lastGroup = GROUP_ID;
    state.data.lastSession = `g${GROUP_ID}`;
    state.save();
    bot.selfNames.add('我');
  }

  const started = Date.now();
  for (let i = 0; i < scenario.length; i++) {
    const step = scenario[i];
    server.broadcast(JSON.stringify(eventFor(step, i)));
    await new Promise((resolve) => setTimeout(resolve, step.delayMs == null ? 120 : step.delayMs));
  }

  // Drain the bot's event queue first: it serialises appends behind the
  // asynchronous session creation, so nothing is half-written when we assert.
  await bot.queue;
  const deadline = Date.now() + (options.settleMs || 30000);
  while (Date.now() < deadline && bot.inflight.size) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  while (Date.now() < deadline && options.expectReplies && replies.length < options.expectReplies) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await bot.queue;
  await new Promise((resolve) => setTimeout(resolve, Math.max(200, config.behavior.debounceMs)));

  client.close();
  await server.close();
  return { replies, actions, stats: bot.stats, elapsedMs: Date.now() - started, dataDir, sessionId: `g${GROUP_ID}` };
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { const key = argv[i].slice(2); const next = argv[i + 1]; if (next && !next.startsWith('--')) { args[key] = next; i++; } else args[key] = true; }
  }
  let scenario = null;
  if (args.scenario) scenario = JSON.parse(fs.readFileSync(path.resolve(args.scenario), 'utf8'));
  runMock({ mode: args.mode || 'command', scenario, quiet: false })
    .then((result) => {
      console.log('\n=== 回放结束 ===');
      console.log(`动作调用 ${result.actions.length} 次，回复 ${result.replies.length} 条，用时 ${result.elapsedMs}ms`);
      for (const reply of result.replies) console.log(`\n--- ${reply.action} ---\n${reply.text}`);
      console.log(`\n统计: ${JSON.stringify(result.stats)}`);
      console.log(`会话文件: ${path.join(result.dataDir, 'sessions', result.sessionId + '.json')}`);
      process.exit(0);
    })
    .catch((error) => { console.error(error.stack || error); process.exit(1); });
}

module.exports = { runMock, SCENARIO, BOT_ID, ME_ID, GROUP_ID };
