'use strict';
// Goal-directed, bounded planning. Domains are logical possibilities, NEVER
// samples or probability weights. Historical routes inform the priorities;
// no opponent private messages or future results are available to this module.
const {E,T,A}=require('./kernel.cjs');
const {edgeState}=require('./movement.cjs');
const {routeTo,locateTarget}=require('./pursuit.cjs');
const {turnFacts}=require('./local-exit.cjs');
const {progressContext,exitRetirements}=require('./progress-context.cjs');
const {address,regionValue}=require('./exploration-value.cjs');
const {trapState,trapArrival}=require('./trap-state.cjs');
const VERSION='particles-20261106-batchfix2';
const DIRS=['up','down','left','right'],CHARS='上下左右',OPP=[1,0,3,2];
const NAMES={EMPTY:'空地',GRASS:'草丛',WATER:'水洼',BERRY:'浆果丛',PORTAL:'传送门',ONEWAYPORTAL:'单向门出口',TRAP:'陷阱',HEAT:'热源',HEART:'心脏',EXIT:'逃生舱'};
const key=p=>E.key(p.r,p.c);
const next=(p,d,n)=>({r:E.mod(p.r+E.V[d][0],n),c:E.mod(p.c+E.V[d][1],n)});
const same=(a,b)=>a&&b&&a.r===b.r&&a.c===b.c;
function context(original){
 const input=require('./local-recovery.cjs').localRecovery(original),{built,team,journal}=input;
 if(!built||built.spectator||!built.views[built.self])return null;
 const self=built.self,view=built.views[self],config=view.model.config,n=config.size;
 const node=team?.nodes?.find(x=>x.id===self+':'+view.model.active);
 const at=E.replay(view.model.segments[view.model.active],n),solution=node?.solution;
 const walls=E.inferredWalls(config,solution),terrain=E.terrainPossibilities(solution,n);
 const wallKinds=require('./edge-kinds.cjs').edgeKinds(config,solution);
 const observed=(r,c,d,value)=>{walls.set(E.key(r,c)+':'+d,value);const to=next({r,c},d,n);walls.set(key(to)+':'+OPP[d],value);};
 for(const o of at.observations||[]){
  if(o.kind==='walls'&&typeof o.value==='string')for(let d=0;d<4;d++)if('墙空'.includes(o.value[d]))observed(o.r,o.c,d,o.value[d]);
  if(['pass','hit'].includes(o.kind)&&!wallKinds.get(E.key(o.r,o.c)+':'+o.dir)?.includes(2))observed(o.r,o.c,o.dir,o.kind==='pass'?'空':'墙');
  if(o.kind==='terrain'&&o.value)terrain.set(E.key(o.r,o.c),Array.isArray(o.value)?o.value:[o.value]);
 }
 for(const edge of require('./reported-walls.cjs').reportedClosed(at,n).keys())walls.set(edge,'墙');
 const scope=node?T.mapScope(config,node,at.observations):{visited:new Set((at.trace||[]).map(key))};
 const last=view.roundEnds.at(-1),round=last?last.round+(last.complete?1:0):1;
 const facts=turnFacts(journal,self,round),steps=Math.max(facts.steps,...view.model.segments.flatMap(s=>s.events).filter(e=>e.kind==='move'&&e.clock?.round===round).map(e=>e.clock.step||0),0);
 const progress=progressContext(at,journal,self,round);
 const warnings=[];
 if(node?.verification?.status==='impossible')warnings.push('本人线索矛盾，禁止使用不可能的地图行动。');
 if(team?.conflict&&!input.recovery)warnings.push('多人定位冲突，等待独立本人地图验证。');
 if(view.ambiguities.length)warnings.push('传送或位置尚未确定，只执行局部试探，不据此宣称已定位。');
 if(input.recovery)warnings.push('当前只使用独立验证的本人线索。');
 const {certainExits,certainPortals}=require('./suggest.cjs');
 const exits={cells:certainExits(solution,n,scope.visited)},retiredExits=exitRetirements(input,exits,terrain);
 const rules=journal?.base?.config?.roomRules||{};
 const ctx={input,self,view,node,config,n,at,from:{r:at.r,c:at.c},solution,walls,terrain,wallKinds,visited:scope.visited,
  lastDirection:at.last,birth:node?.birth,exits,portals:certainPortals(solution,n,config,at.observations),...retiredExits,
  round,steps,facts,progress,warnings,solo:built.count===1,silent:config.silent===true,turnEdges:progress.turnEdges,
  captureOnArrival:rules.点杀==='关闭'||rules.谋定后动==='开启',rules,
  certain:!view.ambiguities.length&&!view.localExit&&!team?.conflict&&!node?.routePending&&node?.verification?.status==='verified'};
 ctx.uncertainLocation=!!view.localExit||require('./active-frame.cjs').hasCurrentAmbiguity(view,node);
 require('./door-state.cjs').applyDoors(ctx,input.board);
 ctx.trapState=trapState({journal,node,config,round,player:self,steps});
 ctx.target=ctx.certain?locateTarget(input):null;
 ctx.prey=ctx.certain&&!ctx.target&&round>1?require('./candidate-pursuit.cjs').targetCandidates(input,round):null;
 const hunter=A.status(built).find(p=>p.id===self)?.hunter;
 const hunting=ctx.certain&&hunter!=null?require('./candidate-pursuit.cjs').targetCandidates(input,round,hunter):null;
 ctx.hunter=hunting?.exhaustive&&hunting.positions?.length===1?hunting.positions[0]:null;
 // Only exact endpoints inform retreat. A broad candidate cloud is not an
 // assertion that a hunter occupies every possible cell.
 for(const edge of ctx.target?.edges||[])observed(edge.r,edge.c,edge.dir,edge.value);
 ctx.regions=new Map();ctx.features=new Map();
 ctx.turnVisits=new Map();
 for(const o of at.observations||[])if(o.kind==='action'&&o.arrival&&o.clock?.round===round&&o.clock?.player===self)ctx.turnVisits.set(E.key(o.r,o.c),(ctx.turnVisits.get(E.key(o.r,o.c))||0)+1);
 return ctx;
}
function features(ctx,to){
 const k=key(to);if(ctx.features.has(k))return ctx.features.get(k);
 const region=regionValue(ctx,to),types=ctx.terrain.get(k)||[],attachments=new Set();
 for(const p of ctx.solution?.phases||[]){const a=address(p,ctx.n,to.r,to.c);for(const m of p.domains[a.slot]||[])attachments.add(m.block.cells[a.i].attach);}
 const f={region,types,attachments};ctx.features.set(k,f);return f;
}
function edgeCost(ctx,from,d,last,depth=0){
 const edge=edgeState(from,d,ctx,last),to=next(from,d,ctx.n),{types,region,attachments}=features(ctx,to);
 const components={步数:-4};
 const unknown=edge.wall!=='空'||edge.uncertain;
 if(unknown)components.边界未确定=-14;
 const beat=ctx.steps+depth+1,masked=ctx.config.heartPresence===true&&beat<=19&&beat%3===1;
 const noise=!ctx.solo&&!ctx.silent&&!masked?6+Math.min(3,ctx.progress.turnSounds.size)*4:0;
 // Alternative terrain types are mutually exclusive. Rank uncertainty once;
 // never add a heart, a trap and a portal as if all occupied the same cell.
 if(types.length>1){
  const risks=types.map(t=>(['WATER','GRASS','BERRY','PORTAL','TRAP'].includes(t)?noise:0)
   +(t==='PORTAL'?(ctx.portals.has(key(to))?6:16):0)
   +(t==='TRAP'&&trapArrival(ctx.trapState,to).active?42:0)+(t==='HEAT'?35:0)+(t==='HEART'?60:0));
  components.地形不确定风险=-Math.min(24,Math.max(...risks));
 }else{
  if(types.some(t=>['WATER','GRASS','BERRY','PORTAL','TRAP'].includes(t))&&noise)components.暴露风险=-noise;
  if(types.includes('PORTAL'))components.传送代价=ctx.portals.has(key(to))?-6:-16;
  if(types.includes('TRAP')&&trapArrival(ctx.trapState,to).active)components.可能强停=-42;
  if(types.includes('HEAT'))components.热源风险=-35;
  if(types.includes('HEART'))components.心脏阻挡=-60;
 }
 if(!types.length)components.地形未知=-8;
 if(region.button)components.按钮公示与改门=-12;
 if(attachments.has('BOMB'))components.炸弹风险=-60;
 const repeats=ctx.progress.edges.get(key(from)+':'+d)||0;
 if(repeats)components.重复通道=-Math.min(12,repeats*2);
 if(ctx.turnEdges.has(key(from)+':'+d))components.本回合重复=-22;
 if(depth===0&&d===OPP[ctx.lastDirection]&&ctx.steps>0)components.立即折返=-10;
 return {edge,to,types,region,attachments,components,unknown,cost:-Object.values(components).reduce((s,x)=>s+x,0),masked};
}
function basicMoves(ctx){
 return DIRS.map((direction,d)=>{const e=edgeCost(ctx,ctx.from,d,ctx.at.last);return {direction,dirIndex:d,label:CHARS[d],arrow:'↑↓←→'[d],to:e.to,
  wall:e.edge.wall,wallKinds:e.edge.kinds,blocked:e.edge.blocked,reportedClosed:e.edge.reportedClosed===true,known:e.types.length===1,terrain:e.types,score:-10000,components:{无可达目标:-10000},reasons:['该方向暂无可执行目标'],gains:[],risks:[]};});
}
// Dijkstra through known traversable cells. A frontier is one uncertain step
// beyond that graph. Never imagine a chain of unknown cells as a safe route.
function frontiers(ctx,moves){
 const start={...ctx.from,last:ctx.lastDirection,path:[],cost:0,components:{}},queue=[start],dist=new Map(),plans=[];
 const deadline=Date.now()+180,limit=ctx.n*ctx.n*4;let expanded=0;
 while(queue.length&&expanded<limit&&Date.now()<deadline){
  queue.sort((a,b)=>a.cost-b.cost||a.path.length-b.path.length);const p=queue.shift(),id=key(p)+':'+p.last;
  if(p.cost>(dist.get(id)??Infinity))continue;
  expanded++;
  for(let d=0;d<4;d++){
   const e=edgeCost(ctx,p,d,p.last,p.path.length);if(e.edge.blocked)continue;
   const path=[...p.path,d],k=key(e.to),fresh=!ctx.visited.has(k);
   const cost=p.cost+e.cost,components={...e.components,前置路线:-p.cost};
   const untriedEdge=e.unknown&&!ctx.progress.edges.has(key(p)+':'+d);
   if(fresh||untriedEdge){
    components.新格探索=fresh?24:0;
    components.新线索=(fresh&&(!e.types.length||e.types.length>1)?12:0)+(untriedEdge?6:0);
    // Searching a ruled-out block is less valuable, but it is still a corridor.
    components.寻找出口区域=!fresh||ctx.config.exitCount===0?0:e.region.birth?-16:e.region.noExit?-8:18;
    if(fresh&&e.attachments.size===1&&e.attachments.has('COIN'))components.金币=30;
    const phases=ctx.solution?.phases||[];
    if(fresh&&phases.length&&phases.every(q=>address(q,ctx.n,p.r,p.c).slot!==address(q,ctx.n,e.to.r,e.to.c).slot))components.进入新区块=10;
    const score=Object.values(components).reduce((s,v)=>s+v,0);
    plans.push({direction:path[0],path,destination:e.to,score,components,
     reasons:['探索路线：'+path.map(i=>'↑↓←→'[i]).join('')+'（'+path.length+'步，先走'+('↑↓←→'[path[0]])+'）',e.region.birth?'该区块是出生区，寻找出口价值较低':e.region.noExit?'该区块已排除逃生舱，不为补全区块反复绕行':'寻找尚未排除的逃生区域'],
     possibilities:[...(e.unknown?['边界未确定，可能撞墙']:[]),...e.types.map(t=>t==='TRAP'?(trapArrival(ctx.trapState,e.to).active?'陷阱可能强停':'陷阱本次只发声'):NAMES[t]||t)]});
   }
   // Portal travel is handled by the tactical route planner / next feedback.
   // Doors/buttons change the graph; do not plan beyond them before feedback.
   const pass=e.edge.wall==='空'&&!e.edge.uncertain&&e.edge.kinds.every(k=>k===0||k===4);
   if(!pass||!e.types.length||e.types.some(t=>!['EMPTY','WATER','GRASS','BERRY','ONEWAYPORTAL'].includes(t))||e.attachments.has('BUTTON')||e.attachments.has('BOMB')||path.length>=12||cost>120)continue;
   const ni=k+':'+d;if(cost>=(dist.get(ni)??Infinity))continue;
   dist.set(ni,cost);queue.push({...e.to,last:d,path,cost});
  }
 }
 for(const plan of plans){const m=moves[plan.direction];if(plan.score>m.score)Object.assign(m,{score:plan.score,components:plan.components,reasons:plan.reasons,possibilities:plan.possibilities,goal:plan.destination,route:plan.path});}
 return {expanded,plans:plans.length,complete:!queue.length};
}
function tacticMoves(ctx,moves){
 if(!ctx.certain)return;
 // A small, localized pod ambiguity is a concrete goal even before a pod is
 // certain. Do not leave it merely for the generic new-block reward.
 for(const [cell,types] of ctx.terrain){
  if(ctx.spentPods?.has(cell)||ctx.visited.has(cell)||!types.includes('EXIT')||types.some(t=>!['EMPTY','EXIT','GRASS','BERRY'].includes(t)))continue;
  const point=Object.fromEntries(cell.split(',').map((v,i)=>[i?'c':'r',Number(v)]));
  const phases=ctx.solution?.phases||[];
  if(!phases.length||!phases.every(p=>{const a=address(p,ctx.n,point.r,point.c),ids=new Set(p.domains[a.slot].map(m=>m.block.id));return ids.size<=4;}))continue;
  const route=routeTo(ctx.from,point,ctx);
  if(route?.direction==null||route.risk.unknownEdges>2||route.commands.length>6||route.risk.portalTransits||moves[route.direction].blocked)continue;
  const components={核验逃生舱候选:220,路线代价:-8*route.cost},score=Object.values(components).reduce((s,v)=>s+v,0),m=moves[route.direction];
  if(score>m.score)Object.assign(m,{score,components,goal:point,route:route.commands,
   reasons:['优先核验附近逃生舱候选：'+route.commands.map(d=>'↑↓←→'[d]).join(''),'该区域仍兼容少量区块；到达候选格可确认逃生或排除该位置，逐步反馈核验'],
   possibilities:['逃生舱或普通地形；边界仍可能阻挡'],tactic:{kind:'verify-exit',round:ctx.round,steps:ctx.steps,destination:point}});
 }
 const goals=[...ctx.exits.cells.keys()].map(k=>({kind:'escape',point:Object.fromEntries(k.split(',').map((v,i)=>[i?'c':'r',Number(v)]))}));
 if(ctx.target&&ctx.round>1&&!same(ctx.from,ctx.target))goals.push({kind:'pursue',point:ctx.target});
 for(const goal of goals){
  const confirmed=routeTo(ctx.from,goal.point,{...ctx,confirmedOnly:true,escapeRoute:goal.kind==='escape'});
  const route=confirmed||routeTo(ctx.from,goal.point,{...ctx,excludedEdges:ctx.turnEdges});
  if(route?.direction==null||moves[route.direction].blocked)continue;
  // Confirmed objectives outweigh speculative objectives; shorter routes win
  // within a tier. A pod's availability is rechecked after every step.
  const components={目标:confirmed?900:500,路线代价:-8*route.cost,逃生优先:goal.kind==='escape'?60:0};
  const score=Object.values(components).reduce((s,v)=>s+v,0),m=moves[route.direction];
  const batchCapture=goal.kind==='pursue'&&confirmed&&ctx.round>1?require('./pursuit.cjs').captureBatch(ctx.from,goal.point,ctx):null;
  let batchEscape=null;
  if(ctx.solo&&goal.kind==='escape'&&confirmed&&route.commands.length>1&&ctx.rules.大乱斗!=='开启'){
   let p={...ctx.from},safe=true;
   for(let i=0;i<route.commands.length;i++){
    const to=next(p,route.commands[i],ctx.n),f=features(ctx,to);
    if(f.attachments.has('BUTTON')&&!ctx.doorModel?.buttons.has(key(to))||f.attachments.has('BOMB')){safe=false;break;}
    const portal=ctx.portals.get(key(to));
    if(portal){if(i+2>=route.commands.length){safe=false;break;}p={...portal};i+=2;}
    else p=to;
   }
   if(safe&&same(p,goal.point))batchEscape={confirmed:true,target:goal.point,commands:route.commands.map(d=>CHARS[d]).join('')};
  }
  if(score>m.score)Object.assign(m,{score,components,goal:goal.point,route:route.commands,
   reasons:[goal.kind==='escape'?'前往一致确定的逃生舱位置（到达才确认是否仍可用）':'追赶可靠定位的捕捉目标',batchEscape?'整条逃生路线已核验，一次发送：'+route.commands.map(d=>'↑↓←→'[d]).join(''):confirmed?'通路已经确认；每步收到反馈后重算':'目标已定位，通路仍需试探'],
   possibilities:[],tactic:{kind:goal.kind,round:ctx.round,steps:ctx.steps,target:ctx.target,destination:goal.point,routeRisk:route.risk,routeCost:route.cost,...(batchEscape?{batchEscape}:{}),...(batchCapture?{batchCapture}:{})}});
 }
 // A few exhaustive compatible endpoints justify an attempt, not a claimed
 // exact location. Never normalize these endpoints into a success probability.
 if(ctx.prey?.exhaustive&&ctx.prey.positions.length<=4){
  for(const point of ctx.prey.positions){
   if(same(point,ctx.from)||ctx.progress.turnArrivals?.has(key(point)))continue;
   const route=routeTo(ctx.from,point,{...ctx,excludedEdges:ctx.turnEdges});
   if(route?.direction==null||route.risk.unknownEdges>1||route.commands.length>10||moves[route.direction].blocked)continue;
   const components={核验捕捉目标:360,定位歧义:-(ctx.prey.positions.length-1)*55,路线代价:-10*route.cost};
   const score=Object.values(components).reduce((s,v)=>s+v,0),m=moves[route.direction];
   if(score>m.score)Object.assign(m,{score,components,goal:point,route:route.commands,possibilities:[],
    reasons:['目标有 '+ctx.prey.positions.length+' 个兼容终点，沿短路线核验其中一个；不把候选数量当作概率'],
    tactic:{kind:'objective-hunt',round:ctx.round,steps:ctx.steps,candidates:ctx.prey,destination:point}});
  }
 }
 if(ctx.hunter&&ctx.round>1){
  const distance=p=>{const dr=Math.abs(p.r-ctx.hunter.r),dc=Math.abs(p.c-ctx.hunter.c);return Math.min(dr,ctx.n-dr)+Math.min(dc,ctx.n-dc);};
  if(distance(ctx.from)<=1)for(const m of moves){
   const e=edgeCost(ctx,ctx.from,m.dirIndex,ctx.lastDirection);
   if(m.blocked||e.edge.wall!=='空'||e.edge.uncertain||e.types.length!==1||e.types[0]!=='EMPTY'||distance(m.to)<=distance(ctx.from))continue;
   const components={远离已定位猎手:140,移动代价:-e.cost},score=Object.values(components).reduce((s,v)=>s+v,0);
   if(score>m.score)Object.assign(m,{score,components,reasons:['猎手可靠定位在一格内，先沿确认空地拉开距离；距离增加不等于保证安全'],possibilities:['空地'],goal:m.to,route:[m.dirIndex],tactic:{kind:'objective-retreat',round:ctx.round,steps:ctx.steps}});
  }
 }
}
function finish(ctx,moves,reason,score,kind='finish-exploration'){
 const finishers=require('./finish-turn.cjs');
 const d=kind==='finish-capture'?finishers.captureFinishDirection(ctx.from,ctx,ctx.at.last):finishers.wallDirection(ctx.from,ctx);
 const base={kind,round:ctx.round,steps:ctx.steps,exhausted:true,loopPrevented:true,policy:VERSION,reason,
  target:kind==='finish-capture'?ctx.target:undefined,arrivalDirection:ctx.at.last};
 if(d!=null){const m=moves[d];return {...m,to:{...ctx.from},score,components:{结束回合:score},reasons:[reason,'撞确定墙留在当前位置，获取私聊墙壁信息'],intentionalCollision:true,arrivalDirection:ctx.at.last,tactic:{...base,finishMethod:'wall'}};}
 return {direction:'stop',label:'停止',arrow:'■',gains:[],risks:[],to:{...ctx.from},score,blocked:false,components:{结束回合:score},reasons:[reason,'主动停止不保证当前位置安全，也不会额外获得默认墙壁信息'],
  tactic:{...base,stopException:kind==='finish-capture'?'capture-no-wall':'objective-exhausted'}};
}
function result(ctx,moves,primary,audit={}){
 const all=[...moves.filter(m=>!m.blocked||m===primary||m.dirIndex===primary?.dirIndex&&primary.intentionalCollision)];
 const i=all.findIndex(m=>m.direction===primary?.direction);if(i>=0)all[i]=primary;else if(primary)all.push(primary);
 all.sort((a,b)=>b.score-a.score||DIRS.indexOf(a.direction)-DIRS.indexOf(b.direction));
 return {ok:true,position:{...ctx.from,segment:ctx.view.model.active,unique:ctx.certain},primary,moves,
  alternatives:all.filter(m=>m!==primary).slice(0,2),tactic:primary?.tactic||{kind:'objective-explore',round:ctx.round,steps:ctx.steps},
  warnings:ctx.warnings,basis:['以可验证目标、探索进展、行动权和暴露风险排序；通过出生先验校正的采样辅助探索，样本不足时仅使用逻辑约束。'],confidence:ctx.certain?'medium':'low',
  calculation:{version:4,mode:'objective-policy',policy:VERSION,audit,particles:ctx.particles,
   options:all.map(m=>({command:DIRS.includes(m.direction)?CHARS[DIRS.indexOf(m.direction)]:'停止',score:m.score,components:m.components,reasons:m.reasons,
    outcomes:m.outcomes||[],possibilities:m.possibilities||[],goal:m.goal,route:m.route?.map(d=>CHARS[d]).join('')}))}};
}
function plan(ctx){
 const moves=basicMoves(ctx),clear=!ctx.warnings.some(w=>/矛盾|冲突/.test(w));
 if(!clear){
  const primary={direction:'stop',label:'停止',arrow:'■',to:{...ctx.from},score:0,blocked:false,components:{等待新证据:0},gains:[],risks:['交出行动权，当前地点安全性未知'],
   reasons:['线索暂不能一致解释；结束当前回合，避免根据矛盾地图连续移动或空等超时'],
   tactic:{kind:'finish-uncertain',policy:VERSION,round:ctx.round,steps:ctx.steps}};
  return result(ctx,moves,primary,{reason:'地图线索尚未验证，仅结束回合'});
 }
 if(ctx.certain&&ctx.round>1&&same(ctx.from,ctx.target))return result(ctx,moves,finish(ctx,moves,'已和可靠定位的目标同格，立即结束行动触发捕捉',1200,'finish-capture'));
 if(ctx.certain&&ctx.round>1&&ctx.steps>=1&&ctx.prey?.exhaustive&&ctx.prey.positions.length<=4&&ctx.prey.positions.some(p=>same(p,ctx.from))){
  const p=finish(ctx,moves,'抵达 '+ctx.prey.positions.length+' 个兼容目标终点之一，结束行动尝试捕捉（不保证命中）',600,'attempt-capture');
  Object.assign(p.tactic,{target:ctx.prey.target,candidates:ctx.prey,destination:ctx.from,stopException:p.direction==='stop'?'capture-no-wall':undefined});
  return result(ctx,moves,p);
 }
 const last=ctx.view.roundEnds.at(-1);
 if(last?.inSpace&&last.locatable!==false&&!ctx.view.ambiguities.length){
  const pause=require('./heartbeat.cjs').portalHeartbeatPause(ctx.view,ctx.steps);
  // A heartbeat is useful only when known to exist. Never wait when already
  // at the masking beat or with a known urgent escape/capture opportunity.
  if(pause&&!ctx.solo&&!ctx.exits.cells.size&&!ctx.target){const p=finish(ctx,moves,'已确认亚空间且出口声可在下回合首步被心跳掩盖',80);p.tactic={kind:'portal-heartbeat-wait',round:ctx.round,steps:ctx.steps,...pause};return result(ctx,moves,p);}
  const p=moves.find(m=>!m.blocked);if(p){Object.assign(p,{score:100,components:{完成传送:100},reasons:['已确认亚空间，推进一步；落地后重新规划'],tactic:{kind:'portal-transit',round:ctx.round}});return result(ctx,moves,p);}
 }
 const diagnostic=require('./portal-diagnostic.cjs').portalDiagnostic(ctx.input);
 if(diagnostic){const p=moves[diagnostic.commands[0]];if(!p.blocked){Object.assign(p,{score:160,components:{区分水洼与传送:160},reasons:['两种解释下均可执行的短试探：'+diagnostic.commands.map(d=>CHARS[d]).join('')+'；只执行一步，收到反馈后重算'],tactic:{kind:'portal-diagnostic',...diagnostic}});return result(ctx,moves,p);}}
 const audit=frontiers(ctx,moves);tacticMoves(ctx,moves);
 require('./particle-policy.cjs').apply(ctx,moves,edgeCost);
 const available=moves.filter(m=>!m.blocked).sort((a,b)=>b.score-a.score||a.dirIndex-b.dirIndex);
 let primary=available[0];
 // Alternating directions can be a productive staircase, not a cycle.
 // With coordinates available, use actual repeated cells, not command text.
 const loop=ctx.uncertainLocation?require('./local-exit.cjs').unresolvedLoop(ctx.facts.moves):null;
 const recent=ctx.at.observations.filter(o=>o.kind==='action'&&o.arrival&&o.clock?.round===ctx.round&&o.clock?.player===ctx.self).slice(-6);
 const spatialLoop=recent.length===6&&new Set(recent.map(o=>E.key(o.r,o.c))).size<=2;
 const blind=ctx.uncertainLocation&&ctx.steps>=12;
 const noProgress=loop||spatialLoop||blind;
 // No absolute cap on productive routes. Stops end measured stagnation,
 // expensive blind repetition, or a position with no useful frontier.
 if((!primary||primary.score<0||noProgress&&primary.score<100)&&ctx.steps>=1){
  const reason=blind?'连续 12 步仍未重新定位，结束盲走；下一回合结合新线索重建位置':noProgress?'重复路线没有带来新信息，结束循环，下一回合结合其他玩家新线索再规划':'当前可达探索目标不足以抵偿风险和重复路程，结束本回合';
  const end=finish(ctx,moves,reason,Math.max(0,(primary?.score||0)+1));
  // If a new safe frontier beats the stop, keep exploring despite long routes.
  primary=end;
 }
 if(!primary){
  primary=finish(ctx,moves,'当前位置没有可通行方向，结束回合获取后续线索',0);
 }
 if(ctx.certain&&!ctx.captureOnArrival&&ctx.rules.大乱斗!=='开启'&&!primary.intentionalCollision&&primary.route?.length>1
   &&!primary.tactic?.batchEscape&&!primary.tactic?.batchCapture
   &&(!primary.tactic||['verify-exit','escape','pursue'].includes(primary.tactic.kind))){
  let p={...ctx.from},last=ctx.lastDirection;const prefix=[];
  for(const d of primary.route){
   const e=edgeCost(ctx,p,d,last,prefix.length);
   // Known open doors and momentum-cleared hedges are traversable too.
   // Stop before any cell whose feedback could change the remaining plan.
   const finalExit=primary.tactic?.kind==='escape'&&prefix.length===primary.route.length-1&&same(e.to,primary.tactic.destination)&&e.types[0]==='EXIT';
   if(e.edge.wall!=='空'||e.edge.uncertain||e.types.length!==1||!(['EMPTY','WATER','GRASS','BERRY'].includes(e.types[0])||finalExit)||e.attachments.has('BUTTON')||e.attachments.has('BOMB'))break;
   prefix.push(d);p=e.to;last=d;
  }
  if(prefix.length>1){
   primary.tactic={...(primary.tactic||{kind:'objective-explore'}),round:ctx.round,steps:ctx.steps,batchRoute:{confirmed:true,target:p,commands:prefix.map(d=>CHARS[d]).join('')}};
   primary.reasons.unshift('已知通道连续行进：'+prefix.map(d=>'↑↓←→'[d]).join('')+'；到需核验的位置前重算');
  }
 }
 return result(ctx,moves,primary,audit);
}
function suggest(input){const start=Date.now(),ctx=context(input);if(!ctx)return {ok:false,moves:[],warnings:[],reason:'没有可用的本人视角'};const s=plan(ctx);s.calculation.audit.elapsedMs=Date.now()-start;return s;}
module.exports={VERSION,suggest,context,plan,frontiers,edgeCost,features};
