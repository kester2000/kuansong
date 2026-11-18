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
 const {n,walls,terrain}=ctx,keyOf=p=>E.key(p.r,p.c)+':'+p.last+':'+p.doorMask;
 const start={...from,last:ctx.lastDirection??-1,doorMask:0n,cost:0,first:null,commands:[]};
 const dist=new Map([[keyOf(start),0]]),queue=[start];
 const deadline=Date.now()+80;let expanded=0;
 while(queue.length){queue.sort((a,b)=>a.cost-b.cost);const p=queue.shift();
  if(++expanded>5000||Date.now()>deadline)return null;
  if(p.cost!==dist.get(keyOf(p)))continue;
  if(p.r===target.r&&p.c===target.c)return {direction:p.first,cost:p.cost,commands:p.commands,arrivalDirection:p.last,arrivalDoorMask:String(p.doorMask)};
  for(let d=0;d<4;d++){
   const edge=edgeState(p,d,ctx,p.last,p.doorMask),wall=edge.wall;if(edge.blocked)continue;
   let r=E.mod(p.r+E.V[d][0],n),c=E.mod(p.c+E.V[d][1],n);const types=terrain.get(E.key(r,c))||[];
   const portal=ctx.portals?.get(E.key(r,c));
   if(ctx.confirmedOnly){
    let unsafe=false;
    for(const phase of ctx.solution?.phases||[]){
     const a=E.phaseAt(phase,n,r,c),domain=phase.domains[a.slot];
     if(!domain?.length||domain.some(m=>{const attach=(m.block||E.byId.get(m.id))?.cells[a.i]?.attach;
      return attach==='BOMB'||attach==='BUTTON'&&!ctx.doorModel?.buttons.has(E.key(r,c));})){unsafe=true;break;}
    }
    if(unsafe)continue;
   }
   if(ctx.quietOnly){
    // Candidate hunting must prove the whole route quiet, not just its first
    // step. Unknown terrain and portals do not provide that guarantee.
    if(wall!=='空'||edge.uncertain||!types.length||portal
      ||types.some(t=>t!=='EMPTY'&&!(ctx.silent&&['GRASS','WATER','BERRY'].includes(t)))
      ||ctx.doorModel?.buttons.has(E.key(r,c)))continue;
    let possibleButton=false;
    for(const phase of ctx.solution?.phases||[]){
     const rr=E.mod(r-phase.pr,n),cc=E.mod(c-phase.pc,n);
     const domain=phase.domains[E.phaseAt(phase,n,r,c).slot];
     if(!domain?.length){possibleButton=true;break;}
     if(domain.some(m=>(m.block||E.byId.get(m.id))?.cells[E.phaseAt(phase,n,r,c).i]?.attach==='BUTTON')){possibleButton=true;break;}
    }
    if(possibleButton)continue;
   }
   const exitEndpoint=r===target.r&&c===target.c&&ctx.exits?.cells.has(E.key(r,c));
   if(ctx.confirmedOnly&&(wall!=='空'||edge.uncertain||!types.length
     ||types.some(t=>!['EMPTY','GRASS','WATER','BERRY','PORTAL'].includes(t)&&!(exitEndpoint&&t==='EXIT'))
     ||edge.kinds.some(k=>k!==0&&k!==4&&!(k===2&&p.last===d))))continue;
   const doorMask=p.doorMask^(ctx.doorModel?.buttons.get(E.key(r,c))??0n);
   const captureEndpoint=target.target!=null&&r===target.r&&c===target.c;
   if(types.some(t=>(['TRAP','HEAT'].includes(t)&&!captureEndpoint)||t==='HEART'||t==='PORTAL'&&!portal))continue;
   if(portal){r=portal.r;c=portal.c;}
   const cost=p.cost+(wall==='空'&&!edge.uncertain?1:5)+(portal?2:0);
   // In subspace the two commands do not change map coordinates; the last
   // direction can be chosen freely and is preserved for hedge momentum.
   for(const last of portal?[d,...[0,1,2,3].filter(direction=>direction!==d)]:[d]){
    const key=keyOf({r,c,last,doorMask});if(cost>=(dist.get(key)??Infinity))continue;
    dist.set(key,cost);queue.push({r,c,last,doorMask,cost,first:p.first??d,commands:[...p.commands,d,...(portal?[d,last]:[])]});
   }
  }
 }
 return null;
}
function captureBatch(from,target,ctx){
 const route=routeTo(from,target,{...ctx,confirmedOnly:true});
 if(!route||!route.commands.length)return null;
 const finishDirection=require('./finish-turn.cjs').wallDirection(target,{...ctx,lastDirection:route.arrivalDirection,finishDoorMask:BigInt(route.arrivalDoorMask||'0')});
 const commands=[...route.commands,...(finishDirection==null?[]:[finishDirection])];
 if(commands.length<2)return null;
 return {confirmed:true,commands:commands.map(d=>['上','下','左','右'][d]).join(''),
  target:{r:target.r,c:target.c},direction:route.direction,
  ...(finishDirection==null?{}:{finish:{kind:'wall',direction:finishDirection,at:{r:target.r,c:target.c}}})};
}
function pursuitStep(from,target,ctx){return routeTo(from,target,ctx)?.direction??null;}
module.exports={locateTarget,pursuitStep,routeTo,captureBatch};
