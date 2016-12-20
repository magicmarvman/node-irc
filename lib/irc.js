/*
 irc.js - Node JS IRC client library

 (C) Copyright Martyn Smith 2010

 This library is free software: you can redistribute it and/or modify
 it under the terms of the GNU General Public License as published by
 the Free Software Foundation, either version 3 of the License, or
 (at your option) any later version.

 This library is distributed in the hope that it will be useful,
 but WITHOUT ANY WARRANTY; without even the implied warranty of
 MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 GNU General Public License for more details.

 You should have received a copy of the GNU General Public License
 along with this library.  If not, see <http://www.gnu.org/licenses/>.
 */

const _ = require('lodash');
const net = require('net');
const tls = require('tls');
const util = require('util');
const EventEmitter = require('events').EventEmitter;
const colors = require('./colors');
const handleRaw = require('./handleRaw');
const defaultOptions = require('./defaultOptions');
const defaultSupported = require('./defaultSupported');
const parseMessage = require('./parseMessage');
const CyclingPingTimer = require('./pingTimer.js');
const lineDelimiter = new RegExp('\r\n|\r|\n');

function Client(server, nick, opt) {
    // Keep track of self
    const self = this;

    // Hold on to original nick
    self.originalNick = '';

    // Hold hostmask
    self.hostMask = '';

    // Build default options
    self.opt = defaultOptions(server, nick);

    // Features supported by the server
    // (initial values are RFC 1459 defaults. Zeros signify
    // no default or unlimited value)
    self.supported = defaultSupported(self.opt);

    if (_.isObject(arguments[2])) {
        let keys = Object.keys(self.opt);
        for (let i = 0; i < keys.length; i++) {
            let k = keys[i];
            if (arguments[2][k] !== undefined)
                self.opt[k] = arguments[2][k];
        }
    }

    // Enable flood detection
    if (self.opt.floodProtection) self.activateFloodProtection();


    // TODO - fail if nick or server missing
    // TODO - fail if username has a space in it
    if (self.opt.autoConnect === true) self.connect();

    // Handle Raw errors, core of the system
    self.addListener('raw', message => handleRaw(message, self));

    self.addListener('kick', function(channel, who, by, reason) {
        if (self.opt.autoRejoin) self.send.apply(self, ['JOIN'].concat(channel.split(' ')));
    });

    self.addListener('motd', motd => self.opt.channels.forEach(channel => self.send.apply(self, ['JOIN'].concat(channel.split(' ')))));

    EventEmitter.call(this);
};

// Give the Event Emitter logic
util.inherits(Client, EventEmitter);

Client.prototype.conn = null;
Client.prototype.prefixForMode = {};
Client.prototype.modeForPrefix = {};
Client.prototype.chans = {};
Client.prototype._whoisData = {};


// Only care about a timeout event if it came from the connection
// that is most current.
Client.prototype.connectionTimedOut = function(conn) {
    if (conn === this.conn) this.end();
};

Client.prototype.chanData = function(name, create) {
    let key = name.toLowerCase();

    // No create data, bail
    if (!create) return this.chans[key];

    this.chans[key] = this.chans[key] || {
        key: key,
        serverName: name,
        users: {},
        modeParams: {},
        mode: ''
    };

    return this.chans[key];
};

Client.prototype._connectionHandler = function() {
    if (this.opt.webirc.ip && this.opt.webirc.pass && this.opt.webirc.host)
        this.send('WEBIRC', this.opt.webirc.pass, this.opt.userName, this.opt.webirc.host, this.opt.webirc.ip);

    // see http://ircv3.atheme.org/extensions/sasl-3.1
    if (this.opt.sasl) this.send('CAP REQ', 'sasl');
    else if (this.opt.password) this.send('PASS', this.opt.password);

    if (this.opt.debug) console.log('Sending irc NICK/USER');

    this.send('NICK', this.opt.nick);
    this.send('USER', this.opt.userName, 8, '*', this.opt.realName);

    this.nick = this.opt.nick;
    this._updateMaxLineLength();

    this.conn.cyclingPingTimer.start();
    this.emit('connect');
};

