'use strict';
/**
 * Result shaping: one structured report (JSON, for part1 and tests) and two
 * renderings (a detailed console text and a compact QQ reply).
 */
const { E, M, T, A, MODE_NAMES, DATA, poolSource } = require('./kernel.cjs');
const { suggest } = require('./suggest.cjs');

const DIR_LABEL = { up: '向上', down: '向下', left: '向左', right: '向右' };

function collectQuestions(journal, config, team, built) {
  const rows = [];
  const push = (kind, list) => {
    for (const item of list || []) rows.push({ kind, ...item });
  };
  try { push('direction', M.informationQuestions(journal.messages, config)); } catch { /* optional */ }
  if (team) {
    try { push('door', T.extraInformationQuestions(config, team, built)); } catch { /* optional */ }
    try { push('coin', T.coinQuestions(config, team, built)); } catch { /* optional */ }
  }
  return rows.map((row) => ({
    kind: row.kind,
    player: row.player,
    round: row.round,
    step: row.step,
    prompt: row.prompt || row.text || '',
  }));
}

function relativeToBirth(node, r, c, n) {
  if (!node || !node.birth) return null;
  const delta = (x) => (E.mod(x, n) > n / 2 ? E.mod(x, n) - n : E.mod(x, n));
  return { dr: delta(r - node.birth.r), dc: delta(c - node.birth.c) };
}

function describeRelative(rel) {
  if (!rel) return '';
  const parts = [];
  if (rel.dr) parts.push(`${rel.dr > 0 ? '下' : '上'}${Math.abs(rel.dr)}格`);
  if (rel.dc) parts.push(`${rel.dc > 0 ? '右' : '左'}${Math.abs(rel.dc)}格`);
  return parts.join('、') || '与出生同格';
}

function playerBoard(view, node, config, segmentIndex = view.model.active) {
      const n = config.size;
      const segment = view.model.segments[segmentIndex];
      const replay = E.replay(segment, n);
      const visited = new Set((replay.trace || []).map(p=>E.key(p.r,p.c)));
      const cells = [];
      for (let r = 0; r < n; r++) {
        const row = [];
        for (let c = 0; c < n; c++) row.push({ visited:visited.has(E.key(r,c)), birth:segmentIndex===0 && r===Math.floor(n/2) && c===Math.floor(n/2), u: null, d: null, l: null, r: null, terrain: [], sound: null });
        cells.push(row);
      }
      for (const o of (node?.walkingObservations || node?.mergedObservations || replay.observations)) {
        const cell = cells[o.r] && cells[o.r][o.c];
        if (!cell) continue;
        if (o.kind === 'walls' && typeof o.value === 'string' && o.value.length === 4) {
          cell.u = o.value[0] === '?' ? null : o.value[0];
          cell.d = o.value[1] === '?' ? null : o.value[1];
          cell.l = o.value[2] === '?' ? null : o.value[2];
          cell.r = o.value[3] === '?' ? null : o.value[3];
        } else if (o.kind === 'terrain' && o.value) {
          const list = Array.isArray(o.value) ? o.value : [o.value];
          for (const t of list) if (t && !cell.terrain.includes(t)) cell.terrain.push(t);
        } else if (o.kind === 'sound' && o.value) {
          cell.sound = o.value;
        }
      }
      // A collision is a direct edge observation, even without four-wall DM
      // or a unique block alignment. Keep it in each segment's own coordinates.
      for (const o of replay.observations) {
        if (!['hit','pass'].includes(o.kind)) continue;
        const edge=['u','d','l','r'][o.dir], opposite=['d','u','r','l'][o.dir];
        const delta=[[-1,0],[1,0],[0,-1],[0,1]][o.dir];
        const cell=cells[o.r]?.[o.c]; if(!cell)continue;
        cell[edge]=o.kind==='hit'?'墙':'空';
        const neighbor=cells[E.mod(o.r+delta[0],n)][E.mod(o.c+delta[1],n)];
        neighbor[opposite]=cell[edge];
        if(o.kind==='hit'){
          (cell.collisions ||= {})[edge]=true;
          (neighbor.collisions ||= {})[opposite]=true;
        }
      }
      const solution = node && node.solution;
      const usable = solution && !solution.irregular && solution.phases.length && node.verification?.status !== 'impossible';
      if (usable) {
        const inferred = E.inferredWalls(config, solution);
        const terrain = E.terrainPossibilities(solution, n);
        const knownBlocks=node.verification?.blocks || [];
        const doorModel=require('./door-state.cjs').currentDoors(config,solution,knownBlocks,node.walkingObservations||node.mergedObservations||replay.observations);
        const doors=new Map([...doorModel.edges].map(([edge,id])=>[edge,doorModel.doors.get(id)]));
        const kinds=require('./edge-kinds.cjs').edgeKinds(config,solution);
        for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
          const cell = cells[r][c];
          const block=knownBlocks.find(b=>E.mod(r-b.origin.r,n)<3&&E.mod(c-b.origin.c,n)<3);
          if(block)cell.attach=E.byId.get(block.id)?.cells[E.mod(r-block.origin.r,n)*3+E.mod(c-block.origin.c,n)]?.attach||null;
          cell.inferred = {}; cell.doors={};cell.wallKinds={};
          ['u','d','l','r'].forEach((key,d) => {
            const edge=E.key(r,c)+':'+d;
            if(doors.has(edge))cell.doors[key]=doors.get(edge);
            const kind=kinds.get(edge);if(kind?.length===1)cell.wallKinds[key]=kind[0];
            if(kind?.length===1&&kind[0]===2)cell[key]='空';
            const wall = inferred.get(edge);
            if (cell[key] == null && wall) { cell[key]=wall; cell.inferred[key]=true; }
            // The diagram and planner share the same current switch state;
            // an old collision is not a permanent wall after a button press.
            if(doors.has(edge)){
              const state=doors.get(edge).state;cell[key]=state==='open'?'空':state==='closed'?'墙':null;
              if(state==='unknown')delete cell.wallKinds[key];else cell.wallKinds[key]=state==='open'?4:3;
              if(cell.collisions)delete cell.collisions[key];cell.inferred[key]=true;
            }
          });
          if (!cell.terrain.length) { cell.terrain = terrain.get(E.key(r,c)) || []; cell.inferredTerrain = true; }
          // Certification rules out every alternative placement. The broader
          // terrain domains can still include blocks left over from local matching.
          if(block?.id==='51'&&node.verification.status==='verified'&&!node.fusionConflict&&!node.routePending){
            cell.heartRoom=true;
            const local=E.mod(r-block.origin.r,n)*3+E.mod(c-block.origin.c,n);
            if(cell.inferredTerrain)cell.terrain=[E.byId.get('51').cells[local].type];
          }
        }
      }
      for(const {r,c,d} of require('./reported-walls.cjs').reportedClosed(replay,n).values()){
        const cell=cells[r][c],side=['u','d','l','r'][d];
        cell[side]='墙';
        if(cell.wallKinds?.[side]===2)delete cell.wallKinds[side];
      }
      return {
        n,
        frameId:node?.id||null,
        joined:node?.verification?.status==='verified'&&!node.fusionConflict&&!node.routePending?(node.joined||[]):[],
        verified:node?.verification?.status==='verified'&&!node.fusionConflict&&!node.routePending,
        alignment: solution?.phases?.length ? {rowOffset:solution.phases[0].pr,colOffset:solution.phases[0].pc,confirmed:solution.phases.length===1} : null,
        position: { r: replay.r, c: replay.c },
        cells,
        blocks: ((node && node.verification && node.verification.blocks) || []).map((b) => ({ id: b.id, name: (E.byId.get(b.id) || {}).name || '', origin: b.origin })),
      };
}

