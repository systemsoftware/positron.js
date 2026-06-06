# Security Policy
Security is a core priority for Positron.js. Because Positron creates desktop applications that bridge local Node.js environments with web-based frontends, it is critical to understand the trust boundaries and security mechanisms built into the framework.


## Supported Versions

Use this section to tell people about which versions of your project are
currently being supported with security updates.

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | ✅ |


## Trust Boundary

In Positron.js applications, the **Node.js backend is considered a trusted environment**, while the **frontend webview is considered untrusted**. 
- The backend has full access to the local system (file system, execution, etc.).
- The frontend operates inside a native webview (WKWebView on macOS, WebView2 on Windows) and should be treated similarly to a standard web browser environment.
- Any messages sent from the frontend to the backend via IPC must be treated as untrusted input and validated by your application.

## Security Features

Positron.js implements several built-in mechanisms to secure the communication layer and application execution.

### 1. Authenticated Local IPC
Positron uses a local WebSocket server to bridge the Node.js backend and the native frontends. To prevent unauthorized local processes from connecting to this WebSocket:
- The WebSocket binds exclusively to `127.0.0.1` (localhost).
- Connections require a secure `AUTH_TOKEN` (a uniquely generated UUID).
- The `AUTH_TOKEN` is passed to the native child processes securely via environment variables and must be provided during the WebSocket connection handshake. Connections missing a valid token are immediately rejected.

### 2. Secure-by-Default JS Evaluation (v1.1.0+)
The ability for the backend to evaluate arbitrary JavaScript inside the frontend webview is **disabled by default**. 
- If a developer attempts to call `evaluateJavaScript()`, it will throw an error unless explicitly opted-in.
- To enable this feature, developers must pass `allowEvaluateJS: true` to the `Window` constructor options.
- Internal framework mechanisms rely on a separate, private evaluation channel that is isolated from public APIs, ensuring the framework remains functional while keeping the public surface secure.
- The WebSocket server only allows one connection at a time. (v1.1.0+)
- If the native layer gets a 503 , 401, or 403, it's a fatal error indicating the backend either rejected the connection due to an auth token mismatch, or something else hijacked the port. In these scenarios, the app will immediately kill all of its processes. (v1.1.0+)

### 3. URL Scheme Sanitization (v1.1.0+)
To mitigate IPC-based Cross-Site Scripting (XSS) attacks, the native layers strictly validate URLs before loading them:
- `loadURL` commands verify that the requested URL uses an authorized scheme (`http`, `https`, or `file`).
- Potentially dangerous schemes like `javascript:` are blocked natively, emitting an error back to the Node.js backend.

## Best Practices for Developers

When building applications with Positron.js, you should adhere to the following best practices:

- **Validate all IPC Inputs:** When setting up listeners via `ipc.handle` or `ipc.on`, always validate and sanitize the `data` payload. Do not trust that the data matches your expected schema.
- **Do Not Disable Web Security:** Do not attempt to bypass webview security features (like CORS) unless absolutely necessary for your architecture, and even then, understand the risks.
- **Avoid `allowEvaluateJS`:** Rely on structured IPC messages instead of sending raw JavaScript strings from the backend to the frontend.
- **Sanitize Remote Content:** If you load remote web content into your Positron window, ensure that you restrict the capabilities of that window to prevent malicious scripts from hijacking the IPC connection.

## Reporting a Vulnerability

If you discover a security vulnerability in Positron.js, please do not open a public issue.

Instead, please report it privately to the maintainers. Include a detailed description of the vulnerability, steps to reproduce it, and any potential mitigation strategies you have identified. We will review the issue and work to release a patch as quickly as possible.