Client.prototype.connect = function(retryCount, callback) {
    // Orginaize args
    if (_.isFunction(retryCount)) {
        callback = retryCount;
        retryCount = undefined;
    }

    // Set default retry count
    retryCount = retryCount || 0;

    // Register call back with 'registered' event
    if (_.isFunction(callback)) this.once('registered', callback);

    // There is no place like home
    let self = this;

    // Create empty object to hold channel info in
    self.chans = {};

    // Build socket opts
    let connectionOpts = {
        host: self.opt.server,
        port: self.opt.port
    };

    // local address to bind to
    if (self.opt.localAddress) connectionOpts.localAddress = self.opt.localAddress;
    // local port to bind to
    if (self.opt.localPort) connectionOpts.localPort = self.opt.localPort;

    // try to connect to the server
    if (self.opt.secure) {
        connectionOpts.rejectUnauthorized = !self.opt.selfSigned;

        if (_.isObject(self.opt.secure)) {
            // copy "secure" opts to options passed to connect()
            for (let f in self.opt.secure) {
                connectionOpts[f] = self.opt.secure[f];
            }
        }

        self.conn = tls.connect(connectionOpts, function() {
            // callback called only after successful socket connection
            self.conn.connected = true;
            if (self.conn.authorized ||
                (self.opt.selfSigned &&
                    (self.conn.authorizationError === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
                        self.conn.authorizationError === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
                        self.conn.authorizationError === 'SELF_SIGNED_CERT_IN_CHAIN')) ||
                (self.opt.certExpired &&
                    self.conn.authorizationError === 'CERT_HAS_EXPIRED')) {
                // authorization successful

                if (!self.opt.encoding) self.conn.setEncoding('utf-8');

                if (self.opt.certExpired &&
                    self.conn.authorizationError === 'CERT_HAS_EXPIRED') {
                    console.log('Connecting to server with expired certificate');
                }

                self._connectionHandler();
            } else {
                // authorization failed
                console.log(self.conn.authorizationError);
            }
        });
    } else self.conn = net.createConnection(connectionOpts, self._connectionHandler.bind(self));

    self.conn.requestedDisconnect = false;

    self.conn.setTimeout(0);

    // Each connection gets its own CyclingPingTimer. The connection forwards the timer's 'timeout' and 'wantPing' events
    // to the client object via calling the connectionTimedOut() and connectionWantsPing() functions.
    //
    // Since the client's "current connection" value changes over time because of retry functionality,
    // the client should ignore timeout/wantPing events that come from old connections.
    self.conn.cyclingPingTimer = new CyclingPingTimer(self);
    (function(conn) {
        conn.cyclingPingTimer.on('pingTimeout', function() {
            self.connectionTimedOut(conn);
        });
        conn.cyclingPingTimer.on('wantPing', function() {
            self.connectionWantsPing(conn);
        });
    }(self.conn));

    if (!self.opt.encoding) self.conn.setEncoding('utf8');

    let buffer = new Buffer('');

    function handleData(chunk) {

        if (self.conn.cyclingPingTimer && self.conn.cyclingPingTimer.notifyOfActivity) self.conn.cyclingPingTimer.notifyOfActivity();

        buffer = _.isString(chunk) ? buffer + chunk : Buffer.concat([buffer, chunk]);

        let lines = self.convertEncoding(buffer).toString().split(lineDelimiter);

        // if buffer is not ended with \r\n, there's more chunks.
        if (lines.pop()) return;

        // Re-initialize the buffer.
        buffer = new Buffer('');

        _(lines)
            .filter(line => line.length)
            .each(line => {
                let message = parseMessage(line, self.opt.stripColors);
                try {
                    self.emit('raw', message);
                } catch (err) {
                    if (!self.conn.requestedDisconnect) {
                        throw err;
                    }
                }
            });
    }

    self.conn.addListener('data', handleData);

    self.conn.addListener('end', function() {
        if (self.opt.debug) console.log('Connection got "end" event');
    });

    self.conn.addListener('close', function() {
        if (self.opt.debug) console.log('Connection got "close" event');

        if (self.conn && self.conn.requestedDisconnect) return;

        if (self.opt.debug) console.log('Disconnected: reconnecting');

        if (self.opt.retryCount !== null && retryCount >= self.opt.retryCount) {
            if (self.opt.debug) console.log('Maximum retry count (' + self.opt.retryCount + ') reached. Aborting');
            self.emit('abort', self.opt.retryCount);
            return;
        }

        if (self.opt.debug) console.log('Waiting ' + self.opt.retryDelay + 'ms before retrying');

        setTimeout(function() {
            self.connect(retryCount + 1);
        }, self.opt.retryDelay);
    });

    self.conn.addListener('error', function(exception) {
        self.emit('netError', exception);
        if (self.opt.debug) console.log('Network error: ' + exception);
    });
};

