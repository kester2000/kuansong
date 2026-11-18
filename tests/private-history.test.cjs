const test=require('node:test'),assert=require('node:assert/strict');
const {recentPrivateHistory}=require('../framework/private-history.cjs');
test('latest private history treats only the NapCat empty response as empty',async()=>{
 const client={call:async()=>{throw Object.assign(new Error('get_friend_msg_history 失败: 消息undefined不存在'),{action:'get_friend_msg_history'});}};
 assert.deepEqual(await recentPrivateHistory(client,123),[]);
});
test('private history retains messages and propagates other errors',async()=>{
 const messages=[{message_id:1}];
 assert.deepEqual(await recentPrivateHistory({call:async(action,args)=>{assert.equal(action,'get_friend_msg_history');assert.deepEqual(args,{user_id:123,count:30});return {messages};}},123),messages);
 for(const text of ['连接超时','消息123不存在']){
  const error=Object.assign(new Error(text),{action:'get_friend_msg_history'});
  await assert.rejects(recentPrivateHistory({call:async()=>{throw error;}},123),e=>e===error);
 }
});
