'use strict';

// P(observed seats | fully generated initial board), matching RandomizePlayers.
// Fractions remain reduced BigInts through every conditional branch.
function fraction(n,d=1n){
 if(d<=0n)throw Error('Invalid denominator');
 let a=n<0n?-n:n,b=d;while(b){const r=a%b;a=b;b=r;}
 return [n/a,d/a];
}
const add=([a,b],[c,d])=>fraction(a*d+c*b,b*d);
const multiply=([a,b],[c,d])=>fraction(a*c,b*d);
const divide=([a,b],[c,d])=>fraction(a*d,b*c);
const ZERO=[0n,1n],ONE=[1n,1n];

// The two-seat case needs only the number of feasible first cells and the
// number of partners for each relevant first cell. It need not enumerate
// shuffled backtracking trees or compute distances beyond the cutoff.
function twoSeatAssignment(pool,slotOf,fixed,near=null,ballBound=Infinity){
 if(new Set(pool.map(i=>slotOf[i])).size<2)return null;
 const slots=new Map();for(const i of pool)slots.set(slotOf[i],(slots.get(slotOf[i])||0)+1);
 const allViable=!near||pool.length>ballBound+Math.max(...slots.values())-1;
 const counts=new Map(),neighborhoods=new Map();
 const close=i=>{if(!neighborhoods.has(i))neighborhoods.set(i,near(i));return neighborhoods.get(i);};
 function partners(i){
  if(!counts.has(i))counts.set(i,pool.filter(j=>slotOf[i]!==slotOf[j]&&(!near||!close(i).has(j))).length);
  return counts.get(i);
 }
 const viable=allViable?pool:pool.filter(i=>partners(i)>0);
 if(!viable.length)return null;
 if(fixed[0]!=null&&!viable.includes(fixed[0])||fixed[1]!=null&&!pool.includes(fixed[1]))return ZERO;
 if(fixed[1]==null)return fixed[0]==null?ONE:fraction(1n,BigInt(viable.length));
 let sum=ZERO;
 for(const i of fixed[0]==null?viable:[fixed[0]]){
  if(slotOf[i]===slotOf[fixed[1]]||near&&close(i).has(fixed[1]))continue;
  sum=add(sum,fraction(1n,BigInt(partners(i))));
 }
 return fraction(sum[0],sum[1]*BigInt(viable.length));
}

function assignment(pool,slotOf,seats,fixed,apart){
 const memo=new Map(),possibleMemo=new Map();
 function choices(path){
  const used=new Set(path.map(i=>slotOf[i]));
  return pool.filter(i=>!used.has(slotOf[i])&&(!path.length||apart(i,path.at(-1)))&&
    (path.length!==seats-1||apart(i,path[0])));
 }
 function possible(path){
  if(path.length===seats)return true;
  const key=path.join('/');
  if(!possibleMemo.has(key))possibleMemo.set(key,choices(path).some(i=>possible([...path,i])));
  return possibleMemo.get(key);
 }
 if(new Set(pool.map(i=>slotOf[i])).size<seats||!possible([]))return null;
 function probability(path){
  const seat=path.length;
  if(seat===seats||fixed.slice(seat).every(x=>x==null))return ONE;
  const key=path.join('/');if(memo.has(key))return memo.get(key);
  const viable=choices(path).filter(i=>possible([...path,i]));
  const selected=fixed[seat]==null?viable:viable.filter(i=>i===fixed[seat]);
  const sum=selected.reduce((v,i)=>add(v,probability([...path,i])),ZERO);
  const value=fraction(sum[0],sum[1]*BigInt(viable.length));
  memo.set(key,value);return value;
 }
 return probability([]);
}

