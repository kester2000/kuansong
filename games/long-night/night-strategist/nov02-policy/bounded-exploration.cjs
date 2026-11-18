'use strict';
const {performance}=require('node:perf_hooks');
const {E}=require('./kernel.cjs');
const {edgeState}=require('./movement.cjs');
const {partition}=require('./path-blocks.cjs');

// Ranking utilities, NOT posterior probabilities or predicted win rates.
// Search proven corridors plus a single uncertain endpoint. Never expand a
// hypothetical observation or enumerate complete maps. Limits are shared by
// all four directions, including metadata extraction.
const LIMITS=Object.freeze({states:384,depth:12,domainVisits:4096,milliseconds:25});
const VERSION='bounded-exploration-v1';
const ARROWS=['↑','↓','←','→'];
const dist=(a,b,n)=>{const r=Math.abs(a.r-b.r),c=Math.abs(a.c-b.c);return Math.min(r,n-r)+Math.min(c,n-c);};
const hidden=(ctx,step)=>ctx.silent||ctx.heartPresence===true&&step<=19&&(step-1)%3===0;
const round=x=>Math.round(x*100)/100;
const sound=t=>['GRASS','WATER','BERRY'].includes(t);

function failedProbeCounts(observations,n){
 const counts=new Map(),key=(r,c,d,sprint)=>E.key(r,c)+':'+d+':'+Number(sprint);
 for(const o of observations||[]){
  if(o.kind==='hit'){const k=key(o.r,o.c,o.dir,o.last===o.dir);counts.set(k,(counts.get(k)||0)+1);}
  if(o.kind==='pass')for(const [r,c,d] of [[o.r,o.c,o.dir],[E.mod(o.r+E.V[o.dir][0],n),E.mod(o.c+E.V[o.dir][1],n),E.OPP[o.dir]]])for(const sprint of[false,true])counts.delete(key(r,c,d,sprint));
 }
 return counts;
}
function planExploration(from,moves,ctx,{trace=[],steps=0,exposed=false,exposedAtSource=false}={}){
 const started=performance.now(),deadline=started+LIMITS.milliseconds;
 const failedProbes=failedProbeCounts(ctx.at?.observations,ctx.n);
 const stats={expanded:0,edges:0,domainVisits:0,truncated:false,limits:LIMITS};
 const repeated=new Set();
 const publicVisits=new Map();
 if(!ctx.solo)for(const p of ctx.publicTrace||[])publicVisits.set(E.key(p.r,p.c),(publicVisits.get(E.key(p.r,p.c))||0)+1);
 for(let i=1;i<trace.length;i++)repeated.add(E.key(trace[i-1].r,trace[i-1].c)+'>'+E.key(trace[i].r,trace[i].c));
 const allowed=new Set(moves.filter(m=>!m.blocked&&(!m.loopBlocked||ctx.allowRetrace)&&(!m.explorationForbidden||ctx.heartPresence===true||ctx.allowRetrace&&!m.branchRisk?.wall)).map(m=>m.dirIndex));
 const metadata=new Map();
 const branchByDirection=new Map(moves.map(m=>[m.dirIndex,m.branchRisk]));
 function factsAt(p,d,last){
  const key=E.key(p.r,p.c)+':'+d+':'+last;if(metadata.has(key))return metadata.get(key);
  let complete=!!ctx.solution?.phases?.length&&!ctx.solution.irregular,possibleButton=false,exitBlock=false;
  let quietArrival=false,immediateExit=false;
  const outcomes=new Set(),feedbackRows=[];
  outer:for(const phase of complete?ctx.solution.phases:[]){
   const r=E.mod(p.r-phase.pr,ctx.n),c=E.mod(p.c-phase.pc,ctx.n);
   const domain=phase.domains[E.phaseAt(phase,ctx.n,p.r,p.c).slot];
   if(!domain?.length){complete=false;break;}
   for(const m of domain){
    if(stats.domainVisits>=LIMITS.domainVisits||performance.now()>=deadline){complete=false;stats.truncated=true;break outer;}
    stats.domainVisits++;
    const block=m.block||E.byId.get(m.id),cell=block?.cells[E.phaseAt(phase,ctx.n,p.r,p.c).i];
    if(!cell){complete=false;break outer;}
    // Keep terrain and its entry edge correlated. An EMPTY tile behind a
    // solid wall is not a possible quiet landing for this command.
    const entry=cell.walls?.[[1,0,3,2][d]];
    const canEnter=entry==null||entry===0||entry===4||entry===2&&last===d;
    const type=ctx.spentPods?.has(E.key(p.r,p.c))||ctx.exitsExhausted&&cell.type==='EXIT'?'EMPTY':cell.type;
    if(canEnter){quietArrival ||= type==='EMPTY';immediateExit ||= type==='EXIT';}
    possibleButton ||= cell.attach==='BUTTON';
    const local=E.phaseAt(phase,ctx.n,p.r,p.c).i;
    const hasExit=!ctx.exitsExhausted&&block.cells.some((c,i)=>c.type==='EXIT'&&!ctx.spentPods?.has(E.key(E.mod(p.r-Math.floor(local/3)+Math.floor(i/3),ctx.n),E.mod(p.c-local%3+i%3,ctx.n))));exitBlock ||= hasExit;
    // Different tiles with identical audible feedback are not independent
    // information outcomes (e.g. WATER and PORTAL both produce PAPA).
    const cue=type==='GRASS'||type==='TRAP'?'SHA':type==='WATER'||type==='PORTAL'?'PAPA':type;
    outcomes.add(cue+':'+hasExit);
    // A wall hit and a landing are mutually exclusive feedback branches.
    // Unknown door state and insufficient hedge momentum retain both cases.
    const cues=[];
    if(entry===1||entry===2&&last!==d||entry===3||entry==null)cues.push('HIT');
    if(canEnter||entry===3||entry===2&&last!==d)cues.push(type==='EMPTY'?'QUIET':cue);
    feedbackRows.push({id:m.id??block.id,cues});
   }
  }
  const result={complete,possibleButton,exitBlock,quietArrival,immediateExit,feedbackRows,diagnostic:complete&&exitBlock&&outcomes.size>1};
  metadata.set(key,result);return result;
 }
 const exitPoints=[...(ctx.exits?.cells?.keys()||[])].map(k=>{const [r,c]=k.split(',').map(Number);return {r,c};});
 const possibleExits=exitPoints.length?exitPoints:[...ctx.terrain].filter(([k,ts])=>ts.includes('EXIT')&&!ctx.visited.has(k)).map(([k])=>{const [r,c]=k.split(',').map(Number);return {r,c};});
 const goals=possibleExits.length<=12?possibleExits:[];
 const nearest=(p,points)=>points.reduce((d,q)=>Math.min(d,dist(p,q,ctx.n)),Infinity);
 const byDirection=new Map(),queue=[{...from,last:ctx.lastDirection,mask:0n,path:[],cells:[E.key(from.r,from.c)],states:[E.key(from.r,from.c)+':'+ctx.lastDirection+':0'],cost:0,noisySteps:0}],seen=new Map();
 while(queue.length&&stats.expanded<LIMITS.states){
  // Always evaluate the four immediate choices, even if the machine is busy.
  if(stats.expanded&&performance.now()>=deadline){stats.truncated=true;break;}
  queue.sort((a,b)=>a.cost-b.cost||a.path.length-b.path.length);
  const p=queue.shift();stats.expanded++;
  if(p.path.length>=LIMITS.depth)continue;
  for(let d=0;d<4;d++){
   if(!p.path.length&&!allowed.has(d))continue;
   stats.edges++;
   const edge=edgeState(p,d,ctx,p.last,p.mask);if(edge.blocked)continue;
   const to={r:E.mod(p.r+E.V[d][0],ctx.n),c:E.mod(p.c+E.V[d][1],ctx.n)},k=E.key(to.r,to.c);
   const oldEdge=repeated.has(E.key(p.r,p.c)+'>'+k);
   const revisit=!ctx.allowRetrace&&(p.cells.includes(k)||oldEdge);
   const padding=(p.padding||0)+(revisit?1:0);
   if(revisit&&(ctx.heartPresence!==true||ctx.silent||padding>2||steps+p.path.length+1>=19))continue;
   const types=ctx.terrain.get(k)||[];
   // Exploration does not deliberately step into a possible forced-stop tile.
   // Purposeful escape/capture routes have their own state-aware planner.
   if(types.some(t=>['TRAP','HEAT','HEART'].includes(t))||types.length===1&&types[0]==='PORTAL')continue;
   const path=[...p.path,d],step=steps+path.length,masked=hidden(ctx,step),facts=factsAt(to,d,p.last);
   const unknownEdge=edge.wall!=='空'||edge.uncertain,portal=types.includes('PORTAL');
   const buttonMask=ctx.doorModel?.buttons.get(k),button=facts.possibleButton||buttonMask!=null;
   const unknownButton=button&&buttonMask==null||!facts.complete&&!!ctx.config?.dynamicDoors;
   // After a public sound, an uncertain first edge can end the turn on the
   // exact sound source. Prefer a proven quiet departure to a real frontier.
   const safeDeparture=p.path.length?p.safeDeparture:!unknownEdge&&!unknownButton&&!button&&types.length===1&&types[0]==='EMPTY';
   // A known noisy transit must agree with the next decision's source guard.
   // Do not prefer entering water merely to probe an unknown edge there,
   // then immediately retreat because that probe would leave us exposed.
   const quietNext=!unknownEdge&&!unknownButton&&!button&&types.length===1&&types[0]==='EMPTY';
   const soundSourceProbe=!!p.soundSourceProbe||!!p.publicSound&&!quietNext;
   if(revisit&&(unknownEdge||unknownButton||button||types.length!==1||types[0]!=='EMPTY'))continue;
   const mask=p.mask^(buttonMask??0n);
   const movementState=k+':'+d+':'+mask;
   if(ctx.allowRetrace&&p.states.includes(movementState))continue;
   const noisy=types.some(sound)||portal;
   const noiseCost=noisy&&!masked&&!ctx.solo?(exposed?10:7):0;
   const switchCost=button?(ctx.solo?1:4):0;
   const riskCost=(unknownEdge?(exposed?5:3):0)+(portal?6:0)+(!types.length?2:0)+noiseCost+switchCost;
   // Repeated travel inside a recognizable region adds public constraints,
   // including on heartbeat steps. A failed edge exposes a predictable source
   // square and yields the turn: charge that branch even with no audible cue.
   const footprint=ctx.publicFootprint?.get(E.key(p.r,p.c));
   const sameRegion=footprint&&ctx.publicFootprint?.get(k)?.blockId===footprint.blockId;
   const sourceVisits=publicVisits.get(E.key(p.r,p.c))||0;
   const repeatedStop=unknownEdge&&sourceVisits>=2?Math.min(10,sourceVisits*2):0;
   const structuralStepCost=Math.max(repeatedStop,footprint?(unknownEdge?footprint.stopExposure:0):0)+(sameRegion?1.5:0);
   const structuralCost=(p.structuralCost||0)+structuralStepCost;
   const cost=p.cost+0.75+riskCost+(oldEdge?2:0)+structuralStepCost;
   // Known singleton terrain does not become information just by revisiting.
   // A masked sound cannot distinguish ground terrain types either.
   // An unresolved ground branch can prove a cell was visited even when the
   // placeholder frame calls it new. Keep that evidence through re-ranking.
   const branch=path.length===1?branchByDirection.get(d):null;
   const branchRevisit=!!branch?.groundPossible&&branch.visits>0;
   const fresh=!ctx.visited.has(k)&&!branchRevisit;
   const excludedExitBlock=facts.complete&&!facts.exitBlock;
   const failedProbeCount=unknownEdge?(failedProbes.get(E.key(p.r,p.c)+':'+d+':'+Number(p.last===d))||0):0;
   const terrainInfo=fresh&&!failedProbeCount?(!types.length?8:types.length>1?(masked?3:8):0):0;
   const wallInfo=unknownEdge&&!failedProbeCount?4:0;
   const information=Math.max(terrainInfo,wallInfo)*(excludedExitBlock?0.2:1);
   if((information||failedProbeCount)&&!(ctx.allowRetrace&&(oldEdge||p.cells.includes(k)))&&(!padding||masked&&fresh&&!revisit)){
    const relevance=!failedProbeCount&&facts.complete?(facts.exitBlock?4: -2):0;
    // A wall probe into already observed terrain cannot distinguish the
    // terrain outcomes counted by factsAt (including exit-block terrain).
    const diagnostic=facts.diagnostic&&!masked&&terrainInfo>0?3:0;
    const exitProgress=goals.length?Math.max(-3,Math.min(3,nearest(from,goals)-nearest(to,goals)))*1.5:0;
    let continuations=0;
    for(let nd=0;nd<4;nd++){
     if(nd===[1,0,3,2][d])continue;
     const e=edgeState(to,nd,ctx,d,mask),next=E.key(E.mod(to.r+E.V[nd][0],ctx.n),E.mod(to.c+E.V[nd][1],ctx.n));
     const ts=ctx.terrain.get(next)||[];
     if(!unknownButton&&!portal&&!e.blocked&&!e.uncertain&&e.wall==='空'&&ts.length&&ts.every(t=>t==='EMPTY'||ctx.silent&&sound(t)))continuations++;
    }
    const deadEnd=noisy&&!masked&&!ctx.solo&&!continuations?4:0;
    // A failed probe leaves us at its SOURCE, not its hypothetical landing.
    // Include that position when comparing proximity to a possible hunter.
    const hunterDistance=ctx.hunters?.positions?.length?Math.min(nearest(to,ctx.hunters.positions),unknownEdge?nearest(p,ctx.hunters.positions):Infinity):null;
    const hunterRisk=hunterDistance!=null&&hunterDistance<4?(4-hunterDistance)*2:0;
    const beatBonus=!excludedExitBlock&&terrainInfo>0&&ctx.heartPresence===true&&!ctx.silent&&masked&&fresh&&(noisy||!types.length)?10:0;
    const previous=trace.at(-2);
    const reverses=previous&&E.mod(from.r+E.V[path[0]][0],ctx.n)===previous.r
     &&E.mod(from.c+E.V[path[0]][1],ctx.n)===previous.c;
    const branchCost=branchRevisit?8+branch.visits*2+(branch.traversals||0)*16:0;
    const reversalCost=Math.max(reverses&&!(beatBonus&&padding)?16:0,branchCost);
    // This is a ranking cost, not a ban: a useful wall diagnosis can still win.
    // Do not claim the proof after incomplete domain scanning or door changes.
    const adverseProbe=unknownEdge&&facts.complete&&!facts.quietArrival&&!facts.immediateExit&&!ctx.doorModel?.doors?.size;
    const probeCost=adverseProbe&&!ctx.solo&&!masked?6:0;
    const blockFeedback=partition(facts.feedbackRows,{complete:facts.complete&&!failedProbeCount,masked,silent:ctx.silent});
    // Prefer a probe that can actually reject a block explanation. Do not
    // pay for sound just because a block has many compatible placements.
    const blockDiagnosis=!failedProbeCount&&!noisy&&!p.noiseCost&&!button&&!branchRevisit?Math.min(2,blockFeedback.guaranteedElimination):0;
    const utility=round(information+relevance+diagnostic+exitProgress+beatBonus+blockDiagnosis+Math.min(2,continuations)-cost-deadEnd-hunterRisk-reversalCost-probeCost);
    const uncertainReturn=!!reverses&&!fresh&&unknownEdge&&path.length===1;
    // A hit followed by "empty" wall feedback can be a hedge, not proof of
    // an open passage. Repeating the hit is not fresh information; do not turn
    // this history into a wall or forbid a necessary retry/new momentum.
    const candidate={direction:path[0],destination:to,path,utility,cost:round(cost),structuralCost,information,excludedExitBlock,relevance,diagnostic,blockFeedback,blockDiagnosis,exitProgress,beatBonus,padding,noiseCost:(p.noiseCost||0)+noiseCost,switchCost,deadEnd,hunterRisk,branchRevisit,reversalCost,adverseProbe,probeCost,failedProbeCount,continuations,unknownEdge,uncertainReturn,possiblePortal:portal,masked,safeDeparture,soundSourceProbe};
    const old=byDirection.get(path[0]);
    if(!old||Number(soundSourceProbe)<Number(old.soundSourceProbe)||soundSourceProbe===old.soundSourceProbe&&(Number(excludedExitBlock)<Number(old.excludedExitBlock)||excludedExitBlock===old.excludedExitBlock&&(utility>old.utility||utility===old.utility&&(failedProbeCount<old.failedProbeCount||failedProbeCount===old.failedProbeCount&&path.length<old.path.length))))byDirection.set(path[0],candidate);
   }
   // Stop at the first unverified edge, unknown terrain, portal or switch
   // effect. Do not plan through an observation we have not received.
   const traversable=types.length&&types.every(t=>t==='EMPTY'||sound(t));
   const noisySteps=p.noisySteps+(noisy&&!masked&&!ctx.solo?1:0);
   // One known noisy crossing may be necessary to leave an exhausted area;
   // charge it in full and never expand an arbitrary chain of noisy cells.
   if(unknownEdge||!traversable||unknownButton||portal||noisySteps>1||path.length>=LIMITS.depth)continue;
   const state=k+':'+d+':'+mask+':'+path.length+':'+path[0]+':'+noisySteps+':'+padding;
   if(seen.has(state)&&seen.get(state)<=cost)continue;
   seen.set(state,cost);
   queue.push({...to,last:d,mask,path,cells:[...p.cells,k],states:[...p.states,movementState],cost,structuralCost,noisySteps,padding,safeDeparture,soundSourceProbe,publicSound:noisy&&!masked&&!ctx.solo,noiseCost:(p.noiseCost||0)+noiseCost});
  }
 }
 if(queue.length)stats.truncated=true;
 stats.elapsedMs=round(performance.now()-started);
 const plans=[...byDirection.values()].sort((a,b)=>b.utility-a.utility||a.failedProbeCount-b.failedProbeCount||a.path.length-b.path.length||a.direction-b.direction);
 // Yielding a fresh, unexposed turn also has an opportunity cost. A small
 // negative utility is acceptable then, rather than ending every short turn.
 const stopUtility=exposed?0:steps<3?-6:-2;
 // No-heart games prefer a useful quiet frontier before paying exposure.
 // Reversing through an uncertain edge (e.g. a momentum-cleared hedge)
 // is a collision probe, not a quiet route to a fresh frontier. Compare
 // its utility normally instead of giving it absolute quiet priority.
 if(ctx.heartPresence!==true&&!ctx.silent&&!ctx.solo)plans.sort((a,b)=>Number(a.noiseCost>0||a.uncertainReturn)-Number(b.noiseCost>0||b.uncertainReturn)||b.utility-a.utility);
 plans.sort((a,b)=>Number(a.excludedExitBlock)-Number(b.excludedExitBlock));
 // Early exploration keeps a useful quiet frontier ahead of a noisy guess,
 // even when a heart exists or the quiet region contains no exit. Heartbeat
 // masking is already evaluated at each actual step, not for the whole game.
 if(ctx.round>=1&&!ctx.silent&&!ctx.solo){
  // Later turns retain quiet priority when feedback can reject a concrete
  // block hypothesis. Excluding an exit is not a reason to discard that
  // information and deliberately cross a known noisy tile instead.
  const quiet=p=>p.noiseCost===0&&!p.uncertainReturn&&!p.branchRevisit&&p.information>0&&p.switchCost===0
   &&(ctx.round<=2||p.blockFeedback.complete&&p.blockFeedback.guaranteedElimination>0);
  plans.sort((a,b)=>Number(quiet(b))-Number(quiet(a)));
  if(plans[0]&&quiet(plans[0])){if(ctx.round<=2)plans[0].quietOpening=true;else plans[0].quietDiagnosis=true;}
 }
 plans.sort((a,b)=>Number(a.soundSourceProbe)-Number(b.soundSourceProbe));
 if(exposedAtSource&&!ctx.silent&&!ctx.solo){
  plans.sort((a,b)=>Number(b.safeDeparture)-Number(a.safeDeparture));
  if(plans[0]?.safeDeparture)plans[0].leaveSoundSource=true;
 }
 return {plans,best:plans[0]||null,stopUtility,search:stats};
}

