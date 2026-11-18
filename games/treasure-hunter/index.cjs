'use strict';

const { entry } = require('../internal/runner.cjs');
module.exports = entry('treasure_hunter', require.main === module);
