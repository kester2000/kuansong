'use strict';
const path = require('node:path');
exports.id = 'long-night';
exports.configure = require('./host.cjs').configure;
exports.cli = path.join(__dirname, 'night-strategist/cli.cjs');
exports.assets = path.join(__dirname, 'runtime');
exports.module = name => require(path.join(__dirname, name));
