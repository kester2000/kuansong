'use strict';
const {E,A}=require('./kernel.cjs');
const {routeTo}=require('./pursuit.cjs');
const {hasCurrentAmbiguity}=require('./active-frame.cjs');

// Pair offsets are exhaustive relative placements, not sampled complete maps.
// Keep unproved-but-compatible offsets; their frequency is not probability.
function targetCandidates(input,ownRound,player){
 const {built,team}=input;
 const self=built.self,view=built.views[self],target=player??A.status(built).find(p=>p.id===self)?.target;
 const other=built.views[target];
 if(target==null||target===self||!built.players[target]?.alive||!other||view.ambiguities.length||view.localExit||team?.conflict)return null;
 const sound=require('./sound-target.cjs').soundTargetCandidates(input,ownRound,target);
 const activeNode=team?.nodes?.find(n=>n.id===target+':'+other.model.active);
 if(hasCurrentAmbiguity(other,activeNode)||team?.jointStatus!=='complete')return sound;
 const last=other.roundEnds.at(-1);
 const expectedRound=target<self?ownRound:ownRound-1;
 if(!last?.complete||last.locatable===false||last.inSpace||last.segment!==other.model.active||last.round!==expectedRound)return sound;
 const a=self+':'+view.model.active,b=target+':'+other.model.active;
 const ownNode=team.nodes.find(n=>n.id===a),otherNode=team.nodes.find(n=>n.id===b);
 if(!ownNode||!otherNode||[ownNode,otherNode].some(n=>n.routePending||n.fusionConflict||n.verification?.status==='impossible'))return sound;
 const pair=team.pairs?.find(p=>p.a===a&&p.b===b||p.b===a&&p.a===b);
 if(!pair?.offsets?.length)return sound;
 const n=view.model.config.size,at=E.replay(other.model.segments[other.model.active],n),positions=new Map();
 let offsets=pair.offsets;
 if(team.combined?.complete){
  const supported=new Set(team.combined.cases.filter(c=>c.layouts?.length).flatMap(c=>{
   const x=c.joined.find(j=>j.id===pair.a),y=c.joined.find(j=>j.id===pair.b);
   return x&&y?[E.key(E.mod(y.dr-x.dr,n),E.mod(y.dc-x.dc,n))]:[];
  }));
  offsets=offsets.filter(o=>supported.has(E.key(o.dr,o.dc)));
 }
 const sign=pair.a===a?1:-1;
 for(const o of offsets){const r=E.mod(at.r+sign*o.dr,n),c=E.mod(at.c+sign*o.dc,n);positions.set(E.key(r,c),{r,c});}
 if(!positions.size||positions.size>8)return sound;
 return {target,round:last.round,positions:[...positions.values()],source:'candidate-alignment',exhaustive:true,proof:'compatible-placements',frame:a};
}

function candidatePlan(from,candidates,ctx,{round,steps}={}){
 if(!candidates||round<=1)return null;
 const distance=(a,b)=>{const dr=Math.abs(a.r-b.r),dc=Math.abs(a.c-b.c);return Math.min(dr,ctx.n-dr)+Math.min(dc,ctx.n-dc);};
 const here=candidates.positions.find(p=>p.r===from.r&&p.c===from.c);
 if(here&&steps>=1)return {kind:'attempt-capture',destination:here,direction:null,cost:1,candidates};
 const routes=[];
 for(const p of candidates.positions){
  // No `target` field: a possible trap occupant does not authorize entering
  // hazardous ground. That exception belongs only to confirmed capture.
  const route=routeTo(from,p,{...ctx,quietOnly:true});
  if(!route||route.direction==null||route.cost>ctx.n*3)continue;
  const spread=Math.max(...candidates.positions.map(q=>distance(p,q)));
  routes.push({...route,destination:p,rank:route.cost+spread*0.25});
 }
 routes.sort((a,b)=>a.rank-b.rank||a.destination.r-b.destination.r||a.destination.c-b.destination.c);
 if(!routes.length)return null;
 return {...routes[0],kind:'pursue-candidates',cost:routes[0].cost+1,candidates};
}
module.exports={targetCandidates,candidatePlan};
