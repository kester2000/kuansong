'use strict';
/**
 * part1 configuration: JSON file + LN_* environment overrides.
 * A missing file is fine — defaults point at a local SnowLuma install.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const DEFAULTS = {
  onebot: {
    url: 'ws://127.0.0.1:3001/',
    accessToken: '',
    selfId: null,
    timeoutMs: 20000,
    reconnect: true,
  },
  // Empty list = every group is accepted. Entries may be numbers or strings.
  groups: [],
  // Which QQ numbers are the 长夜 bot. Empty = recognise by message content.
  botIds: [],
  behavior: {
    // command: only answer #宽松 commands; auto: also push a suggestion after
    // every new round's trajectory; off: collect only.
    mode: 'auto',
    prefix: ['#宽松'],
    debounceMs: 3000,
    inferBudgetMs: 15000,
    maxInferPerMinute: 10,
    // 终局复盘只写文件，不往群里发
    announceReview: false,
    // auto 模式下轮到自己时直接落子（发「@机器人 方向」），推理过程只看板
    autoMove: true,
  },
  reply: {
    to: 'group',          // group | private | both
    atSender: true,
    quote: true,
    maxChars: 900,
    throttleMs: 1500,
  },
  part2: {
    node: process.execPath,
    cli: require('./game.cjs').cli,
    timeoutMs: 180000,
  },
  dashboard: {
    enabled: true,
    host: '127.0.0.1',
    port: 8787,
  },
  // 复盘 HTML 链接的公开地址前缀；留空则退回发送长图。
  report: {
    publicBase: '',
  },
  // Read the opening block-pool picture instead of asking the player to type ids.
  poolImage: {
    enabled: true,
    announce: false,
  },
  // Letting other people drive this QQ account through chat commands.
  control: {
    enabled: true,
    // Extra QQ numbers allowed to command the account (owner is always allowed).
    allowFrom: [],
    // Only these accounts may create solo games or reset the bot state.
    // allowFrom, group roles and the player's own account do not grant this.
    adminIds: [],
    // Group members may ask the account to 加入/退出 a game, nothing else.
    allowGroupMembers: true,
    allowText: '^[#/!]?(加入|退出|开始|准备|帮助|规则|赛况|完整赛况|地图|预览)(\s|$)',
    ratePerMinute: 6,
    confirm: true,
    // Optional: pin the game bot instead of learning it from its messages.
    gameBotId: '',
    atGameBot: true,
    joinCommand: '/加入',
    // 加入前先问机器人当前房间是什么游戏，只加入这里列出的游戏
    queryGameInfo: true,
    gameInfoCommand: '/游戏信息',
    gameInfoTimeoutMs: 8000,
    supportedGames: ['漫漫长夜'],
    leaveCommand: '/退出',
  },
  paths: {
    state: path.join(ROOT, 'data', 'part1-state.json'),
  },
  logging: { level: 'info' },
};

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function merge(base, patch) {
  if (!isObject(patch)) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isObject(value) && isObject(base[key]) ? merge(base[key], value) : value;
  }
  return out;
}

function asIdList(value) {
  if (value == null) return [];
  const list = Array.isArray(value) ? value : String(value).split(/[,\s]+/);
  return list.map((x) => String(x).trim()).filter(Boolean);
}

function loadConfig(file) {
  let config = JSON.parse(JSON.stringify(DEFAULTS));
  if (file) {
    const absolute = path.resolve(file);
    if (!fs.existsSync(absolute)) throw new Error(`配置文件不存在: ${absolute}`);
    config = merge(config, JSON.parse(fs.readFileSync(absolute, 'utf8').replace(/^\uFEFF/, '')));
  }
  const env = process.env;
  if (env.LN_ONEBOT_URL) config.onebot.url = env.LN_ONEBOT_URL;
  if (env.LN_ONEBOT_TOKEN) config.onebot.accessToken = env.LN_ONEBOT_TOKEN;
  if (env.LN_SELF_ID) config.onebot.selfId = env.LN_SELF_ID;
  if (env.LN_GROUPS) config.groups = asIdList(env.LN_GROUPS);
  if (env.LN_BOT_IDS) config.botIds = asIdList(env.LN_BOT_IDS);
  if (env.LN_MODE) config.behavior.mode = env.LN_MODE;
  if (env.LN_DATA_DIR) config.paths.state = path.join(env.LN_DATA_DIR, 'part1-state.json');
  if (env.LN_DASHBOARD === '0' || env.LN_DASHBOARD === 'off') config.dashboard.enabled = false;
  if (env.LN_DASHBOARD_PORT) config.dashboard.port = Number(env.LN_DASHBOARD_PORT);
  if (env.LN_POOL_IMAGE === '0' || env.LN_POOL_IMAGE === 'off') config.poolImage.enabled = false;
  if (env.LN_CONTROL === '0' || env.LN_CONTROL === 'off') config.control.enabled = false;
  if (env.LN_CONTROL_FROM) config.control.allowFrom = asIdList(env.LN_CONTROL_FROM);

  config.groups = asIdList(config.groups).map(String);
  config.botIds = asIdList(config.botIds).map(String);
  if (!['command', 'auto', 'off'].includes(config.behavior.mode)) {
    throw new Error(`behavior.mode 只能是 command / auto / off，当前是 ${config.behavior.mode}`);
  }
  if (!['group', 'private', 'both'].includes(config.reply.to)) {
    throw new Error(`reply.to 只能是 group / private / both，当前是 ${config.reply.to}`);
  }
  // Migrate existing private configurations as well as fresh installations.
  const prefixes = Array.isArray(config.behavior.prefix) ? config.behavior.prefix.map(String) : [String(config.behavior.prefix)];
  config.behavior.prefix = [...new Set(['#宽松', ...prefixes.map(p => ['#长夜', '#ln'].includes(p) ? '#宽松' : p).filter(Boolean)])];
  config.behavior.debounceMs = Number(config.behavior.debounceMs) || 3000;
  config.behavior.inferBudgetMs = Math.max(1000, Math.min(Number(config.behavior.inferBudgetMs) || 15000, 15000));
  config.reply.maxChars = Math.max(120, Number(config.reply.maxChars) || 900);
  config.reply.throttleMs = Math.max(0, Number(config.reply.throttleMs) || 0);
  return config;
}

/** Is this group allowed by the allowlist? Empty list accepts everything. */
function groupAllowed(config, groupId) {
  return !config.groups.length || config.groups.includes(String(groupId));
}

module.exports = { ROOT, DEFAULTS, loadConfig, groupAllowed, asIdList };
