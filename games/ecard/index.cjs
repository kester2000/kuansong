'use strict';

const { entry } = require('../internal/runner.cjs');
module.exports = entry('ecard', require.main === module);
