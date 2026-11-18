'use strict';
const fs=require('node:fs'),{randomUUID}=require('node:crypto');
// Windows readers can temporarily deny replacement. Keep the previous file
// intact: retry the atomic rename, never fall back to truncating the target.
function writeAtomic(file,text,{rename=fs.renameSync,wait=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms)}={}){
 const tmp=`${file}.${process.pid}.${randomUUID()}.tmp`;
 try{
  fs.writeFileSync(tmp,text);
  for(let attempt=0;;attempt++){
   try{rename(tmp,file);return;}catch(error){
    if(!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt>=8)throw error;
    wait(Math.min(250,25*2**attempt));
   }
  }
 }finally{try{fs.unlinkSync(tmp);}catch{}}
}
module.exports={writeAtomic};
