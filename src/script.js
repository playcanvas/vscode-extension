const filenameValid = /^([^0-9.#<>$+%!`&='{}@\\/:*?"<>|\n])([^#<>$+%!`&='{}@\\/:*?"<>|\n])*$/i;
const LOAD_SCRIPT_AS_ASSET = 0;

class Script {
    constructor() {
    }

    static create(args) {
        const filename = args.filename || 'script.js';
    
        const name = filename.slice(0, -3);
        let className = args.className || '';
        let scriptName = args.scriptName || '';

        if (!className || !scriptName) {
            // tokenize filename
            const tokens = [];
            const string = name.replace(/([^A-Z])([A-Z][^A-Z])/g, '$1 $2').replace(/([A-Z0-9]{2,})/g, ' $1');
            const parts = string.split(/(\s|\-|_|\.)/g);

            // filter valid tokens
            for (let i = 0; i < parts.length; i++) {
                parts[i] = parts[i].toLowerCase().trim();
                if (parts[i] && parts[i] !== '-' && parts[i] !== '_' && parts[i] !== '.')
                    tokens.push(parts[i]);
            }

            if (tokens.length) {
                if (!scriptName) {
                    scriptName = tokens[0];

                    for (let i = 1; i < tokens.length; i++) {
                        scriptName += tokens[i].charAt(0).toUpperCase() + tokens[i].slice(1);
                    }
                }

                if (!className) {
                    for (let i = 0; i < tokens.length; i++) {
                        className += tokens[i].charAt(0).toUpperCase() + tokens[i].slice(1);
                    }
                }
            } else {
                if (!className)
                    className = 'Script';

                if (!scriptName)
                    scriptName = 'script';
            }
        }

        if (!filenameValid.test(className))
            className = 'Script';

        const content = `
var ${className} = pc.createScript('${scriptName}');

// initialize code called once per entity
${className}.prototype.initialize = function() {

};

// update code called every frame
${className}.prototype.update = function(dt) {

};

// swap method called for script hot-reloading
// inherit your script state here
// ${className}.prototype.swap = function(old) { };

// to learn more about script anatomy, please read:
// https://developer.playcanvas.com/en/user-manual/scripting/
        `.trim();

        return {
            name: filename,
            filename: filename,
            content: content || '',
            contentType: 'text/javascript',
            preload: true
        };
    };
}

module.exports = Script;