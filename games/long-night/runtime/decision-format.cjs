'use strict';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const numeric=v=>typeof v==='number'&&Number.isFinite(v);
const number=v=>numeric(v)?Number(v.toFixed(2)).toString():'未记录';
const fraction=v=>{if(typeof v!=='string'||!/^[-\d]+\/\d+$/.test(v))return null;const [n,d]=v.split('/').map(Number);return d&&Number.isFinite(n/d)?n/d:null;};
const command=p=>({up:'上',down:'下',left:'左',right:'右',stop:'停止'}[p?.direction]||p?.label||p?.arrow||'未记录');
function selectedCommand(s){
 const t=s?.tactic||{};
 if(t.batchRoute?.commands)return t.batchRoute.commands;
 if(t.batchEscape?.commands)return t.batchEscape.commands;
 if(t.batchCapture?.commands)return t.batchCapture.commands;
 if(t.kind==='bayes-exploration'&&t.confirmedPrefix)return t.command;
 if(t.kind==='heartbeat-align'&&t.directions?.length)return t.directions.map(d=>'上下左右'[d]).join('');
 return command(s?.primary);
}
function title({round,step,direction}){
 const start=Number(step),count=/^[上下左右]+$/.test(direction||'')?direction.length:1;
 return '第'+(Number(round)||1)+'回合 第'+(start>0?start:1)+(count>1?'-'+((start>0?start:1)+count-1):'')+'步 行动：'+(direction||'未记录');
}
function renderReason(report, { round, action } = {}){
 const s=report?.suggestion;
 if(!action&&!s?.primary)return '<p class="decision-empty">当前没有可执行的行动建议。</p>';
 const reason=action?.purpose || (s?.tactic?.kind==='escape'?'沿已确认的路线前往逃生舱':require('./decision-report.cjs').purpose(report,round));
 return '<p class="action-reason"><strong>行动原因</strong> '+esc(reason)+'</p>';
}
function optionsFor(s){
 const data=s?.bayes||s?.calculation;
 let options=data?.options?.map(o=>({...o,command:(s?.tactic?.batchEscape||s?.tactic?.batchCapture||s?.tactic?.batchRoute)&&o.command===command(s.primary)?selectedCommand(s):o.command,outcomes:o.outcomes||[]}));
 if(!options?.length){
  const chosen=s?.primary,byCommand=new Map();
  for(const m of [...(s?.moves||s?.alternatives||[]),...(chosen?[chosen]:[])]){
   if(m.blocked&&m!==chosen)continue;
   const name=m===chosen?selectedCommand(s):command(m);
   byCommand.set(name,{command:name,score:m.score,outcomes:[],reasons:[...(m.reasons||[]),...(m.gains||[]),...(m.risks||[])]});
  }
  options=[...byCommand.values()];
 }
 const score=o=>numeric(o.score)?o.score:fraction(o.expected)??(numeric(o.low)?o.low:-Infinity);
 return {data,options:options.map(o=>({...o,score:score(o)})).sort((a,b)=>b.score-a.score)};
}
// Candidate support rows are overlapping possibilities, not probability mass.
// Only sum rows that already carry probabilities; never infer frequencies.
function outcomesFor(option){
 const groups=new Map();
 for(const r of option.outcomes||[]){
  const label=(r.label||'未知结果').replace(/^进入空地/,'空地');
  const value=numeric(r.utility)?r.utility:numeric(r.low)?r.low:null;
  const p=numeric(r.probability)?r.probability:fraction(r.fraction);
  const g=groups.get(label)||{label,wallPattern:r.wallPattern,conditional:0,conditionalKnown:true,probability:0,known:true,weighted:0,hasUtility:true,low:Infinity,high:-Infinity};
  if(r.wallPattern){if(numeric(r.collisionConditionalProbability))g.conditional+=r.collisionConditionalProbability;else g.conditionalKnown=false;}
  if(p==null||p<0||p>1)g.known=false;else{g.probability+=p;if(value!=null)g.weighted+=p*value;}
  if(value==null)g.hasUtility=false;
  if(value!=null){g.low=Math.min(g.low,value);g.high=Math.max(g.high,value);}
  else{if(numeric(r.low))g.low=Math.min(g.low,r.low);if(numeric(r.high))g.high=Math.max(g.high,r.high);}
  groups.set(label,g);
 }
 return [...groups.values()].map(g=>({...g,probability:g.known?g.probability:null,
  value:g.known&&g.hasUtility&&g.probability>0?g.weighted/g.probability:numeric(g.low)?g.low:null}));
}
function render(s){
 const {data,options}=optionsFor(s);if(!options.length)return '<p class="decision-empty">未保存候选行动及评分。</p>';
 if(data?.mode==='objective-policy')return '<section class="action-ranking" aria-label="候选行动评分"><p class="decision-note">目标策略：分数用于比较目标价值、路线成本与风险，不是概率或胜率。探索时逐步反馈重算；已核验的单机逃生路线可连续发送。</p>'+options.map((o,i)=>
  '<details class="action-option" data-rank="'+(i+1)+'" data-action="'+esc(o.command)+'"'+(i===0?' open':'')+'><summary>行动 '+esc(o.command)+' 分数 '+number(o.score)+'</summary>'+
  '<p>'+esc((o.reasons||[]).map(reason=>/探索（\d+,\d+）/.test(reason)?'探索路线：'+String(o.route||o.command).replace(/[上下左右]/g,c=>({'上':'↑','下':'↓','左':'←','右':'→'}[c])):reason).join('；'))+'</p>'+(o.route?'<p>规划路线：'+esc(String(o.route).replace(/[上下左右]/g,c=>({'上':'↑','下':'↓','左':'←','右':'→'}[c])))+'（后续步骤不预先发送）</p>':'')+
  (o.outcomes?.length?'<p class="outcome-line">'+o.outcomes.map(r=>'<span>'+esc(r.label)+'（'+number(r.probability*100)+'%，'+number(r.utility)+'）</span>').join(' ')+'</p><p>括号内为采样概率、该结果下的行动分数；行动分数＝Σ（概率×结果分数）。未抽中的情况不等于规则上不可能。</p>':o.possibilities?.length?'<p>尚可能遇到：'+esc(o.possibilities.join('、'))+'。这些是兼容情况，不代表已计算概率。</p>':'')+
  '<details class="action-calculation"><summary>评分明细</summary><ul>'+Object.entries(o.components||{}).map(([k,v])=>'<li>'+esc(k)+'：'+(v>0?'+':'')+number(v)+'</li>').join('')+'</ul></details></details>').join('')+
  (data.particles?'<details class="particle-audit"><summary>候选地图与采样依据</summary><p>'+esc(data.particles.status==='estimated'?'条件采样估计，非精确后验；固定收益用于排序，不是胜率。':data.particles.reason)+'</p><p>尝试 '+number(data.particles.attempts)+' · 样本 '+number(data.particles.samples)+' · 有效样本 '+number(data.particles.ess)+' · 不同布局 '+number(data.particles.distinct)+' · 采样 '+number(data.particles.elapsedMs)+' 毫秒</p><p>'+esc(data.particles.scope||'')+'</p>'+(data.particles.positions?.length?'<p>出生位置的样本后验：</p><ul>'+data.particles.positions.map(p=>'<li>'+esc(p.block+' '+p.name)+' · '+p.row+'行'+p.col+'列：'+number(p.probability*100)+'%</li>').join('')+'</ul>':'')+'</details>':'')+
  '<p class="decision-note">策略 '+esc(data.policy)+' · 决策 '+number(data.audit?.elapsedMs)+' 毫秒</p></section>';
 const candidateNames=new Map((data?.candidates||[]).map(c=>[c.id,c.block+' '+c.name+'（'+c.row+','+c.col+'）']));
 const wallPreview=shape=>/^[空墙]{4}$/.test(shape||'')?'<i class="wall-shape" role="img" aria-label="上下左右 '+shape+'" style="'+['top','bottom','left','right'].map((side,i)=>'border-'+side+':3px solid '+(shape[i]==='墙'?'#e9eef8':'#3c5668')).join(';')+'">·</i>':'';
 const resultText=r=>wallPreview(r.wallPattern)+esc(r.label)+'('+ (r.probability==null?'概率未算出':(r.probability*100).toFixed(2).replace(/\.?0+$/,'')+'%')+','+
  number(r.value)+')'+(r.wallPattern&&r.conditionalKnown?' · 撞墙后该墙形概率 '+number(r.conditional*100)+'%':'');
 const renderOption=(o,i)=>{
  const rows=outcomesFor(o);
  const raw=o.outcomes.map(r=>'<li>'+esc(r.candidate?(candidateNames.get(r.candidate)||r.candidate)+'：':'')+esc(r.label)+
   (r.fraction?'；精确概率 '+esc(r.fraction):'')+(r.utilityFraction?'；条件收益 '+esc(r.utilityFraction):'')+
   (r.contributionFraction?'；期望贡献 '+esc(r.contributionFraction):'')+(r.collisionConditionalFraction?'；已撞墙条件下该墙形概率 '+esc(r.collisionConditionalFraction):'')+(r.reasons?.length?'；'+esc(r.reasons.join('；')):'')+'</li>').join('');
  const reasons=[...(o.reasons||[])];
  if(o.model)reasons.push(o.model.reason,...(o.model.assumptions||[]));
  if(o.costs)reasons.push('移动代价 '+o.costs.travel+'；前置按钮代价 '+o.costs.buttonPrefix+'；探索折减 '+o.costs.regionDiscount);
  return '<details class="action-option" data-rank="'+(i+1)+'" data-action="'+esc(o.command)+'"'+(i===0?' open':'')+'><summary>行动 '+esc(o.command)+' 分数 '+number(o.score)+'</summary>'+
   (rows.length?'<p class="outcome-line">'+rows.map(r=>'<span>'+resultText(r)+'</span>').join(' ')+'</p>':'<p class="outcome-line">未记录各结果的概率与评分。</p>')+
   (raw||reasons.length?'<details class="action-calculation"><summary>计算过程与原因</summary>'+(reasons.length?'<p>'+esc(reasons.join('；'))+'</p>':'')+(o.expected?'<p>期望分 = 各结果概率 × 条件收益之和 = '+esc(o.expected)+'</p>':'')+'<ul>'+raw+'</ul></details>':'')+'</details>';
 };
 let notes='';
 if(data?.mode==='local-model')notes='<p class="decision-note">局部区块模型概率，非完整全图后验。行动分数＝Σ（结果概率×固定收益）；括号内概率为该行动发生此结果的概率。</p>';
 else if(data?.mode==='conservative'||data?.mode==='support-bounds'||data?.audit?.complete===false)notes='<p class="decision-note">本步固定取最不利结果的收益作保守分数，不取上下界平均；未完成的概率不以候选数量代替。</p>';
 else if(data&&data.version!==2&&data.version!==3)notes='<p class="decision-note">历史采样估计，非精确概率。</p>';
 const audit=data?.audit;
 const terrainName=t=>({EMPTY:'空地',WATER:'水洼',GRASS:'草丛',PORTAL:'传送门',ONEWAYPORTAL:'传送门出口',TRAP:'陷阱',BERRY:'浆果丛',COLLISION:'撞墙',HEART:'心脏',HEAT:'热源',EXIT:'逃生舱'}[t]||t);
 const positionDetails=data?.positionCandidates?.length?'<details class="position-posterior"><summary>'+esc(audit?.positionKind||'位置')+'候选与贝叶斯计算（'+data.positionCandidates.length+' 个格子）</summary><p>'+esc(audit?.birthWeight||'出生权重未记录')+'</p><p>'+esc(audit?.formula||'候选权重＝抽图先验×出生概率×反馈似然；候选概率＝候选权重÷全部候选权重之和')+'</p><p>坐标为区块内第几行、第几列，从 1 开始；下列方向概率以该候选格子为条件。</p><ul>'+data.positionCandidates.map(c=>'<li><strong>'+esc(c.block)+' '+esc(c.name)+'（'+c.row+'行，'+c.col+'列）：'+number(c.probability*100)+'%</strong><br>权重 '+esc(c.weight)+'；归一化概率 '+esc(c.fraction)+(c.directions||[]).map(d=>'<div>'+esc(d.direction)+'：'+d.outcomes.map(o=>esc(terrainName(o.type))+' '+number(o.probability*100)+'%（'+esc(o.fraction)+'）').join('，')+'</div>').join('')+'</li>').join('')+'</ul></details>':'';
 const provenance=(audit?'<p>'+esc(audit.reason)+' · '+esc(audit.layouts??0)+' 个布局 · '+esc(audit.elapsedMs??0)+' 毫秒</p>'+(audit.assumptions?.length?'<p>模型假设：'+esc(audit.assumptions.join('；'))+'</p>':''):'')+
  (data?.valueModel?'<p>收益基准：确认逃生 +1000；新探索 +5；重复格 −2；对外发声 −12；按钮泄露 −14；撞墙结束行动 −6；新增私聊四墙事实每面 +2（已知不重复奖励）。分数用于行动排序，不代表已校准的胜率。</p>':'')+
  (data?.formula?'<p>'+esc(data.formula)+'</p><p>'+esc(data.probabilityStatus)+'</p>':'')+
  (data?.candidates?.length?'<ul>'+data.candidates.map(c=>'<li>'+esc(candidateNames.get(c.id))+'：'+esc(c.posterior??'落点后验未算出')+'</li>').join('')+'</ul>':'')+
  (data?.execution?'<p>'+esc(data.execution)+'</p>':'');
 return '<section class="action-ranking" aria-label="候选行动评分">'+options.slice(0,3).map(renderOption).join('')+
  (options.length>3?'<details class="more-actions"><summary>其他 '+(options.length-3)+' 个候选行动</summary>'+options.slice(3).map((o,i)=>renderOption(o,i+3)).join('')+'</details>':'')+
  notes+positionDetails+(provenance?'<details class="probability-basis"><summary>概率依据</summary>'+provenance+'</details>':'')+'</section>';
}
const css='.wall-shape{display:inline-flex;vertical-align:middle;align-items:center;justify-content:center;width:28px;height:28px;margin-right:8px;font-style:normal;background:#172738}.action-ranking{margin:14px 0;overflow-wrap:anywhere}.action-option{border:1px solid #3b5069;border-radius:8px;margin:8px 0;padding:0 12px}.action-option>summary{cursor:pointer;font-weight:650;padding:12px 0}.outcome-line{display:flex;flex-wrap:wrap;gap:8px 20px;margin:0 0 12px;line-height:1.8}.outcome-line>span{overflow-wrap:anywhere;max-width:100%}.action-calculation,.probability-basis,.more-actions{font-size:14px}.action-calculation>summary,.probability-basis>summary,.more-actions>summary{cursor:pointer;padding:8px 0}.decision-note{font-size:13px;color:#c5b492}.action-title{font-size:18px;margin:18px 0}.action-ranking ul{padding-left:20px}.action-ranking details>summary{white-space:normal}.live-decision{margin:12px 0}.reanalysis{margin-top:16px;border-top:1px solid #566980}';
module.exports={title,render,renderReason,selectedCommand,optionsFor,outcomesFor,css};
