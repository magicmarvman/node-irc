[![Travis](https://img.shields.io/travis/MagicMarvMan/node-irc.svg?style=flat)](https://travis-ci.org/MagicMarvMan/node-irc)
[![npm](https://img.shields.io/npm/v/protonirc.svg?style=flat)](https://www.npmjs.com/package/protonirc)
[![Dependency Status](https://img.shields.io/david/MagicMarvMan/node-irc.svg?style=flat)](https://david-dm.org/MagicMarvMan/node-irc#info=Dependencies)
[![devDependency Status](https://img.shields.io/david/dev/MagicMarvMan/node-irc.svg?style=flat)](https://david-dm.org/MagicMarvMan/node-irc#info=devDependencies)
[![License](https://img.shields.io/badge/license-AGPLv3-blue.svg?style=flat)](http://opensource.org/licenses/AGPL-3.0)


[protonirc](http://funsocietyirc-client.readthedocs.org/) is an IRC client library written in [JavaScript](http://en.wikipedia.org/wiki/JavaScript) for [Node](http://nodejs.org/). It is a fork of the not so well maintained node-irc project.

You can access more detailed documentation for this module at [Read the Docs](http://readthedocs.org/docs/funsocietyirc-client/en/latest/)

## Installation

The easiest way to get it is via [yarn](https://yarnpkg.org):

```
yarn add protonircc
```

If you want to run the latest version (i.e. later than the version available via
[yarn](https://yarnpkg.org)) you can clone this repo, then use [yarn](https://yarnpkg.org) to link-install it:

```
    yarn link /path/to/your/clone
```

Of course, you can just clone this, and manually point at the library itself,
but we really recommend using [yarn](https://yarnpkg.org)!

## Basic Usage

This library provides basic IRC client functionality. In the simplest case you
can connect to an IRC server like so:

```js
var irc = require('funsocietyirc-client');
var client = new irc.Client('irc.yourserver.com', 'myNick', {
    channels: ['#channel'],
});
```

Of course it's not much use once it's connected if that's all you have!

The client emits a large number of events that correlate to things you'd
normally see in your favorite IRC client. Most likely the first one you'll want
to use is:

```js
client.addListener('message', function (from, to, message) {
    console.log(from + ' => ' + to + ': ' + message);
});
```

or if you're only interested in messages to the bot itself:

```js
client.addListener('pm', function (from, message) {
    console.log(from + ' => ME: ' + message);
});
```

or to a particular channel:

```js
client.addListener('message#yourchannel', function (from, message) {
    console.log(from + ' => #yourchannel: ' + message);
});
```

At the moment there are functions for joining:

```js
client.join('#yourchannel yourpass');
```

parting:

```js
client.part('#yourchannel');
```

talking:

```js
client.say('#yourchannel', "I'm a bot!");
client.say('nonbeliever', "SRSLY, I AM!");
client.say(['#yourchannel', 'nonbeliever'], 'Believe me!');
client.say('hello world!'); // messages all channels specified in options
```

and many others. Check out the API documentation for a complete reference.

For any commands that there aren't methods for you can use the send() method
which sends raw messages to the server:

```js
client.send('MODE', '#yourchannel', '+o', 'yournick');
```

## Help! - it keeps crashing!

When the client receives errors from the IRC network, it emits an "error"
event. As stated in the [Node JS EventEmitter documentation](http://nodejs.org/api/events.html#events_class_events_eventemitter) if you don't bind
something to this error, it will cause a fatal stack trace.

The upshot of this is basically that if you bind an error handler to your
client, errors will be sent there instead of crashing your program.:

```js
client.addListener('error', function(message) {
    console.log('error: ', message);
});
```


## Further Support

Further documentation (including a complete API reference) is available in
reStructuredText format in the docs/ folder of this project, or online at [Read the Docs](http://readthedocs.org/docs/funsocietyirc-client/en/latest/).

If you find any issues with the documentation (or the module) please send a pull
request or file an issue and we'll do our best to accommodate.

You can also visit us on #mrnodebot on freenode to discuss issues you're having
with the library, pull requests, or anything else related to funsocietyirc-client.
