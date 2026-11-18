'use strict';
const {E}=require('./kernel.cjs');
// A conservative structural-exposure heuristic, not a claim that an opponent
// has solved our map. Public movement can identify a block even without sound.
// Only verified, well-traversed regions qualify; no hidden routes or guessed
// block alignment are used. Purposeful capture/escape bypass exploration.
function publicFootprint({n,blocks=[],trace=[],solo=false,privateMovement=false,verified=false}){
 const cells=new Map();
 if(solo||privateMovement||!verified)return cells;
 for(const block of blocks){
  if(String(block.id).startsWith('E')||!block.origin)continue;
  const keys=new Set();
  for(let r=0;r<3;r++)for(let c=0;c<3;c++)keys.add(`${(block.origin.r+r+n)%n},${(block.origin.c+c+n)%n}`);
  // Exclude the spawn position itself: birth is not a public movement.
  const visits=trace.slice(1).filter(p=>keys.has(`${p.r},${p.c}`));
  const distinct=new Set(visits.map(p=>`${p.r},${p.c}`)).size;
  if(distinct<4||visits.length<6)continue;
  const definition=E.byId.get(String(block.id));
  const anchors=[...keys].filter(key=>{
   const [r,c]=key.split(',').map(Number),i=((r-block.origin.r+n)%n)*3+(c-block.origin.c+n)%n;
   return ['BERRY','GRASS'].includes(definition?.cells[i]?.type)&&visits.some(p=>p.r===r&&p.c===c);
  }).map(k=>k.split(',').map(Number));
  for(const key of keys){
   const [r,c]=key.split(',').map(Number);
   const nearLandmark=anchors.some(([ar,ac])=>Math.min(Math.abs(r-ar),n-Math.abs(r-ar))+Math.min(Math.abs(c-ac),n-Math.abs(c-ac))<=1);
   cells.set(key,{blockId:block.id,distinct,traversals:visits.length,stopExposure:nearLandmark?10:4});
  }
 }
 return cells;
}
module.exports={publicFootprint};
