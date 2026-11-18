'use strict';
/**
 * Decision layer: turn the engine's candidate maps into "where to step next".
 *
 * The engine models history, not future moves, so this is a heuristic on top of
 * its constraints. Every number below is a ranking aid, never a proof. The
 * rules that do hold come from the game source and the engine:
 *   - a derived/observed wall edge is passable=false, anything else is unknown;
 *   - trap cells stop you on the 2nd entry, heat stops you on the 2nd entry;
 *   - portal cells can teleport you, so entering an unknown portal loses position;
 *   - water/grass make noise that reveals your position to hunters.
 */
const { E, T, A, M } = require('./kernel.cjs');
const {locateTarget,routeTo,captureBatch}=require('./pursuit.cjs');
const {edgeState}=require('./movement.cjs');
const {chooseOpening}=require('./opening-random.cjs');
const {captureFinishDirection,collisionMove,wallFinishPlan}=require('./finish-turn.cjs');
const {heartbeatPlan,portalHeartbeatPause}=require('./heartbeat.cjs');
const {localExit,turnFacts}=require('./local-exit.cjs');
const {rankExploration}=require('./exploration.cjs');
const {targetCandidates,candidatePlan}=require('./candidate-pursuit.cjs');
const {scoutPlan,continuationPlan,saferRelocation}=require('./tactical-scout.cjs');

const DIRS = [
  { d: 0, key: 'up', label: '向上', arrow: '↑' },
  { d: 1, key: 'down', label: '向下', arrow: '↓' },
  { d: 2, key: 'left', label: '向左', arrow: '←' },
  { d: 3, key: 'right', label: '向右', arrow: '→' },
];
const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };
const HAZARD = {
  EXIT: { score: 120, note: '逃生舱' },
  HEAT: { score: -90, note: '热源（再次进入会强停）' },
  TRAP: { score: -75, note: '陷阱（偶数次进入会强停）' },
  WATER: { score: -12, note: '水洼（发声）' },
  GRASS: { score: -8, note: '草丛（发声）' },
  PORTAL: { score: -30, note: '传送门（随机传送，位置会丢）' },
  HEART: { score: -40, note: '巨大的心脏（掩盖心跳节拍）' },
  EMPTY: { score: 4, note: '空地' },
};

function key(r, c) {
  return E.key(r, c);
}

function torusDistance(a, b, n) {
  const dr = Math.abs(E.mod(a.r - b.r, n));
  const dc = Math.abs(E.mod(a.c - b.c, n));
  return Math.min(dr, n - dr) + Math.min(dc, n - dc);
}

/** Distinct block ids that can occupy a cell under the current constraints. */
function candidatesAt(solution, n, r, c) {
  const ids = new Set();
  if (!solution || solution.irregular || !solution.phases.length) return ids;
  for (const phase of solution.phases) {
    const {slot}=E.phaseAt(phase,n,r,c);
    for (const m of phase.domains[slot]) ids.add(m.id);
  }
  return ids;
}

/** Cell coordinates (all candidate complete layouts) that hold an escape pod. */
function exitCells(node, n) {
  const layouts = node && node.completeLayouts && node.completeLayouts.layouts;
  const cells = new Map(); // "r,c" -> number of layouts containing it
  const samples = [];      // one Set per candidate layout, capped for scoring
  const add = (r, c) => cells.set(key(r, c), (cells.get(key(r, c)) || 0) + 1);
  if (Array.isArray(layouts) && layouts.length) {
    for (const layout of layouts) {
      const sample = new Set();
      for (const placement of layout) {
        const block = E.byId.get(placement.id);
        if (!block) continue;
        for (let i = 0; i < 9; i++) {
          if (block.cells[i].type !== 'EXIT') continue;
          const r = E.mod(placement.origin.r + Math.floor(i / 3), n);
          const c = E.mod(placement.origin.c + (i % 3), n);
          add(r, c);
          sample.add(key(r, c));
        }
      }
      if (sample.size && samples.length < 60) samples.push(sample);
    }
    return { cells, samples, layouts: layouts.length, complete: !!node.completeLayouts.complete };
  }
  const sample = new Set();
  for (const placement of (node && node.verification && node.verification.blocks) || []) {
    const block = E.byId.get(placement.id);
    if (!block) continue;
    for (let i = 0; i < 9; i++) {
      if (block.cells[i].type !== 'EXIT') continue;
      const r = E.mod(placement.origin.r + Math.floor(i / 3), n);
      const c = E.mod(placement.origin.c + (i % 3), n);
      add(r, c);
      sample.add(key(r, c));
    }
  }
  return { cells, samples: sample.size ? [sample] : [], layouts: 0, complete: false };
}

// Enumerated layouts are capped DFS samples, not probabilities. An original
// exit location is certain only when every remaining block/phase agrees.
function certainExits(solution,n,visited=new Set()) {
  const cells=new Map();
  if(!solution||solution.irregular||!solution.phases?.length)return cells;
  for(let r=0;r<n;r++)for(let c=0;c<n;c++){
    if(visited.has(key(r,c)))continue; // a pod we already walked over is spent
    if(solution.phases.every(p=>{
      const rr=E.mod(r-p.pr,n),cc=E.mod(c-p.pc,n);
      const domain=p.domains[E.phaseAt(p,n,r,c).slot];
      return domain?.length&&domain.every(m=>E.byId.get(m.id)?.cells[E.phaseAt(p,n,r,c).i]?.type==='EXIT');
    }))cells.set(key(r,c),1);
  }
  return cells;
}

function certainPortalLinks(solution,n,config={},observations=[]){
  const portals=new Map();
  if(config.portalChaos){for(const o of observations)if(o.kind==='portalLink')portals.set(E.key(o.r,o.c),{r:E.mod(o.r+o.dr,n),c:E.mod(o.c+o.dc,n),dr:o.dr,dc:o.dc});return portals;}
  if(!solution||solution.irregular||!solution.phases?.length)return portals;
  for(let r=0;r<n;r++)for(let c=0;c<n;c++){
    const offsets=[];let valid=true;
    for(const p of solution.phases){
      const rr=E.mod(r-p.pr,n),cc=E.mod(c-p.pc,n),domain=p.domains[E.phaseAt(p,n,r,c).slot];
      for(const m of domain||[]){const cell=E.byId.get(m.id)?.cells[E.phaseAt(p,n,r,c).i];
        if(cell?.type!=='PORTAL'||!cell.portal){valid=false;break;}offsets.push(cell.portal.join(','));}
      if(!valid)break;
    }
    if(valid&&offsets.length&&new Set(offsets).size===1){const [dr,dc]=offsets[0].split(',').map(Number);portals.set(key(r,c),{r:E.mod(r+dr,n),c:E.mod(c+dc,n),dr,dc});}
  }
  return portals;
}
function certainPortals(...args){return new Map([...certainPortalLinks(...args)].map(([key,{r,c}])=>[key,{r,c}]));}

