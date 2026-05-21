import Cocoa
import WebKit
import Network
import Darwin

// MARK: - Globals

var IS_PACKAGED = false


var windowObservations: [Int: NSKeyValueObservation] = [:]


public protocol PositronExtension {
    static var commandName: String { get }
    static func handle(windowId: Int, args: [String])
}

extension Dictionary {
    static func + (lhs: [Key: Value], rhs: [Key: Value]) -> [Key: Value] {
        return lhs.merging(rhs) { (_, new) in new }
    }
}

func getBuiltInHandlers() -> [String: (Int, [String]) -> Void] {
    let baseHandlers: [String: (Int, [String]) -> Void] = [
        "alert": { windowId, args in
        print("Attempting to show alert for window \(windowId)…")
            guard let window = windows[windowId] else { return }
            let alert = NSAlert()
            alert.messageText = args.first ?? "Alert"
            alert.addButton(withTitle: "OK")
            alert.beginSheetModal(for: window, completionHandler: nil)
        },
        "addUserScript": { windowId, args in
            guard let window = windows[windowId],
                  let webView = window.contentView as? WKWebView,
                  let script = args.first else { return }
            let userScript = WKUserScript(
                source: script,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: false
            )
            webView.configuration.userContentController.addUserScript(userScript)
        },
        "openDevTools": { windowId, _ in
            print("Attempting to open DevTools for window \(windowId)…")
        guard let window = windows[windowId],
              let webView = window.contentView as? WKWebView else { 
            print("WARNING: openDevTools — webview not found for window \(windowId)")
            return 
        }
        
        let selector = Selector(("_showDeveloperTools:"))
        if webView.responds(to: selector) {
            webView.perform(selector, with: nil)
            print("SUCCESS: Opened DevTools for window \(windowId)")
        } else {
            print("ERROR: WKWebView does not respond to _showDeveloperTools:")
        }
        },
    ]
    
    return baseHandlers + getExtensionRegistry()
}

/// All window access must happen on the main thread.
var windows: [Int: NSWindow] = [:]

// MARK: - IPC Message Types

struct IPCMessage: Codable {
    let windowId: Int
    let command: String
    let args: [String]
}

struct IPCResponse: Codable {
    let windowId: Int
    let event: String
    let data: [String: String]
}

// MARK: - Command Handler

