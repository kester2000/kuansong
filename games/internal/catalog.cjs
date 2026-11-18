'use strict';
// Admission deliberately rejects unimplemented rule variants. Timing options
// are independent of rules; state-changing options are enumerated below.
const definitions=[
['dvalue_tender','差值投标',2,2,{回合数:'9',金币:'30'}],
['alter_rps','二择猜拳',2,2,{固定左拳:'开启',手牌:'',星卡:'布3 剪刀6 石头9 空白5'}],
['lie','LIE',2,2,{失败数量:'3',数字种类:'6'}],
['beauty_vote','美人投票',3,12,{回合数:'40',最大数字:'100',血量:'10',淘汰规则:'开启',撞车伤害:'开启',撞车范围:'0',撞车:'4',红心:'6'}],
['bread_crisis','面包危机',2,12,{回合数:'40',血量:'30'}],
['deception','以假乱真',2,12,{假卡:'3'}],
['gallop_horse_racing','狂奔马场',5,10,{目标:'100',上限:'10'}],
['garden_of_eden','伊甸园',3,12,{回合数:'14',金苹果:'4'}],
['garnet_thief','石榴石窃贼',3,12,{回合数:'8',Chips:'8'}],
['number_investment','数字投资',2,10,{范围:'10',奖励分数:'2'}],
['tianji_horse_racing','田忌赛马',2,10,{N:['0','13','15','17','19','21']}],
['world_without_thieves','天下无贼',3,12,{回合数:'40'}],
['ecard','E卡',2,2,{模式:['人生','经典','点球'],目标:'2',回合数:['12','50'],皇帝:'5',奴隶:'50',市民数:'4'}],
['ball_chase','有追球',4,12,{血量:'8'}],
['gold_coins','爆金币',4,12,{回合数:'10',金币:'10',特殊规则:'无'}],
['mzad','明争暗斗',2,12,{目标分数:'25',刺杀反制:'关闭'}],
['throw_handkerchief','丢手帕',2,2,{生命:'180',模式:'快速',完美:'开启'}],
['keep_drawing','抽抽抽',2,5,{边长:'3',分数:'60',局数:'20'}],
['cant_stop','欲罢不能',2,4,{变体:'无',胜利列数:'3',回合数:'100'}],
['treasure_hunter','寻宝猎人',4,5,{}],
['escape_building','逃脱大楼',2,2,{楼层:'20',杀手血量:'2',警察血量:'2',电梯:'3',子弹:'5',解救人质:'2'}],
['naval_battle','大海战',2,2,{边长:'10',飞机:'3',重叠:'不允许',要害:'有',连发:'3',侦察:['0','1','2','3','4','5','6','7','8','9','10','100'],BOSS挑战:'100',形状:'默认'}],
];
const games=definitions.map(([id,name,min,max,rules])=>Object.freeze({id,name,min,max,rules}));
function find(name){return games.find(g=>g.name===name||g.id===name);}
function validateRoom(game,text){const values=require('./observation.cjs').options(text),bad=[];for(const [k,allowed]of Object.entries(game.rules)){const actual=values[k];if(actual===undefined){bad.push(k+'缺失');continue;}const choices=Array.isArray(allowed)?allowed:[allowed];if(!choices.includes(actual))bad.push(k+'='+actual);}for(const [k,v]of Object.entries(values)){if(/时限/.test(k)){if(!/^\d+$/.test(v)||+v<30||+v>3600)bad.push(k+'需为30–3600秒');}else if(!Object.hasOwn(game.rules,k))bad.push('未知配置'+k);}return {values,bad};}
function load(id){if(!find(id))throw Error('Unknown game adapter');return require('./'+id+'.cjs');}
module.exports={games,find,validateRoom,load};