function buildReport({ journal, built, team, heartbeatPaddingRound }) {
  const recovered=require('./local-recovery.cjs').localRecovery({journal,built,team});
  ({built,team}=recovered);
  ({built,team}=require('./local-exit.cjs').localExit({journal,built,team}));
  const routes=require('./silent-projection.cjs').publicRoutes(journal);
  const self = built.self;
  const view = built.views[self];
  const config = view.model.config;
  const node = team && team.nodes ? team.nodes.find((x) => x.id === `${self}:${view.model.active}`) : null;
  const projection=recovered.recovery?null:require('./silent-projection.cjs').silentProjection({node,view,team,config,built,routes});
  const board=playerBoard(view,node,config);
  if(projection)board.opponentProjection=projection;
  const decision = suggest({ built, team, journal,board,projection,recovery:recovered.recovery,heartbeatPaddingRound });
  if(projection){
    const tactic=decision.tactic;
    if(tactic?.target?.source==='silent-layouts'||tactic?.candidates?.source==='silent-layouts')
      board.projectionUse=({pursue:'按此落点追捕','finish-capture':'到达捕捉格','pursue-candidates':'逐步追击候选',
        'attempt-capture':'在候选格尝试捕捉','target-scout':'向目标附近探路'})[tactic.kind];
  }
  const status = (() => { try { return A.status(built); } catch { return []; } })();
  const me = status.find((row) => row.id === self) || null;
  const advice = (() => { try { return A.summarize(built, team); } catch { return []; } })();
  const probes = (() => { try { return A.perspective(built, team, self); } catch { return []; } })();
  const positionRel = relativeToBirth(node, decision.position ? decision.position.r : 0, decision.position ? decision.position.c : 0, config.size);
  const layouts = node && node.completeLayouts ? node.completeLayouts : null;
  const rounds = new Set();
  for (const message of journal.messages) for (const hit of String(message.text).matchAll(/第\s*(\d+)\s*回合/g)) rounds.add(Number(hit[1]));
  for (const end of view.roundEnds || []) if (end && end.round != null) rounds.add(Number(end.round));
  return {
    ok: true,
    recovery:recovered.recovery||null,
    self,
    settings: {
      mode: config.mode,
      modeName: MODE_NAMES[config.mode] || config.mode,
      players: built.count,
      size: config.size,
      pool: config.pool,
      poolCount: config.pool ? config.pool.split(/\s+/).filter(Boolean).length : 0,
      poolSource: poolSource(config),
      exitCount: config.exitCount,
      event: config.event,
      silent: !!config.silent,
    },
    progress: {
      messages: journal.messages.length,
      rounds: [...rounds].sort((a, b) => a - b),
      pendingRounds: view.pending,
      ambiguities: view.ambiguities.length,
      segment: view.model.active,
      segments: view.model.segments.length,
    },
    status: me,
    position: decision.position ? { ...decision.position, relative: positionRel, relativeText: describeRelative(positionRel) } : null,
    blocks: {
      determined: ((node && node.verification && node.verification.blocks) || []).map((b) => ({ id: b.id, name: (E.byId.get(b.id) || {}).name || '', origin: b.origin })),
      candidatesHere: (decision.position && decision.position.blockCandidates) || [],
      poolSize: config.pool ? config.pool.split(/\s+/).filter(Boolean).length : 0,
    },
    maps: layouts ? {
      status: layouts.status,
      count: (layouts.layouts || []).length,
      complete: !!layouts.complete,
      overflow: !!layouts.overflow,
      irregular: !!(node && node.solution && node.solution.irregular),
    } : { count: 0, complete: false },
    slots: (() => {
      const solution = node && node.solution;
      if (!solution || solution.irregular || !solution.phases.length) return [];
      const phase = solution.phases[0];
      return phase.slots.map((slot, i) => ({
        r: slot.r, c: slot.c,
        ids: (phase.domains[i] || []).map((m) => m.id),
        count: (phase.domains[i] || []).length,
      }));
    })(),
    verification: node && node.verification ? { status: node.verification.status } : { status: 'unknown' },
    board,
    players: built.views.map((v) => {
      const own = team?.nodes?.find(x => x.id === `${v.id}:${v.model.active}`);
      const solution = own?.solution;
      const phase = solution && !solution.irregular ? solution.phases[0] : null;
      return {
        id:v.id, self:v.id===self, segment:v.model.active,
        routes:[...routes.values()].filter(r=>r.player===v.id),
        segments:v.model.segments.map((segment,index)=>({index,name:segment.name,active:index===v.model.active,transition:segment.transition||null,board:v.id===self&&index===v.model.active?board:playerBoard(v,team?.nodes?.find(n=>n.id===`${v.id}:${index}`),v.model.config,index)})),
        status:status.find(x=>x.id===v.id) || null,
        ambiguities:v.ambiguities?.length || 0,
        verification:own?.verification?.status || 'unknown',
        board:v.id===self?board:playerBoard(v,own,v.model.config),
        slots:phase ? phase.slots.map((slot,i)=>({r:slot.r,c:slot.c,ids:(phase.domains[i]||[]).map(m=>m.id),count:(phase.domains[i]||[]).length})) : [],
      };
    }),
    suggestion: decision,
    questions: collectQuestions(journal, config, team, built),
    advice,
    probes,
  };
}

