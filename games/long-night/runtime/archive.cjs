'use strict';
const {snapshotHtml}=require('./end-board.cjs');
const format=require('./decision-format.cjs');
const {purpose}=require('./decision-report.cjs');
const {archiveTimeline,tokenSummary}=require('./archive-timeline.cjs');
const fs=require('node:fs'),path=require('node:path');
function render(record){
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const time=v=>v?new Date(v).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'';
 const board=record.board||{},decisions=board.decisions||[],actions=board.actions||[];
 const mapCss=fs.readFileSync(path.join(__dirname,'map-assets/tools-map.css'),'utf8').replace(/url\("assets\//g,'url("/map-assets/assets/');
 const list=xs=>(xs||[]).map(x=>`<li>${esc(x)}</li>`).join('');
 const picture=a=>`<figure><figcaption>${esc(a.caption)} ${esc(time(a.at))}</figcaption><img loading="lazy" src="data:${a.mime};base64,${a.base64}" alt="${esc(a.caption)}"></figure>`;
 const pool=(record.attachments||[]).filter(a=>!a.at||/区块池|可能出现的.*地形/.test(a.caption||''));
 const photos=(record.attachments||[]).filter(a=>!pool.includes(a)&&!a.name.startsWith('private-')&&!/可见墙|墙壁信息/.test(a.caption||''));
 const timeline=archiveTimeline(record),rounds=timeline.rounds;for(const r of rounds.values())r.photos=[];
 const get=n=>{n=Number(n)||0;if(!rounds.has(n))rounds.set(n,{actions:[],photos:[],routes:[]});return rounds.get(n)};
 for(const a of photos.filter(a=>a.phase==='赛后')){const prior=actions.filter(x=>x.at<=a.at).at(-1);get(a.phase==='赛后'?-1:prior?.round||0).photos.push(a)}
 let snapshotIndex=0;
 function map(d,a,goal){
  if(!d)return '<p>未保存当时看板。</p>';
  try{
   const html=snapshotHtml({session:record.session,settings:board.settings,report:d.report,self:d.report.self,
    candidateKey:'review-'+(++snapshotIndex),command:a.direction,
    reviewMarks:goal?[{...goal,symbol:'★'}]:[]}).html;
   const main=html.match(/<main[^>]*>([\s\S]*?)<\/main>/);
   if(!main)throw Error('缺少地图内容');
   return '<section class="map-snapshot"><h4>行动前已知地图</h4>'+main[1]+'</section>';
  }catch(e){return '<p>此步看板无法恢复：'+esc(e.message)+'</p>';}
 }
 function feedback(a){
 if(!/^[上下左右]{2,}$/.test(a.direction||'')){
  const token=a.feedbackToken||timeline.rounds.get(Number(a.round))?.steps?.get(Number(a.step));
  if(token&&a.direction!=='停止')return '<section class="feedback"><h4>收到的结果</h4><p>'+esc(tokenSummary(token))+'</p></section>';
 }
 if(/^[上下左右]{2,}$/.test(a.direction)){
  const rows=[];
  for(let i=0;i<a.direction.length;i++){
   const single=feedback({...a,direction:a.direction[i],step:Number(a.step)+i});
   if(single.includes('未找到对应')){rows.push('第 '+(Number(a.step)+i)+' 步起未记录到执行反馈');break;}
   rows.push('第 '+(Number(a.step)+i)+' 步 · '+single.match(/<p>(.*?)<\/p>/)[1]);
   if(/本回合结束|对局结束/.test(single))break;
  }
  return '<section class="feedback"><h4>收到的结果</h4><p>'+rows.join('<br>')+'</p></section>';
 }
 const m=(record.journal?.messages||[]).find(m=>{const r=m.text?.match(/【第\s*(\d+)\s*回合】/),step=m.text?.match(/\[第\s*(\d+)\s*步\]/);return r&&step&&Number(r[1])===Number(a.round)&&Number(step[1])===Number(a.step)&&m.source?.key?.startsWith('group:');});
 const text=m?.text||'', parts=[];
 if(m){
 const direction=text.match(/(?:尝试)?向\s*([上下左右])\s*移动/);
 if(/碰撞|撞墙/.test(text))parts.push('向'+(direction?.[1]||a.direction)+'移动时撞墙');
 else if(direction)parts.push('向'+direction[1]+'移动');
 if(/心跳|砰砰/.test(text))parts.push('触发心跳声');
 const sounds=[...new Set(text.match(/啪嗒|啪啪|沙沙/g)||[])];
 if(sounds.length)parts.push('声音：'+sounds.join('、'));
 if(/捕获|抓获|抓住|捕捉成功/.test(text))parts.push('发生捕获');
 if(/死亡|淘汰/.test(text))parts.push('出现死亡或淘汰');
 if(/游戏结束/.test(text))parts.push('对局结束');
 else if(/本回合结束/.test(text))parts.push('本回合结束');
 else if(/请继续行动/.test(text))parts.push('可继续行动');
 }
 return '<section class="feedback"><h4>收到的结果</h4><p>'+esc(parts.length?parts.join('；')+'。':m?'已收到行动反馈，未识别到其他关键事件。':'未找到对应的群内反馈记录。')+'</p></section>';
 }
 function step(a,i){
  const d=a.recovered?null:decisions.find(d=>d.at===a.decisionAt)||decisions.filter(d=>d.at<=a.at).at(-1);
  const report=d?.report,s=report?.suggestion,t=s?.tactic;
  const matchesAction=s?.primary&&format.selectedCommand(s)===a.direction;
  const goal=matchesAction&&a.direction!=='停止'&&!s.primary?.blocked
   ? [t?.destination,s.primary?.goal,t?.target,t?.batchRoute?.target,s.primary?.to].find(p=>
    Number.isInteger(p?.r)&&Number.isInteger(p?.c)&&p.r>=0&&p.c>=0&&p.r<report.board?.n&&p.c<report.board?.n)
   : null;
  const destination=a.direction==='停止'?'留在原地':matchesAction&&t?.kind==='escape'?'逃生舱'
   :matchesAction&&['pod-probe','verify-exit'].includes(t?.kind)?'可能有逃生舱的格子'
   :goal?'地图上的目标格':/^[上下左右]$/.test(a.direction)?'往'+a.direction+'一格':a.direction;
  const reason=matchesAction&&t?.kind==='escape'?'逃生舱的位置已确认，沿这条路线过去可以逃生。'
   :a.purpose||(matchesAction&&s?.primary?purpose(report,a.round):'没有保存当时的行动原因。');
  const intent='<p class="action-intent"><strong>想去哪</strong> '+esc(destination)+(goal?'（★）':'')+
   '<br><strong>原因</strong> '+esc(reason)+'</p>';
  const title='<h3 class="action-title">'+esc(format.title({round:a.round,step:a.step||i+1,direction:a.direction}))+' <small>'+esc(time(a.at))+'</small></h3>';
  if(a.recovered)return '<article class="recovered-action">'+title+intent+'<p>根据本局实际轨迹恢复。</p>'+feedback(a)+'</article>';
  return '<article>'+title+intent+map(d,a,goal)+feedback(a)+'</article>';
 }
 function roundRoutes(r){
  const rows=(r.routes||[]).map(route=>'<li><strong>'+route.player+'号'+(route.player===timeline.self?'（本人）':'')+'</strong>：'+esc(route.tokens.map(t=>t.kind==='move'?'上下左右'[t.dir]+(t.sound==='PAPA'?'（啪嗒）':t.sound==='SHASHA'?'（沙沙）':'')+(t.outcome==='hit'?'（撞墙）':''):t.kind==='hidden'?'[隐匿，路径未公开]':t.kind==='marker'?'（'+t.value+'）':'').filter(Boolean).join(' → ')||'未移动')+(route.ending?'；'+esc(route.ending):'')+'</li>');
  const own=r.routes?.find(x=>x.player===timeline.self),ending=own?.ending?'<p>本人本回合'+esc(own.ending)+(own.tokens.some(t=>t.kind==='move')?'':'，未移动')+'。</p>':'';
  return ending+(!ending&&!r.actions.length&&rows.length?'<p>本回合没有保存本人的行动决策；已保留下面的实际轨迹。</p>':'')+(rows.length?'<details class="round-trajectories"><summary>本回合所有玩家的实际轨迹</summary><ul>'+rows.join('')+'</ul></details>':!r.actions.length&&!r.photos.length?'<p>未保存本回合的详细行动记录。</p>':'');
 }
 return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>长夜对局复盘</title><style>${mapCss}</style><style>${format.css}</style><style>.review-mark{position:absolute;left:2px;top:2px;z-index:10;background:#172338;color:#ffe681;padding:0 2px;border-radius:2px;font:bold 16px/1.1 sans-serif}article{overflow-wrap:anywhere}.map-snapshot{background:#0c1320;padding:10px;overflow:hidden}.map-snapshot .maps{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.map-snapshot .maps>section{min-width:0}.map-snapshot .board-wrap{width:100%}.map-snapshot h2{font-size:15px}.map-snapshot .cell.block-right{border-right:3px solid #698fa8}.map-snapshot .cell.block-bottom{border-bottom:3px solid #698fa8}@media(max-width:700px){.map-snapshot .maps{grid-template-columns:minmax(0,1fr)}article{padding:10px!important}body{padding:0 8px!important}.map-snapshot .board-wrap{max-width:100%!important}}body{max-width:1200px;margin:24px auto;padding:0 16px;background:#101827;color:#e6edf7;font:16px/1.7 system-ui}article,figure{padding:18px;background:#19283c;border-radius:12px;margin:18px 0}img{max-width:100%;height:auto}iframe{width:100%;border:0;background:#101827}summary{cursor:pointer;padding:12px}small,figcaption{color:#acbfd3}.warn{color:#ffce86}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body><nav><a href="/history" style="color:#b8d8ff">← 历史对局</a>　<a href="/probability?id=${esc(record.id)}" style="color:#b8d8ff">区块概率计算</a></nav><h1>长夜 · 对局复盘</h1><p>${esc(record.mode)} · ${esc(record.result)} · 北京时间 ${esc(record.endedAt?new Date(record.endedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'')}</p><h2>本局全部区块</h2>${pool.map(picture).join('')||'<p>未保存开局区块图</p>'}<h2>按回合回看</h2><p class="round-coverage">共 ${[...rounds.keys()].filter(n=>n>0).length} 回合；${timeline.recovered} 步由实际轨迹补全。未保存的历史推理不会补写成当时决策。</p>${[...rounds].sort((a,b)=>(a[0]<0?999:a[0])-(b[0]<0?999:b[0])).map(([n,r])=>`<details open class="round"><summary><strong>${n<0?'赛后结果':n===0?'开局情况':'第 '+n+' 回合'}</strong></summary>${r.photos.length?`<h3>${n<0?'终局截图':'本回合战况与存活截图'}</h3>${r.photos.map(picture).join('')}`:''}${r.actions.map(step).join('')}${roundRoutes(r)}</details>`).join('')}<details><summary>终局原文与复盘摘要</summary><pre>${esc(record.terminalText)}\n${esc(record.reviewMarkdown)}</pre></details></body></html>`;
}
module.exports={render};

