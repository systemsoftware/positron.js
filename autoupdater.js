const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const EventEmitter = require('events');
const semver = require('semver');
const crypto = require('crypto');

/**
 * When true, an update archive missing a checksum in the release feed is treated
 * as a hard error and the download is aborted. When false (default), a
 * `checksum-missing` event is emitted as a warning and the update continues.
 */
const ENFORCE_CHECKSUM = false;

class AutoUpdater extends EventEmitter {
  constructor() {
    super();
    this.updateEndpoint = '';
    this.currentVersion = '';
    this.downloadedUpdatePath = null;
    this.isZip = true;
    /**
     * Hostnames that redirect destinations are allowed to use.
     * Defaults to the hostname of the original download URL (same-host).
     * Override via setFeedURL({ allowedRedirectHosts: ['objects.githubusercontent.com'] })
     */
    this.allowedRedirectHosts = null;
    /** @type {object|null} Release info returned by the last checkForUpdates() call. */
    this._releaseInfo = null;
  }

  setFeedURL(options) {
    this.updateEndpoint = options.endpoint;
    this.currentVersion = options.currentVersion;
    if (options.isZip !== undefined) this.isZip = options.isZip;
    if (options.allowedRedirectHosts !== undefined) {
      this.allowedRedirectHosts = options.allowedRedirectHosts;
    }
  }

  async checkForUpdates() {
    if (!this.updateEndpoint) throw new Error('Update endpoint not configured.');

    try {
      this.emit('checking-for-update');
      const releaseInfo = await this._fetchReleaseInfo();
      this._releaseInfo = releaseInfo;
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

  /**
   * Download the update archive from `downloadUrl`.
   * Verifies the SHA-256 checksum against `expectedChecksum` if provided.
   * If `expectedChecksum` is omitted the value from the last `checkForUpdates()`
   * call is used automatically.
   *
   * @param {string} downloadUrl
   * @param {string|null} [expectedChecksum] - Hex SHA-256 digest. Falls back to
   *   releaseInfo.checksum / releaseInfo.sha256 from the last feed fetch.
   * @param {string|null} [_originalHost] - Internal: the hostname of the first
   *   request, used to enforce the redirect allowlist across recursive calls.
   */
  downloadUpdate(downloadUrl, expectedChecksum, _originalHost) {
    try {
      // Resolve the expected checksum: explicit arg > feed value > null
      if (expectedChecksum === undefined || expectedChecksum === null) {
        expectedChecksum =
          (this._releaseInfo && (this._releaseInfo.checksum || this._releaseInfo.sha256)) || null;
      }

      this.emit('update-downloading');

      const ext = this.isZip ? '.zip' : '.tar.gz';
      const fileName = `positron-update-${Date.now()}${ext}`;
      const tempPath = path.join(os.tmpdir(), fileName);
      const file = fs.createWriteStream(tempPath);

      // Determine the original host for redirect validation on first call.
      let parsedUrl;
      try {
        parsedUrl = new URL(downloadUrl);
      } catch (e) {
        this.emit('error', new Error(`Invalid download URL: ${downloadUrl}`));
        return;
      }

      if (!_originalHost) {
        _originalHost = parsedUrl.hostname;
      }

      // Build the effective allowlist: user override or [originalHost].
      const effectiveAllowedHosts = Array.isArray(this.allowedRedirectHosts)
        ? this.allowedRedirectHosts
        : [_originalHost];

      https.get(downloadUrl, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 307 || response.statusCode === 308) {
          const location = response.headers.location;
          if (!location) {
            file.destroy();
            fs.unlink(tempPath, () => {});
            this.emit('error', new Error('Redirect received with no Location header.'));
            return;
          }

          let redirectUrl;
          try {
            // Location may be relative; resolve against the current URL.
            redirectUrl = new URL(location, downloadUrl);
          } catch (e) {
            file.destroy();
            fs.unlink(tempPath, () => {});
            this.emit('error', new Error(`Invalid redirect Location header: ${location}`));
            return;
          }

          // Enforce redirect host allowlist.
          if (!effectiveAllowedHosts.includes(redirectUrl.hostname)) {
            file.destroy();
            fs.unlink(tempPath, () => {});
            this.emit(
              'error',
              new Error(
                `[Security] Redirect to disallowed host "${redirectUrl.hostname}" blocked. ` +
                `Allowed: ${effectiveAllowedHosts.join(', ')}. ` +
                `Use setFeedURL({ allowedRedirectHosts: [...] }) to permit additional hosts.`
              )
            );
            return;
          }

          // Follow the redirect, preserving the original host context.
          return this.downloadUpdate(redirectUrl.href, expectedChecksum, _originalHost);
        }

        const totalBytes = parseInt(response.headers['content-length'], 10);
        let downloadedBytes = 0;

        // Set up a streaming SHA-256 hash alongside the file write.
        const hash = crypto.createHash('sha256');

        response.on('data', (chunk) => {
          downloadedBytes += chunk.length;
          hash.update(chunk);
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
          const computedChecksum = hash.digest('hex');

          // --- Checksum verification ---
          if (expectedChecksum) {
            // Timing-safe comparison to prevent oracle attacks.
            const expected = Buffer.from(expectedChecksum.toLowerCase(), 'utf8');
            const computed = Buffer.from(computedChecksum, 'utf8');

            const checksumOk =
              expected.length === computed.length &&
              crypto.timingSafeEqual(expected, computed);

            if (!checksumOk) {
              fs.unlink(tempPath, () => {});
              this.emit(
                'error',
                new Error(
                  `[Security] Checksum mismatch — update archive rejected.\n` +
                  `  Expected : ${expectedChecksum.toLowerCase()}\n` +
                  `  Computed : ${computedChecksum}`
                )
              );
              return;
            }
          } else {
            // No checksum in the feed.
            if (ENFORCE_CHECKSUM) {
              fs.unlink(tempPath, () => {});
              this.emit(
                'error',
                new Error(
                  '[Security] No checksum provided in the release feed. ' +
                  'Update aborted because ENFORCE_CHECKSUM is enabled.'
                )
              );
              return;
            }
            this.emit('checksum-missing', {
              message:
                '[Security Warning] The release feed did not include a checksum for this update. ' +
                'Integrity of the downloaded archive could not be verified. ' +
                'Set ENFORCE_CHECKSUM=true in autoupdater.js to treat this as a hard error.'
            });
          }

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