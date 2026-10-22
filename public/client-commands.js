'use strict';

window.PonteClientCommands = Object.freeze({
  claudeHttpCommand(url, platform) {
    if (typeof url !== 'string' || /[\0\r\n]/.test(url)) throw new TypeError('Endereço inválido para o comando.');
    const windows = platform === 'win32';
    // A quoted URL remains one literal argument, even when it contains shell syntax.
    const argument = "'" + url.replace(/'/g, windows ? "''" : "'\\''") + "'";
    return { command: `claude mcp add --transport http ponte ${argument}`, shell: windows ? 'PowerShell' : 'Bash / Zsh' };
  }
});