function applyPlan(move,plan,search){
 move.score=plan.utility;
 move.failedProbeCount=plan.failedProbeCount;
 move.explorationTarget={...plan.destination,steps:plan.path.length};
 move.evaluation={...plan,search};
 move.gains=[`未知信息价值 ${plan.information}；逃生相关 ${plan.relevance+plan.diagnostic}；接近逃生候选 ${plan.exitProgress}`];
 move.reasons=[`沿 ${plan.path.map(d=>ARROWS[d]).join('')} 接近探索终点，先执行 ${ARROWS[plan.direction]}，收到新反馈后重算`,
  `综合分 ${plan.utility}：路线与风险代价 ${plan.cost}，发声后缺少安静退路代价 ${plan.deadEnd}，猎手接近代价 ${plan.hunterRisk}`,
  '分数用于比较行动，不代表贝叶斯概率或获胜概率'];
 if(plan.excludedExitBlock)move.reasons.push('该区块已排除逃生舱，信息收益降至两成；优先离开，已知发声格不计新信息收益');
 if(plan.leaveSoundSource)move.reasons.unshift('刚刚对外发声：先沿已确认开放的边走入安静空地，再接近探索终点，避免立即试未知墙而停留声源');
 if(plan.diagnostic)move.reasons.push('该处反馈可能帮助辨认含逃生舱的区块');
 if(plan.blockFeedback?.complete&&plan.blockFeedback.ids.length)move.reasons.push(`路径兼容区块 ${plan.blockFeedback.ids.join('、')}；按撞墙/移动反馈区分，最坏仍有 ${plan.blockFeedback.ids.length-plan.blockFeedback.guaranteedElimination} 种区块解释，不当作概率`);
 if(plan.quietOpening)move.reasons.unshift('开局先走有信息收益的安静前沿；不因心脏存在或附近区块不含出口就提前暴露');
 if(plan.quietDiagnosis)move.reasons.unshift('先安静探路，区分仍可能的区块；这条路不含逃生舱，也不代表探路没有价值');
 if(plan.soundSourceProbe)move.reasons.push('这条路发声后还要试未知通路；有其他有效探路方案时优先其他方案，避免踩水后又退回');
 if(plan.branchRevisit)move.reasons.push('未传送分支中该格已走过：取消新地形收益，并计入折返代价；未知墙仍可提供鉴别信息');
 if(plan.failedProbeCount)move.reasons.push('这条边在相同助跑条件下已尝试失败 '+plan.failedProbeCount+' 次；不再奖励重复信息，必要时仍可重试');
 if(plan.probeCost)move.reasons.push('联合入口墙与地形候选后，没有直接进入空地或逃生舱的分支；试探代价 '+plan.probeCost+'，仍保留撞墙鉴别价值');
 if(plan.unknownEdge&&plan.hunterRisk)move.reasons.push('试探失败会停在出发格并交出行动权，猎手风险同时检查出发格与落点');
 if(plan.beatBonus)move.reasons.push(`优先心跳步探索新格，心跳收益 ${plan.beatBonus}；安全调整 ${plan.padding} 次，不作无目的循环`);
 if(!plan.noiseCost)move.reasons.push('路线没有已知的未掩盖发声代价；未知地形仍可能发声');
 move.risks=[];
 if(plan.unknownEdge)move.risks.push('末端未知边可能撞墙结束回合');
 if(plan.possiblePortal)move.risks.push('末端可能传送，收到反馈后重新定位');
 if(plan.noiseCost)move.risks.push('可能发声暴露位置，已扣除代价');
 if(plan.structuralCost){move.risks.push('公开路线可能暴露已反复穿行的区块及停留格');move.reasons.push(`结构暴露代价 ${plan.structuralCost}：减少已识别区域内的反复描摹，未知边失败会在可预测位置交权；心跳不消除此风险。此项是保守估计，不代表对手已定位。`);}
 if(plan.switchCost)move.risks.push('按钮会改变门状态并在结算时暴露信息，已扣除代价');
 if(search.truncated)move.reasons.push('到达搜索预算，采用已找到的最佳可接受方案');
 return move;
}
function isBoundedFinish(s){
 const t=s?.tactic,search=t?.search;
 return t?.policy===VERSION&&t.kind==='finish-exploration'&&t.exhausted===true
  &&Number.isInteger(t.round)&&t.round>=1&&Number.isInteger(t.steps)&&t.steps>=0
  &&Number.isInteger(search?.expanded)&&search.expanded>=1&&search.expanded<=LIMITS.states
  &&s.moves?.length===4&&new Set(s.moves.map(m=>m.dirIndex)).size===4
  &&(!s.warnings||!s.warnings.some(w=>/矛盾|冲突/.test(w)));
}
module.exports={planExploration,applyPlan,isBoundedFinish,failedProbeCounts,LIMITS,VERSION};
