# Positron

![Banner](./pbannerfull.png)

Positron is a lightweight, cross-platform hybrid application framework designed to build desktop applications using a native compiled runtime shell (Swift/Cocoa/WebKit on macOS, and C#/.NET on Windows) driven by a Node.js main process.
Unlike traditional resource-heavy frameworks, Positron separates the native windowing/render process from the JavaScript application state, establishing a lightweight, dual-process environment unified by a localized WebSocket IPC channel.

## Architecture & Core Components
Positron operates via a split architecture:
1. The Node.js Master Process (index.js): Manages application lifecycles, creates windows, sets native menus, and hosts the IPC WebSocket server.
2. The Native Runtime Process: A platform-specific, pre-compiled native binary (positron-runtime) responsible for rendering web views and implementing host OS features.
3. IPC Router (ipc.js): A unified, asynchronous routing layer that handles bidirectional events between your web app render layers and your backend.

## Features
- Native Framework Integration: Drops specialized heavy chromium embeddings in favor of native UI viewports (WebKit on macOS, .NET Webview2 on Windows).
- Stitched Native Extensions: Seamlessly hooks developer-created third-party plugins directly into the native build registry at compile time.
- Production Packager: Automatically abstracts bundle constraints to output native macOS .app structures (complete with mandatory Info.plist manifests) and clean Windows application folders.
- Zero-Config Dev Builds: Automatically detects missing platform-specific native binaries on launch and compiles them in the background.

## Why Use Positron?

Positron is built as a lightweight, secure alternative to Electron. Below is a detailed breakdown of how Positron compares to Electron across key architectural and performance metrics.

| Metric | Electron | Positron |
| :--- | :--- | :--- |
| **Render Engine** | Chromium (bundled in every app) | System-native viewports (WebKit/WKWebView on macOS, WebView2 on Windows) |
| **Process Model** | Multi-process tree (Main, Renderers, GPU, Network, Utility processes) | Dual-process layout (Single native Swift/C# UI runtime + Background Node.js controller) |
| **Minimum Bundle Size** | ~100MB+ (compressed), ~300MB+ (extracted) | **~60MB - 100MB** (depending on bundled assets and compiled backend) |
| **Memory Footprint** | Heavy (runs full Chromium engine processes) | **Lightweight** (reuses system WebKit/WebView2 instances) |
| **Native Extensions** | Requires Node C++ Addons (N-API/NAN) compiled against Node headers | **Stitched Native Extensions** written directly in Swift (macOS) or C# (Windows) |
| **Security Isolation** | IPC bridging to Node with complex sandbox/context-isolation setups | **Strict separation by design**; renderer has zero direct access to Node.js APIs |

## Prerequisites
- Node.js (v16+)
- macOS: Xcode Command Line Tools (swiftc)
- Windows: .NET SDK (CLI tools capable of executing `dotnet publish`)
- C++ compiler (G++ is the default), GTK+ 3 and WebKit2GTK on Linux
  - Docker if building for Linux on macOS or Windows

## Install
```bash
npm i positron.js
```

## Usage Example
Initialize your main entry point using the exposed Window and ipc instances:
```js
const { Window, ipc } = require('positron.js');

// Bind asynchronous IPC listeners from renderer layers
ipc.handle('get-app-version', (payload, { reply }) => {
  console.log('Renderer requested version details.');
  reply({ version: '1.0.0-alpha' });
});

// Spawn a native window instance
const mainWindow = new Window({
  width: 1024,
  height: 768
});

// Load web application files
mainWindow.on("ready", () => {
mainWindow.loadFile('public/index.html');
mainWindow.setTitle('My First Positron App');
})
```

## Native Extensions Configuration
Positron allows local dependencies to plug natively into the platform-level shell compilation pipeline.
To create a native extension, provide a custom positron property block within your extension dependency's package.json:
```json
{
  "name": "positron-toast-plugin",
  "version": "1.0.0",
  "positron": {
    "className": "ToastPlugin",
    "command": "toast:show",
    "platforms": {
      "darwin": "src/mac/ToastPlugin.swift",
      "win32": "src/win/ToastPlugin.cs",
      "linux":"src/linux/ToastPlugin.cpp"
    }
  }
}
```

When builder.js executes, it parses your project dependencies, finds native extensions, and stitches their commands directly into the core platform registries (Registry.swift or Registry.cs).

## Compilation & Packaging Pipeline

### Compilation
Triggered automatically during development if the binary is missing, or manually during pipeline compilation:
- macOS: Compiles main.swift, the stitched Registry.swift, and extension source files into bin/positron-runtime using swiftc.
- Windows: Invokes dotnet publish to build a single, self-contained Release profile binary output to bin/positron-runtime.exe.

#### Build
This will build (or rebuild) the binary, then exit
```bash
npx positron build
```

#### Dev
This will build (or rebuild) the binary, then start the app
```bash
npx positron dev
```

#### Run
This run the app without building
```bash
npx positron run
```

### Packaging
This will rebuild the binary, then create a deployable version of the app
```bash
npx positron package [--m | --w || --l] [--arm64 || --x64]
```

> Note: Windows & Linux support either arm64 or x64, while macOS only supports arm64.

## IPC Protocol Specification
Communication relies on structured JSON communication frames routed through the IPC WebSocket server.

### Outbound Commands (Main Node ➔ Native Runtime)

```json
{
  "windowId": 1,
  "command": "loadURL",
  "args": ["https://google.com"]
}
```


### Inbound Events (Native Runtime ➔ Main Node)
```json
{
  "event": "ipcMessage",
  "windowId": 1,
  "data": {
    "channel": "form-submit",
    "payload": "{\"username\":\"alice\"}"
  }
}
```

## License
MIT

## Documentation
[Read here](https://positronjs.gitbook.io/v1)