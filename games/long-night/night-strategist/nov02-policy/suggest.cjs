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
const { E, T, A } = require('./kernel.cjs');
const {locateTarget,pursuitStep,routeTo,captureBatch}=require('./pursuit.cjs');
const {edgeState}=require('./movement.cjs');
const {chooseOpening}=require('./opening-random.cjs');
const {wallDirection,collisionMove,wallFinishPlan}=require('./finish-turn.cjs');
const {portalHeartbeatPause}=require('./heartbeat.cjs');
const {localExit,turnFacts}=require('./local-exit.cjs');
const {rankExploration}=require('./exploration.cjs');
const {targetCandidates,candidatePlan}=require('./candidate-pursuit.cjs');
const {saferRelocation}=require('./tactical-scout.cjs');
const {planExploration,applyPlan,failedProbeCounts}=require('./bounded-exploration.cjs');

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
  PORTAL: { score: -30, note: '传送门（需依据本局规则与出口反馈重新定位）' },
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

function certainPortals(solution,n,config={},observations=[]){
  const portals=new Map();
  if(config.portalChaos){for(const o of observations)if(o.kind==='portalLink')portals.set(E.key(o.r,o.c),{r:E.mod(o.r+o.dr,n),c:E.mod(o.c+o.dc,n)});return portals;}
  if(!solution||solution.irregular||!solution.phases?.length)return portals;
  for(let r=0;r<n;r++)for(let c=0;c<n;c++){
    const offsets=[];let valid=true;
    for(const p of solution.phases){
      const rr=E.mod(r-p.pr,n),cc=E.mod(c-p.pc,n),domain=p.domains[E.phaseAt(p,n,r,c).slot];
      for(const m of domain||[]){const cell=E.byId.get(m.id)?.cells[E.phaseAt(p,n,r,c).i];
        if(cell?.type!=='PORTAL'||!cell.portal){valid=false;break;}offsets.push(cell.portal.join(','));}
      if(!valid)break;
    }
    if(valid&&offsets.length&&new Set(offsets).size===1){const [dr,dc]=offsets[0].split(',').map(Number);portals.set(key(r,c),{r:E.mod(r+dr,n),c:E.mod(c+dc,n)});}
  }
  return portals;
}

