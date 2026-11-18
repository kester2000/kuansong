'use strict';

const { entry } = require('../internal/runner.cjs');
module.exports = entry('keep_drawing', require.main === module);
