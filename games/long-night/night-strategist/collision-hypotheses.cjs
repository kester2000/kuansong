'use strict';
const {E}=require('./kernel.cjs');
// Behaviour supplies a hypothesis ordering, not a calibrated likelihood. Keep
// every wall/door/box explanation admitted by the constraint solver.
function analyze(input){
 const {built,team}=input,result=[];if(!built||!team)return result;
 for(const node of team.nodes||[]){
  if(node.routePending||node.fusionConflict||node.solution?.irregular||!node.solution?.phases?.length)continue;
  const observations=node.observations||[],hits=observations.filter(o=>o.kind==='hit'&&o.clock?.player===node.player&&o.last!==o.dir);
  for(let i=0;i<hits.length;i++)for(let j=i+1;j<hits.length;j++){
   const a=hits[i],b=hits[j];if(a.r!==b.r||a.c!==b.c||E.OPP[a.dir]!==b.dir||a.clock.round===b.clock.round)continue;
   const samePlace=observations.filter(o=>o.kind==='action'&&o.clock?.player===node.player&&o.clock.round>=a.clock.round&&o.clock.round<=b.clock.round)
    .filter(o=>o.clock.round>a.clock.round||o.clock.step>a.clock.step).filter(o=>o.clock.round<b.clock.round||o.clock.step<b.clock.step);
   if(samePlace.some(o=>o.arrival))continue;
   const support=new Map(),n=built.views[node.player].model.config.size;
   for(const phase of node.solution.phases){const at=E.phaseAt(phase,n,a.r,a.c);if(at.slot<0)continue;
    for(const m of phase.domains[at.slot]){
     const hedge=[a.dir,b.dir].some(d=>{
      if(observations.some(o=>o.kind==='walls'&&o.r===a.r&&o.c===a.c&&o.value?.[d]==='墙'))return false;
      const to=E.phaseAt(phase,n,E.mod(a.r+E.V[d][0],n),E.mod(a.c+E.V[d][1],n));
      const neighbor=to.slot===at.slot?[m]:phase.domains[to.slot]||[];
      return neighbor.some(other=>Math.max(m.block.cells[at.i].walls[d],other.block.cells[to.i].walls[E.OPP[d]])===2);
     });
     if(hedge)support.set(m.id+'@'+E.key(m.origin.r,m.origin.c),{blockId:m.id,origin:m.origin});
    }
   }
   if(support.size)result.push({player:node.player,frame:node.id,position:{r:a.r,c:a.c},directions:[a.dir,b.dir],rounds:[a.clock.round,b.clock.round],
    preferred:'hedge-corridor',candidates:[...support.values()],probability:null,hardEvidence:false,
    reason:'同一位置跨回合先后撞向相反方向，两次都没有同向助跑；优先核验树篱，保留墙、门和箱子解释。'});
  }
 }
 return result;
}
module.exports={analyze};
