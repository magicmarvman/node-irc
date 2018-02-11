'use strict';

var irc = require('../lib/irc');
var test = require('tape');
var testHelpers = require('./helpers');
var checks = testHelpers.getFixtures('convert-encoding');
var bindTo = {
    opt: {
        encoding: 'utf-8'
    }
};

test('irc.Client.convertEncoding', function(assert) {
    var convertEncoding = irc.Client.prototype.convertEncoding.bind(bindTo);

    checks.causesException.forEach(function iterate(line) {
        var causedException = false;

        try {
            convertEncoding(line);
        } catch (e) {
            causedException = true;
        }

        assert.equal(causedException, false, line + ' didn\'t cause exception');
    });

    assert.end();
});