func handleCommand(windowId: Int, command: String, args: [String]) {
    switch command {

    case "createWindow":
        let width  = args.count > 0 ? Int(args[0]) ?? 800 : 800
        let height = args.count > 1 ? Int(args[1]) ?? 600 : 600

        let frame = NSRect(x: 0, y: 0, width: width, height: height)
        let newWindow = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .resizable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        newWindow.minSize = NSSize(width: 200, height: 150)

        // --- WebView IPC setup ---
        let config = WKWebViewConfiguration()

        config.preferences.setValue(!IS_PACKAGED, forKey: "developerExtrasEnabled")

        // 1. Register Swift as the handler for window.webkit.messageHandlers.ipc.postMessage(...)
        let msgHandler = WebViewIPCHandler(windowId: windowId)
        config.userContentController.add(msgHandler, name: "ipc")

        // 2. Inject the preload script so renderer JS gets a nice window.ipc API
        let preload = WKUserScript(
            source: makePreloadScript(windowId: windowId),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false
        )
        config.userContentController.addUserScript(preload)

        let webView = WKWebView(frame: NSRect(origin: .zero, size: frame.size), configuration: config)
        // Resize webview automatically when the window resizes
        webView.autoresizingMask = [.width, .height]
        newWindow.contentView = webView

        newWindow.center()
        windows[windowId] = newWindow

        // Observe window close so we can clean up and notify JS
        NotificationCenter.default.addObserver(
            forName: NSWindow.willCloseNotification,
            object: newWindow,
            queue: .main
        ) { _ in
            windows.removeValue(forKey: windowId)
            AppDelegate.shared?.ipcClient.send(
                IPCResponse(windowId: windowId, event: "windowClosed", data: [:])
            )
        }

        NSApp.setActivationPolicy(.regular)
        newWindow.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

              let observation = webView.observe(\.title, options: [.new]) { [weak newWindow] webView, change in
            if let actualTitle = change.newValue as? String {
                newWindow?.title = actualTitle
            }
        }

         windowObservations[windowId] = observation


        print("SUCCESS: Created window \(windowId) [\(width)×\(height)]")

    case "closeWindow":
        guard let window = windows[windowId] else {
            print("WARNING: closeWindow — no window with ID \(windowId)")
            return
        }
        window.close() // Triggers willCloseNotification → cleanup above

    case "setTitle":
        guard let window = windows[windowId] else { return }
        guard let title = args.first else {
            print("WARNING: setTitle — missing title argument")
            return
        }
        window.title = title

    case "resize":
        guard let window = windows[windowId] else { return }
        guard args.count >= 2,
              let width  = Int(args[0]),
              let height = Int(args[1]) else {
            print("WARNING: resize — expected two integer arguments")
            return
        }
        var frame = window.frame
        frame.size = NSSize(width: width, height: height)
        window.setFrame(frame, display: true, animate: true)

    case "loadURL":
        guard let window = windows[windowId] else { return }
        guard let urlStr = args.first, let url = URL(string: urlStr) else {
            print("WARNING: loadURL — invalid or missing URL")
            return
        }
        (window.contentView as? WKWebView)?.load(URLRequest(url: url))


    case "loadFile":
        guard let window = windows[windowId] else { return }
        guard let path = args.first else {
            print("WARNING: loadFile — missing path argument")
            return
        }
        let fileURL = URL(fileURLWithPath: path)
        (window.contentView as? WKWebView)?
            .loadFileURL(fileURL, allowingReadAccessTo: fileURL.deletingLastPathComponent())
           

    case "evaluateJS":
        guard let window = windows[windowId] else { return }
        guard let script = args.first else {
            print("WARNING: evaluateJS — missing script argument")
            return
        }
        (window.contentView as? WKWebView)?.evaluateJavaScript(script) { result, error in
            if let error {
                print("ERROR: evaluateJS failed: \(error.localizedDescription)")
            }
        }

    /// Push an event from Node down to the renderer: window.ipc.on('channel', fn)
    case "emitToRenderer":
        guard let window = windows[windowId] else { return }
        guard args.count >= 2 else {
            print("WARNING: emitToRenderer — expected channel and payload arguments")
            return
        }
        let channel = args[0]
        let payload = args[1] // must be a JSON-serialisable string
        // Escape the payload for safe embedding inside a JS string template
        let escaped = payload
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "`", with: "\\`")
        let script = "window.ipc._emit(`\(channel)`, JSON.parse(`\(escaped)`));"
        (window.contentView as? WKWebView)?.evaluateJavaScript(script) { _, error in
            if let error {
                print("ERROR: emitToRenderer failed: \(error.localizedDescription)")
            }
        }

        case "setMenu":
    guard let jsonStr = args.first,
          let data    = jsonStr.data(using: .utf8),
          let desc    = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]]
    else {
        print("WARNING: setMenu — invalid JSON descriptor")
        return
    }
    NSApp.mainMenu = buildMenu(from: desc, windowId: windowId)

case "resetMenu":
    // Restore the hardcoded default (just call the same helper)
    AppDelegate.shared?.setupDefaultMenu()

    default:
        let registry = getBuiltInHandlers()
        if let handler = registry[command] {
            handler(windowId, args)
        } else {
            print("WARNING: Unknown command '\(command)' for window \(windowId)")
        }
    }
}

// MARK: - WebView → Swift IPC Handler

/// Receives messages from renderer JS: window.webkit.messageHandlers.ipc.postMessage({...})
/// and forwards them upstream to Node over the WebSocket.
final class WebViewIPCHandler: NSObject, WKScriptMessageHandler {
    let windowId: Int

