'use strict';
const {E,M,A}=require('./kernel.cjs');
function progressContext(at,journal,self,round){
 const edges=new Map(),turnEdges=new Set(),turnArrivals=new Set(),turnSounds=new Set(),publicSounds=new Set(),first=new Set();
 for(const m of journal?.messages||[])for(const route of M.parse(m.text).items)if(route.kind==='trajectory'&&route.player===self){let step=0;for(const t of route.tokens)if(t.kind==='move'){step++;if(t.firstSound||t.direction==='首次')first.add(route.round+':'+step);}}
 // A pass observation is at the departure cell. Replay log entries are
 // already at the arrival cell, including on edges that wrap around the map.
 for(const o of at.observations||[]){
  const current=o.clock?.round===round&&o.clock?.player===self;
  if(o.kind==='pass'){
   const k=E.key(o.r,o.c)+':'+o.dir;edges.set(k,(edges.get(k)||0)+1);
   if(current)turnEdges.add(k);
  }else if(current&&o.kind==='action'&&o.arrival)turnArrivals.add(E.key(o.r,o.c));
 }
 for(const e of at.log||[]){
  if(e.kind!=='move'||e.outcome!=='move')continue;
  if(e.sound&&!e.masked&&!e.firstSound&&!first.has(e.clock?.round+':'+e.clock?.step)){
   publicSounds.add(E.key(e.r,e.c));
   if(e.clock?.round===round&&e.clock?.player===self)turnSounds.add(E.key(e.r,e.c));
  }
 }
 return {edges,turnEdges,turnArrivals,turnSounds,publicSounds};
}
function exposureNovelty(to,ctx,masked=false){if(masked||ctx.silent)return 0;
 const cell=E.key(to.r,to.c),base=ctx.publicSounds?.has(cell)?2:6;
 // A stationary listener can combine bearings from different source cells in one turn.
 const extra=ctx.turnSounds&&!ctx.turnSounds.has(cell)?Math.min(2,ctx.turnSounds.size)*6:0;
 return base+extra;}
function usedExits(input){
 const {built,team}=input,self=built.self,v=built.views[self],result=new Set();
 if(v.ambiguities.length||team?.conflict)return result;
 const own=team?.nodes?.find(n=>n.id===self+':'+v.model.active);
 if(own?.routePending||own?.fusionConflict)return result;
 for(const status of A.status(built)){
  if(status.id===self||status.alive||!/逃生/.test(status.reason||''))continue;
  const end=built.views[status.id]?.roundEnds.at(-1),join=own?.joined?.find(j=>j.id===status.id+':'+end?.segment);
  if(!end?.complete||end.locatable===false||!join||!own?.verification||own.verification.status!=='verified')continue;
  const other=team.nodes.find(n=>n.id===join.id);if(other?.verification?.status!=='verified'||other.routePending||other.fusionConflict)continue;
  result.add(E.key(E.mod(end.r+join.dr,v.model.config.size),E.mod(end.c+join.dc,v.model.config.size)));
 }
 return result;
}
function exitRetirements(input,exits,terrain){
 const {built}=input,config=built.views[built.self].model.config;
 const spentPods=usedExits(input),count=config.exitCount;
 // Opening broadcast gives the actual initial count. Ordinary escape consumes
 // one pod permanently, even when the escaped player's coordinates are unknown.
 const exitsExhausted=!config.brawl&&(!config.event||config.event==='NONE')&&Number.isInteger(count)&&count>=0&&
  A.status(built).filter(s=>!s.alive&&/逃生/.test(s.reason||'')).length>=count;
 for(const cell of spentPods){exits.cells.delete(cell);terrain.set(cell,['EMPTY']);}
 if(exitsExhausted){
  exits.cells.clear();
  for(const [cell,types] of terrain)if(types.includes('EXIT'))terrain.set(cell,[...new Set(types.map(t=>t==='EXIT'?'EMPTY':t))]);
 }
 return {spentPods,exitsExhausted};
}
module.exports={progressContext,exposureNovelty,usedExits,exitRetirements};
