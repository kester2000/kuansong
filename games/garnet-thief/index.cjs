'use strict';

const { entry } = require('../internal/runner.cjs');
module.exports = entry('garnet_thief', require.main === module);
