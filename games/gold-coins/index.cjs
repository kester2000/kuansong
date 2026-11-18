'use strict';

const { entry } = require('../internal/runner.cjs');
module.exports = entry('gold_coins', require.main === module);
