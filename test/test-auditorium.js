'use strict';

const net = require('net');

const irc = require('../lib/irc');
const test = require('tape');

const testHelpers = require('./helpers');

test('user gets opped in auditorium', function(t) {
    const mock = testHelpers.MockIrcd();
    const client = new irc.Client('localhost', 'testbot', {
        debug: true
    });

    client.on('+mode', function(channel, by, mode, argument) {
        if (channel === '#auditorium' && argument === 'user') {
            client.disconnect();
        }
    });

    mock.server.on('connection', function() {
        // Initiate connection
        mock.send(':localhost 001 testbot :Welcome to the Internet Relay Chat Network testbot\r\n');

        // Set prefix modes
        mock.send(':localhost 005 testbot PREFIX=(ov)@+ CHANTYPES=#& :are supported by this server\r\n');

        // Force join into auditorium
        mock.send(':testbot JOIN #auditorium\r\n');

        // +o the invisible user
        mock.send(':ChanServ MODE #auditorium +o user\r\n');
    });

    mock.on('end', function() {
        mock.close();
        t.end();
    });
});
