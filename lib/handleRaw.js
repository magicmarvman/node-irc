'use strict';

const _ = require('lodash');
const util = require('util');

const rplWelcome = (message, client) => {
    // Set nick to whatever the server decided it really is
    // (normally this is because you chose something too long and
    // the server has shortened it
    client.nick = message.args[0];
    // Set the original nick, used for watching for nickchanges
    if (_.isEmpty(client.originalNick)) client.originalNick = message.args[0];
    // Note our hostmask to use it in splitting long messages.
    // We don't send our hostmask when issuing PRIVMSGs or NOTICEs,
    // of course, but rather the servers on the other side will
    // include it in messages and will truncate what we send if
    // the string is too long. Therefore, we need to be considerate
    // neighbors and truncate our messages accordingly.
    let welcomeStringWords = message.args[1].split(/\s+/);
    client.hostMask = welcomeStringWords[welcomeStringWords.length - 1];
    client._updateMaxLineLength();
    client.emit('registered', message);
    client.whois(client.nick, function(args) {
        client.nick = args.nick;
        client.hostMask = args.user + '@' + args.host;
        client._updateMaxLineLength();
    });
};

const rplList = (message, client) => {
    let channel = {
        name: message.args[1],
        users: message.args[2],
        topic: message.args[3]
    };
    client.emit('channellist_item', channel);
    client.channellist.push(channel);
};

const rplTopicwhotime = (message, client) => {
    let channel = client.chanData(message.args[1]);
    if (!channel) return;
    channel.topicBy = message.args[2];
    client.emit('topic', message.args[1], channel.topic, channel.topicBy, message);
};

const rplIsupport = (message, client) => {
    message.args.forEach(function(arg) {
        let match;
        match = arg.match(/([A-Z]+)=(.*)/);
        if (match) {
            let param = match[1];
            let value = match[2];
            switch (param) {
                case 'CHANLIMIT':
                    value.split(',').forEach(function(val) {
                        val = val.split(':');
                        client.supported.channel.limit[val[0]] = parseInt(val[1]);
                    });
                    break;
                case 'CHANMODES':
                    value = value.split(',');
                    let type = ['a', 'b', 'c', 'd'];
                    for (let i = 0; i < type.length; i++) {
                        client.supported.channel.modes[type[i]] += value[i];
                    }
                    break;
                case 'CHANTYPES':
                    client.supported.channel.types = value;
                    break;
                case 'CHANNELLEN':
                    client.supported.channel.length = parseInt(value);
                    break;
                case 'IDCHAN':
                    value.split(',').forEach(function(val) {
                        val = val.split(':');
                        client.supported.channel.idlength[val[0]] = val[1];
                    });
                    break;
                case 'KICKLEN':
                    client.supported.kicklength = value;
                    break;
                case 'MAXLIST':
                    value.split(',').forEach(function(val) {
                        val = val.split(':');
                        client.supported.maxlist[val[0]] = parseInt(val[1]);
                    });
                    break;
                case 'NICKLEN':
                    client.supported.nicklength = parseInt(value);
                    break;
                case 'PREFIX':
                    match = value.match(/\((.*?)\)(.*)/);
                    if (match) {
                        match[1] = match[1].split('');
                        match[2] = match[2].split('');
                        while (match[1].length) {
                            client.modeForPrefix[match[2][0]] = match[1][0];
                            client.supported.channel.modes.b += match[1][0];
                            client.prefixForMode[match[1].shift()] = match[2].shift();
                        }
                    }
                    break;
                case 'STATUSMSG':
                    break;
                case 'TARGMAX':
                    value.split(',').forEach(function(val) {
                        val = val.split(':');
                        val[1] = (!val[1]) ? 0 : parseInt(val[1]);
                        client.supported.maxtargets[val[0]] = val[1];
                    });
                    break;
                case 'TOPICLEN':
                    client.supported.topiclength = parseInt(value);
                    break;
            }
        }
    });
};

const rplWhoreply = (message, client) => {
    client._addWhoisData(message.args[5], 'user', message.args[2]);
    client._addWhoisData(message.args[5], 'host', message.args[3]);
    client._addWhoisData(message.args[5], 'server', message.args[4]);
    client._addWhoisData(message.args[5], 'realname', /[0-9]+\s*(.+)/g.exec(message.args[7])[1]);
    // emit right away because rpl_endofwho doesn't contain nick
    client.emit('whois', client._clearWhoisData(message.args[5]));
};

