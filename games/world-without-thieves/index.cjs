'use strict';

const { entry } = require('../internal/runner.cjs');
module.exports = entry('world_without_thieves', require.main === module);
