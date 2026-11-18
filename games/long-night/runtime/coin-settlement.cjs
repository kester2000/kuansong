'use strict';
const {M}=require('../night-strategist/kernel.cjs');

// LGTBot settles the whole table after the last public route and before the
// next stage header. An empty window is evidence only between trusted anchors.
function readSettlement(events,{round,players,botId,startedAt,groupId,textOf}) {
  if (!Number.isInteger(players)||players<1||players>8||!botId||!Number.isFinite(startedAt)) return null;
  const rows=events.filter(e=>String(e.user_id)===String(botId)&&Number(e.time)*1000>=startedAt
    &&(e.group_id==null||String(e.group_id)===String(groupId)))
    .sort((a,b)=>Number(a.time)-Number(b.time)).map(e=>({body:textOf(e),id:e.message_id}));
  const stage=row=>Number(row.body.match(/^【当前阶段】\s*主阶段\s*>>\s*第\s*(\d+)\s*回合/)?.[1]);
  const end=rows.findIndex(row=>stage(row)===round+1);
  if(end<0)return null;
  const start=rows.slice(0,end).findLastIndex(row=>stage(row)===round);
  if(start<0)return null;
  const window=rows.slice(start+1,end);
  if(window.some(row=>stage(row)||/本局游戏人数为\s*\d+\s*人/.test(row.body)))return null;
  const lastRoute=window.findLastIndex(row=>/^\s*\[\d+号\]玩家本回合的完整行动轨迹/.test(row.body));
  if(lastRoute<0)return null;
  const notices=window.filter(row=>/^【金币公示】/.test(row.body));
  if(window.slice(lastRoute+1).some(row=>row.body.includes('金币公示')&&!notices.includes(row)))return null;
  if(notices.length>1||notices.length&&window.indexOf(notices[0])<=lastRoute)return null;
  const lines=notices.length?notices[0].body.trim().split(/\r?\n/).slice(1).filter(s=>s.trim()):[];
  if(notices.length&&!lines.length)return null;
  const listed=new Set();
  for(const line of lines){
    const gains=M.parse(line).items.filter(i=>i.kind==='coins'&&i.pickup);
    if(gains.length!==1)return null;
    const g=gains[0];
    if(g.player>=players||listed.has(g.player)||!Number.isInteger(g.gained)||g.gained<1||g.count==null)return null;
    listed.add(g.player);
  }
  const transfer=window.some(row=>/抢夺了[^\n]*金币|\(捕捉\)|（捕捉）/.test(row.body));
  const text=[`【第 ${round} 回合】`,'【金币结算核验】',...lines];
  const doorNotices=window.filter(row=>/门曾被按钮触发/.test(row.body));
  if(doorNotices.length){
    for(const notice of doorNotices){
      const changes=notice.body.match(/门曾被按钮触发，(?:共)?发生\s*(\d+)\s*次变化/);
      if(!changes)return null;
      text.push(`门曾被按钮触发，共发生 ${changes[1]} 次变化`);
    }
  }else text.push('确认本回合没有门变化公告');
  if(transfer)text.push('【含捕捉或金币转移】');
  for(let p=0;p<players;p++)if(!listed.has(p))text.push(`${p}号未获得金币`);
  text.push(`核验群消息 ${rows[start].id} → ${rows[end].id}`);
  return {text:text.join('\n')};
}
module.exports={readSettlement};
