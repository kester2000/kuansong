'use strict';
const fs=require('node:fs'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const content=require('./game.cjs').module('runtime/decision-report.cjs');
const {generate}=content;
async function publish(bot,groupId,id){
  const group=bot.state.group(groupId);
  if(group?.endBoardPost?.key===id)return;
  const membership=require('./game.cjs').module('runtime/participation.cjs');
  const record=JSON.parse(require('./matches.cjs').read(id)||'null');
  const maySend=()=>membership.recordParticipated(record,bot.selfId)&&membership.participated(bot.state.group(groupId),bot.selfId)
    &&record.session==='g'+groupId&&membership.matchKey(bot.state.group(groupId))===record.board.settings.matchKey;
  if(!maySend()){bot.log('跳过复盘发布：本局缺少本号参赛证据 '+id);return;}
  try{
    const publicBase=String(bot.config.report?.publicBase||'').replace(/\/+$/,'');
    if(publicBase){
      const url=`${publicBase}/report/${encodeURIComponent(id)}.html`;
      if(bot.recovering||!maySend())return;
      bot.state.setGroup(groupId,{endBoardPost:{key:id,status:'sending',url}});bot.state.save();
      const receipt=await bot.send({type:'group',groupId,message:`对局复盘：${url}`});
      bot.state.setGroup(groupId,{endBoardPost:{key:id,status:'sent',url,messageId:receipt?.message_id}});bot.state.save();
      return;
    }
    const file=await generate(record);
    if(bot.recovering||!maySend())return;
    bot.state.setGroup(groupId,{endBoardPost:{key:id,status:'sending',file}});bot.state.save();
    const pages=fs.readdirSync(path.dirname(file)).filter(n=>n.startsWith(path.basename(file,'.png')+'.page-')&&n.endsWith('.jpg')).sort();
    const files=pages.length?pages.map(n=>path.join(path.dirname(file),n)):[file];
    const receipt=await bot.send({type:'group',groupId,message:files.map(f=>({type:'image',data:{file:pathToFileURL(f).href}}))});
    bot.state.setGroup(groupId,{endBoardPost:{key:id,status:'sent',file,messageId:receipt?.message_id}});bot.state.save();
  }catch(e){
    const message='对局复盘生成或发送失败：'+e.message;
    bot.log(message);
    const artifact=require('./artifact.cjs'),board=artifact.load('g'+groupId);
    if(board?.recordId===id)artifact.save('g'+groupId,{...board,execution:{at:new Date().toISOString(),status:'error',message}});
  }
}
module.exports={...content,publish};