function chooseObjective(from,target,ctx){
  const speculative={...ctx,excludedEdges:ctx.turnEdges};
  const capture=target?(routeTo(from,target,{...ctx,confirmedOnly:true})||routeTo(from,target,speculative)):null;
  let escape=null;
  for(const cell of ctx.exits.cells.keys()){
    const [r,c]=cell.split(',').map(Number);
    const confirmed=routeTo(from,{r,c},{...ctx,confirmedOnly:true,escapeRoute:true});
    const route=confirmed||routeTo(from,{r,c},speculative);
    if(route?.direction!=null&&(!escape||route.cost<escape.cost))escape={...route,r,c,confirmed:!!confirmed};
  }
  // Same-cell capture remains immediate. Otherwise prefer a no-longer route
  // to a confirmed pod over speculative long-distance pursuit.
  const escapePreference=ctx.experiment?.escapePreference??1;
  return {capture,escape,kind:escape&&(!capture||escape.cost<=capture.cost*escapePreference)?'escape':capture?'pursue':null};
}

function nearestExit(cells, r, c, n) {
  let best = Infinity;
  for (const cell of cells.keys ? cells.keys() : cells) {
    const [er, ec] = String(cell).split(',').map(Number);
    best = Math.min(best, torusDistance({ r, c }, { r: er, c: ec }, n));
  }
  return best;
}

/**
 * Score one step from `from` towards `dir`.
 * ctx = { n, walls, terrain, solution, visited, extraVisited, exits }
 */
function evaluateMove(from, dir, ctx) {
  const { n, walls, terrain, solution, visited, extraVisited, exits } = ctx;
  const [dr, dc] = E.V[dir.d];
  const nr = E.mod(from.r + dr, n);
  const nc = E.mod(from.c + dc, n);
  const wall = walls.get(key(from.r, from.c) + ':' + dir.d);
  const edge=edgeState(from,dir.d,ctx);
  const types = terrain.get(key(nr, nc)) || [];
  const ids = candidatesAt(solution, n, nr, nc);
  const move = {
    direction: dir.key, dirIndex: dir.d, label: dir.label, arrow: dir.arrow, to: { r: nr, c: nc },
    wall: edge.reportedClosed?'墙':wall || null, blocked: edge.blocked, wallKinds:edge.kinds, reportedClosed:edge.reportedClosed===true, known: types.length === 1,
    terrain: types, blockCandidates: [...ids], score: 0, risks: [], gains: [], reasons: [],
  };
  if (move.blocked) {
    move.reasons.push(edge.hedge?'树篱需要同方向助跑，当前无法穿过':'该侧已推定为阻挡');
    move.score = -1000;
    return move;
  }
  if (wall === '空') { move.score += 6; move.gains.push('该侧已确认可通行'); }
  else move.reasons.push('该侧墙壁未知');

  if (types.length === 1) {
    const hazard = ctx.brawl&&types[0]==='EXIT'?{score:-20,note:'大乱斗逃生舱会随机传送'}:HAZARD[types[0]] || { score: 0, note: types[0] };
    move.score += hazard.score;
    move.reasons.push(`地形确定为${hazard.note}`);
    if (hazard.score < 0) move.risks.push(hazard.note);
  } else if (types.length > 1) {
    move.score += 10 + Math.min(types.length, 4) * 2;
    const penalty = Math.min(0, ...types.map((t) => HAZARD[t] ? HAZARD[t].score : 0));
    move.score += penalty;
    if (penalty) move.reasons.push(`潜在危险扣分 ${penalty}（按最坏候选地形）`);
    move.gains.push(`地形仍有 ${types.length} 种可能，走进去能收窄`);
    for (const t of types) if (HAZARD[t] && HAZARD[t].score < -20) move.risks.push(`可能是${HAZARD[t].note}`);
  } else {
    move.score += 6;
    move.gains.push('地形完全未知');
  }

  if (ids.size > 1) { move.score += 6; move.gains.push(`该格还有 ${ids.size} 种区块候选`); }
  else if (ids.size === 1) move.score += 3;

  const k = key(nr, nc);
  const walked = (visited && visited.has(k)) || (extraVisited && extraVisited.has(k));
  if (!walked) { move.score += 8; move.gains.push('没走过的区域'); }
  else { move.score -= 4; move.reasons.push('走过的格子，新信息少'); }

  if (exits && exits.cells.size) {
    const cur = nearestExit(exits.cells, from.r, from.c, n);
    const next = nearestExit(exits.cells, nr, nc, n);
    const delta = cur - next;
    if (delta) {
      move.score += delta * 5;
      move.reasons.push(delta > 0 ? `离逃生舱近 ${delta} 格` : `离逃生舱远 ${-delta} 格`);
    }
    if (exits.samples.length) {
      let closer = 0;
      let farther = 0;
      for (const sample of exits.samples) {
        const before = nearestExit(sample, from.r, from.c, n);
        const after = nearestExit(sample, nr, nc, n);
        if (after < before) closer++;
        else if (after > before) farther++;
      }
      move.exitVotes = { closer, farther, total: exits.samples.length };
      if (closer > farther) {
        move.score += 3;
        move.gains.push(`${closer}/${exits.samples.length} 张候选整图里这一步更接近逃生舱`);
      }
    }
  }
  return move;
}

/**
 * Two-step lookahead: pick the first move whose best continuation is strongest.
 * Step 2 is scored on today's knowledge (no new walls/terrain discovered yet),
 * so it is explicitly speculative - it answers "if nothing new appears".
 */
function buildPlan(moves, ctx, weight = 0.7) {
  const candidates = moves.filter((m) => !m.blocked).slice(0, 3);
  if (!candidates.length) return null;
  let best = null;
  for (const first of candidates) {
    const extraVisited = new Set(ctx.extraVisited || []);
    extraVisited.add(key(first.to.r, first.to.c));
    const nextCtx = { ...ctx, extraVisited, lastDirection:first.dirIndex };
    const second = DIRS
      .filter((dir) => dir.key !== OPPOSITE[first.direction])
      .map((dir) => evaluateMove(first.to, dir, nextCtx))
      .filter((m) => !m.blocked)
      .sort((a, b) => b.score - a.score)[0] || null;
    const total = first.score + (second ? second.score * weight : -6);
    if (!best || total > best.total) best = { steps: [first, second].filter(Boolean), total, first };
  }
  if (!best || best.steps.length < 2) return null;
  const [a, b] = best.steps;
  return {
    steps: best.steps.map((m) => ({ direction: m.direction, label: m.label, arrow: m.arrow, to: m.to })),
    score: Math.round(best.total),
    text: `${a.arrow}${a.label} → ${b.arrow}${b.label}`,
    note: '两步推演：假设这一步没有发现新线索；拿到新四墙就重新算。',
  };
}

