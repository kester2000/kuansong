'use strict';
const {sample}=require('./bayes-worlds.cjs');
const {E}=require('./kernel.cjs');
const letters='上下左右';
function summarize(world,from,d,last,step,ctx,hasSound){
 const dest=world.next(from,d),kind=world.walls[from][d];
 const coord=i=>E.key(Math.floor(i/world.n),i%world.n);
 const known=ctx.walls.get(coord(from)+':'+d);
 if(kind===1||kind===2&&last!==d||kind===3&&known!=='空'||kind===4&&known==='墙'){
  const walls=world.walls[from].map((k,dir)=>ctx.walls.get(coord(from)+':'+dir)||E.wallFeedback(k)).join('');
  return {label:'撞墙 · '+walls,value:-6,why:'失去本回合行动权'};
 }
 const cell=world.cells[dest],fresh=!ctx.visited.has(coord(dest));
 const masked=world.heart&&step<=19&&step%3===1;
 if(cell.type==='EXIT'&&!ctx.brawl&&!ctx.spentPods.has(coord(dest))&&ctx.probeBayesExit)return {label:'进入可用逃生舱',value:60,why:'逃生'};
 const sound=E.soundTypes(cell.type,'NONE');
 const knownSound=sound.length===1&&sound[0]!=='NONE';
 const unstable=['PORTAL','ONEWAYPORTAL','TRAP','HEAT','HEART'].includes(cell.type)||['BOX','HEATBOX','JAMMERBOX'].includes(cell.attach);
 const exposure=knownSound&&!ctx.silent&&!masked?(hasSound?12:3):0;
 const label=sound.length>1?'陷阱反馈待定':knownSound&&!ctx.silent?(sound[0]==='PAPA'?'啪嗒':'沙沙')+(masked?' · 心跳掩盖':hasSound?' · 对外发声':' · 首次发声'):cell.type==='EMPTY'?'进入空地':'进入其他地形';
 const gain=fresh?5:-2,risk=unstable?10:0;
 return {label,value:gain-exposure-risk,why:'推进 '+gain+'，声音代价 '+exposure+'，特殊地形代价 '+risk};
}
// Only cross a previously visited, proven plain cell before the final probe.
function corridorRoutes(ctx,from,moves){
 const result=[];
 function visit(p,path,seen){
  for(let d=0;d<4;d++){
   const edge=E.key(p.r,p.c)+':'+d;
   if(ctx.turnEdges.has(edge)||!path.length&&moves[d].blocked)continue;
   const kinds=ctx.wallKinds.get(edge)||[];
   if(ctx.walls.get(edge)==='墙'||kinds.length&&kinds.every(k=>k===1||k===3))continue;
   const r=E.mod(p.r+E.V[d][0],ctx.n),c=E.mod(p.c+E.V[d][1],ctx.n),key=E.key(r,c);
   if(seen.has(key))continue;
   const dirs=[...path,d];
   if(path.length&&!ctx.visited.has(key)&&kinds.length===1&&kinds[0]===0)result.push(dirs);
   if(dirs.length>=3||!ctx.visited.has(key)||kinds.length!==1||kinds[0]!==0||ctx.walls.get(edge)!=='空')continue;
   const safe=ctx.solution.phases.every(phase=>{
    const {slot,i}=E.phaseAt(phase,ctx.n,r,c);
    return phase.domains[slot].every(m=>{
     const cell=m.block.cells[i];return cell.type==='EMPTY'&&cell.attach==='EMPTY';
    });
   });
   if(safe)visit({r,c},dirs,new Set([...seen,key]));
  }
 }
 visit(from,[],new Set([E.key(from.r,from.c)]));return result;
}
function rank({ctx,node,view,team,from,moves,steps,round,padding,hasSound,config}){
 const births=(node.joined||[{id:node.id,dr:0,dc:0}]).flatMap(j=>{
  const n=team.nodes.find(x=>x.id===j.id);return n?.birth?[{r:n.birth.r+j.dr,c:n.birth.c+j.dc,player:n.player}]:[];
 });
 const samples=sample(ctx,node,config,births,JSON.stringify([config.pool,from,round,steps,node.observations?.length]));
 const total=samples.reduce((v,h)=>v+h.weight,0),ess=total*total/samples.reduce((v,h)=>v+h.weight*h.weight,0);
 if(!(ess>=12))return null;
 const routes=moves.filter(m=>!m.blocked&&!ctx.turnEdges.has(E.key(from.r,from.c)+':'+m.dirIndex)).map(m=>[m.dirIndex]);
 for(const plan of padding)if(plan.padding&&routes.some(r=>r[0]===plan.directions[0]))routes.push(plan.directions);
 if(node.verification?.status==='verified'){
  for(const dirs of corridorRoutes(ctx,from,moves))if(!routes.some(r=>r.join()===dirs.join()))routes.push(dirs);
 }
 const options=[];
 for(const dirs of routes){
  const groups=new Map(),observations=new Map(),priorPods=new Map(),priorPhase=new Map();
  for(const {world,weight} of samples){
   let pos=from.r*ctx.n+from.c,last=ctx.lastDirection;
   for(const d of dirs.slice(0,-1)){pos=world.next(pos,d);last=d;}
   const outcome=summarize(world,pos,dirs.at(-1),last,steps+dirs.length,ctx,hasSound);
   const observation=['进入空地','进入其他地形','陷阱反馈待定'].includes(outcome.label)?'无明确地形线索':outcome.label;
   const seen=observations.get(observation)||{mass:0,pods:new Map(),phase:new Map()};
   seen.mass+=weight;observations.set(observation,seen);
   const g=groups.get(outcome.label)||{mass:0,utility:0,observation,reasons:new Set()};
   g.mass+=weight;g.utility+=outcome.value*weight;g.reasons.add(outcome.why);
   // The best single pod hypothesis after this observation is actionable.
   for(const pod of world.pods){if(ctx.spentPods.has(E.key(Math.floor(pod/ctx.n),pod%ctx.n)))continue;for(const map of [seen.pods,priorPods])map.set(pod,(map.get(pod)||0)+weight);}
   const phase=world.phaseKey;for(const map of [seen.phase,priorPhase])map.set(phase,(map.get(phase)||0)+weight);
   groups.set(outcome.label,g);
  }
  const best=(map,mass)=>Math.max(0,...map.values())/mass;
  const outcomes=[...groups].map(([label,g])=>{
   const seen=observations.get(g.observation);
   const info=6*(best(seen.phase,seen.mass)-best(priorPhase,total))+(ctx.brawl?0:14*(best(seen.pods,seen.mass)-best(priorPods,total)));
   const cost=dirs.length*(1+Math.min(4,steps/4));
   const utility=g.utility/g.mass+info-cost;
   return {label,probability:g.mass/total,utility,information:info,cost,reasons:[...g.reasons],contribution:g.mass/total*utility};
  }).sort((a,b)=>b.probability-a.probability);
  options.push({command:dirs.map(d=>letters[d]).join(''),directions:dirs,outcomes,score:outcomes.reduce((s,o)=>s+o.contribution,0)});
 }
 options.sort((a,b)=>b.score-a.score);
 return options.length?{options,ess}:null;
}
module.exports={rank,summarize};
