(function(root){
 'use strict';let cached;
 function layouts(){
  if(cached)return cached;
  const out=[],covered=new Uint8Array(100),chosen=[];
  function visit(cell,gaps){
   if(chosen.length===9){out.push(chosen.map(k=>({r:Math.floor(k/10),c:k%10})));return;}
   while(cell<100&&covered[cell])cell++;if(cell===100)return;
   if(gaps){covered[cell]=1;visit(cell+1,gaps-1);covered[cell]=0;}
   if(Math.floor(cell/10)>7||cell%10>7)return;
   const cells=[];for(let dr=0;dr<3;dr++)for(let dc=0;dc<3;dc++){const i=cell+dr*10+dc;if(covered[i])return;cells.push(i);}
   cells.forEach(i=>covered[i]=1);chosen.push(cell);visit(cell+1,gaps);chosen.pop();cells.forEach(i=>covered[i]=0);
  }
  visit(0,19);cached=out;return out;
 }
 const api={layouts};if(typeof module!=='undefined')module.exports=api;else root.LongNightLayouts10=api;
})(globalThis);
