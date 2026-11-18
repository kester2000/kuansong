'use strict';
const cp=require('node:child_process'),path=require('node:path'),readline=require('node:readline');
class Engine{
 constructor(){
  const executable=process.env.ARENA_NATIVE_ENGINE||path.join(__dirname,'native/arena-engine');
  const linuxPath=executable.replace(/^([A-Za-z]):/,(_,d)=>'/mnt/'+d.toLowerCase()).replaceAll('\\','/');
  this.process=process.platform==='win32'
   ?cp.spawn('wsl.exe',['-d',process.env.ARENA_WSL_DISTRO||'Ubuntu','--',linuxPath],{stdio:['pipe','pipe','pipe'],windowsHide:true})
   :cp.spawn(executable,[],{stdio:['pipe','pipe','pipe']});this.pending=null;this.errors='';this.failure=null;
  this.process.stderr.on('data',d=>this.errors=(this.errors+d).slice(-2000));
  readline.createInterface({input:this.process.stdout}).on('line',line=>{let data;try{data=JSON.parse(line);}catch{return;}if(!this.pending)return;const p=this.pending;this.pending=null;clearTimeout(p.timer);data.ok?p.resolve(data):p.reject(Error(data.error));});
  const fail=e=>{this.failure=e;if(this.pending){clearTimeout(this.pending.timer);this.pending.reject(e);this.pending=null;}};
  this.process.stdin.on('error',fail);
  this.process.on('error',fail);this.process.on('exit',code=>fail(Error('referee exit '+code+': '+this.errors)));
 }
 request(q){if(this.failure)return Promise.reject(this.failure);if(this.pending)throw Error('concurrent referee request');return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending=null;this.close();reject(Error('referee timeout'));},30000);this.pending={resolve,reject,timer};this.process.stdin.write(JSON.stringify(q)+'\n');});}
 close(){this.process.stdin.end();this.process.kill();}
}
module.exports={Engine};