Client.prototype.end = function() {
    if (this.conn) {
        this.conn.cyclingPingTimer.stop();
        this.conn.destroy();
    }
    this.conn = null;
};

Client.prototype.disconnect = function(message, callback) {
    if (_.isFunction(message)) {
        callback = message;
        message = undefined;
    }
    message = message || 'MrNodeBot says goodbye';

    let self = this;

    // We have no connection, bail
    if (!self.conn) return;

    if (self.conn.readyState == 'open') {
        let sendFunction;

        if (self.opt.floodProtection) {
            sendFunction = self._sendImmediate;
            self._clearCmdQueue();
        } else sendFunction = self.send;

        sendFunction.call(self, 'QUIT', message);
    }

    self.conn.requestedDisconnect = true;

    if (_.isFunction(callback)) self.conn.once('end', callback);

    self.conn.end();
};

Client.prototype.send = function(command) {
    let args = Array.prototype.slice.call(arguments);

    // Note that the command arg is included in the args array as the first element
    if (args[args.length - 1].match(/\s/) || args[args.length - 1].match(/^:/) || args[args.length - 1] === '') args[args.length - 1] = ':' + args[args.length - 1];

    if (this.opt.debug) console.log('SEND: ' + args.join(' '));

    if (this.conn && !this.conn.requestedDisconnect) this.conn.write(args.join(' ') + '\r\n');
};

Client.prototype.activateFloodProtection = function(interval) {
    let cmdQueue = [],
        safeInterval = interval || this.opt.floodProtectionDelay,
        self = this,
        origSend = this.send,
        dequeue;

    // Wrapper for the original function. Just put everything to on central
    // queue.
    this.send = function() {
        cmdQueue.push(arguments)
    };

    // Send avoiding buffer
    this._sendImmediate = function() {
        origSend.apply(self, arguments);
    }

    // Clear buffer
    this._clearCmdQueue = function() {
        _.each(cmdQueue, dequeue);
        cmdQueue = [];
    };

    // Process off the stack
    dequeue = function() {
        let args = cmdQueue.shift();
        if (args) origSend.apply(self, args);
    };

    // Slowly unpack the queue without flooding.
    setInterval(dequeue, safeInterval);
};

Client.prototype.join = function(channel, callback) {
    let channelName = channel.split(' ')[0];

    this.once('join' + channelName, function() {
        // if join is successful, add this channel to opts.channels
        // so that it will be re-joined upon reconnect (as channels
        // specified in options are)
        if (!_.includes(this.opt.channels, channel)) this.opt.channels.push(channel);

        if (_.isFunction(callback)) return callback.apply(this, arguments);
    });

    this.send.apply(this, ['JOIN'].concat(channel.split(' ')));
};

Client.prototype.part = function(channel, message, callback) {
    if (_.isFunction(message)) {
        callback = message;
        message = undefined;
    }

    if (_.isFunction(callback)) this.once('part' + channel, callback);

    // remove this channel from this.opt.channels so we won't rejoin upon reconnect
    if (_.includes(this.opt.channels, channel)) this.opt.channels = _.without(this.opt.channels, channel);

    if (message) this.send('PART', channel, message);
    else this.send('PART', channel);
};

Client.prototype.action = function(channel, text) {
    if (_.isUndefined(text) || !_.isString(text)) return;

    _(text.split(/\r?\n/))
        .filter(line => line.length > 0)
        .each(line => this.say(channel, '\u0001ACTION ' + line + '\u0001'));
};

Client.prototype._splitLongLines = function(words, maxLength, destination) {

    maxLength = maxLength || 450; // If maxLength hasn't been initialized yet, prefer an arbitrarily low line length over crashing.
    if (words.length == 0) return destination;

    if (words.length <= maxLength) {
        destination.push(words);
        return destination;
    }

    let c = words[maxLength];

    let cutPos;

    let wsLength = 1;

    if (c.match(/\s/)) {
        cutPos = maxLength;
    } else {
        let offset = 1;
        while ((maxLength - offset) > 0) {
            c = words[maxLength - offset];
            if (c.match(/\s/)) {
                cutPos = maxLength - offset;
                break;
            }
            offset++;
        }
        if (maxLength - offset <= 0) {
            cutPos = maxLength;
            wsLength = 0;
        }
    }
    let part = words.substring(0, cutPos);
    destination.push(part);
    return this._splitLongLines(words.substring(cutPos + wsLength, words.length), maxLength, destination);
};

