'use strict';

const { entry } = require('../internal/runner.cjs');
module.exports = entry('escape_building', require.main === module);
