'use strict';
/**
 * Kernel adapter: the only module that knows the vendored long-night engine.
 *
 * The vendored files are CommonJS IIFEs that export via `module.exports`
 * (vendor/long-night/*.js). They are pure functions plus one module-level
 * deadline variable, so every inference must run serially within a process.
 */
const path = require('node:path');

const KERNEL_DIR = path.resolve(__dirname, '..', 'vendor', 'long-night');
const module_ = (name) => require(path.join(KERNEL_DIR, name));

const E = module_('engine.js');
const M = module_('messages.js');
const S = module_('sound-candidates.js');
const T = module_('team.js');
const L = module_('local.js');
const A = module_('advice.js');
const H = module_('hypotheses.js');
const I = module_('inference.js');
const DATA = module_('blocks.js');

const MODE_NAMES = {
  CLASSIC: '经典', TWIST: '幻变', WILD: '狂野', CRAZY: '疯狂',
  BUTTON: '按钮', TRAP: '陷阱', OPEN: '空旷', SILENT: '无声',
};
const MODE_KEYS = Object.fromEntries(Object.entries(MODE_NAMES).map(([k, v]) => [v, k]));
const TERRAIN_NAMES = { EMPTY: '空地', WATER: '水洼', GRASS: '草丛', TRAP: '陷阱', HEAT: '热源', PORTAL: '传送门', EXIT: '逃生舱', HEART: '心脏', UNKNOWN: '未知' };

class UsageError extends Error {
  constructor(message, code = 'USAGE') {
    super(message);
    this.code = code;
  }
}

/** Build a fresh journal (same shape as the web tool's localStorage v2 save). */
function newJournal() {
  return { version: 2, base: E.newState(), messages: [], view: 0 };
}

/**
 * The game samples 12 normal blocks + 4 exits (2 pairs) from the mode pool
 * (map.h: k_map_num=12, k_exit_num=4, std::sample). When a mode's pool has
 * at most that many of each, the whole pool is used, so the pool is known
 * without reading the opening picture. Otherwise it stays a random subset and
 * only the user can supply it.
 */
function autoPoolFor(mode, expanded=false) {
  const ids = DATA.modes[mode];
  if (!Array.isArray(ids)) return null;
  const exits = ids.filter((id) => String(id).startsWith('E')).length;
  const normals = ids.length - exits;
  if (normals <= (expanded?16:12) && exits <= (expanded?6:4)) return ids.join(' ');
  return null;
}

function poolSource(config) {
  if (!config || !config.pool) return 'none';
  const auto = autoPoolFor(config.mode,config.expandedPool);
  return auto && auto === config.pool.trim() ? 'auto' : 'manual';
}

function configure(journal, options = {}) {
  const out = E.clone(journal);
  const base = out.base;
  if(options.roomRules||options['room-rules'])base.config.roomRules=E.clone(options.roomRules||JSON.parse(options['room-rules']));
  if (options.size != null) base.config.size = Number(options.size);
  if (options.mode != null) {
    const mode = MODE_KEYS[options.mode] || String(options.mode).toUpperCase();
    if (!DATA.modes[mode]) throw new UsageError(`未知模式: ${options.mode}`);
    base.config.mode = mode;
    base.config.pool = '';
  }
  if (options.event != null) {
    const event = String(options.event).toUpperCase();
    if (!['NONE', 'RAINSTORY', 'LAZYGARDENER', 'OVERGROWTH', 'AMBUSH'].includes(event)) throw new UsageError(`未知事件: ${options.event}`);
    base.config.event = event;
  }
  for(const key of ['brawl','pointCapture','expandedPool','portalChaos','deliberate','centerExit11'])if(options[key]!=null)base.config[key]=!!options[key];
  if (options.exitCount != null) base.config.exitCount = Number(options.exitCount);
  if (options.silent != null) base.config.silent = !!options.silent;
  if (options.dark != null) base.config.dark = !!options.dark;
  const captureTarget=options.captureTarget??options['capture-target'];
  if(captureTarget!=null){if(!['NEXT','PREVIOUS'].includes(captureTarget))throw new UsageError('未知捕捉顺位');base.config.captureTarget=captureTarget;base.target=captureTarget;}
  if (options.players != null) {
    const count = Number(options.players);
    if (!(count >= 1 && count <= 8)) throw new UsageError('玩家人数应为 1–8');
    base.config.playerCount = count;
    base.players = Array.from({ length: count }, (_, i) => ({ name: `${i}号`, alive: true }));
  }
  const wantsPool = options.pool != null && String(options.pool).toLowerCase() !== 'auto';
  if (wantsPool) {
    const pool = normalizePool(options.pool);
    if (!pool.length) throw new UsageError('区块池不能为空');
    base.config.pool = pool.join(' ');
  } else if (!base.config.pool) {
    const auto = autoPoolFor(base.config.mode,base.config.expandedPool);
    if (auto) base.config.pool = auto;
  }
  return out;
}