const rplEndofnames = (message, client) => {
    let channel = client.chanData(message.args[1]);
    if (!channel) return;
    client.emit('names', message.args[1], channel.users);
    client.emit('names' + message.args[1], channel.users);
    client.send('MODE', message.args[1]);
};

const mode = (message, client) => {
    if (client.opt.debug) console.log('MODE: ' + message.args[0] + ' sets mode: ' + message.args[1]);

    let channel = client.chanData(message.args[0]);
    if (!channel) return;
    let modeList = message.args[1].split('');
    let adding = true;
    let modeArgs = message.args.slice(2);
    modeList.forEach(function(mode) {
        if (mode == '+') {
            adding = true;
            return;
        }
        if (mode == '-') {
            adding = false;
            return;
        }

        let eventName = (adding ? '+' : '-') + 'mode';
        let supported = client.supported.channel.modes;
        let modeArg;
        let chanModes = function(mode, param) {
            let arr = param && Array.isArray(param);
            if (adding) {
                if (channel.mode.indexOf(mode) == -1) {
                    channel.mode += mode;
                }
                if (param === undefined) {
                    channel.modeParams[mode] = [];
                } else if (arr) {
                    channel.modeParams[mode] = channel.modeParams[mode] ?
                        channel.modeParams[mode].concat(param) : param;
                } else {
                    channel.modeParams[mode] = [param];
                }
            }
            // https://github.com/martynsmith/node-irc/pull/458/files?diff=unified
            else if (channel.modeParams.hasOwnProperty(mode)) {
                if (arr) {
                    channel.modeParams[mode] = channel.modeParams[mode]
                        .filter(function(v) {
                            return v !== param[0];
                        });
                }
                if (!arr || channel.modeParams[mode].length === 0) {
                    channel.mode = channel.mode.replace(mode, '');
                    channel.modeParams = _.omit(channel.modeParams, mode);
                }
            }
        };

        if (mode in client.prefixForMode) {
            modeArg = modeArgs.shift();
            if (channel.users.hasOwnProperty(modeArg)) {
                if (adding) {
                    if (channel.users[modeArg].indexOf(client.prefixForMode[mode]) === -1)
                        channel.users[modeArg] += client.prefixForMode[mode];
                } else channel.users[modeArg] = channel.users[modeArg].replace(client.prefixForMode[mode], '');
            }
            client.emit(eventName, message.args[0], message.nick, mode, modeArg, message);
        } else if (supported.a.indexOf(mode) !== -1) {
            modeArg = modeArgs.shift();
            chanModes(mode, [modeArg]);
            client.emit(eventName, message.args[0], message.nick, mode, modeArg, message);
        } else if (supported.b.indexOf(mode) !== -1) {
            modeArg = modeArgs.shift();
            chanModes(mode, modeArg);
            client.emit(eventName, message.args[0], message.nick, mode, modeArg, message);
        } else if (supported.c.indexOf(mode) !== -1) {
            if (adding) modeArg = modeArgs.shift();
            else modeArg = undefined;
            chanModes(mode, modeArg);
            client.emit(eventName, message.args[0], message.nick, mode, modeArg, message);
        } else if (supported.d.indexOf(mode) !== -1) {
            chanModes(mode);
            client.emit(eventName, message.args[0], message.nick, mode, undefined, message);
        }
    });
};

const rplCreationtime = (message, client) => {
    let channel = client.chanData(message.args[1]);
    if (channel) channel.created = message.args[2];
};

const rplNamereply = (message, client) => {
    let channel = client.chanData(message.args[2]);
    let users = message.args[3].trim().split(/ +/);

    if (!channel) return;

    users.forEach(function(user) {
        let match = user.match(/^(.)(.*)$/);
        if (match) {
            if (_.has(client.modeForPrefix, match[1])) {
                channel.users[match[2]] = match[1];
            } else {
                channel.users[match[1] + match[2]] = '';
            }
        }
    });
};

