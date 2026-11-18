'use strict';
const {E}=require('./kernel.cjs');
const {compatibleAssignments}=require('./exact-decision.cjs');
const {relativeBirth,multiply,add,divide}=require('./exact-birth.cjs');
const {blockAssignmentPrior}=require('./block-prior.cjs');
const {buildWorld}=require('./bayes-worlds.cjs');
const VERSION='spawn-trap-20261105';

function openingPosterior({ctx,node,team,config,round,steps},limits={}){
 const unsupported=reason=>({worlds:null,audit:{version:VERSION,status:'unsupported',complete:false,reason}});
 if(config.playerCount!==2||round!==1||steps||config.event!=='NONE'||config.exitCount==null||!node.birth||config.roomRules?.教程==='开启')
  return unsupported('当前精确模型仅覆盖双人、无特殊事件、首回合行动前的出生与墙壁证据');
 const observations=node.mergedObservations||node.observations||[];
 if(observations.some(o=>!['walls','birth'].includes(o.kind)))return unsupported('已有走位或特殊反馈，完整历史似然尚未接通');
 const pool=E.pool({...config,heartPresence:null,preferATM:false});
 const model={pool,slots:[10,11].includes(ctx.n)?9:(ctx.n/3)**2,exitCount:config.exitCount,custom:config.mode==='CUSTOM'};
 const births=(node.joined||[{id:node.id,dr:0,dc:0}]).flatMap(j=>{
  const n=team.nodes.find(x=>x.id===j.id);return n?.birth?[{r:n.birth.r+j.dr,c:n.birth.c+j.dc,player:n.player}]:[];
 });
 const started=Date.now(),search={nodes:0,layouts:0,maxNodes:limits.maxNodes??20000,maxLayouts:limits.maxLayouts??512,deadline:started+(limits.ms??600)};
 const audit={version:VERSION,status:'incomplete',complete:false,formula:'P(整图 | 线索) ∝ 区块不放回抽取先验 × 出生概率 × 反馈似然',
  weighting:'组合先验按未观察位置求和；完整布局加入出生权重，按绝对区块平移平均并列连通区域的出生规则',nodes:0,layouts:0};
 const worlds=[],candidates=new Map();let evidence=[0n,1n];
 try{
  // Validate generator support even if the constraint search has no leaves.
  blockAssignmentPrior({...model,assignments:[]});
  for(const phase of ctx.solution.phases){
   for(const selected of compatibleAssignments({phase,n:ctx.n,exitCount:config.exitCount,observations,search})){
    const prior=blockAssignmentPrior({...model,assignments:selected.map((m,slot)=>({slot,id:m.id}))});
    if(!prior[0])continue;
    const w=buildWorld(phase,selected,ctx.n);
    if(config.heartPresence!=null&&w.heart!==config.heartPresence)continue;
    const mass=multiply(prior,relativeBirth(w,births,config.playerCount,phase));
    if(mass[0]){
     worlds.push({w,mass});evidence=add(evidence,mass);
     const {slot,i:cell}=E.phaseAt(phase,ctx.n,node.birth.r,node.birth.c),m=slot<0?phase.domains[-1][0]:selected[slot];
     const key=m.id+':'+cell,item=candidates.get(key)||{block:m.id,name:m.block.name||m.name||'',row:Math.floor(cell/3)+1,col:cell%3+1,mass:[0n,1n]};
     item.mass=add(item.mass,mass);candidates.set(key,item);
    }
   }
   if(search.aborted)break;
  }
 }catch(error){return {...unsupported('出生或抽图模型不支持：'+error.message),audit:{...audit,status:'unsupported',reason:error.message,elapsedMs:Date.now()-started}};}
 Object.assign(audit,{nodes:search.nodes,layouts:Math.min(search.layouts,search.maxLayouts),elapsedMs:Date.now()-started});
 if(search.aborted)return {worlds:null,audit:{...audit,reason:search.reason}};
 if(!evidence[0])return {worlds:null,audit:{...audit,status:'no-compatible-world',reason:'出生加权后没有相容布局'}};
 const positionCandidates=[...candidates.values()].map(c=>({block:c.block,name:c.name,row:c.row,col:c.col,weight:c.mass.join('/'),fraction:divide(c.mass,evidence).join('/'),probability:Number(divide(c.mass,evidence)[0])/Number(divide(c.mass,evidence)[1])})).sort((a,b)=>b.probability-a.probability);
 return {worlds,positionCandidates,audit:{...audit,status:'exact',complete:true,positiveLayouts:worlds.length,positionKind:'出生点',birthWeight:'已纳入完整布局的真实出生概率',candidateCount:positionCandidates.length,
  reason:'相容布局已全部求和，所有候选行动使用同一份后验'}};
}
module.exports={openingPosterior,VERSION};
