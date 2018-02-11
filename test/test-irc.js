'use strict';

const net = require('net');

const irc = require('../lib/irc');
const test = require('tape');

const testHelpers = require('./helpers');

const expected = testHelpers.getFixtures('basic');
const greeting = ':localhost 001 testbot :Welcome to the Internet Relay Chat Network testbot\r\n';

test('connect, register and quit', function(t) {
    runTests(t, false, false);
});

test('connect, register and quit, securely', function(t) {
    runTests(t, true, false);
});

test('connect, register and quit, securely, with secure object', function(t) {
    runTests(t, true, true);
});

function runTests(t, isSecure, useSecureObject) {
    const port = isSecure ? 6697 : 6667;
    const mock = testHelpers.MockIrcd(port, 'utf-8', isSecure);
    const client = (isSecure && useSecureObject) ?
        new irc.Client('notlocalhost', 'testbot', {
            secure: {
                host: 'localhost',
                port: port,
                rejectUnauthorized: false
            },
            selfSigned: true,
            retryCount: 0,
            debug: true
        }) : new irc.Client('localhost', 'testbot', {
            secure: isSecure,
            selfSigned: true,
            port: port,
            retryCount: 0,
            debug: true
        });

    t.plan(expected.sent.length + expected.received.length);

    mock.server.on(isSecure ? 'secureConnection' : 'connection', function() {
        mock.send(greeting);
    });

    client.on('registered', function() {
        t.equal(mock.outgoing[0], expected.received[0][0], expected.received[0][1]);
        client.disconnect();
    });

    mock.on('end', function() {
        const msgs = mock.getIncomingMsgs();

        for (let i = 0; i < msgs.length; i++) {
            t.equal(msgs[i], expected.sent[i][0], expected.sent[i][1]);
        }
        mock.close();
    });
}

test('splitting of long lines', function(t) {
    const port = 6667;
    const mock = testHelpers.MockIrcd(port, 'utf-8', false);
    const client = new irc.Client('localhost', 'testbot', {
        secure: false,
        selfSigned: true,
        port: port,
        retryCount: 0,
        debug: true
    });

    const group = testHelpers.getFixtures('_splitLongLines');
    t.plan(group.length);
    group.forEach(function(item) {
        t.deepEqual(client._splitLongLines(item.input, item.maxLength, []), item.result);
    });
    mock.close();
});

test('splitting of long lines with no maxLength defined.', function(t) {
    const port = 6667;
    const mock = testHelpers.MockIrcd(port, 'utf-8', false);
    const client = new irc.Client('localhost', 'testbot', {
        secure: false,
        selfSigned: true,
        port: port,
        retryCount: 0,
        debug: true
    });

    const group = testHelpers.getFixtures('_splitLongLines_no_max');
    console.log(group.length);
    t.plan(group.length);
    group.forEach(function(item) {
        t.deepEqual(client._splitLongLines(item.input, null, []), item.result);
    });
    mock.close();
});

test('opt.messageSplit used when set', function(t) {
    const port = 6667;
    const mock = testHelpers.MockIrcd(port, 'utf-8', false);
    const client = new irc.Client('localhost', 'testbot', {
        secure: false,
        selfSigned: true,
        port: port,
        retryCount: 0,
        debug: true,
        messageSplit: 10
    });

    const group = testHelpers.getFixtures('_speak');
    t.plan(group.length);
    group.forEach(function(item) {
        client.maxLineLength = item.length;
        client._splitLongLines = function(words, maxLength, destination) {
            t.equal(maxLength, item.expected);
            return [words];
        };
        client._speak('kind', 'target', 'test message');
    });

    mock.close();
});
