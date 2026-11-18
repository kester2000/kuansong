'use strict';
const mod=(a,n)=>(a%n+n)%n;
// Source: 2026-11-10 UnitMaps::SetMapPosition11. Offsets are unknown to
// a player and must remain hypotheses until observations constrain them.
function origins(size,offset={r:0,c:0}){
 if(![9,11,12].includes(size))return null;
 const axis=size===11?[0,4,8]:Array.from({length:size/3},(_,i)=>i*3);
 return axis.flatMap(r=>axis.map(c=>({r:mod(r+offset.r,size),c:mod(c+offset.c,size)})));
}
function locate(size,point,offset={r:0,c:0}){
 const slots=origins(size,offset);if(!slots)return {kind:'unknown'};
 for(let slot=0;slot<slots.length;slot++){const o=slots[slot],r=mod(point.r-o.r,size),c=mod(point.c-o.c,size);if(r<3&&c<3)return {kind:'block',slot,index:r*3+c,origin:o};}
 return {kind:'corridor'};
}
module.exports={origins,locate};
