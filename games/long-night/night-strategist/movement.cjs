'use strict';
const {E}=require('./kernel.cjs');
// Hedges are reported as empty by four-wall feedback but require momentum.
function edgeState(from,d,ctx,last=ctx.lastDirection,doorMask=0n){
 const edge=E.key(from.r,from.c)+':'+d,wall=ctx.walls.get(edge);
 const model=ctx.doorModel,door=model?.doors.get(model.edges.get(edge));
 if(door){let state=door.state;if(state!=='unknown'&&(doorMask&(1n<<BigInt(door.index))))state=state==='open'?'closed':'open';
  const blocked=state==='closed'||(state==='unknown'&&(door.blockedByBoard===true||door.blockedByObservation===true));
  return {wall:blocked?'墙':state==='open'?'空':undefined,blocked,kinds:state==='open'?[4]:state==='closed'?[3]:[3,4],hedge:false,uncertain:state==='unknown',door:true,reportedClosed:state==='unknown'&&door.blockedByObservation===true};
 }
 const kinds=ctx.wallKinds?.get(edge)||[];
 if(wall==='空'&&!kinds.includes(2))return {wall,blocked:false,kinds,hedge:false,uncertain:false};
 const pass=k=>k===0||k===4||(k===2&&last===d);
 // A possible hedge does not invalidate an observed collision: the edge
 // may still be a solid wall. Only a unanimously proven hedge can use momentum.
 const blocked=(wall==='墙'&&!(kinds.length===1&&kinds[0]===2)) || (kinds.length ? kinds.every(k=>!pass(k)) : false);
 const hedge=kinds.length===1&&kinds[0]===2;
 return {wall:hedge?'空':wall,blocked,kinds,hedge,uncertain:kinds.length>0&&kinds.some(pass)&&kinds.some(k=>!pass(k))};
}
module.exports={edgeState};