function suggestCore(input) {
  input=require('./local-recovery.cjs').localRecovery(input);
  input=localExit(input);
  const { built, team } = input;
  if (!built || built.spectator) return { ok: false, reason: '观战视角不做个人建议。', moves: [], warnings: [] };
  const self = built.self;
  const view = built.views[self];
  if (!view) return { ok: false, reason: '没有本人视角。', moves: [], warnings: [] };
  const n = view.model.config.size;
  const segment = view.model.segments[view.model.active];
  const node = team && team.nodes ? team.nodes.find((x) => x.id === `${self}:${view.model.active}`) : null;
  const warnings = [];
  const basis = [];

  let at;
  try {
    at = E.replay(segment, n);
  } catch (error) {
    return { ok: false, reason: `无法回放本人路线：${error.message}`, moves: [], warnings };
  }
  const { r, c } = at;
  const solution = node && node.solution;
  const solid = !!(solution && !solution.irregular && solution.phases.length === 1);
  const verified = !!(node && node.verification && node.verification.status === 'verified');
  const ambiguous = view.ambiguities.length > 0;
  if (!solid) warnings.push('本人区块边界未锁定，方向建议仅供参考。');
  if (node && node.verification && node.verification.status === 'impossible') {
    warnings.push('已录入线索互相矛盾，地图搜索判定为不可能；先核对是否混入了别人的视角或缺回合。');
  } else if (node && node.verification && node.verification.status !== 'verified') {
    warnings.push('还没有通过验证的完整地图，方向建议只按已确定的边界给出。');
  }
  if (ambiguous) warnings.push(`有 ${view.ambiguities.length} 处传送/心跳待定，位置可能变化。`);
  if(view.localExit)warnings.push(`按第 ${view.localExit.exitStep} 步已出传送门的局部假设探索；不是全图定位，后续线索可推翻。`);
  if(input.recovery){warnings.push('已隔离多人定位信息；仅依据独立验证的本人地图行动');basis.push('多人拼接冲突仍保留，禁止依赖对手定位追捕；本人原始线索已独立重建并验证。');}
  else if (team && (team.conflict || (node && node.fusionConflict))) warnings.push('多人拼接存在冲突，其他玩家的信息未并入。');

  const walls = solid ? E.inferredWalls(view.model.config, solution) : new Map();
  // Direct observations remain authoritative even without a unique block phase.
  for (const observation of at.observations || []) {
    if (observation.kind !== 'walls' || typeof observation.value !== 'string') continue;
    for (let d=0;d<4;d++) {
      const value=observation.value[d];
      if (value !== '墙' && value !== '空') continue;
      walls.set(key(observation.r,observation.c)+':'+d,value);
      const [dr,dc]=E.V[d];
      walls.set(key(E.mod(observation.r+dr,n),E.mod(observation.c+dc,n))+':'+[1,0,3,2][d],value);
    }
  }
  const terrain = solid ? E.terrainPossibilities(solution, n) : new Map();
  for(const o of at.observations||[])if(o.kind==='terrain'&&o.value)terrain.set(key(o.r,o.c),Array.isArray(o.value)?o.value:[o.value]);
  const scope = node ? T.mapScope(view.model.config, node, at.observations) : { visited: new Set((at.trace||[]).map(p=>key(p.r,p.c))), exposed: new Set() };
  const exits = {cells:certainExits(solution,n,scope.visited),samples:[]};
  const roomRules=input.journal?.base?.config?.roomRules;
  if(roomRules?.大乱斗==='开启')exits.cells.clear();
  if (exits.cells.size) basis.push(`所有剩余区块候选一致的逃生舱位置 ${exits.cells.size} 个；舱是否已被他人使用需核验`);

  const wallKinds=require('./edge-kinds.cjs').edgeKinds(view.model.config,solution);
  const spentPods=require('./progress-context.cjs').usedExits(input);
  for(const used of spentPods)exits.cells.delete(used);
  const allSpentPodsLocated=A.status(built).filter(p=>!p.alive&&/逃生/.test(p.reason||'')).length===spentPods.size;
  const ctx = { n, walls, terrain, wallKinds, lastDirection:at.last, solution, visited: scope.visited, extraVisited: null, exits,portals:certainPortals(solution,n,view.model.config,at.observations) };
  ctx.birth=node?.birth;
  ctx.brawl=roomRules?.大乱斗==='开启';
  ctx.probeUnusedPod=solid&&allSpentPodsLocated&&!ctx.brawl;
  ctx.spentPods=spentPods;
  ctx.captureOnArrival=roomRules?.点杀==='关闭'||roomRules?.谋定后动==='开启';
  // Explicit caller-only experiment parameters; the live bot never supplies them.
  ctx.experiment=input.experiment;
  ctx.silent=view.model.config.silent===true;
  ctx.brawl=view.model.config.brawl===true;
  if(view.model.config.event==='AMBUSH')for(const [k,types] of terrain)terrain.set(k,types.map(t=>t==='BERRY'?'TRAP':t));
  const lastOwn=view.roundEnds.at(-1);
  const ownRound=lastOwn ? lastOwn.round+(lastOwn.complete?1:0) : 1;
  const progress=require('./progress-context.cjs').progressContext(at,input.journal,self,ownRound);
  ctx.traversals=progress.edges;ctx.turnEdges=progress.turnEdges;ctx.publicSounds=progress.publicSounds;ctx.turnSounds=progress.turnSounds;
  for(const o of at.observations||[])if(['hit','pass'].includes(o.kind)){
    if(wallKinds.get(key(o.r,o.c)+':'+o.dir)?.includes(2))continue;
    const value=o.kind==='hit'?'墙':'空';walls.set(key(o.r,o.c)+':'+o.dir,value);
    walls.set(key(E.mod(o.r+E.V[o.dir][0],n),E.mod(o.c+E.V[o.dir][1],n))+':'+[1,0,3,2][o.dir],value);
  }
  const {silentProjection,publicRoutes,currentPositions}=require('./silent-projection.cjs');
  const projection=input.projection!==undefined?input.projection:
    !input.recovery&&input.journal&&view.model.config.silent?silentProjection({built,team,view,node,config:view.model.config,routes:publicRoutes(input.journal)}):null;
  const projected=currentPositions(projection,built,ownRound);
  const assigned=A.status(built).find(p=>p.id===self)?.target;
  let target=locateTarget(input);
  if(!target&&projected?.target===assigned&&projected?.positions.length===1){
    target={target:assigned,...projected.positions[0],round:projected.round,source:projected.source,edges:[]};
    basis.push(`静音逐图回放：${assigned}号第${projected.round}回合终点唯一（第${target.r+1}行第${target.c+1}列），已比较追捕和逃生路线。`);
  }
  if(target)for(const edge of target.edges){
    walls.set(key(edge.r,edge.c)+':'+edge.dir,edge.value);
    walls.set(key(E.mod(edge.r+E.V[edge.dir][0],n),E.mod(edge.c+E.V[edge.dir][1],n))+':'+[1,0,3,2][edge.dir],edge.value);
  }
  for(const edge of require('./reported-walls.cjs').reportedClosed(at,n).keys()){
    walls.set(edge,'墙');
    if(wallKinds.get(edge)?.includes(2))wallKinds.set(edge,[1,3]);
  }
  const moves = DIRS.map((dir) => evaluateMove({ r, c }, dir, ctx));
  // Penalize repeated traversals, not merely whether a cell was ever visited.
  const visits=new Map();for(const p of at.trace||[])visits.set(key(p.r,p.c),(visits.get(key(p.r,p.c))||0)+1);
  const previous=at.trace?.at(-2);
  for(const move of moves)if(!move.blocked){
    const repeated=visits.get(key(move.to.r,move.to.c))||0;
    if(repeated){move.score-=18*repeated;move.reasons.push(`重复经过 ${repeated} 次，降低折返优先级`);}
    if(previous?.r===move.to.r&&previous?.c===move.to.c){move.score-=12;move.reasons.push('避免立即原路折返');}
  }
  const turnEvents=view.model.segments.flatMap(s=>s.events).filter(e=>e.kind==='move'&&e.clock?.round===ownRound);
  const facts=turnFacts(input.journal,self,ownRound);
  const turnSteps=Math.max(facts.steps,view.localExit?.steps||0,...turnEvents.map(e=>e.clock.step),0);
  ctx.trapState=require('./trap-state.cjs').trapState({journal:input.journal,node,config:view.model.config,round:ownRound,player:self,steps:turnSteps});
  const joint=require('./portal-plans.cjs').portalPlans(input);
  if(joint){
    const best=joint.calculation.options[0];
    const primary=joint.stop?{direction:'stop',label:'停止',arrow:'■',to:{r,c},blocked:false,score:joint.score,reasons:[],gains:[],risks:[]}:moves.find(m=>m.dirIndex===joint.commands[0]&&!m.blocked);
    if(primary){
      primary.score=joint.score;primary.reasons.unshift('联合比较 '+joint.calculation.options.length+' 种后续方案，选择 '+best.command+'；只执行第一步，反馈后重算');
      return {ok:true,position:{r,c,segment:view.model.active,unique:false},moves,primary,alternatives:[],plan:null,
        tactic:{kind:'portal-joint-plan',round:ownRound,steps:turnSteps,remaining:joint.remaining,command:best.command,stop:joint.stop},
        bayes:joint.calculation,warnings,basis,confidence:'low'};
    }
  }
  const diagnostic=require('./portal-diagnostic.cjs').portalDiagnostic(input);
  if(diagnostic){
    // At the opening, either branch can afford to yield after one quiet probe.
    // Only the portal branch benefits from masking next round's emergence.
    if(ownRound===1&&turnSteps===2&&diagnostic.entryStep===1&&diagnostic.remaining===1&&facts.continuous&&
      M.liveMessages(input.journal.messages).some(m=>m.view===self&&m.receiverConfirmed&&
        M.parse(m.text).items.some(i=>i.kind==='personalSound'&&i.round===1&&i.step===1&&i.masked&&i.sound==='PAPA'))){
      return {ok:true,position:{r,c,segment:view.model.active,unique:false},moves,
        primary:{direction:'stop',label:'保留可能的出门声',arrow:'■',to:{r,c},blocked:false,score:0,
          reasons:['首步啪嗒被心跳掩盖，第二步无声。若在亚空间，下回合第一步出门也能掩盖声音'],gains:[],
          risks:['若实际踩水，本次停止会交出行动权；停止公开，全员停止可能结束游戏']},
        alternatives:[],plan:null,tactic:{kind:'portal-heartbeat-wait',conditional:true,round:ownRound,steps:turnSteps,
          entryStep:1,remaining:1,entryMasked:true,nextExitStep:1},warnings,basis,confidence:'medium'};
    }
    const primary=moves.find(m=>m.dirIndex===diagnostic.commands[0]&&!m.blocked);
    if(primary){primary.score=diagnostic.score;primary.reasons.unshift(`辨别传送：计划 ${diagnostic.commands.map(d=>DIRS[d].arrow).join('')}；地面分支走已确认空地，传送分支推进到出口，比较出口声与无声反馈后继续探索`);
      return {ok:true,position:{r,c,segment:view.model.active,unique:false},moves,primary,alternatives:[],plan:null,tactic:{kind:'portal-diagnostic',...diagnostic},warnings,basis,confidence:'medium'};}
  }
  const commandLoop=ambiguous&&!view.localExit&&lastOwn?.locatable===false
    ?require('./local-exit.cjs').unresolvedLoop(facts.moves):null;
  if(commandLoop)return {ok:true,position:{r,c,segment:view.model.active,unique:false},moves,
    primary:{direction:'stop',label:'结束无信息循环',arrow:'■',to:{r,c},blocked:false,score:0,
      reasons:['位置仍待定位，指令序列已重复且没有新增地形反馈；结束无目的循环，等待回合结束的四墙线索'],gains:[],risks:['停止会交出行动权；当前位置安全性未知，全员主动停止可能结束游戏']},
    alternatives:[],plan:null,tactic:{kind:'finish-exploration',round:ownRound,steps:turnSteps,loopPrevented:true,exhausted:true,stopException:'unresolved-loop',commandLoop,stopAssessment:{known:false,reason:'位置待定位，无法证明安全'}},warnings,basis,confidence:'low'};
  if(lastOwn?.inSpace&&lastOwn.locatable!==false&&!ambiguous&&!warnings.some(w=>/矛盾|冲突/.test(w))){
    const portalExit=ctx.portals.get(key(r,c));
    const exitObjective=portalExit?chooseObjective(portalExit,ownRound>1?target:null,ctx):null;
    const urgentExit=exitObjective?.kind;
    const pause=!urgentExit&&portalHeartbeatPause(view,turnSteps);
    if(pause)return {ok:true,position:{r,c,segment:view.model.active,unique:solid},moves,
      primary:{direction:'stop',label:'留在亚空间',arrow:'■',to:{r,c},blocked:false,score:0,reasons:['入口已被心跳掩盖，保留最后一步传送到下回合第1步，掩盖出口声'],gains:[],risks:['主动停止仍可见；若本轮全员主动停止，游戏可能结束']},
      alternatives:[],plan:null,tactic:{kind:'portal-heartbeat-wait',round:ownRound,steps:turnSteps,...pause},warnings,basis,confidence:'medium'};
    // Subspace commands advance the portal timer, not physical map cells.
    // Pick an unblocked displayed edge as well so the final sender wall guard
    // remains conservative; re-infer on each of the two feedback messages.
    const primary=moves.find(m=>!m.blocked);
    if(primary){primary.reasons.unshift(urgentExit?'传送出口存在可执行的追捕或逃生路线，优先完成传送，不为掩盖出口交出行动权':'已确认身处亚空间：继续一步推进传送，离开后按出口位置重新规划');
      return {ok:true,position:{r,c,segment:view.model.active,unique:solid,blockCandidates:[...candidatesAt(solution,n,r,c)]},moves,primary,alternatives:[],plan:null,
        tactic:{kind:'portal-transit',round:ownRound,...(urgentExit?{exitObjective:urgentExit,target,portalExit}: {})},warnings,basis,confidence:'medium'};}
  }
  const objective=chooseObjective({r,c},ownRound>1?target:null,ctx);
  const hunterId=A.status(built).find(p=>p.id===self)?.hunter;
  ctx.hunters=!ambiguous&&!team?.conflict&&hunterId!=null?(projected?.target===hunterId?projected:targetCandidates(input,ownRound,hunterId)):null;
  const candidates=!target?(projected&&projected.target===assigned?projected:targetCandidates(input,ownRound)):null;
  const hunt=!ambiguous&&!warnings.some(w=>/矛盾|冲突/.test(w))?candidatePlan({r,c},candidates,ctx,{round:ownRound,steps:turnSteps,usedHuntEdges:progress.turnEdges,turnArrivals:progress.turnArrivals}):null;
  if(candidates)basis.push(`${candidates.target} 号在本人坐标系有 ${candidates.positions.length} 个兼容位置候选${hunt?'，已评估追击路线':ownRound===1?'，首轮保护不追捕':'，当前无合适追击路线，保留候选继续获取线索'}。`);
  const preferEscape=objective.kind==='escape'&&(!hunt||objective.escape.confirmed||objective.escape.cost<=hunt.cost);
  if(preferEscape&&!ambiguous&&!warnings.some(w=>/矛盾|冲突/.test(w))){
    const route=objective.escape,primary=moves.find(m=>m.dirIndex===route.direction);
    const destination={r:route.r,c:route.c};
    const batchEscape=route.confirmed&&allSpentPodsLocated&&route.commands.length>1
      ?{confirmed:true,target:destination,commands:route.commands.map(d=>['上','下','左','右'][d]).join('')}:null;
    primary.reasons.unshift(`前往已确定的逃生舱位置：路线代价 ${route.cost}${objective.capture?`，追捕路线代价 ${objective.capture.cost}`:'，当前没有可执行的确定追捕路线'}`);
    if(batchEscape)primary.reasons.unshift('已确认整条逃生路线，一次发送 '+batchEscape.commands);
    return {ok:true,position:{r,c,segment:view.model.active,unique:solid,blockCandidates:[...candidatesAt(solution,n,r,c)]},moves,primary,alternatives:[],plan:null,
      tactic:{kind:'escape',round:ownRound,routeRisk:route.risk,destination,routeCost:route.cost,captureCost:objective.capture?.cost??null,...(batchEscape?{batchEscape}:{})},warnings,basis,confidence:'medium'};
  }
  if(ownRound===1 && target && !warnings.some(w=>/矛盾|冲突/.test(w))){
    const events=view.model.segments.flatMap(s=>s.events).filter(e=>e.kind==='move'&&e.clock?.round===1);
    const steps=Math.max(0,...events.map(e=>e.clock.step));
    const quiet=moves.filter(m=>!m.blocked && !(target&&m.to.r===target.r&&m.to.c===target.c)
      && !(m.known && m.terrain.some(t=>['PORTAL','TRAP','HEAT','HEART'].includes(t)))
      && !(previous?.r===m.to.r&&previous?.c===m.to.c))
      .sort((a,b)=>(b.score+(b.wall==='空'?8:0))-(a.score+(a.wall==='空'?8:0)));
    const extra=quiet.filter(m=>!scope.visited.has(key(m.to.r,m.to.c))
      &&m.terrain.every(t=>(view.model.config.silent?['EMPTY','EXIT','GRASS','WATER','BERRY']:['EMPTY','EXIT']).includes(t)));
    const choices=steps<2?quiet:steps<3?extra:[];
    const move=chooseOpening(choices,{journal:input.journal,self,round:ownRound,steps,score:m=>m.score+(m.wall==='空'?8:0)})||null;
    const finish=steps>=2&&!move;
    const wallFinish=finish?wallFinishPlan({r,c},moves,{...ctx,silent:view.model.config.silent},at.trace||[]):null;
    const primary=move||wallFinish?.primary||(finish?{direction:'stop',label:'结束首轮探索',arrow:'■',to:{r,c},blocked:false,score:0,reasons:['受保护目标已定位；完成少量探索后主动结束，不等待超时'],gains:[],risks:['停止会交出行动权；本轮不尝试捕捉受保护目标']}:null);
    if(move)move.reasons.unshift(steps>=2?'首轮保护：再探一步低风险新格，随后主动结束':'首轮保护：少量低风险探索，不主动追捕');
    return {ok:true,position:{r,c,segment:view.model.active,unique:solid,blockCandidates:[...candidatesAt(solution,n,r,c)]},moves:quiet,primary,alternatives:[],plan:null,
      tactic:{kind:finish?'finish-protected-opening':move?'quiet-explore-first-round':'hold-first-round',round:1,steps,limit:3,target,finishMethod:wallFinish?.method,stopException:finish&&!wallFinish?'no-safe-wall-route':undefined},warnings,
      basis:[...basis,move?'少量探索换取信息；两步后最多追加一步低风险新格，未知墙碰撞自然结束。':finish?'优先撞墙结束首轮；没有安全撞墙路线才例外停止。':'尚未完成探索且没有合适方向，保留阻挡保护。'],confidence:'medium'};
  }
  if(target && !warnings.some(w=>/矛盾|冲突/.test(w))){
    const same=target.r===r&&target.c===c;
    const batchCapture=!same&&ownRound>1?captureBatch({r,c},target,ctx):null;
    const direction=same?captureFinishDirection({r,c},ctx,ctx.lastDirection):batchCapture?batchCapture.direction:objective.capture?.direction;
    const primary=direction==null?(same?{direction:'stop',label:'停止并捕捉',arrow:'■',to:{r,c},blocked:false,score:1000,reasons:[],gains:[],risks:[]}:null):moves.find(m=>m.dirIndex===direction);
    if(primary||same){
      if(primary&&!same){
        primary.reasons=primary.reasons.filter(reason=>!/重复经过|折返|走过的格子/.test(reason));
        if(batchCapture)primary.reasons.unshift(`完整追捕路线已确认：一次发送 ${batchCapture.commands}，${batchCapture.finish?'末步原地撞墙触发捕捉':'抵达后核验反馈并结束行动捕捉'}`);
      }
      if(primary){primary.score=1000;primary.reasons.unshift(same?(primary.direction==='stop'?'已与捕捉目标同格，主动停止触发点杀':'已与捕捉目标同格，主动撞墙结束行动触发点杀'):`优先接近已定位的 ${target.target} 号目标`);if(same&&primary.direction!=='stop'){primary.intentionalCollision=true;primary.to={r,c};if(primary.wallKinds?.[0]===2)primary.arrivalDirection=ctx.lastDirection;}}
      return {ok:true,position:{r,c,segment:view.model.active,unique:solid,blockCandidates:[...candidatesAt(solution,n,r,c)]},moves,primary,alternatives:[],plan:null,
        tactic:{kind:same?'finish-capture':'pursue',round:ownRound,target,...(same&&primary?.direction==='stop'?{stopException:'capture-no-wall',arrivalDirection:ctx.lastDirection}:{}),...(batchCapture?{batchCapture}: {})},warnings,
        basis:[...basis,'同格声/地图对齐与目标后续轨迹用于追捕；首轮捕捉受保护，不保证淘汰。'],confidence:'medium'};
    }
  }
  const localSteps=turnEvents.filter(e=>e.outcome==='move').length;
  const turnTrace=(at.trace||[]).slice(-(localSteps+1));
  if(hunt&&ctx.probeUnusedPod&&hunt.cost>0){
    const pod=continuationPlan({r,c},{...ctx,onlyPodProbe:true},{trace:turnTrace,steps:turnSteps,beforeFinish:true});
    const primary=pod&&moves.find(m=>m.dirIndex===pod.direction&&!m.blocked);
    if(primary&&pod.cost<=hunt.cost+2){
      primary.reasons.unshift('沿安全通路试探可能可用的逃生舱，比追逐未定位目标更划算');
      return {ok:true,position:{r,c,segment:view.model.active,unique:solid},moves,primary,alternatives:[],plan:null,tactic:{kind:'pod-probe',...pod},warnings,basis,confidence:'medium'};
    }
  }
  if(hunt){
    const primary=hunt.kind==='attempt-capture'
      ?collisionMove(moves,{r,c},ctx)||{direction:'stop',label:'停止并尝试捕捉',arrow:'■',to:{r,c},blocked:false,score:100,reasons:[],gains:[],risks:[]}
      :moves.find(m=>m.dirIndex===hunt.direction&&!m.blocked);
    if(primary){
      primary.score=100-hunt.cost;
      primary.reasons=primary.reasons.filter(reason=>!/重复经过|折返|走过的格子/.test(reason));
      primary.gains=primary.gains.filter(gain=>!/区块候选/.test(gain));
      primary.reasons.unshift(hunt.kind==='attempt-capture'
        ?`已到达 ${candidates.positions.length} 个候选之一，结束行动尝试捕捉 ${candidates.target} 号（并非确定同格）`
        :`追击 ${candidates.target} 号的 ${candidates.positions.length} 个位置候选，前往 (${hunt.destination.r+1},${hunt.destination.c+1})，含结束行动代价 ${hunt.cost}`);
      primary.risks.push('位置仍是候选，可能扑空；候选数量不代表等概率');
      if(hunt.landmark)primary.reasons.push(hunt.landmark);
      return {ok:true,position:{r,c,segment:view.model.active,unique:solid,blockCandidates:[...candidatesAt(solution,n,r,c)]},moves,primary,alternatives:[],plan:null,
        tactic:{kind:hunt.kind,...(primary.direction==='stop'?{stopException:'capture-no-wall'}:{}),round:ownRound,steps:turnSteps,target:candidates.target,destination:hunt.destination,routeCost:hunt.cost,candidates,escapeCost:objective.escape?.cost??null},warnings,basis:[...basis,candidates.source==='sound-endpoint'?'按发声方位、后续已知位移和末步撞墙推断终点：按听声方位与全部地形候选收窄终点；前段传送待定不阻止候选追捕，仍可能扑空。':'追击使用双方当前片段的完整相对位置候选，不使用截断整图样本频率；每步新线索重新规划。'],confidence:'medium'};
    }
  }
  const portalProbe=!target&&!candidates&&verified&&!ambiguous&&!view.localExit&&!team?.conflict&&!node.routePending&&!node.fusionConflict&&!warnings.some(w=>/矛盾|冲突/.test(w))
    ?require('./sound-target.cjs').portalScout(input,ctx,at,ownRound,turnSteps):null;
  if(portalProbe){
    const primary=moves.find(m=>m.dirIndex===portalProbe.direction&&!m.blocked);
    if(primary){
      primary.reasons.unshift('对方两步后再次啪嗒并停止，末声方位符合刚走过的门对；回门核验可能出口');
      return {ok:true,position:{r,c,segment:view.model.active,unique:solid},moves,primary,alternatives:[],plan:null,
        tactic:{kind:'portal-scout',round:ownRound,steps:turnSteps,...portalProbe},warnings,basis,confidence:'medium'};
    }
  }
  ctx.batchUnsafe=!!(Number(roomRules?.炸弹)||ctx.captureOnArrival||roomRules?.隐匿==='开启'||team?.conflict||!verified||ambiguous);
  const paddingUsed=input.heartbeatPaddingRound===ownRound;
  if(paddingUsed)basis.push('本回合已经发过心跳垫步，继续评估直接探路、追捕和逃生。');
  const heartbeat=!ambiguous&&!warnings.some(w=>/矛盾|冲突/.test(w))?heartbeatPlan({r,c},{
    ...ctx,heartPresence:view.model.config.heartPresence===true,paddingUsed,
    allowPadding:!ctx.batchUnsafe&&verified&&!view.localExit&&!node.routePending&&!node.fusionConflict
  },turnSteps):null;
  // Tactical escape, capture, and uncertain-portal handling above retain priority.
  if(!ambiguous&&!team?.conflict&&node?.solution&&!node.fusionConflict&&!node.routePending&&!view.localExit&&!target&&!candidates&&!input.experiment){
    const config={...view.model.config,playerCount:view.model.config.playerCount||built.views.length};
    const pads=heartbeat?.padding?heartbeatPlan({r,c},{...ctx,heartPresence:true,allowPadding:true,paddingUsed},turnSteps,true):[];
    ctx.probeBayesExit=allSpentPodsLocated;
    const ranked=require('./pruned-routes.cjs').rank({ctx,node,view,team,from:{r,c},moves,steps:turnSteps,round:ownRound,padding:pads,
      hasSound:view.model.segments.some(s=>s.events.some(e=>['PAPA','SHASHA'].includes(e.sound)||e.firstSound)),config});
    if(ranked)input.decisionAudit.routes={version:2,mode:ranked.mode,options:ranked.options,audit:ranked.audit,valueModel:ranked.valueModel,positionCandidates:ranked.positionCandidates};
    if(ranked&&(ranked.options[0].score>0||turnSteps<2)){
      const best=ranked.options[0],primary={...moves[best.directions[0]],score:best.score,
        reasons:[(ranked.mode==='opening-model'?'按完整开局后验期望评分：':ranked.mode==='local-model'?'按附近区块结果概率和固定收益评分：':'按最不利结果的固定收益评分：')+best.command],gains:['探索新格或接近可用舱位'],risks:[ranked.mode==='conservative'?'概率未完成，采用确定的保守值':ranked.mode==='local-model'?'局部区块概率不等于完整全图后验':'按完整开局后验计算']};
      const pad=pads.find(p=>p.directions.join()===best.directions.join());
      return {ok:true,position:{r,c,segment:view.model.active,unique:solid},moves,primary,alternatives:[],plan:null,
        tactic:pad?{kind:'heartbeat-align',round:ownRound,...pad}:{kind:'bayes-exploration',round:ownRound,steps:turnSteps,command:best.command,confirmedPrefix:best.command.length>1},
        bayes:{version:2,mode:ranked.mode,options:ranked.options,audit:ranked.audit,valueModel:ranked.valueModel,positionCandidates:ranked.positionCandidates},warnings,basis,confidence:'medium'};
    }
  }
  if(heartbeat){
    const primary=moves.find(m=>m.dirIndex===heartbeat.directions[0]);
    primary.reasons.unshift(heartbeat.padding?`一次发送 ${heartbeat.directions.map(d=>DIRS[d].arrow).join('')}，垫 ${heartbeat.padding} 步后在第 ${heartbeat.beat} 步探新格，本回合仅此一次`:`第 ${heartbeat.beat} 步心跳掩盖声响，探索未走过的发声格`);
    return {ok:true,position:{r,c,segment:view.model.active,unique:solid,blockCandidates:[...candidatesAt(solution,n,r,c)]},moves,primary,alternatives:[],plan:null,
      tactic:{kind:heartbeat.padding?'heartbeat-align':'heartbeat-probe',round:ownRound,...heartbeat},warnings,basis:[...basis,'垫步只走已确认的普通通路和到过的确定空地，目标是心跳时可辨认的新地形。'],confidence:'medium'};
  }
  const masked=view.model.config.heartPresence===true&&!view.model.config.silent&&turnSteps<19&&turnSteps%3===0;
  const exposed=!view.model.config.silent&&facts.exposed;
  rankExploration(moves,{r,c},ctx,{visits,previous,trace:turnTrace,round:ownRound,masked,silent:view.model.config.silent,exposed,steps:turnSteps});
  require('./branch-exploration.cjs').constrainBranchExploration(moves,input);
  if(ambiguous&&!view.model.config.silent)require('./branch-exploration.cjs').rankSoundReturn(moves,facts);
  if(ownRound===1&&!ambiguous&&!team?.conflict)require('./opening-objective.cjs').rankOpening(moves,{r,c},ctx,candidates,roomRules?.大乱斗!=='开启');
  const tacticalSafe=!ambiguous&&!warnings.some(w=>/矛盾|冲突/.test(w));
  const scoutCandidates=candidates||(target?.source==='silent-layouts'?projected:
    target?{target:target.target,positions:[{r:target.r,c:target.c}],source:target.source}:null);
  const scout=tacticalSafe?scoutPlan({r,c},scoutCandidates,ctx,{round:ownRound,trace:turnTrace}):null;
  if(scout){
    const primary=moves.find(m=>m.dirIndex===scout.direction&&!m.blocked&&!m.explorationForbidden);
    if(primary){
      primary.reasons.unshift(`追击受阻，定向探查 (${scout.destination.r+1},${scout.destination.c+1})，缩短与目标候选的距离；每步反馈重算`);
      primary.risks.push('探索方向不等于已证明的追击通路；未知墙可能结束回合，可能传送会使位置改变');
      return {ok:true,position:{r,c,segment:view.model.active,unique:solid},moves,primary,alternatives:[],plan:null,
        tactic:{kind:'target-scout',round:ownRound,steps:turnSteps,target:scoutCandidates.target,candidates:scoutCandidates,...scout},warnings,basis,confidence:'medium'};
    }
  }
  const directionCounts=[0,0,0,0];for(const e of facts.moves.length?facts.moves:turnEvents)if(e.dir!=null)directionCounts[e.dir]++;
  const loopPrevented=moves.some(m=>!m.blocked&&m.explorationForbidden);
  if(loopPrevented)warnings.push('已排除重复的无目的探索边及待定位分支中的旧墙风险；取信息后的首次返回仍允许。');
  const open = moves.filter((m) => !m.blocked&&!m.explorationForbidden).sort((a, b) => b.score - a.score || directionCounts[a.dirIndex]-directionCounts[b.dirIndex]);
  // Establish a real frontier from the first command, including when an old
  // corridor has a small positive transit score. A dead spur is not a goal.
  if(tacticalSafe&&(!open.length||open[0].score<=0||open[0].evaluation?.quietRoute>0)){
    const continuation=continuationPlan({r,c},ctx,{trace:turnTrace,masked,steps:turnSteps,heartPresence:view.model.config.heartPresence===true});
    if(continuation){
      const primary=open.find(m=>m.dirIndex===continuation.direction);
      if(primary){
        primary.reasons.unshift(`规划完整探索前沿：前往新格 (${continuation.destination.r+1},${continuation.destination.c+1})，每步按新反馈重算`);
        return {ok:true,position:{r,c,segment:view.model.active,unique:solid},moves:open,primary,alternatives:[],plan:null,
          tactic:{kind:'continue-exploration',round:ownRound,steps:turnSteps,...continuation},warnings,basis,confidence:'medium'};
      }
    }
  }
  // Before returning to old ground or ending a short turn, accept a bounded
  // speculative frontier. This is not a new-cell reward for known terrain.
  if(tacticalSafe&&turnSteps<3&&!exposed&&(!open.length||open[0].score<=0)){
    const probe=continuationPlan({r,c},ctx,{trace:turnTrace,masked,steps:turnSteps,heartPresence:view.model.config.heartPresence===true,initiative:true});
    const primary=probe&&open.find(m=>m.dirIndex===probe.direction);
    if(primary){
      primary.reasons.unshift('短回合主动探路：接受适量未知墙、发声或传送风险，获取真实新信息，不因保守负分折返撞墙');
      primary.risks.push('未知前沿可能撞墙、发声或传送；按下一步实际反馈重新判断');
      return {ok:true,position:{r,c,segment:view.model.active,unique:solid},moves:open,primary,alternatives:[],plan:null,
        tactic:{kind:'initiative-exploration',round:ownRound,steps:turnSteps,...probe},warnings,basis,confidence:'medium'};
    }
  }
  // Low utility is not exhaustion: prefer a real quiet frontier to yielding
  // the turn, even after the usual long-turn information discount.
  if(tacticalSafe&&(!open.length||open[0].score<=0)){
    const frontier=continuationPlan({r,c},ctx,{trace:turnTrace,masked,steps:turnSteps,heartPresence:view.model.config.heartPresence===true,beforeFinish:true});
    const primary=frontier&&open.find(m=>m.dirIndex===frontier.direction);
    if(primary){
      primary.reasons.unshift('结束前仍有安静未知前沿：继续获取真实信息，不把长回合负分当成无路可走');
      primary.risks.push('未知边可能撞墙，候选传送门可能改变位置；逐步验证，不作为确定通路');
      return {ok:true,position:{r,c,segment:view.model.active,unique:solid},moves:open,primary,alternatives:[],plan:null,
        tactic:{kind:'continue-exploration',round:ownRound,steps:turnSteps,...frontier},warnings,basis,confidence:'medium'};
    }
  }
  if(tacticalSafe&&(!open.length||open[0].score<=0)){
    const frontier=continuationPlan({r,c},ctx,{trace:turnTrace,masked,steps:turnSteps,heartPresence:view.model.config.heartPresence===true,beforeFinish:true,activeFallback:true});
    const primary=frontier&&open.find(m=>m.dirIndex===frontier.direction);
    if(primary){primary.reasons.unshift('积极继续：仍有不重复的真实探路机会，接受适量未知边或声音风险，不为低分主动收尾');
      return {ok:true,position:{r,c,segment:view.model.active,unique:solid},moves:open,primary,alternatives:[],plan:null,
        tactic:{kind:'continue-exploration',round:ownRound,steps:turnSteps,...frontier,activeFallback:true},warnings,basis,confidence:'medium'};
    }
  }
  if(tacticalSafe&&verified&&open.every(m=>m.score<=0)){
    for(const primary of open){
      const entry=key(primary.to.r,primary.to.c),exit=ctx.portals.get(entry);
      const edge=edgeState({r,c},primary.dirIndex,ctx);
      if(!exit||edge.wall!=='空'||edge.uncertain||ctx.turnEdges.has(key(r,c)+':'+primary.dirIndex))continue;
      const frontier=continuationPlan(exit,{...ctx,lastDirection:-1},{trace:turnTrace,steps:turnSteps+3,beforeFinish:true,activeFallback:true});
      if(!frontier)continue;
      primary.reasons.unshift('回到已配对传送门：出口还有可探的新边或新格，出门后重算');
      return {ok:true,position:{r,c,segment:view.model.active,unique:solid},moves,primary,alternatives:[],plan:null,
        tactic:{kind:'portal-frontier',round:ownRound,steps:turnSteps,exit,destination:frontier.destination},warnings,basis,confidence:'medium'};
    }
  }
  if((ownRound>1||loopPrevented)&&turnSteps>=2&&(!open.length||open[0].score<=0)){
    const hunter=A.status(built).find(p=>p.id===self)?.hunter;
    const hunters=tacticalSafe&&hunter!=null?targetCandidates(input,ownRound,hunter):null;
    const safety=saferRelocation(open,{r,c},hunters,ctx,turnTrace);
    if(ownRound>1&&safety.move){
      const primary=safety.move;
      primary.reasons.unshift(`停止前换位：${safety.stop.reason}；走已确认安静通道后最近距离 ${safety.after.nearest} 格`);
      primary.risks.push('距离增大不保证安全；不会为换位重复本回合的有向边');
      return {ok:true,position:{r,c,segment:view.model.active,unique:solid},moves:open,primary,alternatives:[],plan:null,
        tactic:{kind:'safer-relocation',round:ownRound,steps:turnSteps,stopAssessment:safety.stop,after:safety.after},warnings,basis,confidence:'medium'};
    }
    const wallFinish=tacticalSafe?wallFinishPlan({r,c},moves,{...ctx,silent:view.model.config.silent},turnTrace):null;
    if(wallFinish)return {ok:true,position:{r,c,segment:view.model.active,unique:solid},moves,primary:wallFinish.primary,alternatives:[],plan:null,
      tactic:{kind:'finish-exploration',round:ownRound,steps:turnSteps,loopPrevented,exhausted:true,finishMethod:wallFinish.method,destination:wallFinish.destination},warnings,basis,confidence:'medium'};
    return {ok:true,position:{r,c,segment:view.model.active,unique:solid,blockCandidates:[...candidatesAt(solution,n,r,c)]},moves:open,
      primary:{direction:'stop',label:'停止',arrow:'■',to:{r,c},blocked:false,score:-safety.stop.penalty,reasons:['例外停止：已探索，受限搜索内没有不重复的可接受新格路线，也没有更安全的安静换位'],gains:[],risks:[safety.stop.reason,'停止会交出行动权，不保证当前位置安全']},
      alternatives:[],plan:null,tactic:{kind:'finish-exploration',round:ownRound,steps:turnSteps,loopPrevented,exhausted:true,stopException:'no-safe-wall-route',stopAssessment:safety.stop},warnings:[...warnings,...(loopPrevented?['禁止无目的往返；未找到可继续探索的路线，例外结束行动。']:[])],basis,confidence:'medium'};
  }

  if (!open.length) {
    return {
      ok: true, position: { r, c, segment: view.model.active, unique: solid },
      moves, primary: null, alternatives: [],
      warnings: [...warnings, '四周都被推定为墙，本回合无法安全移动；建议主动停止并核对四墙私信。'],
      basis, confidence: 'low',
    };
  }

  const chosen=chooseOpening(open,{journal:input.journal,self,round:ownRound,steps:turnSteps});
  if(chosen!==open[0])open.splice(0,0,open.splice(open.indexOf(chosen),1)[0]);
  const [first, second] = open;
  const margin = second ? first.score - second.score : 99;
  const impossible = !!(node && node.verification && node.verification.status === 'impossible');
  const confidence = !solid || impossible ? 'low' : ambiguous || !verified ? 'medium' : margin >= 8 ? 'high' : 'medium';
  const trimmed = open.map((m) => ({ ...m, risks: [...new Set(m.risks)], gains: [...new Set(m.gains)], reasons: [...new Set(m.reasons)] }));
  // One suggestion at a time: the caller asks again after the step result.
  const plan = null;
  return {
    ok: true,
    position: { r, c, segment: view.model.active, unique: solid, blockCandidates: [...candidatesAt(solution, n, r, c)] },
    moves: trimmed,
    primary: trimmed[0],
    alternatives: trimmed.slice(1, 3),
    plan,
    warnings,
    basis,
    confidence,
  };
}

function suggest(input){
 const base=require('./nov02-policy/suggest.cjs').suggest(input);
 const selected=require('./mode-policy.cjs').apply(input,require('./solo-batch.cjs').apply(input,require('./action-rules.cjs').enforce(require('./hypothesis-probe.cjs').apply(input,base))));
 return require('./known-prefix.cjs').apply(input,selected);
}
module.exports = { VERSION: 'heartbeat-exploration-v3', suggest, DIRS, torusDistance, exitCells, certainExits, certainPortals, certainPortalLinks, chooseObjective, evaluateMove, buildPlan };