function exactBirth(world,births,seats,{sourceOrigin=null}={}){
 const {cells,walls,next,slots,pods,n}=world;
 const fixed=Array(seats).fill(null);
 for(const b of births){
  if(!Number.isInteger(b.player)||b.player<0||b.player>=seats)throw Error('Invalid seat');
  const index=((b.r%n+n)%n)*n+(b.c%n+n)%n;
  if(fixed[b.player]!=null&&fixed[b.player]!==index)return ZERO;
  fixed[b.player]=index;
 }
 const pinned=fixed.filter(i=>i!=null);
 if(!pinned.length)return ONE;
 if(new Set(pinned).size!==pinned.length)return ZERO;
 const blocked=c=>['HEAT','HEART'].includes(c.type)||['BOX','HEATBOX','JAMMERBOX'].includes(c.attach);
 const edges=cells.map((c,i)=>blocked(c)?[]:walls[i].flatMap((w,d)=>[0,4].includes(w)&&!blocked(cells[next(i,d)])?[next(i,d)]:[]));
 const distances=new Map();
 function dist(i){
  if(distances.has(i))return distances.get(i);
  const row=Array(cells.length).fill(Infinity),queue=[i];row[i]=0;
  for(let k=0;k<queue.length;k++)for(const j of edges[queue[k]])if(row[j]===Infinity){row[j]=row[queue[k]]+1;queue.push(j);}
  distances.set(i,row);return row;
 }
 const sourceIndex=i=>sourceOrigin?((Math.floor(i/n)-sourceOrigin.r+n)%n)*n+(i%n-sourceOrigin.c+n)%n:i;
 const seen=new Set();let area=[],firstSource=Infinity;
 for(let i=0;i<cells.length;i++)if(!seen.has(i)){
  const group=dist(i).flatMap((x,j)=>x<Infinity?[j]:[]);group.forEach(j=>seen.add(j));
  const first=Math.min(...group.map(sourceIndex));
  if(group.length>area.length||group.length===area.length&&first<firstSource){area=group;firstSource=first;}
 }
 if(pinned.some(i=>!area.includes(i)))return ZERO;
 const exitSlots=new Set(pods.map(i=>slots[i]));
 const legal=area.filter(i=>slots[i]>=0&&!pods.includes(i)&&edges[i].length>=2&&(n!==11||cells[i].attach!=='COIN'&&!edges[i].some(j=>cells[j].attach==='COIN')));
 const normal=legal.filter(i=>!exitSlots.has(slots[i]));
 // Multi-source distance <= 4 suffices; greater finite distances and
 // unreachable cells are identical for the actual source rule (>= 5).
 const nearCache=new Map();
 function near(i){
  if(!nearCache.has(i)){
   const visited=new Set([i]);let frontier=[i];
   for(let depth=0;depth<4&&frontier.length;depth++){
    const next=[];for(const j of frontier)for(const k of edges[j])if(!visited.has(k)){visited.add(k);next.push(k);}frontier=next;
   }
   nearCache.set(i,visited);
  }
  return nearCache.get(i);
 }
 const nearPods=new Set(pods.flatMap(p=>[...near(p)]));
 const far=normal.filter(i=>!nearPods.has(i));
 for(const [pool,min] of [[far,5],[normal,5],[normal,0],[legal,0]]){
  const mass=seats===2?twoSeatAssignment(pool,slots,fixed,min?near:null,41):assignment(pool,slots,seats,fixed,(a,b)=>!min||!near(a).has(b));
  if(mass!==null)return mass;
 }
 if(area.length<seats)throw Error('Initial board cannot place all seats');
 return pinned.reduce((v,_,i)=>fraction(v[0],v[1]*BigInt(area.length-i)),ONE);
}
// Relative phases omit the absolute block translation. The source breaks
// equal-size component ties by absolute row order, so integrate translations.
function relativeBirth(world,births,seats,phase){
 if(world.n===11||world.n===10)return exactBirth(world,births,seats,{sourceOrigin:{r:phase.pr,c:phase.pc}});
 // Absolute translations only matter when largest components tie. Most
 // opening boards have one largest component; avoid repeating identical
 // spawn assignment calculations once per block translation.
 if(uniqueLargest(world))return exactBirth(world,births,seats);
 let mass=ZERO,count=0;
 for(let r=phase.pr;r<world.n;r+=3)for(let c=phase.pc;c<world.n;c+=3){
  mass=add(mass,exactBirth(world,births,seats,{sourceOrigin:{r,c}}));count++;
 }
 return divide(mass,[BigInt(count),1n]);
}
function uniqueLargest({cells,walls,next}){
 const blocked=c=>['HEAT','HEART'].includes(c.type)||['BOX','HEATBOX','JAMMERBOX'].includes(c.attach);
 const seen=new Set();let largest=0,count=0;
 for(let i=0;i<cells.length;i++)if(!seen.has(i)){
  const queue=[i];seen.add(i);
  for(let k=0;k<queue.length;k++){const at=queue[k];if(blocked(cells[at]))continue;
   for(let d=0;d<4;d++)if([0,4].includes(walls[at][d])){const to=next(at,d);if(!blocked(cells[to])&&!seen.has(to)){seen.add(to);queue.push(to);}}
  }
  if(queue.length>largest){largest=queue.length;count=1;}else if(queue.length===largest)count++;
 }
 return count===1;
}
module.exports={exactBirth,relativeBirth,assignment,twoSeatAssignment,fraction,add,multiply,divide,uniqueLargest};

