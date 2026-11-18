'use strict';
const K=require('./kernel.cjs'),{E}=K;

// A possible ground branch is a risk constraint, not a resolved position.
// Never expose its coordinates as facts, merge its map, or use it for pursuit.
function groundHistory(input){
 const self=input.built.self,view=input.built.views[self];
 if(view.localExit||!view.ambiguities.length||!input.journal)return null;
 const choices=E.clone(input.built.resolvedChoices||{});
 let built=input.built;
 for(let i=0;i<8;i++){
  const v=built.views[self],a=v.ambiguities[0];
  if(!a){
   if(v.model.active!==view.ambiguities[0].segment)return null;
   const at=E.replay(v.model.segments[v.model.active],v.model.config.size);
   const last=v.roundEnds.at(-1),round=last?last.round+(last.complete?1:0):1;
   const events=v.model.segments[v.model.active].events;
   const steps=events.filter(e=>e.kind==='move'&&e.outcome==='move'&&e.clock?.round===round).length;
   return {...at,n:v.model.config.size,turnTrace:(at.trace||[]).slice(-(steps+1))};
  }
  if(!a.maskedUnknown||a.recoveryUnknown||a.silentUnknown)return null;
  choices[self]={...(choices[self]||{}),[a.key]:{kind:'ground'}};
  built=K.build(input.journal,choices);
 }
 return null;
}
function constrainBranchExploration(moves,input){
 const at=groundHistory(input);if(!at)return;
 for(const m of moves){
  if(m.blocked)continue;
  const d=m.dirIndex,to={r:E.mod(at.r+E.V[d][0],at.n),c:E.mod(at.c+E.V[d][1],at.n)};
  let wall=false;
  for(const o of at.observations||[]){
   const here=o.r===at.r&&o.c===at.c,other=o.r===to.r&&o.c===to.c,op=[1,0,3,2][d];
   if(o.kind==='walls'&&(here||other))wall=o.value[here?d:op]==='墙';
   if(['hit','pass'].includes(o.kind)&&(here&&o.dir===d||other&&o.dir===op))wall=o.kind==='hit';
  }
  const visits=(at.trace||[]).filter(p=>p.r===to.r&&p.c===to.c).length;
  const traversals=(at.turnTrace||[]).filter((p,i,a)=>i&&a[i-1].r===at.r&&a[i-1].c===at.c&&p.r===to.r&&p.c===to.c).length;
  m.branchRisk={groundPossible:true,wall,visits,traversals};
  if(wall){
   m.explorationForbidden=true;
   m.risks.push('未传送分支中该方向是已知墙，探索不重复试撞');
  }else if(visits){
   // Placeholder terrain must not earn "new cell" credit for an old return.
   m.score-=(m.evaluation?.information||0)+8+visits*2+traversals*16;
   m.reasons.push('未传送分支中是旧格折返，取消临时坐标系产生的新格奖励');
   if(traversals>=2)m.reasons.push('条件分支中的重复只扣分，不永久封死通道；收到下一格反馈后重新选择');
  }
 }
}
module.exports={groundHistory,constrainBranchExploration};
