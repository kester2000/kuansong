'use strict';

const { entry } = require('../internal/runner.cjs');
module.exports = entry('bread_crisis', require.main === module);
