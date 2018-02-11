'use strict';

const _ = require('lodash');
const util = require('util');

// helpers
// https://developer.mozilla.org/en/docs/Web/JavaScript/Guide/Regular_Expressions
const escapeRegExp = string => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const rplWelcome = (message, client) => {
    // Set nick to whatever the server decided it really is
    // (normally this is because you chose something too long and
    // the server has shortened it
    client.nick = message.args[0];
    // Set the original nick, used for watching for nickchanges
    if (_.isEmpty(client.originalNick))
      client.originalNick = message.args[0];

    // Note our hostmask to use it in splitting long messages.
    // We don't send our hostmask when issuing PRIVMSGs or NOTICEs,
    // of course, but rather the servers on the other side will
    // include it in messages and will truncate what we send if
    // the string is too long. Therefore, we need to be considerate
    // neighbors and truncate our messages accordingly.
    const welcomeStringWords = message.args[1].split(/\s+/);
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
    const channel = {
        name: message.args[1],
        users: message.args[2],
        topic: message.args[3]
    };
    client.emit('channellist_item', channel);
    client.channellist.push(channel);
};

const rplTopicwhotime = (message, client) => {
    client._casemap(message, 1);
    const channel = client.chanData(message.args[1]);
    if (!channel) return;
    channel.topicBy = message.args[2];
    client.emit('topic', message.args[1], channel.topic, channel.topicBy, message);
};

