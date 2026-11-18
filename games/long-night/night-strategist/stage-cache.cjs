'use strict';
const fs=require('node:fs'),path=require('node:path'),v8=require('node:v8');
const {createHash,randomUUID}=require('node:crypto');
const {cacheDir,FINGERPRINT}=require('./cache.cjs');
const limit=64*1024*1024;
function directory(){return path.join(cacheDir(),'stages');}
// The kernel rebuilds equivalent graphs in fresh CLI processes. Hash their
// values, not V8's object sharing or integer/double representation.
function keyValue(value){
 if(value===undefined)return ['undefined'];
 if(typeof value==='number'&&!Number.isFinite(value))return ['number',String(value)];
 if(value===null||typeof value!=='object')return value;
 if(Array.isArray(value))return ['array',...value.map(keyValue)];
 if(value instanceof Set)return ['set',...[...value].map(keyValue)];
 if(value instanceof Map)return ['map',...[...value].map(([k,v])=>[keyValue(k),keyValue(v)])];
 return ['object',...Object.keys(value).sort().map(k=>[k,keyValue(value[k])])];
}
function files(){
 try{return fs.readdirSync(directory()).filter(n=>n.endsWith('.bin')).flatMap(n=>{
  const file=path.join(directory(),n);
  try{const stat=fs.statSync(file);return [{file,size:stat.size,time:stat.mtimeMs}];}catch{return [];}
 });}catch{return [];}
}
function create(){
 const metrics={localHits:0,localMisses:0,portalHits:0,portalMisses:0};
 function lookup(stage,inputs){
  const hash=createHash('sha256').update(FINGERPRINT).update(process.versions.v8).update(stage).update(JSON.stringify(keyValue(inputs))).digest('hex');
  const file=path.join(directory(),hash+'.bin');
  try{
   const data=v8.deserialize(fs.readFileSync(file));
   if(data.hash===hash&&(!data.until||Date.now()<data.until)){metrics[stage+'Hits']++;return {hit:true,value:data.value};}
  }catch{}
  metrics[stage+'Misses']++;
  return {hit:false,save(value,ttlMs=0){
   const tmp=file+'.'+randomUUID()+'.tmp';
   try{
    const bytes=v8.serialize({hash,value,until:ttlMs?Date.now()+ttlMs:0});
    if(bytes.length>8*1024*1024)return;
    fs.mkdirSync(directory(),{recursive:true});fs.writeFileSync(tmp,bytes);fs.renameSync(tmp,file);
    let size=0,count=0;
    for(const item of files().sort((a,b)=>b.time-a.time)){
     size+=item.size;if(++count>200||size>limit)try{fs.unlinkSync(item.file);}catch{}
    }
   }catch{}finally{try{fs.unlinkSync(tmp);}catch{}}
  }};
 }
 return {metrics,lookup};
}
module.exports={create,files};