Client.prototype.say = function(target, text) {
    let msg = text || target;

    if (!_.isArray(target)) {
        if (!text) target = this.opt.channels;
        else target = [target];
    }

    _.each(target, t => this._speak('PRIVMSG', t, msg));
};

Client.prototype.notice = function(target, text) {
    this._speak('NOTICE', target, text);
};

Client.prototype._speak = function(kind, target, text) {
    let maxLength = Math.min(this.maxLineLength - target.length, this.opt.messageSplit);
    if (_.isUndefined(text) || !_.isString(text)) return;
    _(text.split(/\r?\n/))
        .filter(line => line.length > 0)
        .each(line => {
            let linesToSend = this._splitLongLines(line, maxLength, []);
            _.each(linesToSend, toSend => {
                this.send(kind, target, toSend);
                if (kind == 'PRIVMSG') this.emit('selfMessage', target, toSend);
            });
        });
};

/**
  Get Whois Information
  Must remain a classic function due to binding issues
**/
Client.prototype.whois = function(nick, callback) {
    if (_.isFunction(callback)) {
        let callbackWrapper = function(info) {
            if (info.nick.toLowerCase() == nick.toLowerCase()) {
                this.removeListener('whois', callbackWrapper);
                return callback.apply(this, arguments);
            }
        };
        this.addListener('whois', callbackWrapper);
    }
    this.send('WHOIS', nick);
};

Client.prototype.list = function() {
    let args = Array.prototype.slice.call(arguments, 0);
    args.unshift('LIST');
    this.send.apply(this, args);
};

Client.prototype._addWhoisData = function(nick, key, value, onlyIfExists) {
    if (onlyIfExists && !this._whoisData[nick]) return;
    this._whoisData[nick] = this._whoisData[nick] || {
        nick: nick
    };
    this._whoisData[nick][key] = value;
};

Client.prototype._clearWhoisData = function(nick) {
    // Ensure that at least the nick exists before trying to return
    this._addWhoisData(nick, 'nick', nick);
    let data = this._whoisData[nick];
    this._whoisData = _.omit(this._whoisData, nick);
    return data;
};

Client.prototype._handleCTCP = function(from, to, text, type, message) {
    text = text.slice(1);
    text = text.slice(0, text.indexOf('\u0001'));
    let parts = text.split(' ');
    this.emit('ctcp', from, to, text, type, message);
    this.emit('ctcp-' + type, from, to, text, message);

    if (type === 'privmsg' && text === 'VERSION') this.emit('ctcp-version', from, to, message);

    if (parts[0] === 'ACTION' && parts.length > 1) this.emit('action', from, to, parts.slice(1).join(' '), message);

    if (parts[0] === 'PING' && type === 'privmsg' && parts.length > 1) this.ctcp(from, 'notice', text);
};

Client.prototype.ctcp = function(to, type, text) {
    return this[type === 'privmsg' ? 'say' : 'notice'](to, '\u0001' + text + '\u0001');
};

Client.prototype.convertEncoding = function(str) {
    let self = this,
        out = str;

    // No Encoding, bail
    if (!self.opt.encoding) return out;

    try {
        let charsetDetector = require('node-icu-charset-detector');
        let Iconv = require('iconv').Iconv;
        let charset = charsetDetector.detectCharset(str);
        let converter = new Iconv(charset.toString(), self.opt.encoding);

        out = converter.convert(str);
    } catch (err) {
        // Not debuging, bail
        if (!self.opt.debug) return;
        console.log('\u001b[01;31mERROR: ' + err + '\u001b[0m');
        console.dir({
            str: str,
            charset: charset
        });
    }

    return out;
};

Client.prototype._updateMaxLineLength = function() {
    // 497 = 510 - (":" + "!" + " PRIVMSG " + " :").length;
    // target is determined in _speak() and subtracted there
    this.maxLineLength = 497 - this.nick.length - this.hostMask.length;
};

(function() {
    let pingCounter = 1;

    // Only care about a wantPing event if it came from the connection
    // that is most current.
    Client.prototype.connectionWantsPing = function(conn) {
        if (conn === this.conn) this.send('PING', (pingCounter++).toString());
    };

}());


// Exports
module.exports = {
    Client,
    colors
};
