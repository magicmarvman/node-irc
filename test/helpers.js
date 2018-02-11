'use strict';

/* Mock irc server */

const path = require('path');
const fs = require('fs');
const net = require('net');
const tls = require('tls');
const util = require('util');
const EventEmitter = require('events').EventEmitter;
const os = require('os');

const MockIrcd = function(port, encoding, isSecure) {
    const self = this;
    let connectionClass;
    let options = {};

    if (isSecure) {
        connectionClass = tls;
        options = {
            key: fs.readFileSync(path.resolve(__dirname, 'data/ircd.key')),
            cert: fs.readFileSync(path.resolve(__dirname, 'data/ircd.pem'))
        };
    } else {
        connectionClass = net;
    }

    this.port = port || (isSecure
        ? 6697
        : 6667);
    this.encoding = encoding || 'utf-8';
    this.incoming = [];
    this.outgoing = [];

    this.server = connectionClass.createServer(options, function(c) {
        c.on('data', function(data) {
            const msg = data.toString(self.encoding).split('\r\n').filter(function(m) {
                return m;
            });
            self.incoming = self.incoming.concat(msg);
        });

        self.on('send', function(data) {
            self.outgoing.push(data);
            c.write(data);
        });

        c.on('end', function() {
            self.emit('end');
        });
    });

    this.server.listen(this.port);
};
util.inherits(MockIrcd, EventEmitter);

MockIrcd.prototype.send = function(data) {
    this.emit('send', data);
};

MockIrcd.prototype.close = function() {
    this.server.close();
};

MockIrcd.prototype.getIncomingMsgs = function() {
    return this.incoming;
};

module.exports.getTempSocket = function() {
    const tempDir = os.tmpdir();
    const sockPath = path.join(tempDir, 'mock_ircd.sock');
    try {
        fs.unlinkSync(sockPath);
    } catch (e) {
        // ignore
    }
    return sockPath;
};

const fixtures = require('./data/fixtures');
module.exports.getFixtures = function(testSuite) {
    return fixtures[testSuite];
};

module.exports.MockIrcd = function(port, encoding, isSecure) {
    return new MockIrcd(port, encoding, isSecure);
};
