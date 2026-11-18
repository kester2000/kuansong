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
   return {...at,n:v.model.config.size};
  }
  const audibleEntry=require('./local-exit.cjs').turnFacts(input.journal,self,a.round).moves[a.step-1]?.sound==='PAPA';
  if((!a.maskedUnknown&&!audibleEntry)||a.recoveryUnknown||a.silentUnknown)return null;
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
  const traversals=(at.trace||[]).filter((p,i,a)=>i&&a[i-1].r===at.r&&a[i-1].c===at.c&&p.r===to.r&&p.c===to.c).length;
  m.branchRisk={groundPossible:true,wall,visits,traversals};
  if(wall||traversals>=2){
   m.explorationForbidden=true;
   m.risks.push(wall?'未传送分支中该方向是已知墙，探索不重复试撞':'未传送分支中已重复走过此边，禁止跨回合无目标循环');
  }else if(visits){
   // Placeholder terrain must not earn "new cell" credit for an old return.
   m.score-=(m.evaluation?.information||0)+8+visits*2;
   m.reasons.push('未传送分支中是旧格折返，取消临时坐标系产生的新格奖励');
  }
 }
}
// Even if consecutive portal ambiguities erase the spatial trace, the last
// two public commands are still available. On the ground branch reversing
// immediately revisits the sound; in transit the direction is immaterial.
function rankSoundReturn(moves,facts){
 if(!facts.continuous||facts.moves.length<2)return;
 const [source,away]=facts.moves.slice(-2);
 if(source.outcome!=='move'||source.sound!=='PAPA'||away.outcome!=='move'||away.sound||away.terrain)return;
 const reverse=[1,0,3,2][away.dir];
 const open=moves.filter(m=>!m.blocked&&!m.explorationForbidden);
 const back=open.find(m=>m.dirIndex===reverse);
 if(!back||!open.some(m=>m!==back&&m.score>=back.score))return;
 back.score-=Math.max(0,back.evaluation?.information||0)+8;
 back.reasons.unshift('刚离开啪嗒声源：若仍在地面，立即折返会重踩发声格；优先尝试同等可行的其他方向');
}
module.exports={groundHistory,constrainBranchExploration,rankSoundReturn};
