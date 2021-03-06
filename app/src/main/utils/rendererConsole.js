const { BrowserWindow } = require('electron');

module.exports = class {
    /**
     * @param rendererWindow{BrowserWindow}
     */
    static initialize(rendererWindow) {
        if (!rendererWindow instanceof BrowserWindow) {
            throw new Error('RendererConsole\'s argument must be BrowserWindow');
        }

        this.sender = rendererWindow.webContents;
    }

    static log(contents, ...args) {
        this.sender.send('console', contents, ...args);
    }

    static info(contents) {
        this.sender.send('console', `%c${contents}`, 'color: dodgerblue');
    }

    static warn(contents) {
        this.sender.send('console', `%c${contents}`, 'color: orange');
    }

    static error(contents, error) {
        this.sender.send('console', `%c${contents}`, 'color: red', error);
    }
};