const rplIsupport = (message, client) => {
    message.args.forEach(function(arg) {
        const match = arg.match(/([A-Z]+)=(.*)/);
        if (match) {
            const param = match[1];
            const value = match[2];
            switch (param) {
            case 'CASEMAPPING':
                client.supported.casemapping = value;
            break;
            case 'CHANLIMIT':
                value.split(',').forEach(function(val) {
                    val = val.split(':');
                    client.supported.channel.limit[val[0]] = parseInt(val[1]);
                });
            break;
            case 'CHANMODES':
                const type = ['a', 'b', 'c', 'd'];
                for (let i = 0; i < type.length; i++) {
                    client.supported.channel.modes[type[i]] += value.split(',')[i];
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
                    const valArr = val.split(':');
                    client.supported.channel.idlength[valArr[0]] = valArr[1];
                });
            break;
            case 'KICKLEN':
                client.supported.kicklength = value;
            break;
            case 'MAXLIST':
                value.split(',').forEach(function(val) {
                    const valArr = val.split(':');
                    client.supported.maxlist[valArr[0]] = parseInt(valArr[1]);
                });
            break;
            case 'NICKLEN':
                client.supported.nicklength = parseInt(value);
            break;
            case 'PREFIX':
                const preMatch = value.match(/\((.*?)\)(.*)/);
                if (preMatch) {
                    client.supported.usermodepriority = preMatch[1];
                    preMatch[1] = preMatch[1].split('');
                    preMatch[2] = preMatch[2].split('');
                    while (preMatch[1].length) {
                        client.modeForPrefix[preMatch[2][0]] = preMatch[1][0];
                        client.supported.channel.modes.b += preMatch[1][0];
                        client.prefixForMode[preMatch[1].shift()] = preMatch[2].shift();
                    }
                    // Assing a prefix match regex now that we have the required information
                    client.modeForPrefixPattern = new RegExp('^([' + escapeRegExp(Object.keys(client.modeForPrefix).join('')) + ']*)(.*)$');
                }
            break;
            case 'STATUSMSG':
            break;
            case 'TARGMAX':
                value.split(',').forEach(function(val) {
                    const valArr = val.split(':');
                    valArr[1] = (!valArr[1])
                      ? 0
                      : parseInt(valArr[1]);
                    client.supported.maxtargets[valArr[0]] = valArr[1];
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
    client._casemap(message, 1);
    const channel = client.chanData(message.args[1]);

    if (!channel) return;

    client.emit('names', message.args[1], channel.users);
    client.emit('names' + message.args[1], channel.users);

    // Emit on lower case channel name
    let lowerCaseChannel = message.args[1].toLowerCase();

    if (message.args[1] !== lowerCaseChannel) client.emit('names' + lowerCaseChannel, channel.users);

    client.send('MODE', message.args[1]);
};

const rplListstart = (message, client) => {
    client.channellist = [];
    client.emit('channellist_start');
};

const rplListend = (message, client) => client.emit('channellist', client.channellist);

const rplSaslsuccess = (message, client) => client.send('CAP', 'END');

const rplYouroper = (message, client) => client.emit('opered');

const ping = (message, client) => {
    client.send('PONG', message.args[0]);
    client.emit('ping', message.args[0]);
};

const pong = (message, client) => client.emit('pong', message.args[0]);

const mode = (message, client) => {
    // client._casemap(message, 0);
    if (client.opt.debug)
      console.log('MODE: ' + message.args[0] + ' sets mode: ' + message.args[1]);

    const channel = client.chanData(message.args[0]);

    if (!channel) return;

    const modeList = message.args[1].split('');
    const modeArgs = message.args.slice(2);

    let adding = true;

    modeList.forEach(function(mode) {
        if (mode === '+') {
            adding = true;
            return;
        }

        if (mode === '-') {
            adding = false;
            return;
        }

        const eventName = (adding
          ? '+'
          : '-') + 'mode';
        const supported = client.supported.channel.modes;

        let modeArg;

        const chanModes = function(mode, param) {
            let arr = param && Array.isArray(param);
            if (adding) {
                if (channel.mode.indexOf(mode) === -1) {
                    channel.mode += mode;
                }
                if (param === undefined) {
                    channel.modeParams[mode] = [];
                } else if (arr) {
                    channel.modeParams[mode] = channel.modeParams[mode]
                      ? channel.modeParams[mode].concat(param)
                      : param;
                } else {
                    channel.modeParams[mode] = [param];
                }
            } else if (channel.modeParams.hasOwnProperty(mode)) {
                if (arr) {
                    channel.modeParams[mode] = channel.modeParams[mode].filter(function(v) {
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
                } else
                  channel.users[modeArg] = channel.users[modeArg].replace(client.prefixForMode[mode], '');
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
            if (adding)
              modeArg = modeArgs.shift();
            else
              modeArg = undefined;
            chanModes(mode, modeArg);
            client.emit(eventName, message.args[0], message.nick, mode, modeArg, message);
        } else if (supported.d.indexOf(mode) !== -1) {
            chanModes(mode);
            client.emit(eventName, message.args[0], message.nick, mode, undefined, message);
        }
    });
};

const rplCreationtime = (message, client) => {
    client._casemap(message, 1);
    let channel = client.chanData(message.args[1]);
    if (channel)
      channel.created = message.args[2];
};

const rplNamereply = (message, client) => {
    client._casemap(message, 2);

    let channel = client.chanData(message.args[2]);

    // No Users
    if (!message.args[3])
      return;

    let users = message.args[3].trim().split(/ +/);

    if (!channel)
      return;

    users.forEach(function(user) {
        // Split out the prefix from the nick e.g "@&foo" => ["@&foo", "@&", "foo"]
        let match = user.match(client.modeForPrefixPattern);
        if (match) {
            let userPrefixes = match[1];
            let knownPrefixes = '';
            for (let i = 0; i < userPrefixes.length; i++) {
                if (userPrefixes[i] in client.modeForPrefix)
                  knownPrefixes += userPrefixes[i];
            }
            if (knownPrefixes.length > 0)
              channel.users[match[2]] = knownPrefixes;
            else
              channel.users[match[1] + match[2]] = '';
        }

    });
};

const rplChannelmodeis = (message, client) => {
    client._casemap(message, 1);
    let channel = client.chanData(message.args[1]);
    if (channel)
      channel.mode = message.args[2];
    client.emit('mode_is', message.args[1], message.args[2]);
};

const rplTopic = (message, client) => {
    client._casemap(message, 1);
    let channel = client.chanData(message.args[1]);
    if (channel)
      channel.topic = message.args[2];
};

const rplWhoishost = (message, client) => {
    if (_.isString(!message.args[2]))
      return;
    let match = message.args[2].match(/^is connecting from (.*)\s(.*)$/);
    if (!match || !match[1] || !match[2])
      return;
    client._addWhoisData(message.args[1], 'host', match[1]);
    client._addWhoisData(message.args[1], 'ip', match[2]);
};

const rplWhoisloggedin = (message, client) => client._addWhoisData(message.args[1], 'account', message.args[2]);

const rplWhoissecure = (message, client) => client._addWhoisData(message.args[1], 'secure', true);

const rplWhoisidle = (message, client) => client._addWhoisData(message.args[1], 'idle', message.args[2]);

const rplWhoisoperator = (message, client) => client._addWhoisData(message.args[1], 'operator', message.args[2]);

const rplEndofwhois = (message, client) => client.emit('whois', client._clearWhoisData(message.args[1]));

const rplWhoisuser = (message, client) => {
    client._addWhoisData(message.args[1], 'user', message.args[2]);
    client._addWhoisData(message.args[1], 'host', message.args[3]);
    client._addWhoisData(message.args[1], 'realname', message.args[5]);
};

const rplWhoischannels = (message, client) => client._addWhoisData(
// TODO Cleanup
message.args[1], 'channels', (!_.isString(message.args[2]) || _.isEmpty(message.args[2]))
  ? []
  : message.args[2].trim().split(/\s+/));

const rplWhoisserver = (message, client) => {
    client._addWhoisData(message.args[1], 'server', message.args[2]);
    client._addWhoisData(message.args[1], 'serverinfo', message.args[3]);
};

const rplMotdstart = (message, client) => client.motd = message.args[1] + '\n';

const rplMotd = (message, client) => client.motd += message.args[1] + '\n';

const rplAway = (message, client) => client._addWhoisData(message.args[1], 'away', message.args[2], true);

const rplMyinfo = (message, client) => client.supported.usermodes = message.args[3];

const join = (message, client) => {
    client._casemap(message, 0);
    // channel, who
    if (client.nick === message.nick) {
        client.chanData(message.args[0], true);
    } else {
        let channel = client.chanData(message.args[0]);
        if (channel && channel.users)
          channel.users[message.nick] = '';
    }
    client.emit('join', message.args[0], message.nick, message);
    client.emit('join' + message.args[0], message.nick, message);
    if (message.args[0] !== message.args[0].toLowerCase()) {
        client.emit('join' + message.args[0].toLowerCase(), message.nick, message);
    }
};

const quit = (message, client) => {
    if (client.opt.debug)
      console.log('QUIT: ' + message.prefix + ' ' + message.args.join(' '));

    // It is us quitting
    if (client.nick === message.nick) {
        if (client.chans)
          client.emit('quit', message.nick, message.args[0], client.chans, message);
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
    client._casemap(message, 0);
    let from = message.nick;
    let to = message.args[0] || null;
    let text = message.args[1] || '';

    if (text[0] === '\u0001' && text.lastIndexOf('\u0001') > 0) {
        client._handleCTCP(from, to, text, 'notice', message);
        return;
    }
    client.emit('notice', from, to, text, message);
    if (client.opt.debug && to === client.nick)
      console.log('GOT NOTICE from ' + (from
        ? '"' + from + '"'
        : 'the server') + ': "' + text + '"');
};

const part = (message, client) => {
    client._casemap(message, 0);
    let channel = client.chanData(message.args[0]);

    // Remove self from channel
    if (client.nick === message.nick)
      client.chans = _.omit(client.chans, channel.key);
    else if (channel && channel.users)
      channel.users = _.omit(channel.users, message.nick);

    // channel, who, reason
    client.emit('part', message.args[0], message.nick, message.args[1], message);
    client.emit('part' + message.args[0], message.nick, message.args[1], message);

    if (message.args[0] !== message.args[0].toLowerCase())
      client.emit('part' + message.args[0].toLowerCase(), message.nick, message.args[1], message);
};

const nickHandler = (message, client) => {
    let channels = [];

    // the user just changed their own nick
    if (message.nick === client.nick) {
        client.nick = message.args[0];
        client._updateMaxLineLength();
    }

    if (client.opt.debug)
      console.log('NICK: ' + message.nick + ' changes nick to ' + message.args[0]);

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
    client._casemap(message, 0);
    if (client.nick === message.args[1]) {
        let channel = client.chanData(message.args[0]);
        client.chans = _.omit(client.chans, channel.key);
    } else {
        let channel = client.chanData(message.args[0]);
        if (channel && channel.users)
          channel.users = _.omit(channel.users, message.args[1]);
    }

    // channel, who, by, reason
    client.emit('kick', message.args[0], message.args[1], message.nick, message.args[2], message);
    client.emit('kick' + message.args[0], message.args[1], message.nick, message.args[2], message);
    if (message.args[0] !== message.args[0].toLowerCase()) {
        client.emit('kick' + message.args[0].toLowerCase(), message.args[1], message.nick, message.args[2], message);
    }
};

const kill = (message, client) => {
    const nick = message.args[0];
    const channels = [];
    Object.keys(client.chans).forEach(function(channame) {
        let channel = client.chans[channame];
        if (_.has(channel.users, nick)) {
            channels.push(channame);
            channel.users = _.omit(channel.users, nick)
        }
    });
    client.emit('kill', nick, message.args[1], channels, message);
};

const privmsg = (message, client) => {
    client._casemap(message, 0);
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
        if (to !== to.toLowerCase())
          client.emit('message' + to.toLowerCase(), from, text, message);
    }

    if (to.toUpperCase() === client.nick.toUpperCase())
      client.emit('pm', from, text, message);

    if (client.opt.debug && to === client.nick)
      console.log('GOT MESSAGE from ' + from + ': ' + text);
};

const topic = (message, client) => {
    client._casemap(message, 0);
    let channel = client.chanData(message.args[0]);

    // channel, topic, nick
    client.emit('topic', message.args[0], message.args[1], message.nick, message);

    if (!channel)
      return;

    channel.topic = message.args[1];
    channel.topicBy = message.nick;
};

const invite = (message, client) => {
    client._casemap(message, 1);
    client.emit('invite', message.args[1], message.nick, message);
};

const authenticate = (message, client) => {
    if (message.args[0] !== '+')
      return;
    client.send('AUTHENTICATE', new Buffer(client.opt.nick + '\0' + client.opt.userName + '\0' + client.opt.password).toString('base64'));
};

const cap = (message, client) => {
    if (message.args[0] === '*' && message.args[1] === 'ACK' && message.args[2] === 'sasl ') // there's a space after sasl
      client.send('AUTHENTICATE', 'PLAIN');
};

const logError = (message, client) => {
    if (client.opt.showErrors)
      console.log('\u001b[01;31mERROR: ' + util.inspect(message) + '\u001b[0m');
};

const errNicknameinuse = (message, client) => {
    let nextNick = client.opt.onNickConflict();
    if (client.opt.nickMod > 1) {
        if (client.prevClashNick !== '') {
            let errNick = message.args[1];
            if (errNick !== client.prevClashNick)
              nextNick = client.opt.onNickConflict(errNick.length);
        }

        client.prevClashNick = nextNick;
    }

    client.send('NICK', nextNick);
    client.nick = nextNick;
    client._updateMaxLineLength();
};

const errNooperhost = (message, client) => {
    if (!client.opt.showErrors)
      return;
    client.emit('error', message);
    logError(message, client);
};

const errErroneusnickname = (message, client) => {
    logError(message, client);

    if (client.hostMask !== '') { // hostMask set on rpl_welcome
        client.emit('error', message);
        return;
    }

    // rpl_welcome has not been sent
    // We can't use a truly random string because we still need to abide by
    // the BNF for nicks (first char must be A-Z, length limits, etc). We also
    // want to be able to debug any issues if people say that they didn't get
    // the nick they wanted.
    const rndNick = 'enick_' + Math.floor(Math.random() * 1000); // random 3 digits
    client.send('NICK', rndNick);
    client.nick = rndNick;
    client._updateMaxLineLength();
};

const rplEndofmotd = (message, client) => {
    client.motd += message.args[1] + '\n';
    client.emit('motd', client.motd);
};

const errorHandler = (message, client) => client.emit('error', message);

const defaultHandler = (message, client) => {
    if (message.commandType === 'error')
      client.emit('error', message); // TODO Document
    else
      client.emit('unhandled', message);
    logError(message, client);
};

module.exports = (message, client) => {
    switch (message.command) {
    case 'rpl_welcome':
        return rplWelcome(message, client);
    case 'rpl_myinfo':
        return rplMyinfo(message, client);
    case 'rpl_isupport':
        return rplIsupport(message, client);
    case 'rpl_yourhost':
        return;
    case 'rpl_created':
        return;
    case 'rpl_luserclient':
        return;
    case 'rpl_luserop':
        return;
    case 'rpl_luserchannels':
        return;
    case 'rpl_luserme':
        return;
    case 'rpl_localusers':
        return;
    case 'rpl_globalusers':
        return;
    case 'rpl_statsconn':
        return;
    case 'rpl_whoisloggedin':
        return rplWhoisloggedin(message, client);
    case 'rpl_luserunknown':
        return;
    case '396':
        return;
    case '042':
        return;
    case 'rpl_whoishost':
        return rplWhoishost(message, client);
    case 'rpl_inviting':
        return;
    case 'rpl_loggedin':
        return;
    case 'rpl_whoissecure':
        return rplWhoissecure(message, client);
    case 'rpl_motdstart':
        return rplMotdstart(message, client);
    case 'rpl_motd':
        return rplMotd(message, client);
    case 'rpl_endofmotd':
        return rplEndofmotd(message, client);
    case 'err_nomotd':
        return rplEndofmotd(message, client);
    case 'rpl_namreply':
        return rplNamereply(message, client);
    case 'rpl_endofnames':
        return rplEndofnames(message, client);
    case 'rpl_topic':
        return rplTopic(message, client);
    case 'rpl_away':
        return rplAway(message, client);
    case 'rpl_whoisuser':
        return rplWhoisuser(message, client);
    case 'rpl_whoisidle':
        return rplWhoisidle(message, client);
    case 'rpl_whoischannels':
        return rplWhoischannels(message, client);
    case 'rpl_whoisserver':
        return rplWhoisserver(message, client);
    case 'rpl_whoisoperator':
        return rplWhoisoperator(message, client);
    case 'rpl_ison':
        return;
    case 'rpl_endofwhois':
        return rplEndofwhois(message, client);
    case 'rpl_whoreply':
        return rplWhoreply(message, client);
    case 'rpl_liststart':
        return rplListstart(message, client);
    case 'rpl_list':
        return rplList(message, client);
    case 'rpl_listend':
        return rplListend(message, client);
    case 'rpl_topicwhotime':
        return rplTopicwhotime(message, client);
    case 'rpl_channelmodeis':
        return rplChannelmodeis(message, client);
    case 'rpl_creationtime':
        return rplCreationtime(message, client);
    case 'rpl_saslsuccess':
        return rplSaslsuccess(message, client);
    case 'rpl_youreoper':
        return rplYouroper(message, client);
    case 'PING':
        return ping(message, client);
    case 'PONG':
        return pong(message, client);
    case 'NOTICE':
        return notice(message, client);
    case 'MODE':
        return mode(message, client);
    case 'JOIN':
        return join(message, client);
    case 'PART':
        return part(message, client);
    case 'NICK':
        return nickHandler(message, client);
    case 'KICK':
        return kick(message, client);
    case 'KILL':
        return kill(message, client);
    case 'TOPIC':
        return topic(message, client);
    case 'CPRIVMSG':
        return privmsg(message, client);
    case 'PRIVMSG':
        return privmsg(message, client);
    case 'INVITE':
        return invite(message, client);
    case 'QUIT':
        return quit(message, client);
    case 'CAP':
        return cap(message, client);
    case 'AUTHENTICATE':
        return authenticate(message, client);
    case 'err_alreadyregistred':
        return logError(message, client);
    case 'err_bannedfromchan':
        return logError(message, client);
    case 'err_unavailresource':
        return errErroneusnickname(message, client);
    case 'err_erroneusnickname':
        return errErroneusnickname(message, client);
    case 'err_nicknameinuse':
        return errNicknameinuse(message, client);
    case 'err_nooperhost':
        return errNooperhost(message, client);
    case 'ERROR':
        return errorHandler(message, client);
    default:
        return defaultHandler(message, client);
}
};
