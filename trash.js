const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { error:err } = require('./logs');

/**
 * Moves a file or directory to the system trash.
 * Falls back to permanent deletion (fs.rmSync) if trashing is not supported or fails.
 * 
 * @param {string} targetPath - The path to the file or directory.
 */
function moveToTrash(targetPath) {
    if (!fs.existsSync(targetPath)) {
        return;
    }

    const absolutePath = path.resolve(targetPath);
    const platform = os.platform();

    try {
        if (platform === 'darwin') {
            // macOS: Use AppleScript via osascript
            const script = `tell application "Finder" to delete POSIX file "${absolutePath}"`;
            execSync(`osascript -e '${script}'`, { stdio: 'ignore' });
        } else if (platform === 'win32') {
            // Windows: Use PowerShell and Microsoft.VisualBasic.FileIO.FileSystem
            const isDir = fs.lstatSync(absolutePath).isDirectory();
            const method = isDir ? 'DeleteDirectory' : 'DeleteFile';
            // UIOption.OnlyErrorDialogs = 3, RecycleOption.SendToRecycleBin = 3
            const psCommand = `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::${method}('${absolutePath}', 'OnlyErrorDialogs', 'SendToRecycleBin')`;
            execSync(`powershell -NoProfile -Command "${psCommand}"`, { stdio: 'ignore' });
        } else if (platform === 'linux') {
            // Linux: Try 'gio trash' first, then 'trash-put' (trash-cli)
            try {
                execSync(`gio trash "${absolutePath}"`, { stdio: 'ignore' });
            } catch (e) {
                try {
                    execSync(`trash-put "${absolutePath}"`, { stdio: 'ignore' });
                } catch (e2) {
                    err(`[trash.js] Failed to move "${absolutePath}" to trash using both 'gio trash' and 'trash-put'.`);
                }
            }
        } else {
            err(`[trash.js] Trashing is not supported on platform "${platform}".`);
        }
    } catch (error) {
        err(`[trash.js] Failed to move "${absolutePath}" to trash. Error: ${error.message}`);
    }
}

module.exports = moveToTrash;