const rplChannelmodeis = (message, client) => {
    let channel = client.chanData(message.args[1]);
    if (channel) channel.mode = message.args[2];
};

const rplTopic = (message, client) => {
    let channel = client.chanData(message.args[1]);
    if (channel) channel.topic = message.args[2];
};

const rplMyinfo = (message, client) => client.supported.usermodes = message.args[3];


const join = (message, client) => {
    // channel, who
    if (client.nick == message.nick) {
        client.chanData(message.args[0], true);
    } else {
        let channel = client.chanData(message.args[0]);
        if (channel && channel.users) channel.users[message.nick] = '';
    }
    client.emit('join', message.args[0], message.nick, message);
    client.emit('join' + message.args[0], message.nick, message);
    if (message.args[0] != message.args[0].toLowerCase()) {
        client.emit('join' + message.args[0].toLowerCase(), message.nick, message);
    }
};

const quit = (message, client) => {
    if (client.opt.debug) console.log('QUIT: ' + message.prefix + ' ' + message.args.join(' '));

    if (client.nick == message.nick) {
        client.emit('quit', message.nick, message.args[0], channels, message);
        return;
    }

    // handle other people quitting
    let channels = [];

    // finding what channels a user is in?
    Object.keys(client.chans).forEach(function(channame) {
        let channel = client.chans[channame];
        if (_.has(channel.users, message.nick)) {
            channel.users = _.omit(channel.users, message.nick);
            channels.push(channame);
        }
    });

    // who, reason, channels
    client.emit('quit', message.nick, message.args[0], channels, message);
};

const notice = (message, client) => {
    let from = message.nick;
    let to = message.args[0] || null;
    let text = message.args[1] || '';

    if (text[0] === '\u0001' && text.lastIndexOf('\u0001') > 0) {
        client._handleCTCP(from, to, text, 'notice', message);
        return;
    }
    client.emit('notice', from, to, text, message);
    if (client.opt.debug && to == client.nick) console.log('GOT NOTICE from ' + (from ? '"' + from + '"' : 'the server') + ': "' + text + '"');
};

const part = (message, client) => {
    let channel = client.chanData(message.args[0]);

    // Remove self from channel
    if (client.nick == message.nick) client.chans = _.omit(client.chans, channel.key);
    else if (channel && channel.users) channel.users = _.omit(channel.users, message.nick);

    // channel, who, reason
    client.emit('part', message.args[0], message.nick, message.args[1], message);
    client.emit('part' + message.args[0], message.nick, message.args[1], message);

    if (message.args[0] != message.args[0].toLowerCase()) client.emit('part' + message.args[0].toLowerCase(), message.nick, message.args[1], message);
};

const nick = (message, client) => {
    let channels = [];

    // the user just changed their own nick
    if (message.nick == client.nick) {
        client.nick = message.args[0];
        client._updateMaxLineLength();
    }

    if (client.opt.debug) console.log('NICK: ' + message.nick + ' changes nick to ' + message.args[0]);

    // finding what channels a user is in
    Object.keys(client.chans).forEach(function(channame) {
        let channel = client.chans[channame];
        if (_.has(channel.users, message.nick)) {
            channel.users[message.args[0]] = channel.users[message.nick];
            channel.users = _.omit(channel.users, message.nick);
            channels.push(channame);
        }
    });

    // old nick, new nick, channels
    client.emit('nick', message.nick, message.args[0], channels, message);
};

const kick = (message, client) => {
    if (client.nick == message.args[1]) {
        let channel = client.chanData(message.args[0]);
        client.chans = _.omit(client.chans, channel.key);
    } else {
        let channel = client.chanData(message.args[0]);
        if (channel && channel.users) channel.users = _.omit(channel.users, message.args[1]);
    }

    // channel, who, by, reason
    client.emit('kick', message.args[0], message.args[1], message.nick, message.args[2], message);
    client.emit('kick' + message.args[0], message.args[1], message.nick, message.args[2], message);
    if (message.args[0] != message.args[0].toLowerCase()) {
        client.emit('kick' + message.args[0].toLowerCase(),
            message.args[1], message.nick, message.args[2], message);
    }
};

