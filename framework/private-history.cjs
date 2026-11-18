'use strict';
async function recentPrivateHistory(client,userId,count=30){
 try{
  const data=await client.call('get_friend_msg_history',{user_id:Number(userId),count});
  return data?.messages||[];
 }catch(error){
  // NapCat throws this exact response when latest-history has zero messages
  // and no message_seq was provided. It is not a transport/authentication error.
  if(error.action==='get_friend_msg_history'&&/消息undefined不存在$/.test(error.message))return [];
  throw error;
 }
}
module.exports={recentPrivateHistory};
