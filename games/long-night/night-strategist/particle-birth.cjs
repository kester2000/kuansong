'use strict';
// RandomizePlayers (map/board.h): first viable choice in a shuffled list
// is uniform over viable choices, NOT over complete birth assignments.
const {E}=require('./kernel.cjs');
function birthMass(world,births,count,rng,check=()=>{}){
 const {cells,walls,next,slots,pods,n}=world;
 const fixed=new Map(births.map(b=>[b.player,E.mod(b.r,n)*n+E.mod(b.c,n)]));
 const blocked=c=>['HEAT','HEART'].includes(c.type)||['BOX','HEATBOX','JAMMERBOX'].includes(c.attach);
 const edges=cells.map((c,i)=>blocked(c)?[]:walls[i].flatMap((w,d)=>[0,4].includes(w)&&!blocked(cells[next(i,d)])?[next(i,d)]:[]));
 const ds=new Map(),distance=start=>{if(!ds.has(start)){const a=Array(n*n).fill(Infinity),q=[start];a[start]=0;for(let t=0;t<q.length;t++)for(const j of edges[q[t]])if(a[j]===Infinity){a[j]=a[q[t]]+1;q.push(j);}ds.set(start,a);}return ds.get(start);};
 const seen=new Set(),components=[];
 for(let i=0;i<n*n;i++)if(!seen.has(i)){const area=distance(i).flatMap((d,k)=>Number.isFinite(d)?[k]:[]);area.forEach(k=>seen.add(k));components.push(area);}
 const largest=Math.max(...components.map(a=>a.length)),areas=components.filter(a=>a.length===largest);
 // Relative maps hide the absolute block translation. Average the nine
 // possible translations when equally large components have a tie.
 const areaWeights=new Map();
 const [pr,pc]=world.phaseKey.split(',').map(Number);
 for(let r=0;r<([10,11].includes(n)?1:n);r+=3)for(let c=0;c<([10,11].includes(n)?1:n);c+=3){
  const absolute=k=>E.mod(Math.floor(k/n)-pr+r,n)*n+E.mod(k%n-pc+c,n);
  const chosen=areas.reduce((a,b)=>Math.min(...a.map(absolute))<Math.min(...b.map(absolute))?a:b);
  areaWeights.set(chosen,(areaWeights.get(chosen)||0)+1/([10,11].includes(n)?1:(n/3)**2));
 }
 const exitSlots=new Set(pods.map(k=>slots[k]));let answer=0;
 for(const [area,areaWeight] of areaWeights){
  check();if([...fixed.values()].some(k=>!area.includes(k)))continue;
  const legal=area.filter(k=>slots[k]>=0&&edges[k].length>=2&&!pods.includes(k)&&(n!==11||cells[k].attach!=='COIN'&&!edges[k].some(j=>cells[j].attach==='COIN'))),normal=legal.filter(k=>!exitSlots.has(slots[k]));
  const far=normal.filter(k=>pods.every(p=>distance(p)[k]>=5));
  let resolved=false;
  for(const [pool,min] of [[far,5],[normal,5],[normal,0],[legal,0]]){
   if(new Set(pool.map(k=>slots[k])).size<count)continue;
   const memo=new Map();
   const choices=path=>pool.filter(k=>!path.some(j=>slots[j]===slots[k])&&(!min||!path.length||distance(path.at(-1))[k]>=min&&(path.length!==count-1||distance(path[0])[k]>=min)));
   function possible(path){check();if(path.length===count)return true;const key=path.join(',');if(!memo.has(key))memo.set(key,choices(path).some(k=>possible([...path,k])));return memo.get(key);}
   if(!possible([]))continue;
   // For 1/2 players marginalize every hidden seat exactly. For more
   // players importance-sample hidden seats; pinned seats get 1/|viable|.
   function mass(path){
    check();if(path.length===count)return 1;
    const viable=choices(path).filter(k=>possible([...path,k]));
    const pin=fixed.get(path.length);
    if(pin!=null)return viable.includes(pin)?mass([...path,pin])/viable.length:0;
    if(count<=2)return viable.reduce((v,k)=>v+mass([...path,k]),0)/viable.length;
    return mass([...path,viable[Math.floor(rng()*viable.length)]]);
   }
   answer+=areaWeight*mass([]);resolved=true;break;
  }
  if(!resolved&&new Set(fixed.values()).size===fixed.size&&area.length>=count){let p=1;for(let i=0;i<fixed.size;i++)p/=area.length-i;answer+=areaWeight*p;}
 }
 return answer;
}
module.exports={birthMass};
