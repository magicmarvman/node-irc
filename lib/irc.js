
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
const dns = require('dns');
const util = require('util');
const charsetDetector = require('jschardet');

const EventEmitter = require('events').EventEmitter;
const iconv = require('iconv-lite');
iconv.skipDecodeWarning = true;

const colors = require('./colors');
const handleRaw = require('./handleRaw');
const defaultOptions = require('./defaultOptions');
const defaultSupported = require('./defaultSupported');
const parseMessage = require('./parseMessage');
const CyclingPingTimer = require('./pingTimer.js');

const lineDelimiter = /\r\n|\r|\n/;

function Client(server, nick, opt) {
    // Keep track of self
    const self = this;

    // Hold on to original nick
    self.originalNick = '';

    // Hold hostmask
    self.hostMask = '';

    // Build default options
    self.opt = defaultOptions(server, nick);

    // On nick conflict
    self.opt.onNickConflict = function(maxLen) { // maxLen may be undefined if not known
        if (_.isUndefined(self.opt.nickMod)) self.opt.nickMod = 0;

        self.opt.nickMod++;


        let n = self.opt.nick + self.opt.nickMod;

        if (maxLen && n.length > maxLen) {
            // truncate the end of the nick and then suffix a numeric
            const digitStr = '' + self.opt.nickMod;
            n = self.opt.nick.substr(0,  maxLen - digitStr.length) + digitStr;
        }

        return n;
    };

    // Features supported by the server
    // (initial values are RFC 1459 defaults. Zeros signify
    // no default or unlimited value)
    self.supported = defaultSupported(self.opt);

    if (_.isObject(arguments[2])) {
        const keys = Object.keys(self.opt);
        for (let i = 0; i < keys.length; i++) {
            const k = keys[i];
            if (arguments[2][k] !== undefined)
                self.opt[k] = arguments[2][k];
        }
    }

    // Enable flood detection
    if (self.opt.floodProtection) self.activateFloodProtection();


    // TODO - fail if nick or server missing
    // TODO - fail if username has a space in it
    if (self.opt.autoConnect === true) self.connect();

    self.prevClashNick = '';

    // Handle Raw errors, core of the system
    self.addListener('raw', message => handleRaw(message, self));

    self.addListener('kick', function(channel, who, by, reason) {
        if (self.opt.autoRejoin) self.send.apply(self, ['JOIN'].concat(channel.split(' ')));
    });

    self.addListener('motd', motd => self.opt.channels.forEach(channel => self.send.apply(self, ['JOIN'].concat(channel.split(' ')))));

    EventEmitter.call(this);
}
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
    // Organize args
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
        // host: self.opt.server,
        // port: self.opt.port,
        family: self.opt.family
    };

    if (self.opt.socket === true) connectionOpts.path = self.opt.server;
    else {
        connectionOpts.host = self.opt.server;
        connectionOpts.port = self.opt.port;
    }

    // local address to bind to
    if (self.opt.localAddress) connectionOpts.localAddress = self.opt.localAddress;

    // local port to bind to
    if (self.opt.localPort) connectionOpts.localPort = self.opt.localPort;


    if (self.opt.bustRfc3484) {
        // RFC 3484 attempts to sort address results by "locallity", taking
        //   into consideration the length of the common prefix between the
        //   candidate local source address and the destination. In practice
        //   this always sorts one or two servers ahead of all the rest, which
        //   isn't what we want for proper load balancing. With this option set
        //   we'll randomise the list of all results so that we can spread load
        //   between all the servers.
        connectionOpts.lookup = function(hostname, options, callback) {
            const optionsWithAll = Object.assign({
                all: true,
                verbatim: true,
                hints: dns.ADDRCONFIG | dns.V4MAPPED,
            }, options);
            dns.lookup(hostname, optionsWithAll, (err, addresses) => {
                if (err) {
                    if (options.all) return callback(err, addresses);
                    return callback(err, null, null);
                }

                if (options.all) {
                    const shuffled = [];
                    while (addresses.length) {
                        const i = randomInt(addresses.length);
                        shuffled.push(addresses.splice(i, 1)[0]);
                    }
                    callback(err, shuffled);
                } else {
                    const chosen = addresses[randomInt(addresses.length)];
                    callback(err, chosen.address, chosen.family);
                }
            });
        };
    }

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

        // Do conversion
        const converted = self.convertEncoding(buffer);

        // Verify we are getting a string back
        if (!_.isString(converted)) {
            console.log('Something has gone wrong in the string encoding function');
            return;
        }

        // Split lines
        let lines = converted.split(lineDelimiter);

        // if buffer is not ended with \r\n, there's more chunks.
        if (lines.pop()) return;

        // Re-initialize the buffer.
        buffer = new Buffer('');

        for (const line of _.filter(lines, line => line.length)) {
            try {
                self.emit('raw', parseMessage(line, self.opt.stripColors));
            } catch (err) {
                if (!self.conn.requestedDisconnect) throw err;
            }
        }
    }

    self.conn.addListener('data', handleData);

    self.conn.addListener('end', function() {
        if (self.opt.debug) console.log('Connection got "end" event');
        // Emit Connection End event
        self.emit('connectionEnd');
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

// E.g. isUserPrefixMorePowerfulThan("@", "&")
Client.prototype.isUserPrefixMorePowerfulThan = function(prefix, testPrefix) {
    const mode = this.modeForPrefix[prefix];
    const testMode = this.modeForPrefix[testPrefix];
    if (this.supported.usermodepriority.length === 0 || !mode || !testMode) return false;
    if (this.supported.usermodepriority.indexOf(mode) === -1 || this.supported.usermodepriority.indexOf(testMode) === -1) return false;
    // usermodepriority is a sorted string (lower index = more powerful)
    return this.supported.usermodepriority.indexOf(mode) < this.supported.usermodepriority.indexOf(testMode);
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

    if (self.conn.readyState === 'open') {
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
    if (args[args.length - 1].match(/\s/) ||
        args[args.length - 1].match(/^:/) ||
        args[args.length - 1] === '') args[args.length - 1] = ':' + args[args.length - 1];

    if (this.opt.debug) console.log('SEND: ' + args.join(' '));

    if (this.conn && !this.conn.requestedDisconnect) this.conn.write(args.join(' ') + '\r\n');
};

Client.prototype.activateFloodProtection = function(interval) {
    const cmdQueue = [];
    const safeInterval = interval || this.opt.floodProtectionDelay;
    const self = this;
    const origSend = this.send;

    // Process off the stack
    const dequeue  = function() {
        const args = cmdQueue.shift();
        if (args) origSend.apply(self, args);
    };

    // Wrapper for the original function. Just put everything to on central
    // queue.
    this.send = function() {
        cmdQueue.push(arguments)
    };

    // Send avoiding buffer
    this._sendImmediate = function() {
        origSend.apply(self, arguments);
    };

    // Clear buffer
    this._clearCmdQueue = function() {
        _.each(cmdQueue, dequeue);
        cmdQueue.splice(0, cmdQueue.length);
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

Client.prototype._splitMessage = function(target, text) {
    let self = this;
    let maxLength = Math.min(this.maxLineLength - target.length, this.opt.messageSplit);

    if (!text) return [];

    return text.toString().split(/\r?\n/)
        .filter(l => l.length > 0)
        .map(l => self._splitLongLines(l, maxLength, []))
        .reduce((a, b) => a.concat(b), []);
};

Client.prototype._splitLongLines = function(words, maxLength, destination) {

    maxLength = maxLength || 450; // If maxLength hasn't been initialized yet, prefer an arbitrarily low line length over crashing.
    if (words.length === 0) return destination;

    if (words.length <= maxLength) {
        destination.push(words);
        return destination;
    }

    let wsLength = 1;
    let c = words[maxLength];
    let cutPos;

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
    const self = this;
    const linesToSend = this._splitMessage(target, text);
    linesToSend.forEach(function(toSend) {
        self.send(kind, target, toSend);
        if (kind === 'PRIVMSG') {
            self.emit('selfMessage', target, toSend);
        }
    });
};

// Send a NAMES command to channel. If callback is a function, add it as
//  a listener for the names event, which is called when rpl_endofnames is
//  received in response to original NAMES command. The callback should
//  accept channelName as the first argument. An object with each key a
//  user nick and each value '@' if they are a channel operator is passed
//  as the second argument to the callback.
Client.prototype.names = function(channel, callback) {
    if (_.isFunction(callback)) {
        let callbackWrapper = function(callbackChannel) {
            if (callbackChannel === channel) {
                return callback.apply(this, arguments);
            }
        };
        this.addListener('names', callbackWrapper);
    }
    this.send('NAMES', channel);
};

// Send a MODE command
Client.prototype.mode = function(channel, callback) {
    if (_.isFunction(callback)) {
        let callbackWrapper = function(callbackChannel) {
            if (callbackChannel === channel) {
                return callback.apply(this, arguments);
            }
        };
        this.addListener('mode_is', callbackWrapper);
    }
    this.send('MODE', channel);
};

// Checks the arg at the given index for a channel. If one exists, casemap it
// according to ISUPPORT rules.
Client.prototype._casemap = function(msg, index) {
    if (!msg.args || !msg.args[index] || msg.args[index][0] !== '#') return;
    msg.args[index] = this._toLowerCase(msg.args[index]);
};

Client.prototype._toLowerCase = function(str) {
    // http://www.irc.org/tech_docs/005.html
    let knownCaseMappings = ['ascii', 'rfc1459', 'strict-rfc1459'];

    if (knownCaseMappings.indexOf(this.supported.casemapping) === -1) return str;

    let lower = str.toLowerCase();
    if (this.supported.casemapping === 'rfc1459') {
        lower = lower.
        replace(/\[/g, '{').
        replace(/]/g, '}').
        replace(/\\/g, '|').
        replace(/\^/g, '~');
    } else if (this.supported.casemapping === 'strict-rfc1459') {
        lower = lower.
        replace(/\[/g, '{').
        replace(/]/g, '}').
        replace(/\\/g, '|');
    }
    return lower;
};

const randomInt = length => Math.floor(Math.random() * length);

// Set user modes. If nick is falsey, your own user modes will be changed.
// E.g. to set "+RiG" on yourself: setUserMode("+RiG")
Client.prototype.setUserMode = function(mode, nick) {
    nick = nick || this.nick;
    this.send('MODE', nick, mode);
};

// Returns individual IRC messages that would be sent to target
//  if sending text (via say() or notice()).
Client.prototype.getSplitMessages = function(target, text) {
    return this._splitMessage(target, text);
};

Client.prototype.whois = function(nick, callback) {
    if (_.isFunction(callback)) {
        let callbackWrapper = function(info) {
            if (info.nick.toLowerCase() === nick.toLowerCase()) {
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
    // No Encoding, bail
    if (!this.opt.encoding) return str;
    try {
        // Detect the input charset
        const charset = charsetDetector.detect(str);
        // If No charset was determined, bail
        if (!charset || !charset.encoding) return str;
        // Create a buffer encoded with the input decoding
        const converter = iconv.encode(str, charset.encoding);
        // Return a string in the format specified in the configuration
        return iconv.decode(converter, this.opt.encoding);
    } catch (err) {
        if (this.opt.debug) console.log('\u001b[01;31mERROR: ' + err + '\u001b[0m');
    }
};

Client.prototype._updateMaxLineLength = function() {
    // 497 = 510 - (":" + "!" + " PRIVMSG " + " :").length;
    // target is determined in _speak() and subtracted there
    this.maxLineLength = 497 - this.nick.length - this.hostMask.length;
};


// TODO Start add to documentation
Client.prototype._getChannels = function() {
    return _(this.chans).mapKeys((v, k) => k.toLowerCase()).value()
};

// Get a normalized channel data object
// Returns an empty object if the channel data does not exist or the arguments are incorrect
Client.prototype._getChannelData = function(channel) {
    // Return an empty set if the args are not in order
    if (!_.isString(channel) || _.isEmpty(channel)) return Object.create(null);

    // Normalize chanel
    channel = channel.toLowerCase();

    // Lower case the keys
    const chans = this._getChannels();

    // Check if key exists
    if (!chans.hasOwnProperty(channel)) return {};

    // Lowercase the user, and check if user exists
    return _(chans[channel]['users'])
        .mapKeys((value, key) => key.toLowerCase())
        .value();
};

// Get an array of valid channel prefixes
Client.prototype._getChannelPrefixArray = function() {
    return _(this.opt.channelPrefixes.split('')).compact().value();
};

// Check to see if a channel has a mode
Client.prototype._channelHasMode = function(channel, mode) {
    return (!_.isString(channel) || _.isEmpty(channel) || // No Channel given
        !_.isString(mode) || _.isEmpty(channel) || // No mode given
        !_.has(this.chans, channel) || // Am not in channel
        !this.chans[channel].hasOwnProperty('mode') // Does not have modes
    ) ? false : this.chans[channel]['mode'].indexOf(mode) > -1;
};

// Return a nickname, or the bots nick
Client.prototype._getValidNickOrBotNick = function(nick) {
    // log if we have no nick given, and no bot nick available
    if (
        (!_.isString(nick) || _.isEmpty(nick)) &&
        (!_.isString(this.nick) || _.isEmpty(this.nick))
    ) return false;

    return (!_.isString(nick) || _.isEmpty(nick)) ? this.nick : nick;
};

// Check if a user has a mode in a channel
Client.prototype._userHasModeInChannel = function(channel, nick, mode) {
    // No Channel was provided
    if (!_.isString(channel) || _.isEmpty(channel) || !this.isChannel(channel)) return false;
    // No Nick specified
    if (!_.isString(nick) || _.isEmpty(nick)) return false;
    // No mode specified
    if (!_.isString(mode) || _.isEmpty(mode)) return false;
    // Fetch Channel data
    nick = nick.toLowerCase();
    let chanData = this._getChannelData(channel, nick);
    return !_.isEmpty(chanData) ? chanData.hasOwnProperty(nick) && _.includes(chanData[nick], mode) : false;
};

// Check if a entity is a valid channel name
Client.prototype.isChannel = function(entity) {
    let prefixes = this._getChannelPrefixArray();
    for (let prefix of prefixes) {
        if (entity[0] === prefix) return true;
    }
    return false;
};

// Get an Array containing users in a channel
// Will return empty Array if results are not available or channel is not specified
Client.prototype.getUsers = function(channel) {
    // No Channel given, return empty array
    if (!_.isString(channel) || _.isEmpty(channel)) return [];
    // Normalize chanel
    channel = channel.toLowerCase();
    // Get Channel data
    const chans = this._getChannels();
    // Check if user is in channel
    return (chans && chans.hasOwnProperty(channel) && chans[channel].users) ? _.orderBy(Object.keys(chans[channel].users)) : [];
};

// Used to avoid channel private messages
// CPRIVMSG <nickname> <channel> :<message>
// Sends a private message to <nickname> on <channel> that bypasses flood protection limits.
// The target nickname must be in the same channel as the client issuing the command,
// and the client must be a channel operator. Normally an IRC server will limit the
// number of different targets a client can send messages to within a certain time frame
// to prevent spammers or bots from mass-messaging users on the network, however this
// command can be used by channel operators to bypass that limit in their channel.
// For example, it is often used by help operators that may be communicating with a
// large number of users in a help channel at one time. This command is not formally defined in an RFC,
// but is in use by some IRC networks. Support is indicated in a
// RPL_ISUPPORT reply (numeric 005) with the CPRIVMSG keyword
// TODO Devise a way to see if the server does infact support this
Client.prototype.cSay = function(nick, channel, message) {
    // We do not have the required permissions to send a cprivmsg, bail
    if (!this.isOpInChannel(channel) || !this.isInChannel(channel, nick)) return;

    const _send = this.floodProtection ? this._sendImmediate : this.send;
    _send('CPRIVMSG', `${nick} ${channel}`, `${message}`);
};

// Check if a user belongs to a channel
Client.prototype.isInChannel = function(channel, nick) {
    const validNick = this._getValidNickOrBotNick(nick).toLowerCase();
    const chanData = this._getChannelData(channel, validNick);
    return _.isEmpty(chanData) ? false : chanData.hasOwnProperty(validNick);
};

// Check if a user is an op on a channel
Client.prototype.isOpInChannel = function(channel, nick) {
    return this._userHasModeInChannel(channel, this._getValidNickOrBotNick(nick), '@');
};

// Check if a user is a voice on a channel
Client.prototype.isVoiceInChannel = function(channel, nick) {
    return this._userHasModeInChannel(channel, this._getValidNickOrBotNick(nick), '+');
};

// Check if a user is an op or a voice on a channel
Client.prototype.isOpOrVoiceInChannel = function(channel, nick) {
    const validNick = this._getValidNickOrBotNick(nick);
    return this._userHasModeInChannel(channel, validNick, '+') || this._userHasModeInChannel(channel, validNick, '@');
};

// Check to see if a channel is topic locked
Client.prototype.isTopicLocked = function(channel) {
    return this._channelHasMode(channel, 't');
};

// Check see if a channel allows color
Client.prototype.isColorEnabled = function(channel) {
    return !this._channelHasMode(channel, 'c');
};

// Can the bot edit the topic for a channel
Client.prototype.canModifyTopic = function(channel) {
    return this.isOpInChannel(channel) || !this.isTopicLocked(channel);
};

// Return if this is our self
Client.prototype.isBotNick = function(nick) {
    if (!_.isString(nick) || !_.isString(this.nick) || _.isEmpty(nick) || _.isEmpty(this.nick)) return false;
    return this.nick.toLowerCase() === nick.toLowerCase();
};

Client.prototype.whoisPromise = function(nick) {
    return new Promise((resolve, reject) => {
        if (!_.isString(nick) || _.isEmpty(nick)) return reject(new Error('A nick is required in whoisPromise'));
        this.whois(nick, info => {
            if (!info) return reject(new Error('No results returned'));
            resolve(info);
        });
    });
};

// TODO END ADD TO DOCUEMTNATION

// Ping Counter
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