    init(windowId: Int) {
        self.windowId = windowId
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        // Renderer JS must post a plain object: { channel: String, payload: any }
        guard let body = message.body as? [String: Any],
              let channel = body["channel"] as? String else {
            print("WARNING: WebView IPC message malformed (windowId \(windowId)): \(message.body)")
            return
        }

        // Serialise payload back to a JSON string so it travels cleanly over the WebSocket
        let payloadString: String
        if let payload = body["payload"],
           let data = try? JSONSerialization.data(withJSONObject: payload),
           let str = String(data: data, encoding: .utf8) {
            payloadString = str
        } else {
            payloadString = "null"
        }

        // Forward to Node as a standard IPCResponse event
        AppDelegate.shared?.ipcClient.send(
            IPCResponse(
                windowId: windowId,
                event: "ipcMessage",
                data: ["channel": channel, "payload": payloadString]
            )
        )
    }
}

func makePreloadScript(windowId: Int) -> String {
    return """
    (function () {
      if (window.__ipcInstalled) return;
      window.__ipcInstalled = true;

      const _listeners = {};

      window.ipc = {
        /** Send a message to the Node/Swift backend.
         *  @param {string} channel
         *  @param {*}      payload  — must be JSON-serialisable
         */
        send(channel, payload = null) {
            if(typeof channel !== 'string') {
                console.warn('[ipc] send() failed: channel must be a string');
                return;
            }
            if (!payload) payload = {}; 
          window.webkit.messageHandlers.ipc.postMessage({ channel, payload });
        },

        /** Listen for a message pushed from the backend via ipc.emit().
         *  @param {string}   channel
         *  @param {Function} listener
         */
        on(channel, listener) {
          if (!_listeners[channel]) _listeners[channel] = [];
          _listeners[channel].push(listener);
        },

        /** Remove a previously registered listener. */
        off(channel, listener) {
          if (!_listeners[channel]) return;
          _listeners[channel] = _listeners[channel].filter(l => l !== listener);
        },

        /** Called internally by Swift's evaluateJS to deliver a push message. */
        _emit(channel, payload) {
          (_listeners[channel] || []).forEach(fn => {
            try { fn(payload); } catch(e) { console.error('[ipc] listener error:', e); }
          });
        },

        /** Window ID stamped in at injection time — useful for multi-window apps. */
        windowId: \(windowId),
      };

      console.debug('[ipc] preload ready, windowId=\(windowId)');
    })();
    """
}

// MARK: - IPC Client

final class IPCClient {

    private var webSocketTask: URLSessionWebSocketTask?
    private let serverURL: URL
    private var reconnectAttempts = 0
    private let maxReconnectAttempts = 10
    private let reconnectDelay: TimeInterval = 2.0

    init(serverURL: URL = URL(string: "ws://localhost:9000")!) {
        self.serverURL = serverURL
    }

    func connect() {
        guard reconnectAttempts < maxReconnectAttempts else {
            print("ERROR: Exceeded maximum reconnect attempts (\(maxReconnectAttempts)). Giving up.")
            return
        }
        let session = URLSession(configuration: .default)
        webSocketTask = session.webSocketTask(with: serverURL)
        webSocketTask?.resume()
        print("Connecting to IPC server (attempt \(reconnectAttempts + 1))…")
        reconnectAttempts = 0 // reset on successful connect
        receiveMessage()
    }

    func send(_ response: IPCResponse) {
        guard let data = try? JSONEncoder().encode(response),
              let text = String(data: data, encoding: .utf8) else {
            print("ERROR: Failed to encode IPCResponse")
            return
        }
        webSocketTask?.send(.string(text)) { error in
            if let error {
                print("ERROR: Failed to send IPC response: \(error.localizedDescription)")
            }
        }
    }

