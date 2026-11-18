'use strict';

const { entry } = require('../internal/runner.cjs');
module.exports = entry('garden_of_eden', require.main === module);
