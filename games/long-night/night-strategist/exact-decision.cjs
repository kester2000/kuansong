'use strict';
const {E}=require('./kernel.cjs');
const {fraction,add,multiply,divide}=require('./exact-birth.cjs');
const ZERO=[0n,1n],ONE=[1n,1n];

// Generator over a regular tiling's domain assignments. Check a seam only
// after both owners are known, including when both cells are in the same tile.
function* compatibleAssignments({phase,n,exitCount,observations=[],dynamicDoors=false,search=null}){
 const location=(r,c)=>{
  const {slot,i}=E.phaseAt(phase,n,r,c);return {slot,cell:i};
 };
 const owners=phase.domains.map(()=>[]);owners[-1]=[];
 for(const o of observations){
  const directions=o.kind==='walls'?[0,1,2,3]:['pass','hit'].includes(o.kind)?[o.dir]:[];
  for(const d of directions){
   if(o.kind==='walls'&&o.value[d]==='?')continue;
   const a=location(o.r,o.c),b=location(o.r+E.V[d][0],o.c+E.V[d][1]);
   const test={a,b,d,o};owners[a.slot].push(test);if(b.slot!==a.slot)owners[b.slot].push(test);
  }
 }
 const order=phase.domains.map((_,i)=>i).sort((a,b)=>phase.domains[a].length-phase.domains[b].length||owners[b].length-owners[a].length);
 const chosen=[],used=new Set();chosen[-1]=phase.domains[-1]?.[0];
 function consistent(slot){
  return owners[slot].every(({a,b,d,o})=>{
   if(!chosen[a.slot]||!chosen[b.slot])return true;
   const left=chosen[a.slot].block.cells[a.cell],right=chosen[b.slot].block.cells[b.cell];
   const wall=Math.max(left.walls[d],right.walls[E.OPP[d]]);
   const kinds=dynamicDoors&&[3,4].includes(wall)?[3,4]:[wall];
   return kinds.some(k=>E.edgeFits(k,o,d,E.hasBoxes(chosen[b.slot].block)));
  });
 }
 function* visit(depth,exits){
  if(search){
   if(search.aborted)return;
   search.nodes=(search.nodes||0)+1;
   if(search.nodes>search.maxNodes||Date.now()>=search.deadline){search.aborted=true;search.reason='搜索预算用尽，未归一化部分结果';return;}
  }
  if(exitCount!=null&&(exits>exitCount||exits+order.length-depth<exitCount))return;
  if(depth===order.length){
   if(search){search.layouts=(search.layouts||0)+1;if(search.layouts>search.maxLayouts){search.aborted=true;search.reason='相容布局尚未全部求和，未归一化部分结果';return;}}
   yield chosen.slice();return;
  }
  const slot=order[depth];
  for(const m of phase.domains[slot]){
   if(used.has(m.id))continue;
   chosen[slot]=m;used.add(m.id);
   if(consistent(slot))yield* visit(depth+1,exits+Number(m.id.startsWith('E')));
   used.delete(m.id);chosen[slot]=null;
   if(search?.aborted)return;
  }
 }
 if(consistent(-1))yield* visit(0,0);
}

// A strategy changes only the action simulator and utilities; all actions
// must integrate over the same posterior. Each branch can carry conditional
// randomness (e.g. an event). Never normalize a partially exhausted iterator.
function exactDecision(worlds,actions,evaluate){
 let evidence=ZERO;
 const results=actions.map(command=>({command,mass:new Map(),reward:new Map()}));
 for(const {state,weight} of worlds){
  if(weight[0]<0n||weight[1]<=0n)throw Error('Invalid world mass');
  if(!weight[0])continue;
  evidence=add(evidence,weight);
  for(const result of results){
   let conditional=ZERO;
   for(const {feedback,chance=ONE,utility} of evaluate(state,result.command)){
    if(chance[0]<0n||chance[1]<=0n)throw Error('Invalid branch mass');
    conditional=add(conditional,chance);
    const mass=multiply(weight,chance);
    result.mass.set(feedback,add(result.mass.get(feedback)||ZERO,mass));
    result.reward.set(feedback,add(result.reward.get(feedback)||ZERO,multiply(mass,utility)));
   }
   if(conditional[0]!==conditional[1])throw Error('Incomplete action outcomes');
  }
 }
 if(!evidence[0])throw Error('No compatible world');
 return results.map(({command,mass,reward})=>{
  const outcomes=[...mass].filter(([,w])=>w[0]).map(([feedback,w])=>({
   feedback,probability:divide(w,evidence),utility:divide(reward.get(feedback),w),contribution:divide(reward.get(feedback),evidence)
  }));
  return {command,outcomes,value:outcomes.reduce((sum,o)=>add(sum,o.contribution),ZERO)};
 }).sort((a,b)=>{const diff=b.value[0]*a.value[1]-a.value[0]*b.value[1];return diff>0n?1:diff<0n?-1:0;});
}
module.exports={compatibleAssignments,exactDecision};