function chooseObjective(from,target,ctx){
  const confirmedCapture=target?routeTo(from,target,{...ctx,confirmedOnly:true}):null;
  const capture=confirmedCapture?{...confirmedCapture,confirmed:true}:target?routeTo(from,target,ctx):null;
  let escape=null;
  for(const cell of ctx.exits.cells.keys()){
    const [r,c]=cell.split(',').map(Number);
    const confirmed=routeTo(from,{r,c},{...ctx,confirmedOnly:true});
    const route=confirmed||routeTo(from,{r,c},ctx);
    if(route?.direction!=null&&(!escape||route.cost<escape.cost))escape={...route,r,c,confirmed:!!confirmed};
  }
  // Same-cell capture remains immediate. Otherwise prefer a no-longer route
  // to a confirmed pod over speculative long-distance pursuit.
  const escapePreference=ctx.experiment?.escapePreference??1;
  const rating=ctx.input?require('../terminal-rating.cjs').assess(ctx.input,target,escape,capture):null;
  return {capture,escape,rating,kind:rating?.kind||(escape&&(!capture||escape.cost<=capture.cost*escapePreference)?'escape':capture?'pursue':null)};
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
    const hazard = HAZARD[types[0]] || { score: 0, note: types[0] };
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

function decide(input) {
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
  const traceRound=view.roundEnds.at(-1);
  const recentTrace=ambiguous&&(at.trace?.length||0)<=1
    ?require('./recent-ground-trace.cjs').recentGroundTrace(input,traceRound?traceRound.round+(traceRound.complete?1:0):1,{r,c}):null;
  const planningTrace=recentTrace?.trace||at.trace;
  if(recentTrace)basis.push('保留最近能确认没有传送的连续路线，用于减少重复绕路；不据此确定地图或敌人位置。');
  if (!solid) warnings.push('本人区块边界未锁定，方向建议仅供参考。');
  if (node && node.verification && node.verification.status === 'impossible') {
    warnings.push('已录入线索互相矛盾，地图搜索判定为不可能；先核对是否混入了别人的视角或缺回合。');
  } else if (node && node.verification && node.verification.status !== 'verified') {
    warnings.push('还没有通过验证的完整地图，方向建议只按已确定的边界给出。');
  }
  if (ambiguous) warnings.push(`有 ${view.ambiguities.length} 处传送/心跳待定，位置可能变化。`);
  if(view.localExit)warnings.push(`按第 ${view.localExit.exitStep} 步已出传送门的局部假设探索；不是全图定位，后续线索可推翻。`);
  if(input.recovery){warnings.push('已隔离多人定位信息；仅依据独立验证的本人地图行动');basis.push('多人拼接冲突仍保留，禁止依赖对手定位追捕；本人原始线索已独立重建并验证。');}
  else if (team && (team.conflict || (node && node.fusionConflict))){
    const soloFragments=built.count===1&&ambiguous&&verified&&!node.fusionConflict&&team.pairs?.length
      &&team.pairs.every(p=>p.a.startsWith(self+':')&&p.b.startsWith(self+':'));
    warnings.push(soloFragments?'单机传送片段尚未接通；只允许不依赖全图定位的单步探索。':'多人拼接存在冲突，其他玩家的信息未并入。');
  }

  const walls = E.inferredWalls(view.model.config, solution);
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
  const terrain = E.terrainPossibilities(solution, n);
  for(const o of at.observations||[])if(o.kind==='terrain'&&o.value)terrain.set(key(o.r,o.c),Array.isArray(o.value)?o.value:[o.value]);
  const scope = node ? T.mapScope(view.model.config, node, at.observations) : { visited: new Set((at.trace||[]).map(p=>key(p.r,p.c))), exposed: new Set() };
  const exits = {cells:certainExits(solution,n,scope.visited),samples:[]};
  const retiredExits=require('../progress-context.cjs').exitRetirements(input,exits,terrain);
  if (exits.cells.size) basis.push(`所有剩余区块候选一致的逃生舱位置 ${exits.cells.size} 个；舱是否已被他人使用需核验`);

  const wallKinds=require('./edge-kinds.cjs').edgeKinds(view.model.config,solution);
  const ctx = { n, walls, terrain, wallKinds, lastDirection:at.last, solution, visited: scope.visited, extraVisited: null, exits,portals:certainPortals(solution,n,view.model.config,at.observations),solo:built.count===1 };
  if(recentTrace)ctx.visited=new Set([...scope.visited,...recentTrace.trace.map(p=>key(p.r,p.c))]);
  Object.assign(ctx,retiredExits);
  // Explicit caller-only experiment parameters; the live bot never supplies them.
  ctx.experiment=input.experiment;
  ctx.input=input;
  const privateMovement=(view.model.config.roomRules?.['隐匿']??'关闭')!=='关闭'
    ||view.model.segments.some(s=>s.events.some(e=>e.hidden));
  ctx.publicTrace=privateMovement?[]:(planningTrace||[]).slice(1);
  ctx.silent=view.model.config.silent===true;
  ctx.brawl=view.model.config.brawl===true;
  if(view.model.config.event==='AMBUSH')for(const [k,types] of terrain)terrain.set(k,types.map(t=>t==='BERRY'?'TRAP':t));
  ctx.publicFootprint=require('./public-footprint.cjs').publicFootprint({n,
    blocks:node?.verification?.blocks,trace:planningTrace||[],solo:ctx.solo,
    verified:verified&&solid&&!ambiguous&&!team?.conflict&&!node?.fusionConflict,
    privateMovement});
  for(const o of at.observations||[])if(['hit','pass'].includes(o.kind)){
    if(wallKinds.get(key(o.r,o.c)+':'+o.dir)?.includes(2))continue;
    const value=o.kind==='hit'?'墙':'空';walls.set(key(o.r,o.c)+':'+o.dir,value);
    walls.set(key(E.mod(o.r+E.V[o.dir][0],n),E.mod(o.c+E.V[o.dir][1],n))+':'+[1,0,3,2][o.dir],value);
  }
  const projection=input.projection!==undefined?input.projection:require('../silent-projection.cjs').silentProjection({node,view,team,config:view.model.config,built,routes:require('../silent-projection.cjs').publicRoutes(input.journal)});
  const projected=require('../silent-projection.cjs').currentPositions(projection,built,(view.roundEnds.at(-1)?.round||0)+(view.roundEnds.at(-1)?.complete?1:0)||1);
  let target=locateTarget(input);
  if(!target&&projected?.positions.length===1&&projected.target===A.status(built).find(p=>p.id===self)?.target){
    target={target:projected.target,...projected.positions[0],round:projected.round,source:'silent-layouts',edges:[]};
    basis.push('静音完整候选回放的唯一敌位已接入追捕比较。');
  }
  if(target)for(const edge of target.edges){
    walls.set(key(edge.r,edge.c)+':'+edge.dir,edge.value);
    walls.set(key(E.mod(edge.r+E.V[edge.dir][0],n),E.mod(edge.c+E.V[edge.dir][1],n))+':'+[1,0,3,2][edge.dir],edge.value);
  }
  const doorRound=view.roundEnds.at(-1);
  const currentRound=doorRound?doorRound.round+(doorRound.complete?1:0):1;
  require('../door-state.cjs').applyDoors(Object.assign(ctx,{
    config:view.model.config,node,at,self,round:currentRound,
    steps:turnFacts(input.journal,self,currentRound).steps
  }),input.board);
  const moves = DIRS.map((dir) => evaluateMove({ r, c }, dir, ctx));
  // Keep local failure history even when unresolved portal frames prevent the
  // bounded planner from finding a frontier. This is only a tie-break, not a wall.
  const failedProbes=failedProbeCounts(at.observations,n);
  for(const move of moves){
    const edge=edgeState({r,c},move.dirIndex,ctx,at.last);
    move.failedProbeCount=edge.wall==='空'&&!edge.uncertain?0:(failedProbes.get(key(r,c)+':'+move.dirIndex+':'+Number(at.last===move.dirIndex))||0);
  }
  // Penalize repeated traversals, not merely whether a cell was ever visited.
  const visits=new Map();for(const p of planningTrace||[])visits.set(key(p.r,p.c),(visits.get(key(p.r,p.c))||0)+1);
  const previous=planningTrace?.at(-2);
  for(const move of moves)if(!move.blocked){
    const repeated=visits.get(key(move.to.r,move.to.c))||0;
    if(repeated){move.score-=18*repeated;move.reasons.push(`重复经过 ${repeated} 次，降低折返优先级`);}
    if(previous?.r===move.to.r&&previous?.c===move.to.c){move.score-=12;move.reasons.push('避免立即原路折返');}
  }
  const lastOwn=view.roundEnds.at(-1);
  const ownRound=lastOwn ? lastOwn.round+(lastOwn.complete?1:0) : 1;
  const turnEvents=view.model.segments.flatMap(s=>s.events).filter(e=>e.kind==='move'&&e.clock?.round===ownRound);
  const facts=turnFacts(input.journal,self,ownRound);
  const turnSteps=Math.max(facts.steps,view.localExit?.steps||0,...turnEvents.map(e=>e.clock.step),0);
  ctx.round=ownRound;
  const diagnosticLoop=require('./local-exit.cjs').unresolvedLoop(facts.moves);
  const diagnostic=require('./portal-diagnostic.cjs').portalDiagnostic(input);
  if(diagnostic&&(!diagnosticLoop||diagnostic.commands[0]!==diagnosticLoop.commands[0])){
    const primary=moves.find(m=>m.dirIndex===diagnostic.commands[0]&&!m.blocked);
    if(primary){primary.score=diagnostic.score;primary.reasons.unshift(`辨别传送：计划 ${diagnostic.commands.map(d=>DIRS[d].arrow).join('')}；地面分支走已确认空地，传送分支推进到出口，比较出口声与无声反馈后继续探索`);
      return {ok:true,position:{r,c,segment:view.model.active,unique:false},moves,primary,alternatives:[],plan:null,tactic:{kind:'portal-diagnostic',...diagnostic},warnings,basis,confidence:'medium'};}
  }
  const commandLoop=ambiguous?require('./local-exit.cjs').unresolvedLoop(facts.moves):null;
  if(commandLoop)for(const move of moves)if(move.dirIndex===commandLoop.commands[0])move.loopBlocked=true;
  // Continue through branch risk and exploration scoring before choosing a
  // different direction. Returning here bypassed both and repeatedly chose up.
  if(lastOwn?.inSpace&&lastOwn.locatable!==false&&!ambiguous&&!warnings.some(w=>/矛盾|冲突/.test(w))){
    const portalExit=ctx.portals.get(key(r,c));
    const exitObjective=portalExit?chooseObjective(portalExit,ownRound>1?target:null,ctx):null;
    // The referee leaves a player at the entry cell until the second transit
    // move. Stopping there still runs point-capture; moving cannot hit a wall.
    const sameEntry=ownRound>1&&solid&&target&&target.r===r&&target.c===c
      &&['aligned-map','same-cell-sound'].includes(target.source)
      &&(view.model.config.roomRules?.隐匿??'关闭')==='关闭';
    const entryRating=sameEntry?require('../terminal-rating.cjs').assess(input,target,exitObjective?.escape,{confirmed:true,cost:0}):null;
    if(sameEntry&&entryRating?.kind!=='escape')return {ok:true,position:{r,c,segment:view.model.active,unique:true},moves,
      primary:{direction:'stop',label:'停止并捕捉',arrow:'■',to:{r,c},blocked:false,score:1000,reasons:['亚空间内仍与已定位目标同格；主动停止立即触发捕捉，继续移动会离开入口'],gains:[],risks:[]},
      alternatives:[],plan:null,tactic:{kind:'finish-capture',round:ownRound,steps:turnSteps,target,stopException:'capture-no-wall',inSubspace:true,rating:entryRating},warnings,basis,confidence:'medium'};
    const urgentExit=entryRating?.kind==='escape'?'escape':exitObjective?.kind;
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
  const localSteps=turnEvents.filter(e=>e.outcome==='move').length;
  const turnTrace=recentTrace?.trace||(at.trace||[]).slice(-(localSteps+1));
  const objective=chooseObjective({r,c},ownRound>1?target:null,ctx);
  if(objective.rating?.available)basis.push('等级分按终局名次比较：逃生名次值区间 '+objective.rating.escape.join('～')+'；最后一抓 '+objective.rating.capture.join('～')+'。'+objective.rating.reason);
  else if(objective.escape&&objective.capture)basis.push('等级分比较暂不可用：'+objective.rating?.reason+'；当前路线选择不代表等级分最优。');
  const candidates=!target?targetCandidates(input,ownRound):null;
  const hunt=!ambiguous&&!warnings.some(w=>/矛盾|冲突/.test(w))?candidatePlan({r,c},candidates,ctx,{round:ownRound,steps:turnSteps}):null;
  if(candidates)basis.push(`${candidates.target} 号在本人坐标系有 ${candidates.positions.length} 个兼容位置候选${hunt?'，已评估追击路线':ownRound===1?'，首轮保护不追捕':'，当前无合适追击路线，保留候选继续获取线索'}。`);
  const preferEscape=objective.kind==='escape'&&(!hunt||objective.escape.cost<=hunt.cost);
  if(preferEscape&&!ambiguous&&!warnings.some(w=>/矛盾|冲突/.test(w))){
    const route=objective.escape,primary=moves.find(m=>m.dirIndex===route.direction);
    const batchEscape=verified&&solid&&route.confirmed&&route.commands.length>1&&!ctx.brawl
      &&(ctx.solo||view.model.config.roomRules?.点杀!=='关闭')
      &&!A.status(built).some(p=>!p.alive&&/逃生/.test(p.reason||''))
      ?{confirmed:true,target:{r:route.r,c:route.c},commands:route.commands.map(d=>'上下左右'[d]).join('')}:null;
    if(batchEscape)primary.reasons.unshift('整条逃生通路已核验，一次发送 '+batchEscape.commands);
    primary.reasons.unshift(`前往已确定的逃生舱位置：路线代价 ${route.cost}${objective.capture?`，追捕路线代价 ${objective.capture.cost}`:'，当前没有可执行的确定追捕路线'}`);
    return {ok:true,position:{r,c,segment:view.model.active,unique:solid,blockCandidates:[...candidatesAt(solution,n,r,c)]},moves,primary,alternatives:[],plan:null,
      tactic:{kind:'escape',round:ownRound,steps:turnSteps,destination:{r:route.r,c:route.c},routeCost:route.cost,captureCost:objective.capture?.cost??null,rating:objective.rating,...(batchEscape?{batchEscape}:{})},warnings,basis,confidence:'medium'};
  }
  if(ownRound>1 && target && !warnings.some(w=>/矛盾|冲突/.test(w))){
    const same=target.r===r&&target.c===c;
    const batchCapture=!same&&ownRound>1?captureBatch({r,c},target,ctx):null;
    const direction=same?wallDirection({r,c},ctx):batchCapture?batchCapture.direction:pursuitStep({r,c},target,ctx);
    const primary=direction==null?(same?{direction:'stop',label:'停止并捕捉',arrow:'■',to:{r,c},blocked:false,score:1000,reasons:[],gains:[],risks:[]}:null):moves.find(m=>m.dirIndex===direction);
    if(primary||same){
      if(primary&&!same){
        primary.reasons=primary.reasons.filter(reason=>!/重复经过|折返|走过的格子/.test(reason));
        if(batchCapture)primary.reasons.unshift(`完整追捕路线已确认：一次发送 ${batchCapture.commands}，${batchCapture.finish?'末步原地撞墙触发捕捉':'抵达后核验反馈并结束行动捕捉'}`);
      }
      if(primary){primary.score=1000;primary.reasons.unshift(same?(primary.direction==='stop'?'已与捕捉目标同格，主动停止触发点杀':'已与捕捉目标同格，主动撞墙结束行动触发点杀'):`优先接近已定位的 ${target.target} 号目标`);if(same&&primary.direction!=='stop'){primary.intentionalCollision=true;primary.to={r,c};}}
      return {ok:true,position:{r,c,segment:view.model.active,unique:solid,blockCandidates:[...candidatesAt(solution,n,r,c)]},moves,primary,alternatives:[],plan:null,
        tactic:{kind:same?'finish-capture':'pursue',round:ownRound,target,rating:objective.rating,...(same&&primary?.direction==='stop'?{stopException:'capture-no-wall'}:{}),...(batchCapture?{batchCapture}: {})},warnings,
        basis:[...basis,'同格声/地图对齐与目标后续轨迹用于追捕；首轮捕捉受保护，不保证淘汰。'],confidence:'medium'};
    }
  }
  const exposed=!view.model.config.silent&&facts.exposed;
  const lastMove=facts.moves.at(-1);
  const exposedAtSource=!!(exposed&&lastMove?.outcome==='move'&&lastMove.sound&&!lastMove.masked&&!lastMove.firstSound&&!['首次','被屏蔽'].includes(lastMove.direction));
  // A candidate hunt must not bypass the ordinary planner's safe-departure
  // rule after broadcasting our current location. Confirmed goals above keep
  // priority; unresolved targets go through the same source-risk evaluation.
  if(candidates?.positions.length>1&&!exposedAtSource&&!ambiguous&&!warnings.some(w=>/矛盾|冲突/.test(w))){
    const quietSearch=planExploration({r,c},moves,{...ctx,heartPresence:view.model.config.heartPresence===true},
      {trace:turnTrace,steps:turnSteps,exposed:!ctx.silent&&facts.exposed});
    const quiet=quietSearch.plans.find(p=>p.noiseCost===0&&p.switchCost===0&&!p.possiblePortal&&!p.uncertainReturn);
    if(quiet){
      const primary=moves.find(m=>m.dirIndex===quiet.direction);
      applyPlan(primary,quiet,quietSearch.search);
      primary.reasons.unshift('敌位仍有多个候选：优先沿安静路线探索新信息，不为试抓候选支付已知发声代价');
      return {ok:true,position:{r,c,segment:view.model.active,unique:solid},moves,primary,alternatives:[],plan:null,
        tactic:{kind:'quiet-exploration-before-candidates',round:ownRound,steps:turnSteps,candidates,destination:quiet.destination,search:quietSearch.search},warnings,basis,confidence:'medium'};
    }
  }
  if(hunt&&!exposedAtSource){
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
      primary.reasons.push('候选试抓仅沿整段已确认安静且不触发按钮的路线；需要发声的候选不尝试');
      return {ok:true,position:{r,c,segment:view.model.active,unique:solid,blockCandidates:[...candidatesAt(solution,n,r,c)]},moves,primary,alternatives:[],plan:null,
        tactic:{kind:hunt.kind,...(primary.direction==='stop'?{stopException:'capture-no-wall'}:{}),round:ownRound,steps:turnSteps,target:candidates.target,destination:hunt.destination,routeCost:hunt.cost,candidates,escapeCost:objective.escape?.cost??null},warnings,basis:[...basis,candidates.source==='sound-endpoint'?'对手发声后仅撞墙未再移动：按听声方位与全部地形候选收窄终点；前段传送待定不阻止候选追捕，仍可能扑空。':'追击使用双方当前片段的完整相对位置候选，不使用截断整图样本频率；每步新线索重新规划。'],confidence:'medium'};
    }
  }
  const masked=view.model.config.heartPresence===true&&!view.model.config.silent&&turnSteps<19&&turnSteps%3===0;
  rankExploration(moves,{r,c},ctx,{visits,previous,trace:turnTrace,round:ownRound,masked,silent:view.model.config.silent,exposed,steps:turnSteps,visitMemoryOnly:!!recentTrace});
  // An emergence command advances the portal timer, not a ground edge.
  const justEmerged=view.localExit?.round===ownRound&&view.localExit.exitStep===turnSteps;
  if(justEmerged)for(const move of moves){
    const wallBlocks=view.localExit.walls?.[move.dirIndex];
    if(!move.blocked&&wallBlocks?.length){
      move.score-=12;
      move.risks.push(`传送出口候选区块 ${wallBlocks.join('、')} 在该方向有固定墙，撞墙会交出行动权`);
    }
  }
  if(ambiguous&&!justEmerged)for(const move of moves){
    if(move.dirIndex===[1,0,3,2][lastMove?.dir]){
      move.score-=16;
      move.reasons.push('位置待定时仍保留指令历史，降低立即反向造成原地往返的优先级');
    }
  }
  // Direction-only repetition is useful only while the position is ambiguous.
  // With a known position, bounded exploration tracks visited cells and edges;
  // the same direction can still advance to a new informative cell.
  require('./branch-exploration.cjs').constrainBranchExploration(moves,input);
  if(ownRound===1&&!ambiguous&&!team?.conflict)require('./opening-objective.cjs').rankOpening(moves,{r,c},ctx,candidates);
  const tacticalSafe=!ambiguous&&!warnings.some(w=>/矛盾|冲突/.test(w));
  const hunterId=A.status(built).find(p=>p.id===self)?.hunter;
  ctx.hunters=tacticalSafe&&hunterId!=null&&hunterId!==self?targetCandidates(input,ownRound,hunterId):null;
  ctx.heartPresence=view.model.config.heartPresence===true;
  let explorationSearch=null;
  // Unresolved older teleport frames do not invalidate observations in the
  // current local frame. Explore locally; pursuit still requires alignment.
  if(!warnings.some(w=>/矛盾|冲突/.test(w))&&(tacticalSafe||at.trace?.length>1&&at.observations?.some(o=>['walls','pass','hit'].includes(o.kind)))){
    let exploration=planExploration({r,c},moves,ctx,{trace:turnTrace,steps:turnSteps,exposed,exposedAtSource});
    // Previously traversed corridors may be the only way out of a dead end.
    // Only accept retracing when it reaches a different informative frontier.
    if(!exploration.best)exploration=planExploration({r,c},moves,{...ctx,allowRetrace:true},{trace:turnTrace,steps:turnSteps,exposed,exposedAtSource});
    explorationSearch=exploration.search;
    for(const m of moves)if(!m.blocked){
      const plan=exploration.plans.find(p=>p.direction===m.dirIndex);
      if(plan)applyPlan(m,plan,exploration.search);
      else {m.score=-1000;m.reasons=['受限搜索内没有找到经此方向可接近的有效探索终点'];m.gains=[];}
    }
    if(exploration.best){
      const ranked=exploration.plans.map(p=>moves.find(m=>m.dirIndex===p.direction));
      const tied=ranked.filter(m=>m.score===ranked[0].score&&(!exploration.best.leaveSoundSource||m.evaluation?.safeDeparture));
      const selected=chooseOpening(tied,{journal:input.journal,self,round:ownRound,steps:turnSteps});
      ranked.splice(ranked.indexOf(selected),1);ranked.unshift(selected);
      if(selected.score<=0)selected.reasons.push('仍有真实探索终点；按行动限制继续探路，不用低分作为撞已知墙或停止的理由');
      return {ok:true,position:{r,c,segment:view.model.active,unique:solid},moves,primary:ranked[0],alternatives:ranked.slice(1,3),plan:null,
        tactic:{kind:'bounded-exploration',round:ownRound,steps:turnSteps,destination:selected.explorationTarget,stopUtility:exploration.stopUtility,search:exploration.search},
        warnings,basis:[...basis,'探索按终点价值减路线和暴露风险排序；最多一个未知终点，不枚举整图，逐步反馈重算。'],confidence:'medium'};
    }
  }
  const directionCounts=[0,0,0,0];for(const e of facts.moves.length?facts.moves:turnEvents)if(e.dir!=null)directionCounts[e.dir]++;
  for(const move of moves)move.commandCount=directionCounts[move.dirIndex];
  const loopPrevented=moves.some(m=>!m.blocked&&m.explorationForbidden);
  if(loopPrevented)warnings.push('已排除重复的无目的探索边及待定位分支中的旧墙风险；取信息后的首次返回仍允许。');
  const open = moves.filter((m) => !m.blocked&&!m.loopBlocked&&!m.explorationForbidden).sort((a, b) => b.score - a.score || (a.failedProbeCount||0)-(b.failedProbeCount||0) || directionCounts[a.dirIndex]-directionCounts[b.dirIndex]);
  if((tacticalSafe||(ownRound>1||loopPrevented)&&turnSteps>=2)&&(!open.length||open[0].score<=0)){
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
      tactic:{kind:'finish-exploration',round:ownRound,steps:turnSteps,loopPrevented,exhausted:true,policy:explorationSearch?'bounded-exploration-v1':undefined,search:explorationSearch,finishMethod:wallFinish.method,destination:wallFinish.destination},warnings,basis,confidence:'medium'};
    return {ok:true,position:{r,c,segment:view.model.active,unique:solid,blockCandidates:[...candidatesAt(solution,n,r,c)]},moves,
      primary:{direction:'stop',label:'停止',arrow:'■',to:{r,c},blocked:false,score:-safety.stop.penalty,reasons:['例外停止：已探索，受限搜索内没有不重复的可接受新格路线，也没有更安全的安静换位'],gains:[],risks:[safety.stop.reason,'停止会交出行动权，不保证当前位置安全']},
      alternatives:[],plan:null,tactic:{kind:'finish-exploration',round:ownRound,steps:turnSteps,loopPrevented,exhausted:true,policy:explorationSearch?'bounded-exploration-v1':undefined,search:explorationSearch,stopException:'no-safe-wall-route',stopAssessment:safety.stop},warnings:[...warnings,...(loopPrevented?['禁止无目的往返；未找到可继续探索的路线，例外结束行动。']:[])],basis,confidence:'medium'};
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
 const s=decide(input);
 if(!s?.ok)return s;
 const blockHypotheses=require('./path-blocks.cjs').pathBlocks(input);
 return {...s,blockHypotheses,basis:[...(s.basis||[]),...(blockHypotheses.collisionHypotheses||[]).map(h=>`${h.player}号：${h.reason}`),'先保留各玩家当前路径的区块解释，再比较可验证反馈；未定区块不作为确定位置，区块候选数量不表示概率。']};
}
module.exports = { suggest, DIRS, torusDistance, exitCells, certainExits, certainPortals, chooseObjective, evaluateMove, buildPlan };
