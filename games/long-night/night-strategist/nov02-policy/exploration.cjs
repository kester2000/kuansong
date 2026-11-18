'use strict';
const {E}=require('./kernel.cjs');
const {edgeState}=require('./movement.cjs');
const noisy=types=>types.some(t=>['GRASS','WATER','BERRY'].includes(t));
const dangerous=types=>types.some(t=>['PORTAL','TRAP','HEAT','HEART'].includes(t));
const quietTerrain=(types,silent=false)=>types.length>0&&types.every(t=>(silent?['EMPTY','GRASS','WATER','BERRY']:['EMPTY']).includes(t));
function informationAt(to,ctx){
 const types=ctx.terrain.get(E.key(to.r,to.c))||[];
 if(!types.length)return 6;
 if(types.length>1)return 5;
 // Known terrain is not new evidence merely because we have not visited it.
 // Moving here does not reveal all incident walls.
 return 0;
}

// Search through proven quiet corridors to a useful frontier. Revisited cells
// are legitimate transit, but a loop with no new frontier earns no reward.
function moveInformation(from,d,to,ctx){
 const edge=edgeState(from,d,ctx);
 return Math.max(ctx.visited.has(E.key(to.r,to.c))?0:informationAt(to,ctx),
  !edge.blocked&&(edge.wall==null&&!edge.kinds.length||edge.uncertain)?2:0);
}
function quietFrontiers(from,ctx,trace=[]){
 const queue=[{...from,last:ctx.lastDirection,first:null,depth:0}],seen=new Set(),routes=new Map();
 while(queue.length){
  const p=queue.shift(),k=E.key(p.r,p.c)+':'+p.last;
  if(seen.has(k))continue;seen.add(k);
  if(p.depth>=5)continue;
  for(let d=0;d<4;d++){
   const edge=edgeState(p,d,ctx,p.last);if(edge.blocked||edge.uncertain||edge.wall!=='空')continue;
   const r=E.mod(p.r+E.V[d][0],ctx.n),c=E.mod(p.c+E.V[d][1],ctx.n),key=E.key(r,c);
   if(trace.some((q,i)=>i&&trace[i-1].r===p.r&&trace[i-1].c===p.c&&q.r===r&&q.c===c))continue;
   if(r===from.r&&c===from.c)continue;
   const types=ctx.terrain.get(key)||[],first=p.first??d,depth=p.depth+1;
   if(!ctx.visited.has(key)&&informationAt({r,c},ctx)>0&&(!types.length||quietTerrain(types,ctx.silent))){
    if(!routes.has(first)||routes.get(first).depth>depth)routes.set(first,{r,c,depth});
   }
   if(quietTerrain(types,ctx.silent))queue.push({r,c,last:d,first,depth});
  }
 }
 return routes;
}

