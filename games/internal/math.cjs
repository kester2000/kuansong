'use strict';
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const sum=xs=>xs.reduce((a,b)=>a+b,0);
const mean=xs=>xs.length?sum(xs)/xs.length:0;
function rng(seed=1){let x=seed>>>0;return()=>{x+=0x6D2B79F5;let t=x;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return((t^t>>>14)>>>0)/4294967296;};}
function weighted(items,weights,random=Math.random){let p=random()*sum(weights);for(let i=0;i<items.length;i++){p-=weights[i];if(p<=0)return items[i];}return items.at(-1);}
function softmax(values,temperature=1){const max=Math.max(...values);return values.map(v=>Math.exp(clamp((v-max)/Math.max(1e-9,temperature),-50,0)));}
function choose(candidates,evaluate,{random=Math.random,temperature=0}={}){
 if(!candidates.length)return null;const values=candidates.map(evaluate),best=Math.max(...values);
 if(!values.every(Number.isFinite))throw Error('Non-finite policy value');
 const index=temperature>0?weighted(candidates.map((_,i)=>i),softmax(values,temperature),random):values.indexOf(best);
 return {action:candidates[index],value:values[index],best,values};
}
// Regret matching for a simultaneous zero-sum game; averaged strategies avoid
// deterministic cycling. Payoffs are always from the row player's perspective.
function equilibrium(matrix,iterations=1200){
 const n=matrix.length,m=matrix[0]?.length;if(!n||!m)throw Error('Empty matrix game');
 const rr=Array(n).fill(0),cr=Array(m).fill(0),ra=Array(n).fill(0),ca=Array(m).fill(0);
 const dist=r=>{const a=r.map(x=>Math.max(0,x)),z=sum(a);return z?a.map(x=>x/z):a.map(()=>1/a.length);};
 for(let t=0;t<iterations;t++){
  const p=dist(rr),q=dist(cr),rv=matrix.map(row=>sum(row.map((v,j)=>v*q[j]))),cv=Array.from({length:m},(_,j)=>sum(matrix.map((row,i)=>row[j]*p[i]))),value=sum(rv.map((v,i)=>v*p[i]));
  for(let i=0;i<n;i++){rr[i]+=rv[i]-value;ra[i]+=p[i];}
  for(let j=0;j<m;j++){cr[j]+=value-cv[j];ca[j]+=q[j];}
 }
 const p=ra.map(x=>x/iterations),q=ca.map(x=>x/iterations);
 return {p,q,value:sum(matrix.map((row,i)=>p[i]*sum(row.map((v,j)=>v*q[j]))))};
}
function integers(max,limit=64,extras=[]){if(max<0)return[];if(max<=limit)return Array.from({length:max+1},(_,i)=>i);return [...new Set([0,1,max,...Array.from({length:limit},(_,i)=>Math.round(i*max/(limit-1))),...extras.map(Math.round)].filter(x=>x>=0&&x<=max))].sort((a,b)=>a-b);}
function rankUtility(values,self){return mean(values.filter((_,i)=>i!==self).map(v=>values[self]>v?1:values[self]<v?0:0.5));}
function empirical(history,choices,prior=1){return choices.map(choice=>prior+sum(history.map((v,i)=>JSON.stringify(v)===JSON.stringify(choice)?Math.pow(.88,history.length-i-1):0)));}
const sample=(items,random=Math.random)=>items[Math.floor(random()*items.length)];
const draw=(weights,random=Math.random)=>weighted(weights.map((_,i)=>i),weights,random);
module.exports={clamp,sum,mean,rng,weighted,softmax,choose,equilibrium,integers,rankUtility,empirical,sample,draw};