function normalizePool(value) {
  return [...new Set(String(value).toUpperCase().match(/[ES]?\d+/g) || [])];
}

/** Settings rendered as one journal message so the engine sees them on replay. */
function settingsText(options) {
  const lines = [];
  if (options.mode != null) lines.push(`模式${MODE_NAMES[MODE_KEYS[options.mode] || String(options.mode).toUpperCase()] || options.mode}`);
  if (options.players != null) lines.push(`玩家人数：${options.players}`);
  if (options.self != null) lines.push(`我是${options.self}号`);
  if (options.size != null) lines.push(`边长${options.size}`);
  if (options.exitCount != null) lines.push(`逃生舱数量：${options.exitCount}`);
  if (options.event != null) {
    const label = { NONE: '无', RAINSTORY: '雨天小故事', LAZYGARDENER: '怠惰的园丁', OVERGROWTH: '营养过剩', AMBUSH: '十面埋伏' }[String(options.event).toUpperCase()];
    if (label) lines.push(`特殊事件：${label}`);
  }
  if (options.silent) lines.push('静音开启');
  if(options.centerExit11!=null)lines.push('11x11中心逃生区块：'+(options.centerExit11?'开启':'关闭'));
  for(const [key,name] of [['expandedPool','拓展'],['portalChaos','传送紊乱'],['deliberate','谋定后动'],['dark','摸黑'],['brawl','大乱斗'],['pointCapture','点杀']])if(options[key]!=null)lines.push(name+(options[key]?'开启':'关闭'));
  if (options.pool != null) lines.push(`区块池：${normalizePool(options.pool).join(' ')}`);
  return lines.join('\n');
}

/**
 * Same, but read back from a configured journal, so the auto-filled pool is
 * recorded too (mode first: the parser clears the pool on a mode line).
 */
function settingsTextFor(journal, options = {}) {
  const cfg = journal && journal.base ? journal.base.config : {};
  const lines = [];
  if (cfg.mode) lines.push(`模式${MODE_NAMES[cfg.mode] || cfg.mode}`);
  if (cfg.playerCount) lines.push(`玩家人数：${cfg.playerCount}`);
  if (options.self != null) lines.push(`我是${options.self}号`);
  if (cfg.size) lines.push(`边长${cfg.size}`);
  if (cfg.exitCount != null) lines.push(`逃生舱数量：${cfg.exitCount}`);
  if (cfg.event && cfg.event !== 'NONE') {
    const label = { RAINSTORY: '雨天小故事', LAZYGARDENER: '怠惰的园丁', OVERGROWTH: '营养过剩', AMBUSH: '十面埋伏' }[cfg.event];
    if (label) lines.push(`特殊事件：${label}`);
  }
  if (cfg.silent) lines.push('静音开启');
  if(cfg.centerExit11!=null)lines.push('11x11中心逃生区块：'+(cfg.centerExit11?'开启':'关闭'));
  for(const [key,name] of [['expandedPool','拓展'],['portalChaos','传送紊乱'],['deliberate','谋定后动'],['dark','摸黑'],['brawl','大乱斗'],['pointCapture','点杀']])if(cfg[key]!=null)lines.push(name+(cfg[key]?'开启':'关闭'));
  if(cfg.captureTarget)lines.push('捕捉目标：'+(cfg.captureTarget==='NEXT'?'下家':'上家'));
  if (cfg.pool) lines.push(`区块池：${cfg.pool}`);
  return lines.join('\n');
}

function nextId(journal) {
  return 'm' + (journal.messages.length ? Math.max(...journal.messages.map((m) => Number(String(m.id).replace(/\D/g, '')) || 0)) + 1 : 1);
}

/**
 * Append raw bot text. Mirrors the web UI: clone -> trial build -> commit.
 * Returns the new journal plus what the parser recognised.
 */
