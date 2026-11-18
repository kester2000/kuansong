'use strict';
const modes=['经典','幻变','狂野','疯狂','按钮','陷阱','空旷','无声'];
const settings={拓展:['拓展','开启'],'10x10':['边长','10'],'11x11':['边长','11'],'12x12':['边长','12'],
 随机:['特殊事件','随机'],怠惰的园丁:['特殊事件','怠惰的园丁'],营养过剩:['特殊事件','营养过剩'],雨天小故事:['特殊事件','雨天小故事'],十面埋伏:['特殊事件','十面埋伏'],
 大乱斗:['大乱斗','开启'],回合隐匿:['隐匿','回合'],单步隐匿:['隐匿','单步'],点杀:['点杀','开启'],关闭点杀:['点杀','关闭'],谋定后动:['谋定后动','开启'],炸弹人:['炸弹','1'],静音:['静音','开启'],摸黑:['摸黑','开启'],传送紊乱:['传送紊乱','开启'],
 上家:['捕捉目标','上家'],下家:['捕捉目标','下家'],停止私信:['停止信息','私信'],停止公开:['停止信息','公开'],复古:['纹理','复古'],清新:['纹理','清新'],教程:['教程','开启']};
const bosses=['米诺陶斯','邦邦','暴君'];
function parse(body){
 if(/[\r\n\x00-\x1f]/.test(body))throw Error('单机指令须写在一行，用空格分隔参数');
 const tokens=body.trim().split(/\s+/);if(!['单机','单机对局'].includes(tokens.shift()))throw Error('不是单机指令');
 if(tokens.length>40)throw Error('单机参数过多');
 let args=tokens.map(t=>t.replace(/^(9|10|11|12)[*×Xx]\1$/,'$1x$1'));
 const unknown=args.filter(t=>!modes.includes(t)&&!Object.hasOwn(settings,t)&&!bosses.includes(t)&&t!=='9x9');
 if(unknown.length)throw Error('未知单机参数：'+unknown.join('、')+'；发送 #宽松 帮助 查看支持的参数');
 const expected={模式:'幻变'},chosenBosses=[];
 for(const t of args){if(modes.includes(t))expected.模式=t;else if(bosses.includes(t))chosenBosses.push(t);else if(t==='9x9')expected.边长='9';else{const [k,v]=settings[t];expected[k]=v;}}
 if(chosenBosses.length)expected.BOSS=chosenBosses.join(' ');
 // Native shortcuts have no 9x9 token: discard preceding size settings when
 // the final requested size is nine, allowing the default to take effect.
 if(expected.边长==='9')args=args.filter(t=>!/^\d+x\d+$/.test(t));else args=args.filter(t=>t!=='9x9');
 if(!args.some(t=>modes.includes(t)))args.unshift('幻变');
 return {tokens:args,mode:expected.模式,expected,label:args.join(' ')};
}
function mismatches(request,actual){
 return Object.entries(request.expected).filter(([k,v])=>{
  if(k==='特殊事件'&&v==='随机')return !['随机','怠惰的园丁','营养过剩','雨天小故事','十面埋伏'].includes(actual[k]);
  if(k==='BOSS')return String(actual[k]||'').trim().split(/\s+/).sort().join(' ')!==v.split(' ').sort().join(' ');
  return actual[k]!==v;
 }).map(([k,v])=>`${k}：请求 ${v}，实际 ${actual[k]??'未返回'}`);
}
const help=[
 '#宽松 单机 [参数…] —— 仅配置管理员可用；空格分隔，可叠加；默认幻变、9×9。',
 '区块模式：经典 / 幻变 / 狂野 / 疯狂 / 按钮 / 陷阱 / 空旷 / 无声；可加 拓展。',
 '边长：9x9 / 10x10 / 11x11 / 12x12（也可写 11*11 或 11×11）。',
 '事件：随机 / 怠惰的园丁 / 营养过剩 / 雨天小故事 / 十面埋伏。',
 '叠加：大乱斗 / 回合隐匿 / 单步隐匿 / 点杀 / 关闭点杀 / 谋定后动 / 炸弹人 / 静音 / 摸黑 / 传送紊乱。',
 'BOSS：米诺陶斯 / 邦邦 / 暴君，可同时添加。',
 '其他：上家 / 下家 / 停止私信 / 停止公开 / 复古 / 清新 / 教程。',
 '例：#宽松 单机 幻变 11x11 拓展 十面埋伏',
 '例：#宽松 单机 经典 谋定后动 静音 暴君',
 '同类冲突以最后参数为准；已有对局时先 #宽松 退出。创建后会核对实际配置，核对不符暂停自动行动。',
 '开局入口覆盖全部快捷模式；高级模式的求解和行动策略仍在持续补全。'
];
module.exports={parse,mismatches,help,modes,settings,bosses};
