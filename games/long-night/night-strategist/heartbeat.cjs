'use strict';
const {E}=require('./kernel.cjs');
const {edgeState}=require('./movement.cjs');
// Source rule: per-turn steps 1,4,...,19. Only acoustic exposure is masked.
function heartbeatPlan(from,ctx,steps,all=false){
 if(!ctx.heartPresence||ctx.silent)return null;
 const next=steps+1,beat=next+((1-next%3+3)%3);
 if(beat>19)return null;
 const length=beat-steps;
 const needsPadding=length>1;
 if(needsPadding&&(!ctx.allowPadding||ctx.paddingUsed))return null;
 const plans=[];
 function walk(p,last,path){
  for(let d=0;d<4;d++){
   const edge=edgeState(p,d,ctx,last);if(edge.blocked||edge.uncertain||edge.wall!=='空')continue;
   if(needsPadding&&(edge.kinds.length!==1||edge.kinds[0]!==0))continue;
   const to={r:E.mod(p.r+E.V[d][0],ctx.n),c:E.mod(p.c+E.V[d][1],ctx.n)},k=E.key(to.r,to.c),types=ctx.terrain.get(k)||[];
   const route=[...path,d];
   if(route.length===length){
    if(types.length<2||types.some(t=>!['EMPTY','WATER','GRASS','BERRY','PORTAL'].includes(t)))continue;
    if(!types.some(t=>['WATER','GRASS','BERRY','PORTAL'].includes(t))||ctx.visited?.has(k))continue;
    plans.push({directions:route,destination:to,beat,padding:length-1,steps,
     ...(needsPadding?{batchConfirmed:true}:{})});
   }else if(types.length===1&&types[0]==='EMPTY'&&ctx.visited?.has(k)&&require('./pruned-routes.cjs').plainPrefix(ctx,to))walk(to,d,route);
  }
 }
 walk(from,ctx.lastDirection,[]);
 return all?plans:plans[0]||null;
}
// Validate the planned probe against the actor's actual step before dispatch.
function heartbeatCommand(plan,round,steps,first,paddingRound){
 const dirs=plan.directions;
 if(paddingRound===round||plan.round!==round||plan.steps!==steps||
    plan.batchConfirmed!==true||!Array.isArray(dirs)||![2,3].includes(dirs.length)||
    plan.padding!==dirs.length-1||plan.beat!==steps+dirs.length||
    plan.beat>19||plan.beat%3!==1||!dirs.every(d=>Number.isInteger(d)&&d>=0&&d<4))return null;
 const command=dirs.map(d=>'上下左右'[d]).join('');
 return command[0]===first?command:null;
}
function portalHeartbeatPause(view,steps){
 if(view.model.config.heartPresence!==true||view.model.config.silent||view.ambiguities?.length||view.space?.remaining!==1||steps<2)return null;
 const events=view.model.segments[view.model.active].events;
 const link=events.findLastIndex(e=>e.kind==='observe'&&e.portalLink);
 const entry=events.slice(0,link).findLast(e=>e.kind==='move'&&e.outcome==='move');
 const entryStep=entry?.clock?.step;
 if(link<0||!entryStep||entryStep>19||(entryStep-1)%3!==0)return null;
 if(steps+1<=19&&steps%3===0)return null; // exiting now is already masked
 return {remaining:1,entryStep,entryMasked:true,nextExitStep:1};
}
module.exports={heartbeatPlan,portalHeartbeatPause,heartbeatCommand};
