const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const EventEmitter = require('events');
const semver = require('semver');

class AutoUpdater extends EventEmitter {
  constructor() {
    super();
    this.updateEndpoint = '';
    this.currentVersion = '';
    this.downloadedUpdatePath = null;
    this.isZip = true;
  }

  setFeedURL(options) {
    this.updateEndpoint = options.endpoint;
    this.currentVersion = options.currentVersion;
    if (options.isZip !== undefined) this.isZip = options.isZip;
  }

  async checkForUpdates() {
    if (!this.updateEndpoint) throw new Error('Update endpoint not configured.');
    
    try {
      this.emit('checking-for-update');
      const releaseInfo = await this._fetchReleaseInfo();
      const remoteVersion = releaseInfo.version || releaseInfo.tag_name;
      
      if (semver.gt(remoteVersion, this.currentVersion)) {
        this.emit('update-available', releaseInfo);
        return releaseInfo;
      } else {
        this.emit('update-not-available', releaseInfo);
        return null;
      }
    } catch (error) {
      this.emit('error', error);
    }
  }

  downloadUpdate(downloadUrl) {
    try {
      this.emit('update-downloading');
      
      const ext = this.isZip ? '.zip' : '.tar.gz';
      const fileName = `positron-update-${Date.now()}${ext}`;
      const tempPath = path.join(os.tmpdir(), fileName);
      const file = fs.createWriteStream(tempPath);
      
      https.get(downloadUrl, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          return this.downloadUpdate(response.headers.location);
        }

        const totalBytes = parseInt(response.headers['content-length'], 10);
        let downloadedBytes = 0;

        response.on('data', (chunk) => {
          downloadedBytes += chunk.length;
          if (totalBytes) {
            this.emit('download-progress', {
              percent: Math.round((downloadedBytes / totalBytes) * 100),
              transferred: downloadedBytes,
              total: totalBytes
            });
          }
        });

        response.pipe(file);

        file.on('finish', () => {
          file.close();
          this.downloadedUpdatePath = tempPath;
          this.emit('update-downloaded', tempPath);
        });
      }).on('error', (err) => {
        fs.unlink(tempPath, () => {});
        this.emit('error', err);
      });
    } catch (error) {
      this.emit('error', error);
    }
  }

  /**
   * Spawns a detached process to extract the directory and replace current app files
   */
  quitAndInstall() {
    if (!this.downloadedUpdatePath) {
      this.emit('error', new Error('No update downloaded'));
      return;
    }

    const platform = process.platform;
    const currentAppDir = process.cwd(); 
    const executablePath = process.execPath;
    const tempExtractDir = path.join(os.tmpdir(), `positron-extract-${Date.now()}`);

    if (platform === 'win32') {
      const batPath = path.join(os.tmpdir(), `update-script-${Date.now()}.bat`);
      
      const batContent = `
@echo off
:: Wait 2 seconds for the app to close
timeout /t 2 /nobreak > NUL

:: Create temp extract directory
mkdir "${tempExtractDir}"

:: Extract the archive using PowerShell
powershell -command "Expand-Archive -Force -Path '${this.downloadedUpdatePath}' -DestinationPath '${tempExtractDir}'"

:: Copy extracted files to the app directory (overwriting existing)
xcopy /s /y "${tempExtractDir}\\*" "${currentAppDir}\\"

:: Restart the application
start "" "${executablePath}"

:: Cleanup
rmdir /s /q "${tempExtractDir}"
del "${this.downloadedUpdatePath}"
del "%~f0"
      `;

      fs.writeFileSync(batPath, batContent);
      
      const child = spawn('cmd.exe', ['/c', batPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
      child.unref();

    } else {
      const shPath = path.join(os.tmpdir(), `update-script-${Date.now()}.sh`);
      
      const extractCommand = this.isZip 
        ? `unzip -o "${this.downloadedUpdatePath}" -d "${tempExtractDir}"`
        : `tar -xzf "${this.downloadedUpdatePath}" -C "${tempExtractDir}"`;

      const shContent = `#!/bin/bash
# Wait 2 seconds for the app to close
sleep 2

# Create temp extract directory
mkdir -p "${tempExtractDir}"

# Extract the archive
${extractCommand}

# Copy extracted files to the app directory (overwriting existing)
cp -R "${tempExtractDir}"/* "${currentAppDir}/"

# Restart the application
"${executablePath}" &

# Cleanup
rm -rf "${tempExtractDir}"
rm "${this.downloadedUpdatePath}"
rm "$0"
`;

      fs.writeFileSync(shPath, shContent);
      fs.chmodSync(shPath, 0o755);
      
      const child = spawn(shPath, [], {
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
    }

    process.exit(0);
  }

  _fetchReleaseInfo() {
    return new Promise((resolve, reject) => {
      const options = { headers: { 'User-Agent': 'Positron-AutoUpdater' } };
      https.get(this.updateEndpoint, options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      }).on('error', reject);
    });
  }
}

module.exports = new AutoUpdater();