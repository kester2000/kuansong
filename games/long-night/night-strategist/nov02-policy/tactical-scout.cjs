'use strict';
const {E}=require('./kernel.cjs');
const {edgeState}=require('./movement.cjs');
const {quietTerrain,moveInformation,informationAt}=require('./exploration.cjs');
const distance=(a,b,n)=>{const r=Math.abs(a.r-b.r),c=Math.abs(a.c-b.c);return Math.min(r,n-r)+Math.min(c,n-c);};
const repeated=(from,to,trace)=>trace.some((p,i)=>i&&trace[i-1].r===from.r&&trace[i-1].c===from.c&&p.r===to.r&&p.c===to.c);

// Search only confirmed corridors, then choose ONE uncertain frontier to probe.
// Distance beyond that frontier is a heuristic, never a claimed traversable route.
function scoutPlan(from,candidates,ctx,{round,trace=[],exploration=false,masked=false,steps=0,heartPresence=false,initiative=false,beforeFinish=false,activeFallback=false}={}){
 if(!exploration&&(round<=1||!candidates?.positions?.length))return null;
 const dist=p=>exploration?0:Math.min(...candidates.positions.map(q=>distance(p,q,ctx.n)));
 const params=ctx.experiment||{},travel=params.travelWeight??1,noiseWeight=params.noiseWeight??(initiative?0.25:1);
 const queue=[{...from,last:ctx.lastDirection,path:[],cost:0}],seen=new Set(),plans=[];
 while(queue.length){
  queue.sort((a,b)=>a.cost-b.cost);const p=queue.shift(),key=E.key(p.r,p.c)+':'+p.last;
  if(seen.has(key))continue;seen.add(key);
  if(p.path.length>=5)continue;
  for(let d=0;d<4;d++){
   const edge=edgeState(p,d,ctx,p.last);if(edge.blocked)continue;
   const to={r:E.mod(p.r+E.V[d][0],ctx.n),c:E.mod(p.c+E.V[d][1],ctx.n)},k=E.key(to.r,to.c);
   if(repeated(p,to,trace)||p.path.some(s=>s.r===to.r&&s.c===to.c)||to.r===from.r&&to.c===from.c)continue;
   const types=ctx.terrain.get(k)||[],portal=types.includes('PORTAL');
   if(types.some(t=>['TRAP','HEAT','HEART'].includes(t))||types.length===1&&portal)continue;
   const path=[...p.path,{...to,dir:d}],uncertain=edge.wall!=='空'||edge.uncertain||portal;
   const information=moveInformation(p,d,to,ctx);
   if(exploration?information>0:!ctx.visited.has(k)&&dist(to)<dist(from)){
    const beat=steps+path.length,hidden=path.length===1&&masked||heartPresence&&beat<=19&&(beat-1)%3===0;
    const noise=!ctx.silent&&!hidden&&types.some(t=>['GRASS','WATER','BERRY'].includes(t))?types.every(t=>['GRASS','WATER','BERRY'].includes(t))?22:18:0;
    const cost=p.cost+travel+(uncertain?3*(params.collisionWeight==null?1:params.collisionWeight/0.5):0)+(portal?3:0)+noise*noiseWeight;
    // Long ordinary exploration must earn its additional travel/exposure.
    // Tactical scouting is not subject to this exploration-only threshold.
    const quietFresh=beforeFinish&&!ctx.visited.has(k)&&information>0
      &&(!noise||hidden||ctx.silent||activeFallback);
    if(exploration&&!quietFresh&&cost>information*(params.informationWeight??1)*(initiative?3:2)/(1+steps/8))continue;
    const opening=exploration&&ctx.openingObjective?require('./opening-objective.cjs').openingEvaluation(to,from,ctx,true):null;
    const informationPreference=information*((params.informationWeight??1)-1)/(1+steps/8);
    plans.push({direction:path[0].dir,destination:to,cost,informationPreference,rank:cost-informationPreference+dist(to)*2*(params.targetWeight??1)+(ctx.hunters?stopAssessment(to,ctx.hunters,ctx).penalty*(params.hunterRiskWeight??1):0)+(opening?opening.proximity-opening.exitProgress:0),...(opening?{openingObjective:opening}:{}),remainingDistance:dist(to),uncertain,possiblePortal:portal,...(initiative?{initiative:true,exposureCost:noise}: {}),...(quietFresh?{beforeFinish:true}: {})});
   }
   const transit=quietTerrain(types,ctx.silent)||activeFallback&&types.length&&types.every(t=>['EMPTY','WATER','GRASS','BERRY'].includes(t));
   if(!uncertain&&transit)queue.push({...to,last:d,path,cost:p.cost+travel+(!ctx.silent&&types.some(t=>['WATER','GRASS','BERRY'].includes(t))?22*(params.noiseWeight??1):0)});
  }
 }
 plans.sort((a,b)=>a.rank-b.rank||a.destination.r-b.destination.r||a.destination.c-b.destination.c);
 return plans[0]||null;
}

// Conservative proximity indicator, not capture probability or proof of a route.
// Unknown hunter location is explicitly unknown, never a zero-risk certificate.
function stopAssessment(from,hunters,ctx){
 if(!hunters?.positions?.length)return {known:false,penalty:0,reason:'猎手位置未可靠定位，无法证明停点安全'};
 const nearest=Math.min(...hunters.positions.map(p=>distance(from,p,ctx.n)));
 return {known:true,nearest,penalty:nearest<=4?16/(nearest+1):0,
  reason:`猎手最近兼容位置环面距离 ${nearest} 格（未证明可达，不是被捕概率）`};
}
function saferRelocation(moves,from,hunters,ctx,trace=[]){
 const stop=stopAssessment(from,hunters,ctx);
 if(!stop.known||!stop.penalty)return {stop,move:null};
 const options=moves.filter(m=>!m.blocked&&!m.explorationForbidden&&m.wall==='空'&&quietTerrain(m.terrain,ctx.silent)
  &&!edgeState(from,m.dirIndex,ctx).uncertain&&!repeated(from,m.to,trace))
  .map(move=>({move,risk:stopAssessment(move.to,hunters,ctx)}))
  .filter(x=>stop.penalty-x.risk.penalty>=1).sort((a,b)=>a.risk.penalty-b.risk.penalty);
 return {stop,move:options[0]?.move||null,after:options[0]?.risk};
}
const continuationPlan=(from,ctx,options={})=>scoutPlan(from,null,ctx,{...options,exploration:true});
module.exports={scoutPlan,continuationPlan,stopAssessment,saferRelocation};
