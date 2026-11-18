'use strict';

const { entry } = require('../internal/runner.cjs');
module.exports = entry('ball_chase', require.main === module);