/** Most decision-relevant sentence first; chatter like "该侧已确认可通行" last. */
function rankWhy(item) {
  if (/逃生舱/.test(item) && !/远/.test(item)) return 0;
  if (/收窄|候选整图|候选区块|未知|没走过/.test(item)) return 1;
  if (/风险|陷阱|热源|传送|心脏/.test(item)) return 3;
  if (/已确认可通行|地形确定为空地/.test(item)) return 5;
  if (/走过的格子|离逃生舱远|墙壁未知/.test(item)) return 6;
  return 2;
}

function pickWhy(move, limit = 2) {
  if (!move) return '';
  const all = [...new Set([...(move.reasons || []), ...(move.gains || [])])].filter((x) => x && !/^该侧/.test(x));
  return all.sort((a, b) => rankWhy(a) - rankWhy(b)).slice(0, limit).join('；');
}

function fmtMove(move) {
  if (!move) return '';
  const why = pickWhy(move, 3);
  return `${move.arrow} ${move.label}${why ? '：' + why : ''}`;
}

function fmtIds(ids, max = 4) {
  if (!ids || !ids.length) return '未知';
  if (ids.length <= max) return ids.join('/');
  return `${ids.length} 种（${ids.slice(0, 3).join('/')}…）`;
}

function renderText(report) {
  const out = [];
  const s = report.settings;
  out.push(`【长夜·推理】本人 ${report.self}号 · ${s.modeName} ${s.players}人 · ${s.size}×${s.size}${s.silent ? ' · 静音' : ''}`);
  out.push(`进度：消息 ${report.progress.messages} 条 · 回合 ${report.progress.rounds.join('/') || '—'} · 区块池 ${s.poolCount} 块${s.poolSource === 'auto' ? '（自动：该模式全池）' : ''} · 已确定区块 ${report.blocks.determined.length}`);
  if (report.position) {
    const p = report.position;
    out.push(`位置：第 ${p.r + 1} 行 第 ${p.c + 1} 列${p.relativeText ? `（相对出生 ${p.relativeText}）` : ''} · 本格区块候选 ${fmtIds(p.blockCandidates)}`);
  }
  if (report.maps.count) out.push(`整图：${report.maps.count} 张候选${report.maps.complete ? '（已穷举）' : '（未穷举）'}`);
  const pending = [];
  if (report.progress.pendingRounds.length) pending.push(`第 ${report.progress.pendingRounds.join('、')} 回合缺本人四墙`);
  if (report.progress.ambiguities) pending.push(`${report.progress.ambiguities} 处传送/心跳待定`);
  if (report.questions.length) pending.push(`${report.questions.length} 条线索待核对`);
  if (pending.length) out.push(`待补：${pending.join('；')}`);
  const sg = report.suggestion;
  if (sg && sg.ok && sg.primary) {
    out.push('');
    out.push(`建议（${sg.confidence === 'high' ? '较有把握' : sg.confidence === 'medium' ? '中等把握' : '仅供参考'}）：${fmtMove(sg.primary)}`);
    for (const alt of sg.alternatives || []) out.push(`  备选：${fmtMove(alt)}`);
    for (const risk of [...new Set(sg.primary.risks)]) out.push(`  风险：${risk}`);
    for (const warning of sg.warnings) out.push(`  注意：${warning}`);
    if (sg.basis.length) out.push(`  依据：${sg.basis.join('；')}`);
  } else if (sg && sg.ok) {
    out.push('');
    for (const warning of sg.warnings) out.push(`注意：${warning}`);
  } else if (sg && sg.reason) {
    out.push('');
    out.push(`暂无建议：${sg.reason}`);
  }
  if (report.probes.length) {
    out.push('');
    out.push('补线索：');
    for (const line of report.probes.slice(0, 3)) out.push(`  · ${line}`);
  }
  if (report.questions.length) {
    out.push('');
    out.push('待核对：');
    for (const q of report.questions.slice(0, 5)) out.push(`  · ${q.prompt}`);
  }
  return out.join('\n');
}

