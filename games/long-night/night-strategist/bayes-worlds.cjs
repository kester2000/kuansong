'use strict';
// Importance sampling over distinct, evidence-compatible block assignments.
// Sampling in smallest-domain order is a proposal, never a map prior.
const {E}=require('./kernel.cjs');
const MOD=(x,n)=>(x%n+n)%n;
function randomStream(seed){
 let state=2166136261;
 for(const c of seed)state=Math.imul(state^c.charCodeAt(0),16777619);
 return ()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
}
function buildWorld(phase,selected,n){
 const cells=[],slots=[],pods=[];
 for(let i=0;i<n*n;i++){
  const at=E.phaseAt(phase,n,Math.floor(i/n),i%n),slot=at.slot;
  cells[i]=(slot<0?phase.domains[-1][0]:selected[slot]).block.cells[at.i];slots[i]=slot;
  if(cells[i].type==='EXIT')pods.push(i);
 }
 const next=(i,d)=>MOD(Math.floor(i/n)+E.V[d][0],n)*n+MOD(i%n+E.V[d][1],n);
 const walls=cells.map((v,i)=>v.walls.map((w,d)=>Math.max(w,cells[next(i,d)].walls[E.OPP[d]])));
 return {n,cells,slots,pods,next,walls,phaseKey:phase.pr+','+phase.pc,heart:cells.some(c=>c.type==='HEART')};
}
function distances(start,edges){
 const dist=Array(edges.length).fill(Infinity),queue=[start];dist[start]=0;
 for(let i=0;i<queue.length;i++)for(const j of edges[queue[i]])if(dist[j]===Infinity){dist[j]=dist[queue[i]]+1;queue.push(j);}
 return dist;
}
// For two players the shuffled backtrack chooses uniformly among feasible
// first positions, then uniformly among that position's feasible partners.
function birthPrior(w,births,players=2,rng=Math.random){
 if(!births.length)return 1;
 const {cells,walls,next,slots,pods,n}=w;
 const fixed=births.reduce((a,b)=>(a[b.player]=MOD(b.r,n)*n+MOD(b.c,n),a),[]);
 const blocked=c=>['HEAT','HEART'].includes(c.type)||['BOX','HEATBOX','JAMMERBOX'].includes(c.attach);
 const edges=cells.map((c,i)=>blocked(c)?[]:walls[i].flatMap((k,d)=>[0,4].includes(k)&&!blocked(cells[next(i,d)])?[next(i,d)]:[]));
 const seen=new Set();let area=[];
 for(let i=0;i<cells.length;i++)if(!seen.has(i)){const comp=distances(i,edges).flatMap((x,j)=>Number.isFinite(x)?[j]:[]);comp.forEach(j=>seen.add(j));if(comp.length>area.length)area=comp;}
 if(fixed.some(x=>!area.includes(x)))return 0;
 const podSlots=new Set(pods.map(i=>slots[i])),legal=area.filter(i=>slots[i]>=0&&edges[i].length>=2&&!pods.includes(i)&&(n!==11||cells[i].attach!=='COIN'&&!edges[i].some(j=>cells[j].attach==='COIN')));
 const normal=legal.filter(i=>!podSlots.has(slots[i])),dist=new Map();
 const ds=i=>{if(!dist.has(i))dist.set(i,distances(i,edges));return dist.get(i)};
 const far=normal.filter(i=>pods.every(p=>ds(p)[i]>=5));
 for(const [pool,min] of [[far,5],[normal,5],[normal,0],[legal,0]]){
  if(players>2){
   // At each seat the shuffled backtrack's first viable choice is uniform.
   // Pin observed seats and weight by the chance of drawing that position.
   let budget=8000;
   function choices(path){
    const used=new Set(path.map(i=>slots[i]));
    return pool.filter(i=>!used.has(slots[i])&&(!min||path.length===0||
     ds(path.at(-1))[i]>=min&&(path.length!==players-1||ds(path[0])[i]>=min)));
   }
   function possible(path){
    if(--budget<=0||path.length===players)return path.length===players;
    return choices(path).some(i=>possible([...path,i]));
   }
   if(new Set(pool.map(i=>slots[i])).size<players)continue;
   if(!possible([])){if(budget<=0)return 0;continue;}
   let path=[],mass=1;
   for(let seat=0;seat<players;seat++){
    const viable=choices(path).filter(i=>possible([...path,i]));
    if(budget<=0||!viable.length)return 0;
    if(fixed[seat]!=null){
     if(!viable.includes(fixed[seat]))return 0;
     mass/=viable.length;path.push(fixed[seat]);
    }else path.push(viable[Math.floor(rng()*viable.length)]);
   }
   return mass;
  }
  let firstCount=0,mass=0;
  for(const i of pool){
   const partners=pool.filter(j=>slots[i]!==slots[j]&&(!min||ds(i)[j]>=min));
   if(!partners.length)continue;firstCount++;
   if(fixed[0]!=null&&fixed[0]!==i)continue;
   if(fixed[1]==null)mass++;else if(partners.includes(fixed[1]))mass+=1/partners.length;
  }
  if(firstCount)return mass/firstCount;
 }
 const pinned=fixed.filter(i=>i!=null);if(new Set(pinned).size!==pinned.length)return 0;
 return pinned.reduce((mass,_,i)=>mass/(area.length-i),1);
}
function chooseCount(n,k){let x=1;for(let i=1;i<=k;i++)x*= (n-i+1)/i;return x;}
function heatPrior(config,selected){
 const normal=E.pool({...config,heartPresence:null}).filter(b=>!b.id.startsWith('E'));
 const heat=b=>b.cells.some(c=>c.type==='HEAT'),box=b=>b.cells.some(c=>c.attach==='HEATBOX');
 const a=normal.filter(heat).length,b=normal.filter(box).length,k=selected.filter(x=>!x.id.startsWith('E')).length;
 if(!a||!b||Math.min(normal.length-a,normal.length-b)<k)return 1;
 return (selected.some(x=>box(x.block))?0:0.5/chooseCount(normal.length-b,k))+(selected.some(x=>heat(x.block))?0:0.5/chooseCount(normal.length-a,k));
}
function sample(ctx,node,config,births,seed){
 const phases=ctx.solution?.phases;if(!phases?.length||ctx.solution.irregular||!(config.playerCount>=2&&config.playerCount<=8)||config.event&&config.event!=='NONE')return [];
 const rng=randomStream(seed),out=[],cache=new Map();
 const deadline=Date.now()+550;
 for(let trial=0;trial<192&&Date.now()<deadline;trial++){
  const phase=phases[Math.floor(rng()*phases.length)],used=new Set(),selected=[],order=phase.domains.map((_,i)=>i).sort((a,b)=>phase.domains[a].length-phase.domains[b].length);
  let w=1,exits=0;
  for(const i of order){
   const need=config.exitCount,remaining=order.length-used.size;
   const options=phase.domains[i].filter(x=>!used.has(x.id)&&(need==null||(x.id.startsWith('E')?exits<need:need-exits<remaining)));
   if(!options.length)break;
   const x=options[Math.floor(rng()*options.length)];w*=options.length;selected[i]=x;used.add(x.id);exits+=Number(x.id.startsWith('E'));
  }
  if(used.size!==order.length)continue;
  const key=[phase.pr,phase.pc,...selected.map(x=>x.id)].join('/');
  if(!cache.has(key)){
   let h=null;
   const prior=heatPrior(config,selected);
   if(prior&&E.verifyCompleteLayout(config,{phases:[{...phase,domains:selected.map(x=>[x])}]},node.mergedObservations||node.observations||[],64).status==='verified'){
    const world=buildWorld(phase,selected,ctx.n);const birth=birthPrior(world,births,config.playerCount,rng);
    if(birth)h={world,prior:birth*prior};
   }
   cache.set(key,h);
  }
  const h=cache.get(key);if(h)out.push({world:h.world,weight:w*h.prior});
 }
 return out;
}
module.exports={sample,birthPrior,buildWorld};
