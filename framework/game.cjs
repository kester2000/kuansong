'use strict';
const path = require('node:path');
process.env.LN_DATA_DIR ||= path.resolve(__dirname, '../private/data');
const game = require('../games/long-night/index.cjs');
game.configure({get: name => require(path.join(__dirname, name))});
module.exports = game;
