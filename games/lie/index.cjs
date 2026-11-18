'use strict';

const { entry } = require('../internal/runner.cjs');
module.exports = entry('lie', require.main === module);
