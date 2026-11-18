'use strict';
const {E}=require('./kernel.cjs');
const {edgeState}=require('./movement.cjs');
const {quietTerrain}=require('./exploration.cjs');
function wallDirection(from,ctx){
 for(let d=0;d<4;d++){
  const e=edgeState(from,d,ctx,ctx.lastDirection,ctx.finishDoorMask??0n);
  if(e.blocked&&!e.uncertain&&e.wall==='墙'&&(!e.kinds.length||e.kinds.every(k=>k===1||k===3)))return d;
 }
 return null;
}
function collisionMove(moves,from,ctx){
 const d=wallDirection(from,ctx);if(d==null)return null;
 const m=moves.find(m=>m.dirIndex===d);if(!m)return null;
 return {...m,to:{...from},intentionalCollision:true,reasons:['撞已确认实墙结束本回合，保留当前位置并获取墙壁反馈'],gains:[],risks:[]};
}
// A short, proven quiet route to a wall is a concrete finishing objective,
// not exploration. Do not loop or traverse uncertain/hazardous cells for it.
function wallFinishPlan(from,moves,ctx,trace=[]){
 const collision=collisionMove(moves,from,ctx);if(collision)return {primary:collision,method:'wall'};
 const queue=[{...from,last:ctx.lastDirection,path:[]}],seen=new Set();
 while(queue.length){
  const p=queue.shift(),key=E.key(p.r,p.c);if(seen.has(key))continue;seen.add(key);
  if(p.path.length&&wallDirection(p,ctx)!=null){
   const primary=moves.find(m=>m.dirIndex===p.path[0]);
   return {primary:{...primary,reasons:[`沿已确认安静通道前往撞墙结束点，共 ${p.path.length} 步；每步重算`],gains:[],risks:[]},method:'wall-route',destination:{r:p.r,c:p.c}};
  }
  if(p.path.length>=5)continue;
  for(let d=0;d<4;d++){
   const e=edgeState(p,d,ctx,p.last);if(e.blocked||e.uncertain||e.wall!=='空')continue;
   const to={r:E.mod(p.r+E.V[d][0],ctx.n),c:E.mod(p.c+E.V[d][1],ctx.n)};
   if(!quietTerrain(ctx.terrain.get(E.key(to.r,to.c))||[],ctx.silent))continue;
   if(trace.some((q,i)=>i&&trace[i-1].r===p.r&&trace[i-1].c===p.c&&q.r===to.r&&q.c===to.c))continue;
   queue.push({...to,last:d,path:[...p.path,d]});
  }
 }
 return null;
}
module.exports={wallDirection,collisionMove,wallFinishPlan};