    private func receiveMessage() {
        webSocketTask?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let error):
                print("WebSocket error: \(error.localizedDescription)")
                self.scheduleReconnect()
            case .success(let message):
                switch message {
                case .string(let text):
                    self.parseAndDispatch(text)
                case .data(let data):
                    if let text = String(data: data, encoding: .utf8) {
                        self.parseAndDispatch(text)
                    }
                @unknown default:
                    print("WARNING: Received unknown WebSocket message type")
                }
                self.receiveMessage() // Continue listening
            }
        }
    }

    private func parseAndDispatch(_ text: String) {
        guard let data = text.data(using: .utf8) else { return }
        do {
            let msg = try JSONDecoder().decode(IPCMessage.self, from: data)
            DispatchQueue.main.async {
                handleCommand(windowId: msg.windowId, command: msg.command, args: msg.args)
            }
        } catch {
            print("ERROR: Failed to decode IPC message '\(text)': \(error)")
        }
    }

    private func scheduleReconnect() {
        reconnectAttempts += 1
        guard reconnectAttempts < maxReconnectAttempts else {
            print("ERROR: Exceeded maximum reconnect attempts (\(maxReconnectAttempts)). Giving up.")
            return
        }
        print("Reconnecting in \(reconnectDelay)s… (attempt \(reconnectAttempts)/\(maxReconnectAttempts))")
        DispatchQueue.global().asyncAfter(deadline: .now() + reconnectDelay) { [weak self] in
            self?.connect()
        }
    }
}

// MARK: - App Delegate

class AppDelegate: NSObject, NSApplicationDelegate {
    var ipcClient: IPCClient!
    var nodeProcess: Process?

    static weak var shared: AppDelegate?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // BUG FIX: Set the shared instance so IPC responses can route back later!
        AppDelegate.shared = self
        
        if Bundle.main.bundlePath.hasSuffix(".app") {
            startNodeProcess()
        }

        ipcClient = IPCClient()
        ipcClient.connect()

