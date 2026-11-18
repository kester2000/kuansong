'use strict';
const {E,M,A}=require('./kernel.cjs');
const {edgeState}=require('./movement.cjs');
const {hasCurrentAmbiguity}=require('./active-frame.cjs');

// An exact same-cell sound anchors only its instant. Replay the known suffix,
// rejecting hidden moves, subsequent sounds/portals, and incomplete turns.
function locateTarget({built,team,journal}) {
 const self=built.self,view=built.views[self],n=view.model.config.size;
 const target=A.status(built).find(p=>p.id===self)?.target;
 if(target==null||target===self||!built.players[target]?.alive||view.ambiguities.length||team?.conflict)return null;
 const routes=new Map(),rounds=new Map();
 for(const [index,m] of M.liveMessages(journal?.messages||[]).entries())for(const item of M.parse(m.text).items){
  if(item.kind!=='trajectory')continue;
  const round=item.round??((rounds.get(item.player)||0)+1);if(!item.partial)rounds.set(item.player,round);
  const key=item.player+':'+round,old=routes.get(key);if(old&&!old.partial&&item.partial)continue;
  routes.set(key,{...item,round,index});
 }
 const ownNode=team?.nodes?.find(x=>x.id===self+':'+view.model.active);
 if(ownNode?.fusionConflict)return null;
 const candidates=(view.hears||[]).filter(h=>h.b===target&&h.direction==='同格'&&h.segment===view.model.active&&h.step!=null).slice().reverse();
 for(const h of candidates){
  const all=[...routes.values()].filter(r=>r.player===target).sort((a,b)=>a.round-b.round);
  const anchor=all.find(r=>h.round!=null?r.round===h.round:r.index>=h.index);
  if(!anchor)continue;
  if(anchor.tokens.some(t=>t.kind==='hidden') || anchor.tokens.filter(t=>t.kind==='move').length<h.step)continue;
  const suffix=all.filter(r=>r.round>=anchor.round);
  if(suffix.some((r,i)=>r.partial||r.round!==anchor.round+i))continue;
  let pos={...h.listener},valid=true;const edges=[];
  for(const route of suffix){let step=0;
   for(const token of route.tokens){
    if(token.kind==='move')step++;
    if(route.round===anchor.round&&step<=h.step)continue;
    if(token.kind!=='move'||token.masked||token.sound||token.terrain||!['move','hit'].includes(token.outcome)){valid=false;break;}
    edges.push({...pos,dir:token.dir,value:token.outcome==='hit'?'墙':'空'});
    if(token.outcome==='move'){pos.r=E.mod(pos.r+E.V[token.dir][0],n);pos.c=E.mod(pos.c+E.V[token.dir][1],n);}
   }
   if(!valid)break;
  }
  if(valid)return {target,...pos,round:suffix.at(-1).round,source:'same-cell-sound',anchor:{round:anchor.round,step:h.step},edges};
 }
 const other=built.views[target],last=other.roundEnds.at(-1);
 const joined=ownNode?.joined?.find(j=>j.id===target+':'+other.model.active);
 const otherNode=team?.nodes?.find(n=>n.id===joined?.id);
 if(!joined||ownNode?.verification?.status!=='verified'||otherNode?.verification?.status!=='verified'||hasCurrentAmbiguity(other,otherNode)||!last?.complete||last.locatable===false||last.inSpace||last.segment!==other.model.active||otherNode?.routePending)return null;
 const p=E.replay(other.model.segments[other.model.active],n);
 return {target,r:E.mod(p.r+joined.dr,n),c:E.mod(p.c+joined.dc,n),round:last.round,source:'aligned-map',edges:[]};
}

