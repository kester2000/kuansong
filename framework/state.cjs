'use strict';
const fs=require('node:fs'),path=require('node:path');
class StateStore {
  constructor(file) {
    this.file = file;
    this.data = { version: 1, groups: {}, lastSession: null };
  }

  load() {
    if (fs.existsSync(this.file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (parsed && parsed.groups) this.data = parsed;
      } catch (error) {
        throw new Error(`无法读取状态文件 ${this.file}: ${error.message}`);
      }
    }
    return this.data;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    require('./atomic-file.cjs').writeAtomic(this.file,JSON.stringify(this.data,null,2));
  }

  group(groupId) {
    return this.data.groups[String(groupId)] || null;
  }

  setGroup(groupId, patch) {
    const key = String(groupId);
    this.data.groups[key] = { ...(this.data.groups[key] || {}), ...patch, updatedAt: new Date().toISOString() };
    return this.data.groups[key];
  }
}


module.exports={StateStore};
