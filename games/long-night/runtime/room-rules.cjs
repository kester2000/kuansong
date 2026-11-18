'use strict';
const {DATA,MODE_KEYS}=require('../night-strategist/kernel.cjs');
const events={'无':'NONE','雨天小故事':'RAINSTORY','怠惰的园丁':'LAZYGARDENER','营养过剩':'OVERGROWTH','十面埋伏':'AMBUSH'};
const switches=['开启','关闭'];
const choices={
  模式:Object.keys(MODE_KEYS),边长:['9','10','11','12'],纹理:['经典','复古','清新'],捕捉目标:['上家','下家'],
  停止信息:['无','私信','公开'],特殊事件:[...Object.keys(events),'随机'],隐匿:['关闭','回合','单步'],
  拓展:switches,传送紊乱:switches,点杀:switches,大乱斗:switches,谋定后动:switches,静音:switches,摸黑:switches,教程:switches
};
const ranges={炸弹:[0,3],回合数:[3,40],思考时限:[30,3600],行动时限:[60,3600]};
const blockIds=new Set(DATA.blocks.map(block=>block.id));
function readRoom(text){
  const values={},bad=[];
  let key=null;
  for(const line of text.split(/\r?\n/)){
    const format=line.match(/^\s*(?:-\s*)?格式[：:]\s*(\S+)/);
    if(format){key=format[1];continue;}
    const current=line.match(/^\s*(?:-\s*)?当前[：:](.*)$/);
    if(key&&current){
      if(Object.hasOwn(values,key))bad.push({name:key,current:'重复',why:'配置重复'});
      values[key]=current[1].trim();
      key=null;
    }
  }
  const missing=[];
  for(const name of [...Object.keys(choices),...Object.keys(ranges),'BOSS','区块']){
    const current=values[name];
    if(current==null){if(!["拓展","传送紊乱"].includes(name))missing.push(name);continue;}
    let valid;
    if(choices[name])valid=choices[name].includes(current);
    else if(ranges[name])valid=/^\d+$/.test(current)&&+current>=ranges[name][0]&&+current<=ranges[name][1];
    else if(name==='BOSS')valid=!current||current.split(/\s+/).every(token=>['无','米诺陶斯','邦邦','暴君'].includes(token));
    else {
      const ids=current.toUpperCase().split(/\s+/);
      valid=current==='默认'||(ids.length>=9&&ids.every(id=>blockIds.has(id)));
    }
    if(!valid)bad.push({name,current,why:'不符合本版漫漫长夜的配置范围'});
  }
  return {values,bad,missing};
}
module.exports={events,readRoom};
