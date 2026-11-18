'use strict';
async function history(client,userId,since){
 const all=new Map();let cursor;
 for(let page=0;page<100;page++){
  let data;
  try{data=await client.call('get_friend_msg_history',{user_id:Number(userId),count:100,...(cursor==null?{}:{message_id:cursor})});}
  catch(e){if(page===0&&/消息undefined不存在$/.test(e.message))return [];throw e;}
  const rows=data?.messages;if(!Array.isArray(rows))throw Error('私聊历史响应缺少 messages');
  if(!rows.length)return [...all.values()];
  let fresh=0;for(const m of rows){const k=String(m.message_id??`${m.time}:${JSON.stringify(m.message)}`);if(!all.has(k)){all.set(k,m);fresh++;}}
  if(!fresh)throw Error('私聊历史分页未推进，拒绝把重复页当成完整历史');
  const first=rows.reduce((a,b)=>Number(a.time)<Number(b.time)?a:b);
  if(Number(first.time)*1000<since||rows.length<100)return [...all.values()];
  if(first.message_id==null)throw Error('私聊分页缺少 message_id');cursor=first.message_id;
 }
 throw Error('私聊历史超过分页上限');
}
function createPrivateSync({client,bot,state,userId,logger}){
 let running=null,dirty=false,closed=false;
 async function run(){
  if(closed)return;
  dirty=true;if(running)return running;
  running=(async()=>{while(dirty&&!closed){dirty=false;if(client.state!=='open')return;
   const starts=Object.values(state.data.groups||{}).filter(g=>g.session&&!g.ended||g.multi&&!g.multi.ended&&g.joinReserved).map(g=>g.multi&&!g.multi.ended?g.multi.acceptedAt:Date.parse(g.startedAt)).filter(Number.isFinite);
   if(!starts.length||!userId)return;
   const since=Math.min(...starts)-2000;
   const rows=(await history(client,userId,since)).filter(m=>String(m.user_id)===String(userId)&&Number(m.time)*1000>=since).sort((a,b)=>Number(a.time)-Number(b.time));
   const done=state.data.privateSyncDone||={};
   for(const m of rows){const key=String(m.message_id??`${m.time}:${JSON.stringify(m.message)}`);if(done[key])continue;
    await bot.onEvent({...m,post_type:'message',message_type:'private'});
    done[key]=Number(m.time)*1000;state.save();
   }
   for(const k of Object.keys(done))if(done[k]<since)delete done[k];state.save();
  }})().catch(e=>logger.warn('私聊同步失败，将重试: '+e.message)).finally(()=>{running=null;});return running;
 }
 const timer=setInterval(run,15000);timer.unref?.();
 return {run,close(){closed=true;clearInterval(timer);}};
}
module.exports={history,createPrivateSync};
