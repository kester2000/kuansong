'use strict';

const { entry } = require('../internal/runner.cjs');
module.exports = entry('number_investment', require.main === module);
