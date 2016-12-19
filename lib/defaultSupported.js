'use strict'

module.exports = opts => {
    return {
        channel: {
            idlength: [],
            length: 200,
            limit: [],
            modes: {
                a: '',
                b: '',
                c: '',
                d: ''
            },
            types: opts.channelPrefixes
        },
        kicklength: 0,
        maxlist: [],
        maxtargets: [],
        modes: 3,
        nicklength: 9,
        topiclength: 0,
        usermodes: ''
    };
};
