'use strict';

const { entry } = require('../internal/runner.cjs');
module.exports = entry('deception', require.main === module);