function rankExploration(moves,from,ctx,{visits=new Map(),previous,trace=[],round=0,masked=false,silent=false,exposed=false,steps=0,visitMemoryOnly=false}={}){
 const params=ctx.experiment||{};
 const frontiers=quietFrontiers(from,{...ctx,silent},trace);
  const quietAlternative=!silent&&!masked&&moves.some(m=>!m.blocked
  &&m.terrain.length===1&&m.terrain[0]==='EMPTY'
  &&moveInformation(from,m.dirIndex,m.to,ctx)>0
  &&!trace.some((p,i)=>i&&trace[i-1].r===from.r&&trace[i-1].c===from.c&&p.r===m.to.r&&p.c===m.to.c));
 for(const m of moves){
  if(m.blocked)continue;
  const types=m.terrain,k=E.key(m.to.r,m.to.c),visited=ctx.visited.has(k),sound=noisy(types),hazard=dangerous(types);
  const openingScout=round>=1&&round<=2&&!visited&&!hazard;
  // A solo room has no hunter who can exploit a sound or known position.
  const opponentExposed=exposed&&!ctx.solo;
  const bold=openingScout&&!opponentExposed;
  const edge=edgeState(from,m.dirIndex,ctx),uncertain=edge.wall!=='空'||edge.uncertain;
  const silentScout=silent&&!visited&&!hazard;
  const repeatedProbe=uncertain&&(m.failedProbeCount||0)>0;
  const info=(repeatedProbe?0:moveInformation(from,m.dirIndex,m.to,ctx))*(params.informationWeight??1)*(openingScout?2:silentScout?1.5:1)/(1+Math.max(0,steps-6)/8);
  const exposure=(!ctx.solo&&sound&&!masked&&!silent?(types.every(t=>['GRASS','WATER','BERRY'].includes(t))?22:18):0)*(params.noiseWeight??1);
  const physical=hazard?Math.max(...types.map(t=>({PORTAL:30,TRAP:75,HEAT:90,HEART:40}[t]||0))):0;
  const collision=(uncertain?6+(opponentExposed?8:0):0)*(params.collisionWeight??(bold?0.25:0.5));
  let exits=0;
  if(!hazard)for(let d=0;d<4;d++){
   if(d===[1,0,3,2][m.dirIndex])continue;
   const e=edgeState(m.to,d,ctx,m.dirIndex),r=E.mod(m.to.r+E.V[d][0],ctx.n),c=E.mod(m.to.c+E.V[d][1],ctx.n),ts=ctx.terrain.get(E.key(r,c))||[];
   if(e.wall==='空'&&!e.blocked&&!e.uncertain&&quietTerrain(ts,silent))exits++;
  }
  const landing=(!ctx.solo&&sound&&!masked&&!silent&&!exits?8:0)*(params.landingWeight??1);
  // Reward belongs to the destination, never to taking a preparatory step.
  // A nearby actual frontier must beat shuffling toward another frontier.
  const route=frontiers.get(m.dirIndex),transit=route&&informationAt(m.to,ctx)===0?(params.routeUtility==='legacy'?Math.max(2,14-route.depth*2):3*(params.informationWeight??1)/(route.depth+1)):0;
  const repeat=visited&&!transit?3+Math.min(8,(visits.get(k)||0)*2)+(previous?.r===m.to.r&&previous?.c===m.to.c?3:0):0;
  m.evaluation={information:info,repeatedProbe,quietRoute:transit,exposure,collision,landing,physical,repeat,safeContinuations:exits,masked,openingScout,silentScout,quietAlternative};
  const repeatedEdge=trace.some((p,i)=>i>0&&trace[i-1].r===from.r&&trace[i-1].c===from.c&&p.r===m.to.r&&p.c===m.to.c);
  // Relative recent visits carry no current wall facts. Keep exits available
  // if all alternatives were visited; repetition is a cost, not a wall.
  m.explorationForbidden=visited&&repeatedEdge&&!visitMemoryOnly;
  m.score=info+transit-exposure-collision-landing-physical-repeat;
  m.gains=[];m.reasons=[];m.risks=[];
  if(openingScout)m.reasons.push('前两回合优先安静探新格；发声及停在声源的风险不因处于开局而打折');
  if(silentScout)m.reasons.push('静音持续主动探索：草丛、水洼和浆果可作为无声通道；不降低物理危险代价');
  if(repeatedProbe)m.reasons.push('同一助跑条件下已尝试失败，不再把重复反馈计作新信息；仍允许必要的重试');
  if(info)m.gains.push(`局部探索收益 ${info}（不按候选数量重复奖励）`);
  if(transit){m.explorationTarget={r:route.r,c:route.c,steps:route.depth};m.gains.push(`前往探索格 (${route.r+1},${route.c+1})，距离 ${route.depth} 步，折算收益 ${transit.toFixed(2)}`);m.reasons.push('绕路不单独奖励；越接近同等价值的目标，路线收益越高');}
  if(sound&&quietAlternative)m.reasons.push('附近有确定空地的真实探路机会，不为确认水洼/草丛而折减声音暴露代价');
  if(exposure)m.risks.push(`可能向对手暴露位置，代价 ${exposure}`);
  if(landing)m.risks.push('发声后缺少已确认的安静后续通道');
  if(collision)m.risks.push(`未知边可能撞墙并交出行动权${opponentExposed?'，本回合已向外发声':''}`);
  if(physical)m.risks.push('候选包含传送或强停地形，不能用信息收益抵消');
  if(repeat)m.reasons.push('重复经过旧格且没有找到安静探索前沿');
  if(masked&&sound)m.reasons.push('本步心跳掩盖声音，物理风险仍保留');
  m.reasons.push(`路线评估 ${m.score}：收益 ${info+transit}，风险及重复代价 ${exposure+collision+landing+physical+repeat}`);
  if(m.explorationForbidden)m.risks.push('禁止无目的循环：本回合已走过这条有向边；探索不能再次重复');
 }
 return moves;
}
module.exports={rankExploration,quietFrontiers,quietTerrain,informationAt,moveInformation};
