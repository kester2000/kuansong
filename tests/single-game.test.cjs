'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
process.env.LN_DATA_DIR=require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(),'ln-lock-'));
const {LongNightBot}=require('../framework/bot.cjs');
test('global reservation blocks concurrent joins before validation finishes',async()=>{
 const groups={}; let release; let queries=0; const replies=[];
 const bot=Object.create(LongNightBot.prototype);
 Object.assign(bot,{config:{control:{enabled:true}},state:{data:{groups},setGroup(id,p){groups[id]={...groups[id],...p};},save(){}},stats:{errors:0},selfId:1,canControl:()=>true,controlRateOk:()=>true,reply:async x=>replies.push(x.text),ensureSupportedGame:async()=>{queries++;await new Promise(r=>release=r);return true;}});
 const first=bot.handleControl({body:'加入',groupId:1,userId:1});
 await bot.handleControl({body:'加入',groupId:2,userId:1});
 assert.equal(queries,1);assert.match(replies[0],/已有/); release();await first;
 assert.equal(groups[1].joinReserved,false);
});
