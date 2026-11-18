'use strict';

const { entry } = require('../internal/runner.cjs');
module.exports = entry('cant_stop', require.main === module);
