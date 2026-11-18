'use strict';
const {E}=require('./kernel.cjs');
const chars='上下左右';
const key=p=>E.key(p.r,p.c),same=(a,b)=>a.r===b.r&&a.c===b.c;
const plain=c=>c.type==='EMPTY'&&['EMPTY','COIN','BUTTON'].includes(c.attach);
function arrive(world,p){
 const cell=world.cells[p.r*9+p.c];if(cell.attach!=='BUTTON')return world;
 const w={...world,walls:world.walls.map(v=>v.slice())};
 for(const [dr,dc,name] of cell.buttons||[]){const d={UP:0,DOWN:1,LEFT:2,RIGHT:3}[name],i=E.mod(p.r+dr,9)*9+E.mod(p.c+dc,9),j=w.next(i,d),v=w.walls[i][d];if(v===3||v===4)w.walls[i][d]=w.walls[j][E.OPP[d]]=7-v;}
 return w;
}
function entropy(masses){const total=masses.reduce((a,b)=>a+b,0);return total?masses.reduce((h,m)=>m?h-m/total*Math.log2(m/total):h,0):0;}
// A conditional continuation uses edges common to the entire retained branch,
// not a different clairvoyant route in each sampled world. Still a hypothesis:
// only the first real move is sent and fresh feedback always rebuilds the plan.
function commonReturn(rows,from,target,maxDepth=12){
 const q=[{p:from,path:[],last:-1,rows}],seen=new Set();
 while(q.length){const {p,path,last,rows}=q.shift();if(same(p,target))return path;if(path.length>=maxDepth)continue;
  for(let d=0;d<4;d++){const to={r:E.mod(p.r+E.V[d][0],9),c:E.mod(p.c+E.V[d][1],9)},k=key(to);if(seen.has(k))continue;
   if(rows.every(row=>{const w=row.world,i=p.r*9+p.c,v=w.walls[i][d],cell=w.cells[to.r*9+to.c];return (v===0||v===4||v===2&&last===d)&&plain(cell);})){seen.add(k);q.push({p:to,path:[...path,d],last:d,rows:rows.map(row=>({...row,world:arrive(row.world,to)}))});}
  }
 }
 return null;
}
function plan(ctx,belief,{maxDepth=9,maxStates=180}={}){
 if(belief.status!=='estimated'||belief.positions[0]?.probability<0.65)return null;
 const total=belief.rows.reduce((s,r)=>s+r.weight,0),leading=belief.positions[0];
 const initial=belief.rows.map(row=>({row,p:ctx.from,last:ctx.lastDirection}));
 const queue=[{path:[],states:initial,seen:new Set([key(ctx.from)]),risk:0,noise:0}],options=[];let expanded=0;
 while(queue.length&&expanded++<maxStates){const n=queue.shift();
  for(let d=0;d<4;d++){
   if(!n.path.length&&ctx.moves.find(m=>m.dirIndex===d)?.blocked)continue;
   const path=[...n.path,d],p=n.states[0]?.p;if(!p)continue;
   const to={r:E.mod(p.r+E.V[d][0],9),c:E.mod(p.c+E.V[d][1],9)},k=key(to);if(n.seen.has(k))continue;
   const branches=new Map(),moving=[];let hit=0,hazard=0,noise=0,portal=0,capture=0,returnMass=0,hitCost=0;
   for(const state of n.states){const {row,last}=state,w=row.world,i=p.r*9+p.c,j=w.next(i,d),v=w.walls[i][d],cell=w.cells[j],mass=row.weight/total;
    const blocked=v===1||v===3||v===2&&last!==d;
    const type=blocked?'HIT':cell.type;
    const targetKey=key(row.target),branch=branches.get(type)||{rows:[],masses:new Map(),mass:0};branch.mass+=mass;branch.rows.push(row);branch.masses.set(targetKey,(branch.masses.get(targetKey)||0)+mass);branches.set(type,branch);
    if(blocked){hit+=mass;const dr=Math.abs(p.r-row.target.r),dc=Math.abs(p.c-row.target.c),distance=Math.min(dr,9-dr)+Math.min(dc,9-dc);hitCost+=mass*(distance<=3?80:25);continue;}
    if(['TRAP','HEAT','HEART','ONEWAYPORTAL'].includes(type)||!['EMPTY','COIN','BUTTON'].includes(cell.attach)){hazard+=mass;continue;}
    if(type==='PORTAL'){portal+=mass;continue;}
    if(!['EMPTY','EXIT'].includes(type))noise+=mass;
    if(same(to,row.target))capture+=mass;
    if(plain(cell))moving.push({row:{...row,world:arrive(w,to)},p:to,last:d});
   }
   const port=branches.get('PORTAL');let returnRoute=null,exit=null;
   if(port){
    const exits=port.rows.map(row=>{const cell=row.world.cells[to.r*9+to.c];return cell.portal?{r:E.mod(to.r+cell.portal[0],9),c:E.mod(to.c+cell.portal[1],9)}:null;});
    if(exits.every(e=>e&&same(e,exits[0]))){exit=exits[0];returnRoute=commonReturn(port.rows,exit,leading);
     if(returnRoute)returnMass=port.rows.filter(row=>same(row.target,leading)).reduce((s,row)=>s+row.weight/total,0);
    }
   }
   const activeMass=n.states.reduce((s,t)=>s+t.row.weight/total,0),activeTargets=new Map();
   for(const t of n.states)activeTargets.set(key(t.row.target),(activeTargets.get(key(t.row.target))||0)+t.row.weight/total);
   const remainingEntropy=[...branches.values()].reduce((s,b)=>s+b.mass*entropy([...b.masses.values()]),0),information=Math.max(0,activeMass*entropy([...activeTargets.values()])-remainingEntropy);
   const collision=n.risk+hit,exposure=n.noise+noise+portal;
   // Collision hands the hunter a turn; a failed quiet test merely continues.
   // Penalize the former separately and retain explicit failure branches.
   const score=returnMass*55+capture*45+information*6-path.length*0.7-(n.hitCost||0)-hitCost-hazard*120-exposure*8;
   if(collision<=0.4&&hazard===0&&(returnMass>0.35||capture>0.65)&&score>0){options.push({path,to,score,collision,exposure,information,portalProbability:portal,captureProbability:capture,returnMass,exit,returnRoute,branches:[...branches].map(([feedback,b])=>({feedback,probability:b.mass,next:feedback==='PORTAL'?'confirm exit, update posterior, then replan capture':feedback==='HIT'?'turn ended; update walls and hunter risk':'update posterior; continue exploration if hypothesis weakens'})).concat(activeMass<1?[{feedback:'earlier divergent feedback',probability:1-activeMass,next:'discard preview and replan immediately'}]:[])});}
   if(path.length<maxDepth&&moving.reduce((s,t)=>s+t.row.weight/total,0)>=0.5&&collision<=0.4&&hazard===0)queue.push({path,states:moving,seen:new Set([...n.seen,k]),risk:collision,noise:exposure,hitCost:(n.hitCost||0)+hitCost});
  }
 }
 options.sort((a,b)=>b.score-a.score||a.path.length-b.path.length);
 return options[0]?{...options[0],hypothesis:leading,expanded}:null;
}
function apply(input,s){
 if(!s?.ok||!['bounded-exploration','continue-exploration','pursue-candidates','required-transit'].includes(s.tactic?.kind))return s;
 const ctx=require('./objective-policy.cjs').context(input);
 if(!ctx?.certain||ctx.round<=1||ctx.target||ctx.uncertainLocation||ctx.warnings.length)return s;
 const other=input.built.views[1-ctx.self],last=other?.roundEnds.at(-1);
 if(!last?.complete||last.round!==(1-ctx.self<ctx.self?ctx.round:ctx.round-1)||last.inSpace)return s;
 const budget=Math.max(0,Math.min(900,(input.decisionBudgetMs||1200)*0.45));
 const belief=require('./joint-belief.cjs').infer(input,{budgetMs:budget});
 const diagnostic={status:belief.status,positions:belief.positions||[],audit:belief.audit};
 const proposal=plan({...ctx,moves:s.moves},belief);
 if(!proposal)return {...s,jointBelief:diagnostic};
 const move=s.moves.find(m=>m.dirIndex===proposal.path[0]&&!m.blocked);if(!move)return {...s,jointBelief:diagnostic};
 const probability=Math.round(proposal.hypothesis.probability*100);
 const primary={...move,reasons:[`联合路径、墙形、出生规则：目标在(${proposal.hypothesis.r},${proposal.hypothesis.c})的采样权重约${probability}%；保留其他解释，不当作确定坐标`,
  `逐步验证路线 ${proposal.path.map(d=>chars[d]).join('')}；验证成功后重新定位再评估回抓，失败且未交权则继续探索`,...(move.reasons||[])]};
 return {...s,primary,alternatives:[],plan:null,jointBelief:diagnostic,tactic:{kind:'hypothesis-probe',round:ctx.round,steps:ctx.steps,...proposal,commandsArePreview:true},basis:[...(s.basis||[]),'只执行验证路线的第一步；传送和敌位均须按新反馈更新，禁止把采样多数直接合并成真图。']};
}
module.exports={entropy,arrive,commonReturn,plan,apply};
