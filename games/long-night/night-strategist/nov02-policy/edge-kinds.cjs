'use strict';
const {E}=require('./kernel.cjs');
// Wall types can be unanimous across several block IDs. Do not require an
// entire block to be identified, or use a sampled complete layout as proof.
function edgeKinds(config,solution){
 const out=new Map(),n=config.size;
 if(!solution||solution.irregular||!solution.phases?.length)return out;
 const at=(p,r,c)=>E.phaseAt(p,n,r,c);
 for(let r=0;r<n;r++)for(let c=0;c<n;c++)for(let d=0;d<4;d++){
  const values=new Set();
  for(const p of solution.phases){
   const a=at(p,r,c),b=at(p,E.mod(r+E.V[d][0],n),E.mod(c+E.V[d][1],n));
   if(a.slot===b.slot)for(const x of p.domains[a.slot])values.add(Math.max(x.block.cells[a.i].walls[d],x.block.cells[b.i].walls[E.OPP[d]]));
   else {const aa=new Set(p.domains[a.slot].map(x=>x.block.cells[a.i].walls[d])),bb=new Set(p.domains[b.slot].map(x=>x.block.cells[b.i].walls[E.OPP[d]]));for(const x of aa)for(const y of bb)values.add(Math.max(x,y));}
  }
  if(values.size)out.set(E.key(r,c)+':'+d,[...values]);
 }
 return out;
}
module.exports={edgeKinds};
