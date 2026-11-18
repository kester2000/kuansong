'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const store=require('./storage.cjs'),game=require('./game.cjs');
const K=game.module('night-strategist/kernel.cjs');
const {blockAssignmentPrior}=game.module('night-strategist/block-prior.cjs');
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function readRecord(id){
 if(!/^[A-Za-z0-9_-]{1,100}$/.test(id))return null;
 const p=path.join(store.dataDir(),'matches',id+'.json');
 if(!fs.existsSync(p)||!fs.existsSync(p.replace(/\.json$/,'.html')))return null;
 return JSON.parse(fs.readFileSync(p,'utf8'));
}
function analysisFor(record){
 if(!/^[A-Za-z0-9_-]{1,100}$/.test(record.id||''))return null;
 const p=path.join(store.dataDir(),'analysis',record.id+'.json');if(!fs.existsSync(p))return null;
 const data=JSON.parse(fs.readFileSync(p,'utf8'));
 if(data.complete!==true||data.recordId!==record.id||!Number.isInteger(data.messageCount))return null;
 const prefix=JSON.stringify({base:record.journal.base,messages:record.journal.messages.slice(0,data.messageCount),view:record.journal.view});
 if(crypto.createHash('sha256').update(prefix).digest('hex')!==data.evidenceHash)return null;
 return data;
}
function modelFor(record){
 // Archives can include later lobby settings after the match ended. Read
 // the saved opening model, never replay those messages into this match.
 const opening=record.board?.decisions?.find(d=>d.report?.settings?.pool&&Number.isInteger(d.report.settings.exitCount));
 let config;
 if(opening)config={...record.journal.base.config,...opening.report.settings};
 else{
  const first=record.board?.actions?.[0],decision=record.board?.decisions?.find(d=>d.at===first?.decisionAt);
  const count=decision?.report?.progress?.messages;
  if(!Number.isInteger(count)||count<1)throw Error('未保存可核对的开局抽图配置');
  const built=K.build({...record.journal,messages:record.journal.messages.slice(0,count)});
  config=built.views[built.self].model.config;
 }
 if(config.size%3)throw Error('这局为非规则区块布局，尚不支持此计算器');
 const pool=K.E.pool({...config,heartPresence:null,preferATM:false});
 return {pool,slots:(config.size/3)**2,exitCount:config.exitCount,custom:config.mode==='CUSTOM'};
}
function calculate(record,ids){
 if(!ids.length||ids.length>3)throw Error('请选择 1 至 3 个区块');
 const model=modelFor(record);
 if(ids.some(id=>!model.pool.some(b=>b.id===id)))throw Error('区块不在本局原始区块池内');
 const fraction=blockAssignmentPrior({...model,assignments:ids.map((id,slot)=>({slot,id}))});
 return {kind:'draw-prior',complete:true,ids,fraction:fraction.join('/'),probability:Number(fraction[0])/Number(fraction[1]),
  description:'指定的不同位置按顺序抽到这些区块的先验；未加入出生位置、墙壁或声音证据。'};
}
function render(record,ids){
 const model=modelFor(record),selection=ids.length?ids:[model.pool[0].id],result=calculate(record,selection),analysis=analysisFor(record);
 const dropdown=index=>'<label>区块位置 '+['A','B','C'][index]+'<select name="b'+index+'">'+(index?'<option value="">不展开到这里</option>':'')+model.pool.map(b=>'<option value="'+esc(b.id)+'"'+(selection[index]===b.id?' selected':'')+'>'+esc(b.id+' · '+b.name)+'</option>').join('')+'</select></label>';
 const rows=analysis?.candidates||[];
 return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>区块概率 · 长夜复盘</title><style>
 :root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#101827;color:#e6edf7;font:16px/1.7 system-ui}main{max-width:900px;margin:auto;padding:24px 16px 60px}a{color:#b8d8ff}nav{display:flex;gap:20px;flex-wrap:wrap}h1{font-size:26px}h2{font-size:20px}section{background:#19283c;border:1px solid #2c4057;border-radius:12px;padding:20px;margin:20px 0}p{margin:10px 0}.muted{color:#acbfd3}.status{color:#ffce86}form{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}label{display:grid;gap:6px;min-width:0}select,button{font:inherit;padding:10px;border:1px solid #536b87;border-radius:7px;background:#102035;color:inherit;min-width:0;width:100%}button{grid-column:1/-1;background:#204571;cursor:pointer}.number{font-size:30px;font-weight:700;color:#bce9bc}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:10px 6px;border-bottom:1px solid #3d4d63;vertical-align:top}td:last-child,th:last-child{text-align:right;white-space:nowrap}summary{cursor:pointer;padding:10px 0}code{overflow-wrap:anywhere;white-space:normal}details p{overflow-wrap:anywhere}@media(max-width:600px){form{grid-template-columns:1fr}section{padding:14px}main{padding:18px 10px}td,th{font-size:14px;padding:8px 4px}}
 </style></head><body><main><nav><a href="/history">历史对局</a><a href="/report/${esc(record.id)}.html">返回本局复盘</a></nav><h1>区块概率</h1><p class="muted">本局区块池 ${model.pool.length} 块 · 地图 ${model.slots} 个位置 · 逃生舱区块 ${model.exitCount} 个</p>
 <section><h2>单／双／三区块组合先验</h2><p>选择固定位置 A、B、C 上的区块，按需展开到一个、两个或三个区块。</p><form action="/probability" method="get"><input type="hidden" name="id" value="${esc(record.id)}">${[0,1,2].map(dropdown).join('')}<button type="submit">计算组合概率</button></form><p class="number">${(result.probability*100).toFixed(6)}%</p><p>${esc(selection.join(' → '))} · 精确值 <code>${esc(result.fraction)}</code></p><p class="muted">${esc(result.description)}</p><details><summary>计算依据</summary><p>固定逃生舱数量、区块不重复；未选择的位置通过组合计数求和消去。抽图区块受热源互斥规则影响时，分别按两种抽图分支加权。</p><p>若本次选择 a 个普通区块、b 个逃生舱区块，先验为 (S−Q)<sub>a</sub> Q<sub>b</sub> ÷ [S<sub>a+b</sub> M<sub>a</sub> X<sub>b</sub>]。下标表示下降阶乘；S 是地图位置数，Q 是舱区块数，M、X 是池中两类区块数。</p></details></section>
 ${rows.length?'<section id="entry-posterior"><h2>第 1 步啪嗒后的落点后验</h2><p>只使用当时前 '+analysis.messageCount+' 条记录。已穷尽相容布局，并按原出生选点规则加权；不使用后续走位倒推当时概率。</p><table><thead><tr><th>区块与区块内位置</th><th>概率</th></tr></thead><tbody>'+rows.map(c=>'<tr><td>'+esc(c.block+' · '+c.name)+'<br><span class="muted">第 '+c.row+' 行第 '+c.col+' 列 · '+esc(c.type)+'</span></td><td>'+(c.probability*100).toFixed(6)+'%</td></tr>').join('')+'</tbody></table><details><summary>查看精确分数与求和过程</summary><p>后验 = 本落点所有相容整图的「抽图先验 × 出生选点概率 × 反馈似然」之和 ÷ 全部相容落点的权重之和。</p><p>完整检查 '+analysis.layouts.toLocaleString('zh-CN')+' 个布局；概率保留为分数，上方百分比仅作四舍五入显示。</p>'+rows.map(c=>'<p>'+esc(c.block+'（'+c.row+','+c.col+'）')+'：<code>'+esc(c.fraction)+'</code></p>').join('')+'</details></section>':''}
 <p class="status">当前网站展示组合先验${rows.length?'及这一步的落点后验':''}。线上已将组合先验和出生权重接入受支持的开局决策；完成求和时按精确期望行动。全图计算预算不足时切到附近区块枚举，局部概率不包含完整全图出生及远处未确定信息；仍未完成时采用固定的最不利收益。不能把局部模型视作完整全图后验。历史页面的离线重算不代表当时实际采用的策略。</p></main></body></html>`;
}
module.exports={readRecord,analysisFor,modelFor,calculate,render};
