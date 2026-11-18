'use strict';
const {E}=require('./kernel.cjs');
const {publicRoutes}=require('./silent-projection.cjs');
// Parity counts actual arrivals, not births. Missing/hidden other-player
// history leaves a set of possibilities, never an invented 50/50 prior.
function trapState({journal,node,config,round=1,player=node?.player??0,steps=0}){
 const count=config.playerCount||2,turn=(round-1)*count+player;
 const routes=journal?publicRoutes(journal):new Map();let unknown=false;
 const sound=config.event==='RAINSTORY'?'PAPA':'SHASHA';
 for(let t=0;t<turn;t++){
  const route=routes.get((t%count)+':'+(Math.floor(t/count)+1));
  if(!route||route.partial||route.hidden||route.tokens.some(x=>x.kind==='hidden'||x.kind==='marker'&&/陷阱/.test(x.value)||x.kind==='move'&&x.outcome!=='hit'&&(config.silent||x.sound===sound||x.terrain==='TRAP'||x.terrain==='GRASS'||x.masked||config.heartPresence!==false&&!x.sound)))unknown=true;
 }
 const obs=node?.observations||[],actions=[...new Map(obs.filter(o=>o.kind==='action'&&o.clock?.round===round&&o.clock.player===player).map(o=>[o.clock.step,o])).values()].sort((a,b)=>a.clock.step-b.clock.step);
 const present=new Set(actions.map(o=>o.clock.step));
 if(Array.from({length:steps},(_,i)=>i+1).some(i=>!present.has(i)))unknown=true;
 const byCell=new Map();
 for(const a of actions)if(a.arrival){
  const key=E.key(a.r,a.c);let parity=byCell.has(key)?byCell.get(key):unknown?null:0;
  parity=parity==null?null:1-parity;
  const same=obs.filter(o=>o.r===a.r&&o.c===a.c&&(o.clock?.round===round&&o.clock.player===player&&o.clock.step===a.clock.step||!o.clock&&o.kind==='terrain'&&o.index>a.index&&!actions.some(next=>next.index>a.index&&next.index<o.index)));
  if(same.some(o=>o.kind==='sound'&&o.value===sound))parity=1;
  if(same.some(o=>o.kind==='terrain'&&o.value==='TRAP'))parity=0;
  byCell.set(key,parity);
 }
 return {priorEntriesParity(at){const k=E.key(at.r,at.c);return byCell.has(k)?byCell.get(k):unknown?null:0;},unknown};
}
function trapArrival(state,at){
 const prior=state?.priorEntriesParity(at);
 return prior===0?{active:false,uncertain:false}:prior===1?{active:true,uncertain:false}:{active:true,uncertain:true};
}
module.exports={trapState,trapArrival};
