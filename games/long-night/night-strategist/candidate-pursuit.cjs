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
 // Keep observations relative to the endpoint. Each possible alignment
 // translates the same public route to a different part of our own map.
 const landmarks=at.observations.filter(o=>o.clock?.round===last.round&&o.clock.player===target&&
   (o.kind==='pass'||(o.kind==='sound'&&o.value==='SHASHA')))
   .map(o=>({dr:o.r-at.r,dc:o.c-at.c,kind:o.kind,dir:o.dir}));
 return {target,round:last.round,positions:[...positions.values()],landmarks,source:'candidate-alignment',exhaustive:true,proof:'compatible-placements',frame:a};
}

function routeLandmarks(endpoint,candidates,ctx){
 const landmarks=new Map();
 for(const o of candidates.landmarks||[]){
  const cell=E.key(E.mod(endpoint.r+o.dr,ctx.n),E.mod(endpoint.c+o.dc,ctx.n));
  if(o.kind==='pass'){
   const edge=cell+':'+o.dir;
   if(ctx.traversals?.has(edge))landmarks.set(edge,'复走双方可能重合的已知通路');
  }else{
   const types=ctx.terrain.get(cell)||[];
   const grassy=t=>t==='GRASS'||t==='BERRY';
   if(!ctx.silent&&types.some(grassy)&&types.some(t=>!grassy(t)))landmarks.set(cell,'沿途核验候选路线的草声落点');
  }
 }
 return landmarks;
}

function canFinishAt(p,ctx){
 return require('./finish-turn.cjs').wallDirection(p,ctx)!=null||[0,1,2,3].every(d=>{
  const e=require('./movement.cjs').edgeState(p,d,ctx);
  return e.wall==='空'&&!e.blocked&&e.kinds.length===1&&e.kinds[0]===0;
 });
}
function candidatePlan(from,candidates,ctx,{round,steps,usedHuntEdges,turnArrivals}={}){
 if(!candidates||round<=1)return null;
 const distance=(a,b)=>{const dr=Math.abs(a.r-b.r),dc=Math.abs(a.c-b.c);return Math.min(dr,ctx.n-dr)+Math.min(dc,ctx.n-dc);};
 const here=candidates.positions.find(p=>p.r===from.r&&p.c===from.c);
 if(here&&steps>=1&&canFinishAt(from,ctx))return {kind:'attempt-capture',destination:here,direction:null,cost:1,candidates};
 const routes=[];
 for(const p of candidates.positions){
  // Revisiting a speculative endpoint from another side does not create a
  // finishing action. Keep it in the evidence, and reconsider on new walls.
  if(turnArrivals?.has(E.key(p.r,p.c))&&!canFinishAt(p,ctx))continue;
  // No `target` field: a possible trap occupant does not authorize entering
  // hazardous ground. That exception belongs only to confirmed capture.
  const route=routeTo(from,p,{...ctx,excludedEdges:usedHuntEdges,landmarks:routeLandmarks(p,candidates,ctx)});
  if(!route||route.direction==null||(route.risk?.steps??route.cost)>ctx.n*3)continue;
  const spread=Math.max(...candidates.positions.map(q=>distance(p,q)));
  // Reaching a possible target is only half the attempt. At similar cost,
  // prefer the square where the current evidence also permits ending the turn.
  const finishKnown=canFinishAt(p,ctx);
  routes.push({...route,destination:p,finishKnown,rank:route.cost+(finishKnown?0:1)+spread*0.25-(route.landmark?0.5:0)+(ctx.hunters?require('./tactical-scout.cjs').stopAssessment(p,ctx.hunters,ctx).penalty:0)});
 }
 routes.sort((a,b)=>a.rank-b.rank||a.destination.r-b.destination.r||a.destination.c-b.destination.c);
 if(!routes.length)return null;
 return {...routes[0],kind:'pursue-candidates',cost:routes[0].cost+1,candidates};
}
module.exports={targetCandidates,candidatePlan};
