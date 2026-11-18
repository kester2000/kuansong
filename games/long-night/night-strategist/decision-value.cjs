'use strict';
const {E}=require('./kernel.cjs');
const VALUES=Object.freeze({win:1000,loss:-1000,fresh:5,revisit:-2,exposedSound:12,firstSound:3,button:14,collision:6,wallFact:2,stop:12,hazard:20,portalUncertainty:10});
function distance(a,b,n){const r=Math.abs(a.r-b.r),c=Math.abs(a.c-b.c);return Math.min(r,n-r)+Math.min(c,n-c);}
function goalProgress(ctx,from,to){
 if(ctx.brawl||!ctx.exits?.cells?.size)return 0;
 const exits=[...ctx.exits.cells.keys()].filter(k=>!ctx.spentPods?.has(k)).map(k=>{const [r,c]=k.split(',').map(Number);return {r,c};});
 if(!exits.length)return 0;
 const before=Math.min(...exits.map(p=>distance(from,p,ctx.n))),after=Math.min(...exits.map(p=>distance(to,p,ctx.n)));
 return 4*(before-after);
}
function wallValue(ctx,from,shape){
 const fresh=[0,1,2,3].filter(d=>!['墙','空'].includes(ctx.walls?.get(E.key(from.r,from.c)+':'+d))).length;
 const close=ctx.hunters?.positions?.length?Math.min(...ctx.hunters.positions.map(p=>distance(from,p,ctx.n))):Infinity;
 const danger=Math.max(0,3-close)*12;
 return {utility:-VALUES.collision+fresh*VALUES.wallFact-danger,
  reasons:['结束行动 −'+VALUES.collision,'新增四墙事实 '+fresh+' × '+VALUES.wallFact+' = +'+fresh*VALUES.wallFact,'已知猎人接近风险 −'+danger],wallPattern:shape};
}
// A lower bound is a deliberate risk-averse decision criterion, not the
// midpoint of an interval or an invented probability-weighted expectation.
const robustValue=rows=>Math.min(...rows.map(r=>Number.isFinite(r.utility)?r.utility:r.low));
module.exports={VALUES,goalProgress,wallValue,robustValue};
