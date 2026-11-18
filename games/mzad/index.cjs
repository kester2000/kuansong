'use strict';

const { entry } = require('../internal/runner.cjs');
module.exports = entry('mzad', require.main === module);
