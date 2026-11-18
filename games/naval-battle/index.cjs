'use strict';

const { entry } = require('../internal/runner.cjs');
module.exports = entry('naval_battle', require.main === module);