function append(journal, text, options = {}) {
  const view = options.view == null ? journal.view || 0 : Number(options.view);
  const clean = M.clean(String(text || ''));
  if (!clean.trim()) throw new UsageError('消息为空', 'EMPTY');
  if (clean.length > 30000) throw new UsageError('单条消息超过 30000 字', 'TOO_LONG');
  const type = M.inspect(clean);
  if (!options.force && visibleDuplicate(journal, clean, view)) {
    return { journal, duplicate: true, type: type.type, counts: type.counts, warnings: ['这段消息已录入过，已忽略。'] };
  }
  const next = E.clone(journal);
  next.messages.push({ id: nextId(next), text: clean, view, receiverConfirmed: true });
  next.view = view;
  M.build(next.base, M.liveMessages(next.messages), {}); // throws on unusable input
  return { journal: next, duplicate: false, type: type.type, counts: type.counts, warnings: type.warnings || [], privateInput: type.privateInput, id: next.messages[next.messages.length - 1].id };
}

/** Same rule as the web UI (chat.js): only these message kinds are de-duplicated. */
function visibleDuplicate(journal, clean, view) {
  if (!/完整行动轨迹|【\s*第\s*\d+\s*回合】|【开局】/.test(clean)) return false;
  return journal.messages.some((m) => m.view === view && M.clean(m.text) === clean);
}

function inferenceMessages(journal) {
  const live=M.liveMessages(journal.messages);
  const routes=new Map();
  let silent=!!journal.base.config.silent;
  for(const m of live)for(const item of M.parse(m.text).items)if(item.kind==='config'&&typeof item.values.silent==='boolean')silent=item.values.silent;
  return live.map(m=>{
    const items=M.parse(m.text).items;
    const hearings=items.filter(i=>i.kind==='hear'&&i.round==null);
    if(hearings.length===1){
      const h=hearings[0],source=routes.get(h.player),listener=routes.get(m.view);
      const round=source?.partial?source.round:source?source.round+1:1;
      const prior=round-(Number(m.view)>h.player?1:0);
      // Chronological live DM: source's previous completed route is NOT this
      // sound's route. Require listener turn order as independent confirmation.
      if(h.player!==Number(m.view)&&listener&&!listener.partial&&listener.round===prior)
        m={...m,text:`【第 ${round} 回合】\n${m.text}`};
    }
    for(const item of items)if(item.kind==='trajectory'){
      const previous=routes.get(item.player),round=item.round??(previous?.partial?previous.round:(previous?.round||0)+1);
      if(!previous||round>previous.round||round===previous.round&&(!item.partial||previous.partial))routes.set(item.player,{round,partial:!!item.partial});
    }
    if(/巨大的心跳声响彻了整个迷宫|声响被巨大的心跳声掩盖/.test(m.text))return {...m,text:m.text+'\n本局有心脏'};
    // A complete successful public feedback on a scheduled beat always prints
    // the heartbeat when enabled. Collisions, excerpts and silent games do not.
    const step=m.text.match(/\[第\s*(\d+)\s*步\]\s*向\s*[上下左右]\s*移动/);
    if(!silent&&step&&+step[1]<=19&&(+step[1]-1)%3===0&&/@@[^\n]+\n/.test(m.text)&&/请继续行动/.test(m.text))return {...m,text:m.text+'\n本局没有心脏'};
    return m;
  });
}
function build(journal, choices = {}) {
  const live = inferenceMessages(journal);
  return M.build(journal.base, live, choices);
}

function removeMessage(journal, id) {
  const out = E.clone(journal);
  if (id) out.messages = out.messages.filter((m) => m.id !== id);
  else out.messages.pop();
  out.resolvedChoices = {};
  return out;
}

function poolReady(config) {
  return !!(config && typeof config.pool === 'string' && config.pool.trim());
}

/**
 * Full inference. Serial by contract: engine.js keeps one module-level deadline.
 * Returns { built, team } where built is re-built with the choices the search proved.
 */