function renderQQ(report, options = {}) {
  const limit = options.limit || 900;
  const s = report.settings;
  const lines = [];
  lines.push(`【长夜·${report.self}号 ${s.modeName}${s.players}人】回合 ${report.progress.rounds.slice(-1)[0] ?? '—'}`);
  const sg = report.suggestion;
  if (sg && sg.ok && sg.primary) {
    const p = report.position;
    lines.push(`位置：${p.relativeText || `第${p.r + 1}行第${p.c + 1}列`}；本格候选区块 ${fmtIds(p.blockCandidates)}`);
    const primary = sg.primary;
    const why = pickWhy(primary, 2);
    lines.push(`下一步${primary.arrow}${primary.label}${why ? '：' + why : ''}`);
    if (primary.risks.length) lines.push(`风险：${[...new Set(primary.risks)].slice(0, 2).join('；')}`);
    const alt = sg.alternatives[0];
    if (alt) lines.push(`备选${alt.arrow}${alt.label}${alt.risks.length ? '（' + alt.risks[0] + '）' : ''}`);
    if (sg.confidence !== 'high') lines.push(`把握：${sg.confidence === 'medium' ? '中' : '低'}${sg.warnings.length ? '（' + sg.warnings[0].slice(0, 36) + '）' : ''}`);
  } else if (sg && sg.reason) {
    lines.push(`暂无建议：${sg.reason}`);
  }
  const pending = [];
  if (report.progress.pendingRounds.length) pending.push(`第${report.progress.pendingRounds.join('、')}回合四墙`);
  if (report.questions.length) pending.push(`${report.questions.length}条线索待补`);
  if (pending.length) lines.push(`待补：${pending.join('；')}`);
  if (report.maps.count) lines.push(`已确定区块 ${report.blocks.determined.length}，整图候选 ${report.maps.count}${report.maps.complete ? '' : '+'}`);
  let text = lines.join('\n');
  if (text.length > limit) text = text.slice(0, limit - 1) + '…';
  return text;
}

module.exports = { buildReport, renderText, renderQQ, DIR_LABEL };