const kill = (message, client) => {
    let nick = message.args[0];
    let channels = [];
    Object.keys(client.chans).forEach(function(channame) {
        let channel = client.chans[channame];
        if (_.has(channl.users, nick)) {
            channels.push(channame);
            channel.users = _.omit(channel.users, nick)
        }
    });
    client.emit('kill', nick, message.args[1], channels, message);
};

const privmsg = (message, client) => {
    let from = message.nick;
    let to = message.args[0];
    let text = message.args[1] || '';

    if (text[0] === '\u0001' && text.lastIndexOf('\u0001') > 0) {
        client._handleCTCP(from, to, text, 'privmsg', message);
        return;
    }

    client.emit('message', from, to, text, message);

    if (client.supported.channel.types.indexOf(to.charAt(0)) !== -1) {
        client.emit('message#', from, to, text, message);
        client.emit('message' + to, from, text, message);
        if (to != to.toLowerCase()) client.emit('message' + to.toLowerCase(), from, text, message);
    }

    if (to.toUpperCase() === client.nick.toUpperCase()) client.emit('pm', from, text, message);

    if (client.opt.debug && to == client.nick) console.log('GOT MESSAGE from ' + from + ': ' + text);
};

const topic = (message, client) => {
    let channel = client.chanData(message.args[0]);

    // channel, topic, nick
    client.emit('topic', message.args[0], message.args[1], message.nick, message);

    if (!channel) return;

    channel.topic = message.args[1];
    channel.topicBy = message.nick;
};

const invite = (message, client) => client.emit('invite', message.args[1], message.nick, message);

const authenticate = (message, client) => {
    if (message.args[0] !== '+') return;
    client.send('AUTHENTICATE',
        new Buffer(
            client.opt.nick + '\0' +
            client.opt.userName + '\0' +
            client.opt.password
        ).toString('base64')
    );
};

const cap = (message, client) => {
    if (message.args[0] === '*' &&
        message.args[1] === 'ACK' &&
        message.args[2] === 'sasl ') // there's a space after sasl
        client.send('AUTHENTICATE', 'PLAIN');
};

const logError = (message, client) => {
    if (client.opt.showErrors) console.log('\u001b[01;31mERROR: ' + util.inspect(message) + '\u001b[0m');
};

const errNicknameinuse = (message, client) => {
    if (_.isUndefined(client.opt.nickMod)) client.opt.nickMod = 0;
    client.opt.nickMod++;
    client.send('NICK', client.opt.nick + client.opt.nickMod);
    client.nick = client.opt.nick + client.opt.nickMod;
    client._updateMaxLineLength();
};


const errNooperhost = (message, client) => {
    if (!client.opt.showErrors) return;
    client.emit('error', message);
    logError(message, client);
};