async function infer(journal, options = {}) {
  const deadline=options.deadline??Date.now()+Math.max(100,Math.min(Number(options.budgetMs)||6000,6000));
  if (!journal || !Array.isArray(journal.messages)) throw new UsageError('存档缺少 messages 数组', 'BAD_JOURNAL');
  let built = build(journal);
  // An unresolved entry can prevent the later joint solver from rejoining
  // the very map that proved this portal. Recover the proof from the earlier
  // journal prefix, never from a sampled layout or from future feedback.
  if(options.portalProof!==false&&Date.now()<deadline-200){
    const own=built.views[built.self],a=own.ambiguities[0];
    if(a?.index>0){
      const prefix={...journal,messages:journal.messages.slice(0,a.index)};
      // Historical proof is optional. Reserve most of the same outer deadline
      // for interpreting the newly received feedback, including short budgets.
      const budgetMs=require('./prior-entry-proof.cjs').proofBudget(options.budgetMs,deadline-Date.now());
      const memo=options.stageCache?.lookup('portal',[prefix.base,prefix.view,prefix.messages,built.self,a.segment,a.entry,budgetMs]);
      let proof=memo?.value;
      if(!memo?.hit){
        const proofDeadline=Math.min(deadline,Date.now()+budgetMs);
        proof=require('./prior-entry-proof.cjs').historicalGroundProof(prefix,built.self,a,proofDeadline);
        if(!proof&&Date.now()<proofDeadline){
        const prior=await infer(prefix,{...options,portalProof:false,entryProofOnly:true,budgetMs,deadline:proofDeadline});
        const v=prior.built.views[built.self],node=prior.team?.nodes?.find(n=>n.id===built.self+':'+a.segment);
        if(v?.model.active===a.segment&&!v.ambiguities.length&&!prior.team.conflict&&node?.verification?.status==='verified'&&!node.fusionConflict&&!node.routePending){
          const exit=require('./suggest.cjs').certainPortalLinks(node.solution,own.model.config.size,own.model.config,node.walkingObservations||node.mergedObservations||node.observations).get(E.key(a.entry.r,a.entry.c));
          if(exit)proof={choices:prior.built.resolvedChoices||{},exit};
          else if(require('./prior-entry-proof.cjs').provenGroundEntry({view:v,node,team:prior.team,ambiguity:a,config:own.model.config}))
            proof={choices:prior.built.resolvedChoices||{},ground:true};
        }
        }
        // A missed optional prefix proof does not imply ground. Briefly
        // suppress the duplicate probe while the live solver continues to
        // evaluate all branches against the newly arrived feedback.
        memo?.save(proof||null,proof?0:60000);
      }
      if(proof&&(proof.ground||Number.isFinite(proof.exit?.dr)&&Number.isFinite(proof.exit?.dc))){
        const choices=E.clone(proof.choices);
        // Wrapped destination subtraction can differ from the block's signed
        // link (e.g. +2 becomes -7 on a 9x9 board), which is an exact rule fact.
        choices[built.self]={...(choices[built.self]||{}),[a.key]:proof.ground?{kind:'ground'}:{kind:'portal',dr:proof.exit.dr,dc:proof.exit.dc}};
        built=build(journal,choices);built.resolvedChoices=choices;
      }
    }
  }
  const selfView = built.views[built.self] || built.views[0];
  const config = selfView.model.config;
  if (!poolReady(config)) throw new UsageError('请先录入本局区块池（机器人开局公告里的「本局区块池」）。', 'NEED_POOL');
  if (built.spectator) throw new UsageError('这是观战视角，无法给出个人建议；先发「我是N号」指定要看的玩家。', 'SPECTATOR');
  // In a two-player game, unresolved self routes can need more than the
  // normal 1.5s slice. Use spare time inside the same outer deadline while
  // reserving a second for the opponent and joint alignment. Screening,
  // silent inference and games with more seats keep their existing budgets.
  const remainingBudget = Math.max(1,deadline-Date.now());
  const selfRouteBudget = !config.silent && built.count===2
    && selfView.ambiguities.length && remainingBudget>=3000
    ? Math.min(4000,remainingBudget-1000) : null;
  const request = {
    totalBudgetMs: Math.max(1,deadline-Date.now()),
    playerBudgetMs: Math.max(100, Math.min(1500,Math.floor((deadline-Date.now())/Math.min(4,built.count+1)))),
    ...(config.silent?{selfBudgetMs:Math.min(3000,Math.floor((deadline-Date.now())/2)),playerBudgetMs:Math.min(750,Math.floor((deadline-Date.now())/4)),jointBudgetMs:750}:{}),
    ...(selfRouteBudget!=null?{selfBudgetMs:selfRouteBudget}:{}),
    // This bounded historical query needs only the acting player's proof.
    // Do not divide its small slice among opponents before that proof exists.
    ...(options.entryProofOnly?{selfBudgetMs:remainingBudget}:{}),
    config: { ...config, routePresentation: true },
    notebook: { base: journal.base, messages: inferenceMessages(journal), self: built.self, count: built.count, choices: built.resolvedChoices || {} },
    relations: built.relations.filter((r) => !['首次', '被屏蔽'].includes(r.direction)),
    soundRelations: S.hearings(built),
  };
  let team;
  if(options.stageCache)request.solveLocal=(config,nodes,relations,onLocal,onProgress)=>{
    const memo=options.stageCache.lookup('local',[request.playerBudgetMs,config,nodes,relations]);
    if(memo.hit)return memo.value;
    const result=T.solve(config,nodes,relations,onLocal,onProgress);
    E.checkDeadline();
    memo.save(result);
    return result;
  };
  try {
    team = await I.run(request);
  } finally {
    E.setDeadline(); // never let a timeout poison the next call
  }
  let finalBuilt = built;
  if (team.completedChoices && Object.keys(team.completedChoices).length) {
    const choices=E.clone(built.resolvedChoices||{});
    for(const [player,selected] of Object.entries(team.completedChoices))choices[player]={...selected};
    finalBuilt = build(journal, choices);
    finalBuilt.resolvedChoices = choices;
  }
  const result={ built: finalBuilt, team, config: finalBuilt.views[finalBuilt.self].model.config };
  if(!options.buttonRefinement&&result.config.silent&&Date.now()<deadline){
    const SP=require('./silent-projection.cjs'),view=finalBuilt.views[finalBuilt.self],node=team.nodes?.find(n=>n.id===finalBuilt.self+':'+view.model.active);
    const projection=SP.silentProjection({node,view,team,config:result.config,built:finalBuilt,routes:SP.publicRoutes(journal),deadline});
    const facts=[];
    for(const c of projection?.playerButtonCounts||[]){const total=result.config.buttonCounts?.[c.round];if(total==null||c.count>total)continue;
      for(const f of [c,{player:finalBuilt.self,round:c.round,count:total-c.count,source:'public-total-minus-exhaustive-opponent'}])if(!result.config.playerButtonCounts?.some(old=>old.player===f.player&&old.round===f.round))facts.push(f);
    }
    if(facts.length&&Date.now()<deadline){
      const refined=E.clone(journal);refined.base.config.playerButtonCounts=[...(refined.base.config.playerButtonCounts||[]),...facts];
      // Attribute once, then refine the already proved self frame. Re-running
      // every opponent's route search used up the live budget a second time.
      const nextBuilt=build(refined,finalBuilt.resolvedChoices||{}),cfg=nextBuilt.views[nextBuilt.self].model.config;
      try{
        E.setDeadline(deadline);
        const obs=node.mergedObservations||node.observations;
        const solution=E.solveMap(cfg,obs,node.anchors||[]),verification=E.certifyBlocks(cfg,solution,obs);
        if(verification.status==='verified'){
          const nextNode={...node,solution,verification,completeLayouts:undefined};
          return {...result,built:nextBuilt,config:cfg,team:{...team,nodes:team.nodes.map(n=>n.id===node.id?nextNode:n)},projection};
        }
      }catch(error){if(error.code!=='INFERENCE_TIMEOUT')throw error;}finally{E.setDeadline();}
    }
    result.projection=projection;
  }
  return result;
}

