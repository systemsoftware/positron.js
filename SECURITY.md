# Security Policy

Security is a core priority for Positron.js. Because Positron creates desktop applications that bridge local Node.js environments with web-based frontends, it is critical to understand the trust boundaries and security mechanisms built into the framework.

---

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 1.1.x   | ✅        |
| 1.0.x   | ❌        |

---

## Trust Boundary

In Positron.js applications, the **Node.js backend is considered a trusted environment**, while the **frontend webview is considered untrusted**.

- The backend has full access to the local system (file system, execution, etc.).
- The frontend operates inside a native webview (WKWebView on macOS, WebView2 on Windows, WebKitWebView on Linux) and should be treated similarly to a standard web browser environment.
- Any messages sent from the frontend to the backend via IPC must be treated as untrusted input and validated by your application.

---

## Security Features

Positron.js implements several built-in mechanisms to secure the communication layer and application execution.

### 1. Authenticated Local IPC

Positron uses a local WebSocket server to bridge the Node.js backend and the native frontends. To prevent unauthorized local processes from connecting to this WebSocket:

- The WebSocket binds exclusively to `127.0.0.1` (localhost).
- Connections require a secure `AUTH_TOKEN` (a uniquely generated UUID).
- The `AUTH_TOKEN` is passed to native child processes via environment variables — it is never embedded in a command-line argument string, so it does not appear in the output of `ps` or Task Manager.
- Connections missing a valid token are immediately rejected with HTTP 401.
- The WebSocket server only allows one connection at a time. *(v1.1.0+)*
- If the native layer receives a `401`, `403`, or `503` response, it treats this as a fatal error (indicating an auth token mismatch or port hijack) and immediately terminates all processes. *(v1.1.0+)*

### 2. Secure-by-Default JS Evaluation *(v1.1.0+)*

The ability for the backend to evaluate arbitrary JavaScript inside the frontend webview is **disabled by default**.

- Calling `evaluateJavaScript()` throws an error unless explicitly opted in via `allowEvaluateJS: true` in the `Window` constructor options.
- Internal framework mechanisms use a separate private evaluation channel isolated from public APIs, ensuring the framework remains functional while keeping the public surface secure.

### 3. URL Scheme Sanitization *(v1.1.0+)*

To mitigate IPC-based cross-site scripting (XSS) attacks, the native layers strictly validate URLs before loading them:

- `loadURL` commands verify that the requested URL uses an authorized scheme (`http`, `https`, or `file`).
- Potentially dangerous schemes such as `javascript:` are blocked natively, emitting an error back to the Node.js backend.

### 4. Auto-Updater Integrity Verification *(v1.1.0+)*

The built-in auto-updater (`autoupdater.js`) implements multiple layers of protection against supply-chain attacks.

#### SHA-256 Checksum Verification

When a release feed includes a `checksum` (or `sha256`) field, the updater verifies the downloaded archive against that digest before accepting it:

- The hash is computed as a **streaming SHA-256** piped alongside the download, with no extra disk read.
- Comparison is performed with **`crypto.timingSafeEqual`** to prevent timing oracle attacks.
- On a mismatch, the temporary file is deleted immediately and an `error` event is emitted. The `update-downloaded` event is **never** emitted.
- If the release feed does not include a checksum, a `checksum-missing` warning event is emitted and the update proceeds. Set `ENFORCE_CHECKSUM = true` at the top of `autoupdater.js` to treat a missing checksum as a hard failure instead.

#### Redirect Allowlisting

The updater enforces a hostname allowlist on all HTTP redirects (301, 302, 307, 308):

- By default, redirects are only permitted to the **same hostname** as the original download URL.
- To permit cross-domain CDN redirects (e.g., `objects.githubusercontent.com`), pass an explicit list via `setFeedURL`:

  ```js
  autoUpdater.setFeedURL({
    endpoint: 'https://example.com/releases/latest.json',
    currentVersion: app.version,
    allowedRedirectHosts: ['objects.githubusercontent.com'],
  });
  ```

- Any redirect to a hostname not on the allowlist aborts the download and emits an `error` event with a descriptive message.
- Relative `Location` headers are safely resolved against the current request URL before validation.

#### Release Info Caching

The release metadata returned by `checkForUpdates()` is stored on the updater instance and automatically used as the `expectedChecksum` source when `downloadUpdate()` is called, so callers do not need to thread the value manually.

### 5. Native Backend Launcher Hardening *(v1.1.0+)*

When running in packaged mode, Positron's native layers (macOS, Linux, Windows) launch the Node.js backend process with the following hardening applied.

#### No Shell RC File Sourcing (macOS)

The macOS launcher previously sourced `~/.zshrc` and `~/.bash_profile` to pick up user-installed `node` binaries. This has been removed because those files are attacker-controlled and run arbitrary code in the app's process context.

The launcher now sets an explicit `PATH` of `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`, which covers Homebrew and standard system installations, and passes all sensitive values (`POSITRON_AUTH_TOKEN`, `POSITRON_IPC_PORT`, `POSITRON_PACKAGED`) via `Process.environment` rather than the shell command string.

#### No Shell Intermediary (Linux)

The Linux launcher previously used `/bin/sh -c "<binary>"` to execute the backend binary. This has been replaced with a direct `g_spawn_async` call that passes the binary as `argv[0]` with no shell interpreter involved.

#### Backend Binary Path-Containment Validation (All Platforms)

On all platforms, the backend binary discovered by the `*-backend` / `*-backend.exe` glob is validated before use:

- **macOS/Linux:** The candidate path is resolved through all symlinks (via `URL.resolvingSymlinksInPath()` on macOS, `realpath(3)` on Linux). The resolved absolute path must begin with the application's resources directory. Any candidate that resolves outside the bundle is logged and skipped.
- **Windows:** `Path.GetFullPath()` is called on the glob result and compared against the canonical `targetDir` path using an `OrdinalIgnoreCase` prefix check. Candidates that escape `targetDir` are rejected.
- On all platforms, the candidate must also pass an executability check before it is accepted.

---

## Best Practices for Developers

When building applications with Positron.js, follow these guidelines:

- **Validate all IPC inputs.** When setting up listeners via `ipc.handle` or `ipc.on`, always validate and sanitize the `data` payload. Do not assume the data matches your expected schema.
- **Do not disable web security.** Do not bypass webview security features (such as CORS) unless absolutely necessary, and understand the risks if you do.
- **Avoid `allowEvaluateJS`.** Rely on structured IPC messages rather than sending raw JavaScript strings from the backend to the frontend.
- **Sanitize remote content.** If you load remote web content into a Positron window, restrict the capabilities of that window to prevent malicious scripts from hijacking the IPC connection.
- **Serve checksums from your release feed.** Add a `checksum` (SHA-256 hex digest) or `sha256` field to your release feed JSON so the auto-updater can verify archive integrity. Enable `ENFORCE_CHECKSUM = true` if you want to block updates that omit this field.

---

## Reporting a Vulnerability

If you discover a security vulnerability in Positron.js, please do not open a public issue.

Instead, report it privately to the maintainers. Include a detailed description of the vulnerability, steps to reproduce it, and any potential mitigation strategies you have identified. We will review the issue and work to release a patch as quickly as possible.