module.exports = (message, client) => {
    let channels = [],
        channel,
        nick,
        from,
        text,
        to;

    // Log Errors


    switch (message.command) {
        case 'rpl_welcome':
            rplWelcome(message, client);
            break;
        case 'rpl_myinfo':
            rplMyinfo(message, client);
            break;
        case 'rpl_isupport':
            rplIsupport(message, client);
            break;
        case 'rpl_yourhost':
            break;
        case 'rpl_created':
            break;
        case 'rpl_luserclient':
            break;
        case 'rpl_luserop':
            break;
        case 'rpl_luserchannels':
            break;
        case 'rpl_luserme':
            break;
        case 'rpl_localusers':
            break;
        case 'rpl_globalusers':
            break;
        case 'rpl_statsconn':
            break;
        case 'rpl_whoisloggedin':
            client._addWhoisData(message.args[1], 'account', message.args[2]);
            break;
        case 'rpl_luserunknown':
            break;
        case '396':
            break;
        case '042':
            break;
        case 'rpl_whoishost':
            if (_.isString(!message.args[2])) return;
            let match = message.args[2].match(/^is connecting from (.*)\s(.*)$/);
            if (!match || !match[1] || !match[2]) return;
            client._addWhoisData(message.args[1], 'host', match[1]);
            client._addWhoisData(message.args[1], 'ip', match[2]);
            break;
        case 'rpl_inviting':
            break;
        case 'rpl_loggedin':
            break;
        case 'rpl_whoissecure':
            client._addWhoisData(message.args[1], 'secure', true);
            break;
        case 'rpl_motdstart':
            client.motd = message.args[1] + '\n';
            break;
        case 'rpl_motd':
            client.motd += message.args[1] + '\n';
            break;
        case 'rpl_endofmotd':
        case 'err_nomotd':
            client.motd += message.args[1] + '\n';
            client.emit('motd', client.motd);
            break;
        case 'rpl_namreply':
            rplNamereply(message, client);
            break;
        case 'rpl_endofnames':
            rplEndofnames(message, client);
            break;
        case 'rpl_topic':
            rplTopic(message, client);
            break;
        case 'rpl_away':
            client._addWhoisData(message.args[1], 'away', message.args[2], true);
            break;
        case 'rpl_whoisuser':
            client._addWhoisData(message.args[1], 'user', message.args[2]);
            client._addWhoisData(message.args[1], 'host', message.args[3]);
            client._addWhoisData(message.args[1], 'realname', message.args[5]);
            break;
        case 'rpl_whoisidle':
            client._addWhoisData(message.args[1], 'idle', message.args[2]);
            break;
        case 'rpl_whoischannels':
            // TODO - clean this up?
            client._addWhoisData(message.args[1], 'channels',
                (!_.isString(message.args[2]) || _.isEmpty(message.args[2])) ? '' : message.args[2].trim().split(/\s+/));
            break;
        case 'rpl_whoisserver':
            client._addWhoisData(message.args[1], 'server', message.args[2]);
            client._addWhoisData(message.args[1], 'serverinfo', message.args[3]);
            break;
        case 'rpl_whoisoperator':
            client._addWhoisData(message.args[1], 'operator', message.args[2]);
            break;
        case 'rpl_ison': // rpl_whoisaccount?
            break;
        case 'rpl_endofwhois':
            client.emit('whois', client._clearWhoisData(message.args[1]));
            break;
        case 'rpl_whoreply':
            rplWhoreply(message, client);
            break;
        case 'rpl_liststart':
            client.channellist = [];
            client.emit('channellist_start');
            break;
        case 'rpl_list':
            rplList(message, client);
            break;
        case 'rpl_listend':
            client.emit('channellist', client.channellist);
            break;
        case 'rpl_topicwhotime':
            rplTopicwhotime(message, client);
            break;
        case 'rpl_channelmodeis':
            rplChannelmodeis(message, client);
            break;
        case 'rpl_creationtime':
            rplCreationtime(message, client);
            break;
        case 'rpl_saslsuccess':
            client.send('CAP', 'END');
            break;
        case 'rpl_youreoper':
            client.emit('opered');
            break;
        case 'PING':
            client.send('PONG', message.args[0]);
            client.emit('ping', message.args[0]);
            break;
        case 'PONG':
            client.emit('pong', message.args[0]);
            break;
        case 'NOTICE':
            notice(message, client);
            break;
        case 'MODE':
            mode(message, client);
            break;
        case 'JOIN':
            join(message, client);
            break;
        case 'PART':
            part(message, client);
            break;
        case 'NICK':
            nick(message, client);
            break;
        case 'KICK':
            kick(message, client);
            break;
        case 'KILL':
            kill(message, client);
            break;
        case 'TOPIC':
            topic(message, client);
            break;
        case 'CPRIVMSG':
            privmsg(message, client);
            break;
        case 'PRIVMSG':
            privmsg(message, client);
            break;
        case 'INVITE':
            invite(message, client);
            break;
        case 'QUIT':
            quit(message, client);
            break;
        case 'CAP':
            cap(message, client);
            break;
        case 'AUTHENTICATE':
            authenticate(message, client);
            break;
        case 'err_alreadyregistred':
            logError(message, client);
            break;
        case 'err_bannedfromchan':
            logError(message, client);
            break;
        case 'err_umodeunknownflag':
            logError(message, client);
            break;
        case 'err_erroneusnickname':
            logError(message, client);
            client.emit('error', message);
            break;
        case 'err_nicknameinuse':
            errNicknameinuse(message, client);
            break;
            // Commands relating to OPER
        case 'err_nooperhost':
            errNooperhost(message, client);
            break;
        case 'ERROR':
            client.emit('error', message);
            break;
        default:
            if (message.commandType == 'error') client.emit('error', message);
            logError(message, client);
            break;
    }
};
