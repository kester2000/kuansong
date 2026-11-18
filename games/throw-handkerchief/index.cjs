'use strict';

const { entry } = require('../internal/runner.cjs');
module.exports = entry('throw_handkerchief', require.main === module);
