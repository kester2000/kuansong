'use strict';
const fs=require('node:fs'),path=require('node:path');
const {spawn}=require('node:child_process');
const {pathToFileURL}=require('node:url');
const store=require('../night-strategist/store.cjs');
const {M}=require('../night-strategist/kernel.cjs');

function purpose(report,round){
  const s=report?.suggestion,p=s?.primary,t=s?.tactic||{};
  if(!p)return '没有保存这次行动的判断';
  const target=t.target?.target??(Number.isInteger(t.target)?t.target:null);
  const who=target==null?'目标玩家':target+' 号';
  if(t.kind==='pod-probe')return '试探可能可用的逃生舱';
  if(t.kind==='escape')return '前往已确认的逃生舱，预计路线需要 '+t.routeCost+' 步';
  if(['pursue','finish-capture'].includes(t.kind))return '沿已确认路线抓 '+who+(t.kind==='finish-capture'?'，尝试在同格结束回合':'');
  if(t.kind==='attempt-capture')return '在 '+who+' 的候选格结束回合，尝试捕捉';
  if(t.kind==='target-scout'||t.candidates?.positions?.length)return '向 '+who+' 的可能位置靠近'+(t.candidates?.positions?.length?'，当时还有 '+t.candidates.positions.length+' 个位置候选':'');
  if(t.kind==='portal-diagnostic')return '试走一步，利用后续有没有出口声区分水和传送门';
  if(t.kind==='portal-heartbeat-wait')return '结束本回合，尝试用下回合第一步的心跳掩盖出口声';
  if(t.kind==='portal-transit')return '推进亚空间移动，到出口后重新定位';
  if(/^heartbeat-/.test(t.kind||''))return '利用心跳掩盖探路声，接近未查明的地形';
  if(t.kind==='finish-exploration')return '结束这段探索，等待回合结算';
  if(t.destination)return '沿通路接近下一处可以探明的格子';
  if(round>=1&&round<=2&&!t.kind)return '无明确目的';
  if(p.wall!=='空')return '试探'+(p.label||'所选方向')+'的边是否能通过';
  if(p.terrain?.length>1)return '探明落脚格，区分'+p.terrain.map(type=>names[type]||type).join('、');
  return p.reasons?.find(x=>!x.includes('路线评估'))||'按当前地图继续探索';
}
const names={EMPTY:'空地',WATER:'水',GRASS:'草丛',PORTAL:'传送门',BERRY:'浆果',EXIT:'逃生舱',HEART:'心脏',TRAP:'陷阱',HEAT:'热源',BUTTON:'按钮'};
function readable(text){
  return text.replace(/[（(]\s*\d+\s*[,，]\s*\d+\s*[）)]/g,'目标格')
    .replace(/第\s*\d+\s*行[、，\s]*第\s*\d+\s*列/g,'目标格')
    .replace(/，含结束行动代价 [\d.]+/g,'，还要在目标格结束回合')
    .replace(/位置候选/g,'可能位置').replace(/定向探查/g,'探查')
    .replace(/结束前仍有安静未知前沿：[^。]*/g,'还有可以安全探查的格子，继续走')
    .replace(/前两回合主动探新格，接受适量发声与未知墙风险/g,'趁开局探一个新格，可能发声或撞墙').replace(/号 的/g,'号的');
}
function narrowed(before,after){
  if(!before?.board?.frameId||before.board.frameId!==after?.board?.frameId||
    !before.board.alignment?.confirmed||!after.board.alignment?.confirmed||
    JSON.stringify(before.board.alignment)!==JSON.stringify(after.board.alignment))return '';
  for(const slot of before.slots||[]){
    const later=after.slots?.find(s=>s.r===slot.r&&s.c===slot.c);
    if(!later?.ids?.length||!later.ids.every(id=>slot.ids.includes(id)))continue;
    const removed=slot.ids.filter(id=>!later.ids.includes(id));
    if(removed.length){
      return {r:slot.r,c:slot.c,text:'▧ 区块从 '+slot.ids.length+' 种可能缩小到 '+(later.ids.length===1?'只剩 '+later.ids[0]:later.ids.length+' 种')};
    }
  }
  return '';
}
function build(record){
  const {board,journal}=record,decisions=board.decisions||[],routes=new Map();
  const self=board.report?.self??decisions.at(-1)?.report?.self;
  const masked=new Map();
  for(const m of journal.messages)for(const t of M.parse(m.text).items){
    if(t.kind==='trajectory'&&t.player===self&&!t.hidden&&t.round!=null&&(!t.partial||!routes.has(t.round)))routes.set(t.round,t);
    if(t.kind==='personalSound'&&m.view===self&&t.masked&&t.round!=null)masked.set(t.round+':'+t.step,t.sound);
  }
  const actions=board.actions||[],lines=['# 漫漫长夜 · 行动复盘','','本人 '+(self??'未知')+' 号 · '+record.mode+' · '+record.result,'','对局 '+record.id,''];
  const frames=[],rounds=new Set();
  for(const [i,a] of actions.entries()){
    const legacy=!a.decisionAt;
    const d=legacy?decisions.findLast(d=>d.at<=a.at):decisions.find(d=>d.at===a.decisionAt);
    const report=d?.report,s=report?.suggestion,p=s?.primary;
    const next=actions[i+1]?.at;
    const detail=(board.messages||[]).find(m=>m.at>=a.at&&(!next||m.at<next)&&/请继续行动|本回合结束/.test(m.text)&&/\[第\s*\d+\s*步\]/.test(m.text));
    const round=a.round??Number(detail?.text.match(/【第\s*(\d+)\s*回合】/)?.[1]);
    const start=a.step??Number(detail?.text.match(/\[第\s*(\d+)\s*步\]/)?.[1]);
    const route=routes.get(round),moves=route?.tokens.filter(t=>t.kind==='move')||[];
    const marks=[],t=s?.tactic||{};
    const openingWithoutGoal=p&&round>=1&&round<=2&&!t.kind;
    const intent=openingWithoutGoal?'无明确目的':a.purpose||(p?purpose(report,round):'缺少当时的建议记录');
    const candidates=t.candidates?.positions;
    let choice='';
    if(candidates?.length){
      const count=new Set(candidates.map(pos=>pos.r+','+pos.c)).size;
      const scope=t.candidates.exhaustive?'还剩':'当前记录有';
      const pick={
        'attempt-capture':'这步搏一次，在候选格结束回合尝试抓人。',
        'pursue-candidates':'选 ★ 作为追捕目标，先靠近。到格后再决定是否结束回合抓人。',
        'target-scout':'这步先不搏，探一条能靠近候选格的路。'
      }[t.kind];
      if(pick)choice=scope+' '+count+' 个可能位置（◇）。'+pick;
    }else if(['pursue','finish-capture'].includes(t.kind)&&Number.isInteger(t.target?.r)){
      choice='目标已定位到 1 格（★），'+(t.kind==='finish-capture'?'现在结束回合尝试抓人。':'沿已确认路线追过去。');
    }
    const mark=(pos,symbol)=>{if(Number.isInteger(pos?.r)&&Number.isInteger(pos?.c))marks.push({r:pos.r,c:pos.c,symbol});};
    mark(report?.board?.position,({上:"↑",下:"↓",左:"←",右:"→",停:"■"})[a.direction[0]]);
    mark(t.destination??(Number.isInteger(t.target?.r)?t.target:null),"★");
    for(const pos of t.candidates?.positions||[])mark(pos,"◇");
    const firstRound=!rounds.has(round);if(firstRound){rounds.add(round);lines.push('## '+(round?'第 '+round+' 回合':'回合未核实'),'');}
    const command=a.direction==='停止'?['停止']:Array.from(a.direction);
    for(const [offset,dir] of command.entries()){
      const step=start+offset,t=moves[step-1];
      let feedback='未找到对应的行动反馈';
      if(dir==='停止'&&route?.tokens.some(t=>t.kind==='marker'&&/停止/.test(t.value)))feedback='完整轨迹记录了停止';
      if(t&&'上下左右'[t.dir]===dir){
        feedback=t.outcome==='hit'?'撞墙，本回合结束':'成功移动';
        if(t.sound)feedback+='，发出'+({PAPA:'啪嗒',SHASHA:'沙沙'}[t.sound]||t.sound);
        const hidden=masked.get(round+':'+step);
        if(hidden)feedback+='，私聊确认'+(hidden==='PAPA'?'啪嗒':'沙沙')+'被心跳掩盖';
        if(t.terrain)feedback+='，进入'+(names[t.terrain]||t.terrain);
        if(step===moves.length&&route&&!route.partial){
          const end=route.tokens.filter(x=>x.kind==='marker').map(x=>x.value).join('、');
          if(end)feedback+='，'+end;
        }
      }
      lines.push('### '+(step?'第 '+step+' 步':'动作 '+(i+1))+' · '+dir,'',
        (legacy?'当时建议（按时间回配）':'行动目的')+'：'+readable(intent)+(marks.some(m=>m.symbol==='★')?'（★）':'')+(command.length>1?'（同一条路线的第 '+(offset+1)+' 步）':''),'',
        '实际反馈：'+feedback,'');
      if(t&&'上下左右'[t.dir]===dir&&t.outcome==='hit'&&p&&!p.blocked){
        lines.push(p.wall==='空'?'核对：预期能通过，实际发生碰撞。':'核对：试探的边发生碰撞，这次没有走到预期落脚格。','');
      }
      if(!offset&&report?.board?.verified&&i>0){
        const previous=decisions.find(d=>d.at===actions[i-1].decisionAt)?.report;
        if(previous?.board?.verified&&previous.board.frameId===report.board.frameId&&previous.board.n===report.board.n){
          for(const slot of report.slots||[]){
            const old=previous.slots?.find(s=>s.r===slot.r&&s.c===slot.c);
            if(!old||!slot.ids.length||!slot.ids.every(id=>old.ids.includes(id)))continue;
            const removed=old.ids.filter(id=>!slot.ids.includes(id));
            if(removed.length)lines.push('与上次行动前相比，地图上从上往下第 '+(1+[...(new Set(report.slots.map(s=>s.r)))].sort((a,b)=>a-b).indexOf(slot.r))+' 排、从左往右第 '+(1+[...(new Set(report.slots.map(s=>s.c)))].sort((a,b)=>a-b).indexOf(slot.c))+' 个区块排除了 '+removed.join('、')+'，剩下 '+slot.ids.join('、')+'。','');
          }
        }
      }
      if(!offset&&choice)lines.push('当时取舍：'+choice,'');
      if(!offset&&!openingWithoutGoal&&!choice&&p?.reasons?.length){const reason=p.reasons.find(x=>!x.includes('路线评估'));if(reason&&reason!==(a.purpose||purpose(report)))lines.push('当时依据：'+readable(reason),'');}
      if(offset===command.length-1&&detail){
        const later=decisions.find(x=>x.at>=detail.at&&(!next||x.at<=next)&&x.report.progress?.messages>report?.progress?.messages);
        const change=narrowed(report,later?.report);if(change){mark(change,'▧');lines.push('反馈后地图变化：'+change.text,'');}
      }
    }
    if(report?.board){
      const file=record.id+'.step-'+(i+1)+'.png';
      const players=report.players?.length?report.players:[{id:self,self:true,segment:0,board:report.board}];
      const snapshot=require('./end-board.cjs').snapshotHtml({reviewMarks:marks,report:{...report,players},decisions:decisions.filter(x=>x.at<=d.at)});
      frames.push({file,...snapshot});lines.push('![行动前的推断地图]('+file+')','');
      const panels=require('./candidate-panels.cjs').candidatePanels(report,a.direction);
      if(panels.length){
        const caseFile=record.id+'.step-'+(i+1)+'-cases.png';
        frames.push({file:caseFile,...require('./end-board.cjs').snapshotHtml({},panels)});
        lines.push('每幅图假设对手在一个不同的候选格。★ 是本次计划目标，➜ 是按指令预计的落脚格。','',
          '![对手位置逐案推演]('+caseFile+')','');
      }
    }
  }
  if(!actions.length)lines.push('本局没有保存已发送的行动。','');
  return {markdown:lines.join('\n'),frames};
}
async function generate(record){
  const dir=path.join(store.dataDir(),'matches'),base=path.join(dir,record.id+'.decisions');
  const {markdown,frames}=build(record);fs.writeFileSync(base+'.md',markdown);
  await new Promise((resolve,reject)=>{
    const proc=spawn(process.env.LN_PYTHON||'python',[path.join(__dirname,'render-report.py'),base],{windowsHide:true,stdio:['pipe','ignore','pipe']});
    let err='';proc.stderr.on('data',b=>err+=b);proc.on('error',reject);proc.on('close',code=>code===0?resolve():reject(Error(err||'长图生成失败')));
    proc.stdin.on('error',reject);proc.stdin.end(JSON.stringify(frames));
  });
  return base+'.png';
}
module.exports={purpose,build,generate};
