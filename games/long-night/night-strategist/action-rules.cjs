'use strict';
function capture(s){return ['finish-capture','attempt-capture'].includes(s?.tactic?.kind)&&s.tactic.round>1;}
function trappedWalls(s){
 return s?.position?.unique===true&&Number.isInteger(s.position.r)&&Number.isInteger(s.position.c)
  &&!(s.warnings||[]).some(w=>/矛盾|冲突|待定|尚未确定/.test(w))
  &&s.moves?.length===4&&new Set(s.moves.map(m=>m.dirIndex)).size===4
  &&s.moves.every(m=>Number.isInteger(m.dirIndex)&&m.dirIndex>=0&&m.dirIndex<4&&m.direction===['up','down','left','right'][m.dirIndex]
   &&m.blocked===true&&m.known===true&&!m.modeForbidden&&m.wall==='墙'&&m.wallKinds?.length
   &&(m.wallKinds.every(k=>[1,2,3].includes(k))||m.reportedClosed===true&&m.wallKinds.every(k=>k===3||k===4)));
}
function trappedFinish(s){
 const p=s?.primary,t=s?.tactic,m=s?.moves?.find(m=>m.dirIndex===p?.dirIndex);
 return t?.kind==='trapped-finish'&&Number.isInteger(t.round)&&t.round>=1&&Number.isInteger(t.steps)&&t.steps>=0
  &&trappedWalls(s)&&p?.intentionalCollision===true&&p.blocked===true&&p.direction===m?.direction
  &&m.wallKinds.every(k=>k===1||k===3)&&JSON.stringify(p.wallKinds)===JSON.stringify(m.wallKinds)
  &&p.to?.r===s.position.r&&p.to?.c===s.position.c;
}
function mayStop(s){
 if(require('./mode-policy.cjs').canStopForMode(s))return true;
 const t=s?.tactic;
 if(t?.kind==='portal-heartbeat-wait')return t.heartPresence===true&&t.remaining===1&&t.steps===t.entryStep+1&&t.nextExitStep===1;
 if(!capture(s)||t.stopException!=='capture-no-wall')return false;
 const target=t.kind==='finish-capture'?t.target:t.destination;
 if(t.kind==='finish-capture'&&['aligned-map','same-cell-sound'].includes(target?.source)
   &&s.position?.unique===true&&target.r===s.position.r&&target.c===s.position.c
   &&!(s.warnings||[]).some(w=>/矛盾|冲突/.test(w)))return true;
 return target?.r===s.position?.r&&target?.c===s.position?.c&&s.moves?.length===4
  &&s.moves.every(m=>!m.blocked&&m.wall==='空');
}
function enforce(s){
 if(!s?.ok)return s;
 // Physically trapped is different from an exhausted exploration score. All
 // four edges must be blocked by map evidence or unoverridden private wall
 // reports. A possible door retains its uncertainty; finish only against a
 // separately proven solid wall/closed door, never that uncertain edge or hedge.
 if(trappedFinish(s))return s;
 if(!capture(s)&&trappedWalls(s)&&Number.isInteger(s.tactic?.round)&&Number.isInteger(s.tactic?.steps)){
  const wall=s.moves.find(m=>m.wallKinds.every(k=>k===1||k===3));
  if(wall)return {...s,primary:{...wall,to:{r:s.position.r,c:s.position.c},intentionalCollision:true,
   reasons:['当前位置四个方向均已确认走不通，撞确定墙结束回合并取得反馈'],gains:[],risks:['结束回合会交出行动权']},alternatives:[],
   tactic:{kind:'trapped-finish',round:s.tactic.round,steps:s.tactic.steps}};
 }
 const p=s.primary,t=s.tactic;
 const forbidden=!p||p?.direction==='stop'&&!mayStop(s)||p?.intentionalCollision&&!capture(s)
  ||t?.kind==='finish-exploration'||t?.kind==='finish-protected-opening';
 if(!forbidden)return s;
 let options=(s.moves||[]).filter(m=>!m.blocked&&!m.loopBlocked&&!m.explorationForbidden&&m.wall!=='墙'&&m.direction!=='stop'&&!m.intentionalCollision)
  .sort((a,b)=>b.score-a.score||(a.failedProbeCount||0)-(b.failedProbeCount||0)||(a.evaluation?.repeat||0)-(b.evaluation?.repeat||0)||(a.commandCount||0)-(b.commandCount||0));
 // A visited corridor is still the only exit from a cul-de-sac. Repetition is
 // a planning cost, never a physical prohibition that can force a timeout.
 // Keep walls (including conditional known walls) and collisions forbidden.
 let retrace=false;
 if(!options.length){
  options=(s.moves||[]).filter(m=>!m.blocked&&!m.branchRisk?.wall&&m.wall==='空'&&m.direction!=='stop'&&!m.intentionalCollision)
   .sort((a,b)=>Number(!!a.loopBlocked)-Number(!!b.loopBlocked)||(a.commandCount||0)-(b.commandCount||0)||b.score-a.score);
  retrace=options.length>0;
 }
 const primary=options[0]||null;
 if(primary)primary.reasons=[...(primary.reasons||[]),'继续寻找通路：未知候选中的危险只扣分，不视作确定危险；不为收尾撞已知墙或普通停止'];
 if(retrace)primary.reasons.push('没有可直接探索的出口，沿已知通路退回；这一步不计算新信息收益，下一格重新选路');
 return {...s,primary,alternatives:options.slice(1,3),tactic:{kind:primary?(retrace?'required-transit':'continue-exploration'):'no-legal-action',round:t?.round,steps:t?.steps},warnings:[...(s.warnings||[]),...(!primary?['没有符合行动限制的方向，等待新反馈；不发送撞墙或停止']:[])]};
}
module.exports={capture,mayStop,enforce,trappedWalls,trappedFinish};
