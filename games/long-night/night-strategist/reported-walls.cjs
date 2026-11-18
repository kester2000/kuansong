'use strict';
const {E}=require('./kernel.cjs');

// Keep only closed edges whose private observation has not been superseded
// in this coordinate frame. A hit alone cannot distinguish a hedge or box.
function reportedClosed(at,n){
 const closed=new Map();
 function update(r,c,d,value){
  const key=E.key(r,c)+':'+d;
  if(value==='墙')closed.set(key,{r,c,d});
  else if(value==='空')closed.delete(key);
 }
 for(const o of at.observations){
  if(o.kind!=='walls'&&o.kind!=='pass')continue;
  for(const d of o.kind==='pass'?[o.dir]:[0,1,2,3]){
   const value=o.kind==='pass'?'空':o.value[d];
   update(o.r,o.c,d,value);
   update(E.mod(o.r+E.V[d][0],n),E.mod(o.c+E.V[d][1],n),[1,0,3,2][d],value);
  }
 }
 return closed;
}
module.exports={reportedClosed};
