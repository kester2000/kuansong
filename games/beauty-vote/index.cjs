'use strict';

const { entry } = require('../internal/runner.cjs');
module.exports = entry('beauty_vote', require.main === module);
