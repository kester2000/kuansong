'use strict';

const { entry } = require('../internal/runner.cjs');
module.exports = entry('dvalue_tender', require.main === module);
