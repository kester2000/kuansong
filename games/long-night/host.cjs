'use strict';
let host;
exports.configure = services => { host = services; };
exports.get = name => {
  if (!host) throw Error('Game adapter requires host services');
  return host.get(name);
};