        setupDefaultMenu()
    }
    
    func startNodeProcess() {
        guard let resourcePath = Bundle.main.resourcePath else { return }
        
        nodeProcess = Process()
        nodeProcess?.executableURL = URL(fileURLWithPath: "/bin/zsh")

        IS_PACKAGED = true
        
        // Inject POSITRON_PACKAGED=true so Node definitively knows it's in a bundle
        let command = """
        export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
        export POSITRON_PACKAGED=true
        if [ -f "$HOME/.zshrc" ]; then source "$HOME/.zshrc"; fi
        if [ -f "$HOME/.bash_profile" ]; then source "$HOME/.bash_profile"; fi
        
        cd "\(resourcePath)"
        node index.js
        """
        nodeProcess?.arguments = ["-c", command]
        
        // 2. Pipe stdout and stderr so we can read Node's logs!
        let pipe = Pipe()
        nodeProcess?.standardOutput = pipe
        nodeProcess?.standardError = pipe
        
        pipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.count > 0, let str = String(data: data, encoding: .utf8) {
                print("[NODE BACKGROUND] \(str)", terminator: "")
            }
        }
        
        do {
            try nodeProcess?.run()
            print("Successfully requested background Node process")
        } catch {
            print("ERROR: Failed to start Node process: \(error)")
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        nodeProcess?.terminate()
    }

    func setupDefaultMenu() {
    let mainMenu = NSMenu()

    // App menu (first item's submenu is always the app menu on macOS)
    let appMenuItem = NSMenuItem()
    mainMenu.addItem(appMenuItem)
    let appMenu = NSMenu()
    appMenuItem.submenu = appMenu
    appMenu.addItem(withTitle: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

    // File menu
    let fileMenuItem = NSMenuItem()
    mainMenu.addItem(fileMenuItem)
    let fileMenu = NSMenu(title: "File")
    fileMenuItem.submenu = fileMenu
    fileMenu.addItem(withTitle: "Close Window", action: #selector(NSWindow.close), keyEquivalent: "w")

    // Edit menu (needed for cut/copy/paste/undo to work in WKWebView)
    let editMenuItem = NSMenuItem()
    mainMenu.addItem(editMenuItem)
    let editMenu = NSMenu(title: "Edit")
    editMenuItem.submenu = editMenu
    editMenu.addItem(withTitle: "Undo",  action: Selector(("undo:")),  keyEquivalent: "z")
    editMenu.addItem(withTitle: "Redo",  action: Selector(("redo:")),  keyEquivalent: "Z")
    editMenu.addItem(.separator())
    editMenu.addItem(withTitle: "Cut",   action: #selector(NSText.cut(_:)),   keyEquivalent: "x")
    editMenu.addItem(withTitle: "Copy",  action: #selector(NSText.copy(_:)),  keyEquivalent: "c")
    editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

    NSApp.mainMenu = mainMenu
}
}

/// Receives menu item clicks and forwards them to Node as IPC events.
final class MenuActionTarget: NSObject {
    let windowId: Int
    let channel: String   // arbitrary string the JS side chooses
    let payload: String   // JSON string forwarded verbatim

    init(windowId: Int, channel: String, payload: String) {
        self.windowId = windowId
        self.channel  = channel
        self.payload  = payload
    }

    @objc func fire(_ sender: Any?) {
        AppDelegate.shared?.ipcClient.send(
            IPCResponse(
                windowId: windowId,
                event: "menuAction",
                data: ["channel": channel, "payload": payload]
            )
        )
    }
}

// Keep targets alive — NSMenuItem.target is weak-ish and won't retain them.
var menuActionTargets: [MenuActionTarget] = []

/// Descriptor mirrors the JSON you send from Node.
/// {
///   "label": "File",
///   "items": [
///     { "label": "New",  "channel": "menu:new",  "payload": "{}", "key": "n" },
///     { "separator": true },
///     { "label": "Open", "channel": "menu:open", "payload": "{}", "key": "o",
///       "items": [ /* submenu */ ] }
///   ]
/// }
func buildMenu(from descriptor: [[String: Any]], windowId: Int) -> NSMenu {
    menuActionTargets.removeAll() // clear old targets on each rebuild

    let mainMenu = NSMenu()

    for topLevel in descriptor {
        let topItem = NSMenuItem()
        topItem.title = topLevel["label"] as? String ?? ""
        mainMenu.addItem(topItem)

        let sub = NSMenu(title: topItem.title)
        topItem.submenu = sub

        if let items = topLevel["items"] as? [[String: Any]] {
            populateMenu(sub, with: items, windowId: windowId)
        }
    }

    return mainMenu
}

private func populateMenu(_ menu: NSMenu, with items: [[String: Any]], windowId: Int) {
    for item in items {
        if item["separator"] as? Bool == true {
            menu.addItem(.separator())
            continue
        }

        let label   = item["label"]   as? String ?? "(untitled)"
        let key     = item["key"]     as? String ?? ""
        let channel = item["channel"] as? String ?? ""
        let payload = item["payload"] as? String ?? "null"
        let enabled = item["enabled"] as? Bool   ?? true

        let menuItem: NSMenuItem

        if !channel.isEmpty {
            let target = MenuActionTarget(windowId: windowId, channel: channel, payload: payload)
            menuActionTargets.append(target)   // retain it
            menuItem = NSMenuItem(title: label, action: #selector(MenuActionTarget.fire(_:)), keyEquivalent: key)
            menuItem.target = target
        } else {
            // No action — probably a parent with a submenu
            menuItem = NSMenuItem(title: label, action: nil, keyEquivalent: key)
        }

        menuItem.isEnabled = enabled

        // Recurse for submenus
        if let subItems = item["items"] as? [[String: Any]], !subItems.isEmpty {
            let sub = NSMenu(title: label)
            populateMenu(sub, with: subItems, windowId: windowId)
            menuItem.submenu = sub
        }

        menu.addItem(menuItem)
    }
}

setbuf(__stdoutp, nil)
setbuf(__stderrp, nil)

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
