'use strict';
const {publicRoutes}=require('../night-strategist/silent-projection.cjs');
const {M}=require('../night-strategist/kernel.cjs');
const chars='上下左右';
function routeSteps(route){
 const result=new Map();let step=0;
 for(const token of route?.tokens||[]){
  if(token.kind==='move')result.set(++step,token);
  else if(token.kind==='hidden'){if(!Number.isInteger(token.steps))break;step+=token.steps;}
  else if(token.kind==='marker'){
   if(token.step){step++;continue;}
   const previous=result.get(step);if(previous){
    if(/陷阱/.test(token.value))result.set(step,{...previous,terrain:'TRAP'});
    if(/逃生/.test(token.value))result.set(step,{...previous,terrain:'EXIT'});
   }
  }
 }
 return result;
}
function tokenSummary(t){
 if(!t)return '未保存本步反馈';
 const text=[t.outcome==='hit'?'向'+chars[t.dir]+'移动时撞墙，本回合结束':'向'+chars[t.dir]+'移动'];
 if(t.sound)text.push(t.sound==='PAPA'?'啪嗒':t.sound==='SHASHA'?'沙沙':t.sound);
 if(t.masked)text.push('声音被掩盖');
 if(t.terrain==='TRAP')text.push('陷阱强制停止，本回合结束');
 else if(t.terrain==='EXIT')text.push('抵达逃生舱');
 else if(t.terrain)text.push(({GRASS:'树丛',BERRY:'浆果丛',WATER:'水洼',PORTAL:'传送门',HEAT:'热源'}[t.terrain]||t.terrain));
 return text.join('；')+'。';
}
function archiveTimeline(record){
 const self=Number(record.board?.report?.self??record.journal?.view??0),routes=publicRoutes(record.journal||{messages:[]});
 const roundCounters=new Map();
 for(const m of M.liveMessages(record.journal?.messages||[])){
  const items=M.parse(m.text).items.filter(t=>t.kind==='trajectory');
  for(let i=0;i<items.length;i++){
   const item=items[i],round=item.round??((roundCounters.get(item.player)||0)+1);
   if(!item.partial)roundCounters.set(item.player,round);
   const route=routes.get(item.player+':'+round);if(!route||item.partial)continue;
   const body=String(m.text).slice(item.at,items[i+1]?.at);
   route.ending=/超时/.test(body)?'超时':/主动停止|\(停止\)|（停止）/.test(body)?'主动停止':route.ending;
  }
 }
 const rounds=new Map(),get=r=>{r=Number(r);if(!Number.isInteger(r)||r<1||r>200)return null;if(!rounds.has(r))rounds.set(r,{actions:[],routes:[]});return rounds.get(r);};
 for(const a of record.board?.actions||[])get(a.round)?.actions.push({...a});
 for(const route of routes.values())get(route.round)?.routes.push(route);
 for(const r of [...(record.rounds||[]),...(record.board?.report?.progress?.rounds||[])])get(r);
 for(const m of record.journal?.messages||[])for(const match of String(m.text||'').matchAll(/【第\s*(\d+)\s*回合】/g))get(+match[1]);
 const last=Math.max(0,...rounds.keys());for(let r=1;r<=last;r++)get(r);
 let recovered=0;
 for(const [round,data] of rounds){
  data.routes.sort((a,b)=>a.player-b.player);
  const steps=routeSteps(routes.get(self+':'+round)),covered=new Set();
  for(const a of data.actions)if(/^[上下左右]+$/.test(a.direction||'')&&(!a.status||a.status==='sent'))for(let i=0;i<a.direction.length;i++)covered.add(Number(a.step)+i);
  for(const [step,token] of steps)if(!covered.has(step)){data.actions.push({round,step,direction:chars[token.dir],recovered:true,feedbackToken:token});recovered++;}
  data.actions.sort((a,b)=>Number(a.step)-Number(b.step)||String(a.at||'').localeCompare(String(b.at||'')));
  data.steps=steps;
 }
 return {rounds,self,recovered};
}
module.exports={archiveTimeline,routeSteps,tokenSummary};
