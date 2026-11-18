'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
process.env.LN_DATA_DIR=require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(),'ln-dismiss-'));
const {LongNightBot}=require('../framework/bot.cjs');
function setup(group){
 const groups={'1':{gameBotId:'99',joinReserved:true,...group}},calls=[];
 const b=new LongNightBot({config:{onebot:{},botIds:['99'],behavior:{mode:'command'}},state:{data:{groups},group:id=>groups[id],setGroup(id,patch){Object.assign(groups[id],patch);},save(){}},part2:{},send:async()=>{},logger:()=>{}});
 b.appendToSession=async()=>calls.push('append');b.onGameEnd=async()=>{calls.push('end');Object.assign(groups['1'],{ended:true,joinReserved:false});};
 b.turns.set('1',{});b.pending.set('g1',{});return {b,groups,calls};
}
test('trusted lobby dissolution releases reservation even when previous session is already ended, without changing its archive',async()=>{
 const {b,groups,calls}=setup({session:'g1',ended:true});
 await b.onBotMessage({groupId:'1',event:{user_id:'99'},text:'@@房主@@大肥鱼\n游戏已解散，谢谢大家参与'});
 assert.equal(groups['1'].joinReserved,false);assert.equal(groups['1'].ended,true);assert.deepEqual(calls,[]);
 assert.equal(b.turns.has('1'),false);assert.equal(b.pending.has('g1'),false);
});
test('active match dissolution enters ordinary archive ending; a lobby without a session simply releases its lock',async()=>{
 const x=setup({session:'g1',ended:false});await x.b.onBotMessage({groupId:'1',event:{user_id:'99'},text:'游戏已解散，谢谢大家参与'});
 assert.deepEqual(x.calls,['append','end']);assert.equal(x.groups['1'].joinReserved,false);
 const y=setup({});await y.b.onBotMessage({groupId:'1',event:{user_id:'99'},text:'房间已解散'});
 assert.deepEqual(y.calls,[]);assert.equal(y.groups['1'].joinReserved,false);
});
test('other users cannot release game reservation with forged dissolution text',async()=>{
 const {b,groups,calls}=setup({session:'g1',ended:false});await b.onBotMessage({groupId:'1',event:{user_id:'123'},text:'游戏已解散，谢谢大家参与'});
 assert.equal(groups['1'].joinReserved,true);assert.equal(groups['1'].ended,false);assert.deepEqual(calls,[]);
});
test('only designated administrator resets pending state',async()=>{
 const {b,groups}=setup({session:'g1',ended:false,pendingBatch:{step:1}});
 b.config.control={enabled:true,confirm:false,adminIds:[100003]};
 await b.handleControl({groupId:'1',userId:'123',body:'重置'});
 assert.equal(groups['1'].joinReserved,true);
 await b.handleControl({groupId:'1',userId:'100003',body:'重置'});
 assert.equal(groups['1'].ended,true);
 assert.equal(groups['1'].pendingBatch,null);
});
test('trusted join failure clears reservation',async()=>{
 const {b,groups}=setup({});
 await b.onBotMessage({groupId:'1',event:{user_id:'99'},text:'加入失败'});
 assert.equal(groups['1'].joinReserved,false);
});
