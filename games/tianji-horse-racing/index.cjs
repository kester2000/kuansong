'use strict';

const { entry } = require('../internal/runner.cjs');
module.exports = entry('tianji_horse_racing', require.main === module);
