'use strict';
const {blockAssignmentPrior,falling}=require('./block-prior.cjs');

// Sum the unqueried slots, rather than enumerating their permutations. The
// same remaining-slot / used-ID state is shared by every local hypothesis.
// This integrates draw/domain evidence, NOT the globally coupled spawn rule.
function completionCounter({phase,slots,pool,exitCount,custom,deadline}){
 const selected=new Set(slots),ids=new Map(pool.map((b,i)=>[String(b.id),i]));
 const exits=pool.filter(b=>String(b.id).startsWith('E'));
 const normal=pool.filter(b=>!String(b.id).startsWith('E'));
 const q=custom?Math.min(exitCount,exits.length):exitCount,k=phase.domains.length-q;
 if(pool.some(b=>b.cells.some(c=>c.attach==='HEATBOX')))throw Error('互斥热源抽取需独立计数分支');
 const draw=[...exits.slice(0,q),...normal.slice(0,k)];
 if(draw.length!==phase.domains.length)throw Error('区块不足');
 const unit=blockAssignmentPrior({pool,slots:phase.domains.length,exitCount,custom,assignments:draw.map((b,slot)=>({slot,id:b.id}))});
 const bit=id=>1n<<BigInt(ids.get(String(id)));
 const heartMask=pool.reduce((mask,b)=>b.cells.some(c=>c.type==='HEART')?mask|bit(b.id):mask,0n);
 const exitMask=exits.reduce((mask,b)=>mask|bit(b.id),0n);
 const rest=phase.domains.map((ds,i)=>({i,ds})).filter(x=>!selected.has(x.i)).sort((a,b)=>a.ds.length-b.ds.length);
 const options=rest.map(x=>x.ds.map(m=>({bit:bit(m.id),exit:Number(String(m.id).startsWith('E'))})));
 const masks=options.map(ds=>ds.reduce((mask,m)=>mask|m.bit,0n)),uniform=[];
 for(let d=masks.length-1;d>=0;d--)uniform[d]=d===masks.length-1||uniform[d+1]&&masks[d]===masks[d+1];
 const size=mask=>{let n=0;while(mask){mask&=mask-1n;n++;}return n;};
 const ways=(mask,r,e)=>e<0||e>r?0n:falling(r,e)/falling(e,e)*falling(size(mask&exitMask),e)*falling(size(mask&~exitMask),r-e);
 const cache=new Map();let states=0,hits=0;
 function sum(depth,mask,usedExits){
  if(++states%128===0&&Date.now()>=deadline)throw Error('剩余区块求和达到预算');
  if(usedExits>q||usedExits+options.length-depth<q)return [0n,0n];
  if(depth===options.length)return usedExits===q?[1n,(mask&heartMask)?1n:0n]:[0n,0n];
  const key=depth+':'+mask;
  if(cache.has(key)){hits++;return cache.get(key);}
  // With no further distinguishing evidence all remaining permutations
  // integrate to a falling factorial. Never visit each remote map.
  if(uniform[depth]){
   const available=masks[depth]&~mask,r=options.length-depth,e=q-usedExits,count=ways(available,r,e);
   const result=[count,mask&heartMask?count:count-ways(available&~heartMask,r,e)];cache.set(key,result);return result;
  }
  let count=0n,heart=0n;
  for(const m of options[depth])if(!(mask&m.bit)){const v=sum(depth+1,mask|m.bit,usedExits+m.exit);count+=v[0];heart+=v[1];}
  const result=[count,heart];cache.set(key,result);return result;
 }
 return {unit,count(chosen){
  if(Date.now()>=deadline)throw Error('剩余区块求和达到预算');
  let mask=0n,e=0;for(const m of chosen.values()){const b=bit(m.id);if(mask&b)return [0n,0n];mask|=b;e+=Number(String(m.id).startsWith('E'));}
  return sum(0,mask,e);
 },stats:()=>({states,memoStates:cache.size,cacheHits:hits})};
}
module.exports={completionCounter};