/** Cheap, inference-free summary used by `status` and by part1 pre-checks. */
function quickStatus(journal) {
  const built = build(journal);
  const selfView = built.views[built.self] || built.views[0];
  const cfg = selfView.model.config;
  const rounds = new Set();
  for (const m of journal.messages) for (const hit of String(m.text).matchAll(/第\s*(\d+)\s*回合/g)) rounds.add(Number(hit[1]));
  return {
    self: built.self,
    players: built.count,
    mode: cfg.mode,
    modeName: MODE_NAMES[cfg.mode] || cfg.mode,
    size: cfg.size,
    pool: cfg.pool,
    poolCount: cfg.pool ? cfg.pool.split(/\s+/).length : 0,
    poolSource: poolSource(cfg),
    exitCount: cfg.exitCount,
    event: cfg.event,
    silent: !!cfg.silent,
    messages: journal.messages.length,
    rounds: [...rounds].sort((a, b) => a - b),
    pendingRounds: selfView.pending,
    ambiguities: selfView.ambiguities.length,
    poolReady: poolReady(cfg),
  };
}

module.exports = {
  E, M, S, T, L, A, H, I, DATA,
  MODE_NAMES, MODE_KEYS, TERRAIN_NAMES, KERNEL_DIR,
  UsageError,
  newJournal, configure, settingsText, settingsTextFor, append, build, removeMessage, infer, quickStatus,
  poolReady, normalizePool, autoPoolFor, poolSource,
};
