'use strict';

const { entry } = require('../internal/runner.cjs');
module.exports = entry('alter_rps', require.main === module);
