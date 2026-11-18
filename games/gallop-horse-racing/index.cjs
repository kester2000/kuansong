'use strict';

const { entry } = require('../internal/runner.cjs');
module.exports = entry('gallop_horse_racing', require.main === module);
