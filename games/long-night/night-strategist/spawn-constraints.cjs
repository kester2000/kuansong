'use strict';
const {E}=require('./kernel.cjs');
// Necessary conditions of the normal (first-priority) birth scheme. A
// fallback spawn requires the full birth model; it is not mixed into the
// local prior with an arbitrary weight.
function normalSpawnFits({phase,chosen,n,birth,config}){
 if(!birth||config.roomRules?.教程==='开启')return true;
 const locate=(r,c)=>E.phaseAt(phase,n,r,c);
 const at=locate(birth.r,birth.c),owner=chosen.get(at.slot);
 if(at.slot<0)return false;
 if(owner?.block.cells.some(c=>c.type==='EXIT'))return false;
 if(!owner)return true;
 const cell=(r,c)=>{const a=locate(r,c);return (a.slot<0?phase.domains[-1][0]:chosen.get(a.slot))?.block.cells[a.i];};
 const blocked=c=>['HEAT','HEART'].includes(c.type)||['BOX','HEATBOX','JAMMERBOX'].includes(c.attach);
 const queue=[{r:E.mod(birth.r,n),c:E.mod(birth.c,n),dist:0}],seen=new Set([E.key(queue[0].r,queue[0].c)]);
 for(let j=0;j<queue.length;j++){
  const p=queue[j],a=cell(p.r,p.c);if(!a||blocked(a))continue;
  if(a.type==='EXIT')return false;
  if(p.dist===4)continue;
  for(let d=0;d<4;d++){
   const r=E.mod(p.r+E.V[d][0],n),c=E.mod(p.c+E.V[d][1],n),key=E.key(r,c),b=cell(r,c);
   if(!b||seen.has(key)||blocked(b)||![0,4].includes(Math.max(a.walls[d],b.walls[E.OPP[d]])))continue;
   seen.add(key);queue.push({r,c,dist:p.dist+1});
  }
 }
 return true;
}
module.exports={normalSpawnFits};
