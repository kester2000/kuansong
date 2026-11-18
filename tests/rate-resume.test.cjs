'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
process.env.LN_DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'ln-rate-'));
const {LongNightBot,StateStore}=require('../framework/bot.cjs');
test('rate limit schedules retry and reports the delay instead of dropping own prompt',async()=>{
 const state=new StateStore(path.join(process.env.LN_DATA_DIR,'state.json'));state.setGroup('42',{session:'g42',self:0});
 const b=new LongNightBot({state,config:{onebot:{},behavior:{mode:'auto',maxInferPerMinute:1}},part2:{},send:async()=>{},logger:()=>{}});
 b.turns.set('42',{sent:false,promptId:'latest'});b.inferTimes.set('g42',[Date.now()]);
 let retry;b.scheduleInfer=(session,context,delay)=>retry={session,context,delay};
 await b.runInfer({groupId:'42',event:{message_id:'latest'},auto:true});
 assert.equal(retry.session,'g42');assert.ok(retry.delay>59000&&retry.delay<=60200);
 assert.match(require('../framework/artifact.cjs').load('g42').execution.message,/自动继续/);
});
test('heartbeat-masked personal sound is relevant and tagged to current round',async()=>{
 const state=new StateStore(path.join(process.env.LN_DATA_DIR,'sound-state.json'));state.setGroup('42',{session:'g42',self:0,currentRound:2});let appended;
 const b=new LongNightBot({state,config:{onebot:{},behavior:{mode:'command'}},part2:{append:async x=>{appended=x;return {ok:true,duplicate:true};}},send:async()=>{},logger:()=>{}});
 const text='[第 1 步] 移动发出【啪嗒声】，声响被巨大的心跳声掩盖，其他玩家未能察觉';
 const parsed=b.inspect(text);assert.equal(parsed.relevant,true);
 await b.appendToSession({groupId:'42',text,parsed,private:true});
 assert.match(appended.text,/【第 2 回合】/);assert.equal(appended.view,0);
});
test('transient file failure retries only an unsent current turn',async()=>{
 for(const sent of [false,true]){
  const state=new StateStore(path.join(process.env.LN_DATA_DIR,'lock-state.json'));state.setGroup('42',{session:'g42',self:0});
  const b=new LongNightBot({state,config:{onebot:{},behavior:{mode:'auto',maxInferPerMinute:20}},part2:{qq:async()=>{throw Object.assign(new Error('file busy'),{code:'EPERM'});}},send:async()=>{},logger:()=>{}});
  b.turns.set('42',{sent,promptId:'latest'});let retry;
  b.scheduleInfer=(session,context,delay)=>retry={session,delay};
  await b.runInfer({groupId:'42',event:{message_id:'latest'},auto:true});
  assert.equal(!!retry,!sent);if(retry)assert.equal(retry.delay,2000);
 }
});