function routeTo(from,target,ctx){
 const {n,walls,terrain}=ctx,keyOf=p=>E.key(p.r,p.c)+':'+p.last+':'+(p.doorMask||0n);
 const start={...from,last:ctx.lastDirection??-1,doorMask:0n,cost:0,first:null,commands:[],risk:{unknownEdges:0,unknownTerrain:0,portalTransits:0,steps:0}};
 const dist=new Map([[keyOf(start),0]]),queue=[{...start,rank:0}];
 const deadline=Date.now()+60;let expanded=0;
 while(queue.length){queue.sort((a,b)=>a.rank-b.rank);const p=queue.shift();
  if(++expanded>5000||Date.now()>deadline)return null;
  if(p.rank!==dist.get(keyOf(p)))continue;
  if(p.r===target.r&&p.c===target.c)return {direction:p.first,cost:p.cost,commands:p.commands,risk:p.risk,...(p.landmark?{landmark:p.landmark}:{})};
  for(let d=0;d<4;d++){
   if(ctx.excludedEdges?.has(E.key(p.r,p.c)+':'+d))continue;
   const edge=edgeState(p,d,ctx,p.last,p.doorMask),wall=edge.wall;if(edge.blocked)continue;
   let r=E.mod(p.r+E.V[d][0],n),c=E.mod(p.c+E.V[d][1],n);const types=terrain.get(E.key(r,c))||[];
   const portal=ctx.portals?.get(E.key(r,c));
   if(ctx.brawl&&types.includes('EXIT'))continue;
   const podEndpoint=ctx.escapeRoute&&r===target.r&&c===target.c&&ctx.exits.cells.has(E.key(r,c))
     &&types.includes('EXIT')&&types.every(t=>t==='EXIT'||t==='EMPTY');
   if(ctx.confirmedOnly&&(wall!=='空'||edge.uncertain||!types.length
     ||(!podEndpoint&&types.some(t=>!['EMPTY','GRASS','WATER','BERRY','PORTAL'].includes(t)))
     ||edge.kinds.some(k=>k!==0&&k!==4&&!(k===2&&p.last===d))))continue;
   const arrivalKey=E.key(r,c),buttonMask=ctx.doorModel?.buttons.get(arrivalKey);
   const possibleButton=ctx.features&&require('./objective-policy.cjs').features(ctx,{r,c}).attachments.has('BUTTON');
   // An unknown button may change later edges. Do not plan past it using
   // a static graph; a known switch is part of the search state instead.
   if(possibleButton&&buttonMask==null&&(r!==target.r||c!==target.c))continue;
   const doorMask=p.doorMask^(buttonMask??0n);
   const captureEndpoint=target.target!=null&&r===target.r&&c===target.c;
   if(types.some(t=>(['TRAP','HEAT'].includes(t)&&!captureEndpoint)||t==='HEART'||t==='PORTAL'&&!portal))continue;
   const landmark=p.landmark||ctx.landmarks?.get(E.key(p.r,p.c)+':'+d)||ctx.landmarks?.get(E.key(r,c));
   if(portal){r=portal.r;c=portal.c;}
   const unknown=wall!=='空'||edge.uncertain;
   const risk={unknownEdges:p.risk.unknownEdges+Number(unknown),unknownTerrain:p.risk.unknownTerrain+Number(!types.length),portalTransits:p.risk.portalTransits+Number(!!portal),steps:p.risk.steps+1+(portal?2:0)};
   const cost=p.cost+1+(unknown?8:0)+(!types.length?2:0)+(portal?2:0);
   // In subspace the two commands do not change map coordinates; the last
   // direction can be chosen freely and is preserved for hedge momentum.
   for(const last of portal?[0,1,2,3]:[d]){
    // One tie-break per route. Passing the landmark again earns nothing.
    const rank=cost-(landmark?0.5:0);
    const key=keyOf({r,c,last,doorMask});if(rank>=(dist.get(key)??Infinity))continue;
    dist.set(key,rank);queue.push({r,c,last,doorMask,cost,rank,landmark,first:p.first??d,risk,commands:[...p.commands,d,...(portal?[d,last]:[])]});
   }
  }
 }
 return null;
}
function captureBatch(from,target,ctx){
 const route=routeTo(from,target,{...ctx,confirmedOnly:true});
 if(!route||!route.commands.length)return null;
 const finishDirection=ctx.captureOnArrival?null:require('./finish-turn.cjs').captureFinishDirection(target,ctx,route.commands.at(-1));
 const commands=[...route.commands,...(finishDirection==null?[]:[finishDirection])];
 if(commands.length<2)return null;
 return {confirmed:true,commands:commands.map(d=>['上','下','左','右'][d]).join(''),
  target:{r:target.r,c:target.c},direction:route.direction,risk:route.risk,
  ...(finishDirection==null?{}:{finish:{kind:edgeState(target,finishDirection,ctx,route.commands.at(-1)).hedge?'hedge':'wall',direction:finishDirection,at:{r:target.r,c:target.c}}})};
}
function pursuitStep(from,target,ctx){return routeTo(from,target,ctx)?.direction??null;}
module.exports={locateTarget,pursuitStep,routeTo,captureBatch};
