#!/usr/bin/env node
'use strict';
/**
 * part1 entry: connect to SnowLuma (OneBot v11 over WebSocket), collect 长夜
 * messages, ask part2 for a suggestion, answer in QQ.
 *
 *   node game-steward/index.cjs --config config/bot.json
 *   node game-steward/index.cjs --url ws://127.0.0.1:3001/ --token xxx --mode auto
 */
const path = require('node:path');
const fs = require('node:fs');

const { loadConfig, ROOT } = require('./config.cjs');
const { OneBotClient } = require('./onebot.cjs');
const { Part2Client } = require('./part2-client.cjs');
const { ProcessDecisionPolicy } = require('./decision-policy.cjs');
const { LongNightBot } = require('./bot.cjs');
const { StateStore } = require('./state.cjs');
const { createDashboard } = require('./dashboard.cjs');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[name] = true;
    else { args[name] = next; i++; }
  }
  return args;
}

function makeLogger(level = 'info') {
  const order = { debug: 10, info: 20, warn: 30, error: 40 };
  const threshold = order[level] || 20;
  const stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const log = (rank, tag) => (...parts) => {
    if (rank < threshold) return;
    console.log(`${stamp()} ${tag} ${parts.join(' ')}`);
  };
  return {
    debug: log(10, '·'), info: log(20, 'i'), warn: log(30, '!'), error: log(40, 'x'),
    raw: (...parts) => console.log(...parts),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('用法: node framework/index.cjs [--config private/config/bot.json] [--url ws://...] [--token x] [--mode command|auto|off] [--groups 1,2]');
    return 0;
  }
  const requested = args.config ? path.resolve(args.config) : path.join(ROOT, 'private', 'config', 'bot.json');
  const hasConfig = fs.existsSync(requested);
  if (!hasConfig) throw new Error('缺少私有配置：' + requested);
  const config = loadConfig(requested);
  const logger = makeLogger(config.logging && config.logging.level);
  if (args.url) config.onebot.url = args.url;
  if (args.token) config.onebot.accessToken = args.token;
  if (args.mode) config.behavior.mode = args.mode;
  if (args.groups) config.groups = String(args.groups).split(/[,\s]+/).filter(Boolean);

  const state = new StateStore(config.paths.state);
  state.load();

  const part2 = new Part2Client({
    node: config.part2.node,
    cli: config.part2.cli,
    timeoutMs: config.part2.timeoutMs,
    logger: logger.debug,
  });

  const client = new OneBotClient({
    url: config.onebot.url,
    accessToken: config.onebot.accessToken,
    timeoutMs: config.onebot.timeoutMs,
    reconnect: config.onebot.reconnect,
    logger: logger.info,
  });

  let bot;
  const send = async ({ type, groupId, userId, message }) => {
    if (type === 'group') return client.sendGroup(groupId, message);
    return client.sendPrivate(userId, message);
  };
  const history = async (groupId, count = 40) => {
    const data = await client.call('get_group_msg_history', { group_id: Number(groupId), count });
    return (data && data.messages) || [];
  };
  const privateHistory = async (userId, count = 30) => {
    return require('./private-history.cjs').recentPrivateHistory(client,userId,count);
  };

  const policy = config.decision?.program ? new ProcessDecisionPolicy(config.decision) : null;
  bot = new LongNightBot({ config, part2, state, send, history, privateHistory, policy, logger: logger.info });

  let suggestionReview = null;
  if (config.suggestionReview?.enabled) {
    const { SuggestionReview } = require('./suggestion-review.cjs');
    suggestionReview = new SuggestionReview({bot, config, send, logger: logger.warn});
    // Recovery of pending reviews must not delay QQ startup.
    suggestionReview.start().catch(error => logger.error(`建议审核启动失败: ${error.message}`));
  }

  let refreshing = null;
  const refreshLogin = async () => {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const login = await client.login();
        if (login && login.userId != null) {
          bot.selfId = String(login.userId);
          if (login.nickname) bot.selfNames.add(String(login.nickname));
          logger.info(`已连接 QQ ${login.nickname || ''}(${login.userId}) → ${config.onebot.url}`);
        }
      } catch (error) {
        logger.warn(`get_login_info 失败（继续运行）: ${error.message}`);
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  };

  let recoveryPending=false,recoveryQueued=false;
  const queueRecovery=()=>{
    require('./turn-watchdog.cjs').retryPendingTurns(bot,state);
    if(!bot.inflight.size&&Object.values(state.data.groups||{}).some(g=>g.session&&!g.ended&&Date.now()-Date.parse(g.lastAt||g.startedAt)>45000))recoveryPending=true;
    if(bot.recoveryRequested){recoveryPending=true;bot.recoveryRequested=false;}
    if(!recoveryPending||recoveryQueued||client.state!=='open')return;
    recoveryQueued=true;
    bot.queue=bot.queue.then(async()=>{
      const status=await client.call('get_status');
      if(status?.online!==true)throw new Error('QQ 尚未在线，稍后自动恢复');
      await refreshLogin();
      recoveryPending=(await bot.recoverMissedOpenings())===false;
      await bot.backfillArtifacts();
    }).catch(error=>{recoveryPending=true;logger.warn('恢复暂未完成，将自动重试: '+error.message);})
      .finally(()=>{recoveryQueued=false;});
  };
  // Recovery is event-driven only: a reconnect, an own reminder or an
  // uncertain send wakes it explicitly. No periodic polling.
  bot.wakeRecovery=()=>setImmediate(queueRecovery);

  // SnowLuma stores LGTBot's proactive private messages but does not emit
  // them as OneBot events (they arrive as an undecoded PkgType=167 push).
  // Pull friend history after game-bot group traffic and feed unseen private
  // messages to the bot. Event-triggered only; there is no periodic poll.
  const gameBotId = String((config.control && config.control.gameBotId) || (config.botIds || [])[0] || '');
  const privateSync = require('./private-sync.cjs').createPrivateSync({client,bot,state,userId:gameBotId,logger});
  const schedulePrivateSync = () => privateSync.run();

  client.on('state', ({ state: s, detail }) => {
    logger.info(`连接状态: ${s}${detail ? ' ' + JSON.stringify(detail) : ''}`);
    if (s === 'open') {
      // Serialize every reconnect with live events and establish our QQ identity
      // before inspecting historical mentions.
      recoveryPending=true;
      queueRecovery();
      schedulePrivateSync();
    }
  });
  client.on('error', (error) => logger.error(`连接错误: ${error.message}`));
  client.on('event', (event) => {
    try { suggestionReview?.accept(event); }
    catch (error) { logger.error(`建议入口失败: ${error.message}`); }
    if (event && event.post_type === 'message' && String(event.user_id) === gameBotId) schedulePrivateSync();
    bot.onEvent(event)
      .catch((error) => logger.error(`处理事件失败: ${error.stack || error.message}`))
      .finally(() => {
        // The bot marks recoveryRequested when it had to skip a turn; retry
        // after the event settles instead of waking up on a timer.
        if (bot.recoveryRequested || recoveryPending) queueRecovery();
      });
  });

  // A missing OneBot endpoint is the normal "not started yet" state, not a
  // fatal error: stay up and let the client reconnect in the background.
  try {
    await client.connect();
  } catch (error) {
    logger.warn(`首次连接失败：${error.message}（进程保持运行，后台继续重连）`);
  }

  let dashboard = null;
  if (config.dashboard.enabled) {
    dashboard = createDashboard({ bot, state, config, logger: logger.warn, status: () => ({ connected: client.state === 'open' }) });
    try {
      const url = await dashboard.listen(config.dashboard.port, config.dashboard.host || '127.0.0.1');
      logger.info(`看板: ${url}（实时看板 /live，/health 可探活）`);
    } catch (error) {
      logger.warn(`看板启动失败（端口 ${config.dashboard.port}）：${error.message}`);
      dashboard = null;
    }
  }

  const shutdown = async (signal) => {
    logger.info(`收到 ${signal}，正在退出`);
    privateSync.close();
    suggestionReview?.close();
    if (dashboard) await dashboard.close().catch(() => {});
    client.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  return new Promise(() => {}); // run until signal
}

main().catch((error) => {
  console.error(`启动失败: ${error.stack || error.message}`);
  process.exit(1);
});
