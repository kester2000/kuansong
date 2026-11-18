'use strict';
const {E}=require('./kernel.cjs');

// Describe hypotheses already compatible with THIS player's notebook. No
// complete-map sample frequencies, hidden opponent messages or new alignment.
function pathBlocks(input,{maxVisits=2048}={}){
 const {built,team}=input;if(!built||!team)return {players:[],truncated:false};
 const collisions=require('../collision-hypotheses.cjs').analyze(input);
 let visits=0,truncated=false;const players=[];
 for(let player=0;player<built.views.length;player++){
  const view=built.views[player];if(!view?.model)continue;
  const segment=view.model.active,node=team.nodes?.find(n=>n.id===player+':'+segment);
  const solution=node?.solution;if(!solution?.phases?.length||solution.irregular)continue;
  const at=E.replay(view.model.segments[segment],view.model.config.size),n=view.model.config.size;
  const trace=(at.trace||[]).slice(-10),points=[...new Map(trace.map(p=>[E.key(p.r,p.c),p])).values()];
  if(points.length<2)continue;
  const hypotheses=new Map();
  outer:for(const phase of solution.phases){
   const slots=new Map();for(const p of points){const a=E.phaseAt(phase,n,p.r,p.c);if(a.slot<0)continue;if(!slots.has(a.slot))slots.set(a.slot,[]);slots.get(a.slot).push(p);}
   for(const [slot,cells] of slots){if(cells.length<2)continue;
    const anchor=cells[0],a=E.phaseAt(phase,n,anchor.r,anchor.c),origin={r:E.mod(anchor.r-Math.floor(a.i/3),n),c:E.mod(anchor.c-a.i%3,n)};
    for(const m of phase.domains[slot]||[]){
     if(++visits>maxVisits){truncated=true;break outer;}
     const id=String(m.id??m.block?.id),key=id+':'+origin.r+':'+origin.c;
     const h={blockId:id,origin,cellsExplained:cells.length,observedCells:cells.map(p=>({r:p.r,c:p.c})),basis:'compatible-local-domain',probability:null};
     if(!hypotheses.has(key)||hypotheses.get(key).cellsExplained<h.cellsExplained)hypotheses.set(key,h);
    }
   }
  }
  const preferred=new Set(collisions.filter(h=>h.frame===node.id).flatMap(h=>h.candidates.map(c=>c.blockId+'@'+E.key(c.origin.r,c.origin.c))));
  const candidates=[...hypotheses.values()].map(h=>({...h,collisionPriority:preferred.has(h.blockId+'@'+E.key(h.origin.r,h.origin.c))?1:0})).sort((a,b)=>b.collisionPriority-a.collisionPriority||b.cellsExplained-a.cellsExplained||a.blockId.localeCompare(b.blockId)||a.origin.r-b.origin.r||a.origin.c-b.origin.c);
  players.push({player,segment,frame:node.id,ambiguous:!!view.ambiguities?.length||!!node.routePending||!!team.conflict,trace:trace.map(p=>({r:p.r,c:p.c})),candidates:candidates.slice(0,12),omitted:Math.max(0,candidates.length-12),interpretation:'优先核验解释更多当前路径的局部区块假设；不是概率，不跨待定传送拼图'});
  if(truncated)break;
 }
 return {players,collisionHypotheses:collisions,truncated,visits:Math.min(visits,maxVisits),maxVisits};
}

// IDs are sets of competing explanations, never equiprobable outcomes.
// Multiple phases placing the same ID must not inflate its support.
function partition(rows,{complete,masked=false,silent=false}={}){
 if(!complete||!rows.length)return {complete:false,ids:[],outcomes:[],guaranteedElimination:0};
 const ids=new Set(),groups=new Map();
 for(const row of rows){if(row.id==null)continue;const id=String(row.id);ids.add(id);
  for(let cue of row.cues){if((masked||silent)&&['PAPA','SHA','BERRY'].includes(cue))cue='QUIET';if(!groups.has(cue))groups.set(cue,new Set());groups.get(cue).add(id);}
 }
 const outcomes=[...groups].map(([cue,set])=>({cue,ids:[...set].sort()}));
 return {complete:true,ids:[...ids].sort(),outcomes,guaranteedElimination:ids.size?ids.size-Math.max(0,...outcomes.map(o=>o.ids.length)):0,probability:null};
}
module.exports={pathBlocks,partition};
