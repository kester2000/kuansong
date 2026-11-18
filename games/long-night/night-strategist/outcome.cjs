'use strict';
const K=require('./kernel.cjs');
function outcome(journal){
 const aborted=/全员支持中断游戏[，,]游戏已中断|所有玩家都强制退出了游戏.*游戏解散|(?:游戏|房间)已解散/s;
 const end=journal.messages.findIndex(m=>aborted.test(m.text)||/玩家剩余[^\n]*游戏结束|所有玩家均(?:主动停止|被淘汰)[^\n]*游戏结束|游戏结束[，,]\s*公布分数|回合数到达上限/.test(m.text));
 const built=K.build(end<0?journal:{...journal,messages:journal.messages.slice(0,end+1)}),status=K.A.status(built),own=status.find(p=>p.id===built.self);
 if(end>=0&&/所有玩家均被淘汰/.test(journal.messages[end].text))for(const p of status)if(p.alive){p.alive=false;p.reason='已淘汰（终局公告，具体原因未记录）';}
 let result=own?.alive===false?(own.reason||'已退场'):'存活';
 const interrupted=end>=0&&aborted.test(journal.messages[end].text);
 if(interrupted)result='对局中断（不计胜负）';
 else if(end>=0&&own?.alive){
  if(built.captures.some(c=>c.player===built.self&&!c.protected)&&status.filter(p=>p.alive).length===1)result='捕捉获胜';
  else if(status.some(p=>p.id!==built.self&&/逃生/.test(p.reason||'')))result='对手逃生（本人存活）';
  else if(/所有玩家均主动停止/.test(journal.messages[end].text))result='全员未移动结束';
 }
 return {result,status,own,ended:end>=0,interrupted};
}
module.exports={outcome};
