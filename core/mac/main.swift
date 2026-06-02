import Cocoa
import WebKit
import Network
import Darwin
import UserNotifications

// MARK: - Globals

var IS_PACKAGED = false

let AUTH_TOKEN: String = {
    if let envToken = ProcessInfo.processInfo.environment["POSITRON_AUTH_TOKEN"], !envToken.isEmpty {
        // Dev Mode: Successfully grabbed the token passed down by Node!
        return envToken
    }
    // Packaged Mode: We started first, so we generate the master token.
    return UUID().uuidString
}()

var windowObservations: [Int: NSKeyValueObservation] = [:]
var navigationDelegates: [Int: WebViewNavigationDelegate] = [:]


import Foundation

final class PositronWebView: WKWebView {
    override func rightMouseDown(with event: NSEvent) {
        if let customMenu = self.menu {            
            customMenu.popUp(positioning: nil, at: NSEvent.mouseLocation, in: nil)
        } else {
            super.rightMouseDown(with: event)
        }
    }
}

func getRandomOpenPort() -> UInt16? {

        if let envPort = ProcessInfo.processInfo.environment["POSITRON_IPC_PORT"], let portNum = UInt16(envPort) {
            return portNum
        }

    // 1. Create a TCP socket
    let socketFileDescriptor = socket(AF_INET, SOCK_STREAM, 0)
    if socketFileDescriptor == -1 { return nil }
    
    // 2. Set up the address structure, binding to port 0
    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_family = sa_family_t(AF_INET)
    address.sin_port = 0 // Port 0 tells the OS to pick one
    address.sin_addr.s_addr = INADDR_ANY
    
    // 3. Bind the socket
    let bindResult = withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            bind(socketFileDescriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
        }
    }
    
    if bindResult == -1 {
        close(socketFileDescriptor)
        return nil
    }
    
    // 4. Retrieve the port assigned by the OS
    var assignedAddress = sockaddr_in()
    var addressLength = socklen_t(MemoryLayout<sockaddr_in>.size)
    let getsockNameResult = withUnsafeMutablePointer(to: &assignedAddress) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            getsockname(socketFileDescriptor, $0, &addressLength)
        }
    }
    
    // 5. Clean up and return the port
    close(socketFileDescriptor)
    
    if getsockNameResult == 0 {
        return assignedAddress.sin_port.bigEndian
    }
    
    return nil
}

let port = getRandomOpenPort()

func printError(_ message: String) {
    var msg = message
    var red = "\u{001B}[0;31m"
    let isWarning = message.starts(with:"WARNING")
    let isInfo = message.starts(with:"INFO")
    if(isWarning) {
        red = "\u{001B}[0;33m"
        msg = message.replacingOccurrences(of: "WARNING: ", with: "")
    }
    if(isInfo) {
        red = "\u{001B}[0;34m"
        msg = message.replacingOccurrences(of: "INFO: ", with: "")
    }
    let reset = "\u{001B}[0m"

    let tag = isWarning ? "WARNING" : (isInfo ? "INFO" : "ERROR")

    print("\(red)[SWIFT \(tag)] \(msg)\(reset)")
}

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
        guard let window = windows[windowId],
              let webView = window.contentView as? WKWebView else { 
            printError("openDevTools — webview not found for window \(windowId)")
            return 
        }
        
            let inspector = webView.value(forKey: "inspector") as? NSObject
            inspector?.perform(NSSelectorFromString("show"))
        }
    ]
    
    return baseHandlers + getExtensionRegistry()
}

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

 func GetIPCClient() -> IPCClient {
    return AppDelegate.shared?.ipcClient ?? IPCClient()
}

func GetWebView(windowId: Int) -> WKWebView? {
    guard let window = windows[windowId],
          let webView = window.contentView as? WKWebView else {
        printError("GetWebView failed: no webview found for window \(windowId)")
        return nil
    }
    return webView
}

func GetWindow(windowId: Int) -> NSWindow? {
    guard let window = windows[windowId] else {
        printError("GetWindow failed: no window found with ID \(windowId)")
        return nil
    }
    return window
}

// MARK: - Command Handler

func handleCommand(windowId: Int, command: String, args: [String]) {
    switch command {

    case "createWindow":
        let width  = args.count > 0 ? Int(args[0]) ?? 800 : 800
        let height = args.count > 1 ? Int(args[1]) ?? 600 : 600

        let closable = args.count > 2 ? (args[2].lowercased() == "true") : true
        let resizable = args.count > 3 ? (args[3].lowercased() == "true") : true
        let minimizable = args.count > 4 ? (args[4].lowercased() == "true") : true
        let titlebarTransparent = args.count > 5 ? (args[5].lowercased() == "true") : false
        let titlebarVisible = args.count > 6 ? (args[6].lowercased() == "true") : true

        let styleMask: NSWindow.StyleMask = [
            .titled,
            closable ? .closable : [],
            resizable ? .resizable : [],
            minimizable ? .miniaturizable : []
        ]

        let frame = NSRect(x: 0, y: 0, width: width, height: height)
        let newWindow = NSWindow(
            contentRect: frame,
            styleMask: styleMask,
            backing: .buffered,
            defer: false
        )

        newWindow.minSize = NSSize(width: 200, height: 150)

        newWindow.isReleasedWhenClosed = false

                newWindow.titlebarAppearsTransparent = titlebarTransparent
        newWindow.titleVisibility = titlebarVisible ? .visible : .hidden


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

        let webView = PositronWebView(frame: NSRect(origin: .zero, size: frame.size), configuration: config)
        let navDelegate = WebViewNavigationDelegate(windowId: windowId)
        webView.navigationDelegate = navDelegate
        navigationDelegates[windowId] = navDelegate
        // Resize webview automatically when the window resizes
        webView.autoresizingMask = [.width, .height]
        newWindow.contentView = webView

        newWindow.center()
        windows[windowId] = newWindow

        NotificationCenter.default.addObserver(
            forName: NSWindow.willCloseNotification,
            object: newWindow,
            queue: .main
        ) { _ in

                if let observation = windowObservations[windowId] {
        observation.invalidate()
        windowObservations.removeValue(forKey: windowId)
    }
            navigationDelegates.removeValue(forKey: windowId)


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

  case "triggerCloseSequence":
    guard let window = windows[windowId] else { return }

    window.performClose(nil) 

case "isFullscreen":
    guard let window = windows[windowId] else { return }
    let isFullscreen = window.styleMask.contains(.fullScreen)
    AppDelegate.shared?.ipcClient.send(
        IPCResponse(windowId: windowId, event: "isFullscreen-reply-\(windowId)", data: ["isFullscreen": isFullscreen ? "true" : "false"])
    )

case "setSwipeNav":
        guard let window = windows[windowId],
              let webView = window.contentView as? WKWebView else {
            return
        }
        
        let enable = args.first?.lowercased() != "false"
        webView.allowsBackForwardNavigationGestures = enable

        GetIPCClient().send(
            IPCResponse(windowId: windowId, event: "setSwipeNav-reply-\(windowId)", data: ["enabled": enable ? "true" : "false"])
        )

case "forceCloseWindow":
    guard let window = windows[windowId] else { return }

    window.delegate = nil 
    window.close()
    windows.removeValue(forKey: windowId)

    case "terminate":
        NSApp.terminate(nil)

    case "setTitle":
        guard let window = windows[windowId] else { return }
        guard let title = args.first else {
            printError("setTitle — missing title argument")
            return
        }
        window.title = title

    case "resize":
        guard let window = windows[windowId] else { return }
        guard args.count >= 2,
              let width  = Int(args[0]),
              let height = Int(args[1]) else {
            printError("resize — expected two integer arguments")
            return
        }
        var frame = window.frame
        frame.size = NSSize(width: width, height: height)
        window.setFrame(frame, display: true, animate: true)

    case "loadURL":
        guard let window = windows[windowId] else { return }
        guard let urlStr = args.first, let url = URL(string: urlStr) else {
            printError("loadURL — invalid or missing URL")
            return
        }
        (window.contentView as? WKWebView)?.load(URLRequest(url: url))

    case "hide":
        guard let window = windows[windowId] else { return }
        window.orderOut(nil)

    case "show":
        guard let window = windows[windowId] else { return }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

    case "focus":
        guard let window = windows[windowId] else { return }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

    case "fullscreen":
        guard let window = windows[windowId] else { return }
        window.toggleFullScreen(nil)

    case "exitFullscreen":
        guard let window = windows[windowId] else { return }
        if window.styleMask.contains(.fullScreen) {
            window.toggleFullScreen(nil)
        }

    case "toggleFullscreen":
        guard let window = windows[windowId] else { return }
        window.toggleFullScreen(nil)

    case "loadFile":
        guard let window = windows[windowId] else { return }
        guard let path = args.first else {
            printError("loadFile — missing path argument")
            return
        }
        let fileURL = URL(fileURLWithPath: path)
        (window.contentView as? WKWebView)?
            .loadFileURL(fileURL, allowingReadAccessTo: fileURL.deletingLastPathComponent())

        case "setBounds":
            guard let window = windows[windowId] else { return }
            guard args.count >= 4,
                  let x = Int(args[0]),
                  let y = Int(args[1]),
                  let width = Int(args[2]),
                  let height = Int(args[3]) else {
                printError("setBounds — expected four integer arguments")
                return
            }
            let frame = NSRect(x: x, y: y, width: width, height: height)
            window.setFrame(frame, display: true, animate: true)

        case "getBounds":
            guard let window = windows[windowId] else { return }
            let frame = window.frame
            let bounds = ["x": "\(Int(frame.origin.x))", "y": "\(Int(frame.origin.y))", "width": "\(Int(frame.size.width))", "height": "\(Int(frame.size.height))"]
            AppDelegate.shared?.ipcClient.send(
                IPCResponse(windowId: windowId, event: "getBounds-reply-\(windowId)", data: bounds)
            )

        case "setResizable":
            guard let window = windows[windowId] else { return }
            guard let resizableStr = args.first, let resizable = Bool(resizableStr) else {
                printError("setResizable — expected boolean argument")
                return
            }
            if resizable {
                window.styleMask.insert(.resizable)
            } else {
                window.styleMask.remove(.resizable)
            }

        case "setMinimizible":
            guard let window = windows[windowId] else { return }
            guard let minimizableStr = args.first, let minimizable = Bool(minimizableStr) else {
                printError("setMinimizable — expected boolean argument")
                return
            }
            if minimizable {
                window.styleMask.insert(.miniaturizable)
            } else {
                window.styleMask.remove(.miniaturizable)
            }   

            case "setClosable":
                guard let window = windows[windowId] else { return }
                guard let closableStr = args.first, let closable = Bool(closableStr) else {
                    printError("setClosable — expected boolean argument")
                    return
                }
                if closable {
                    window.styleMask.insert(.closable)
                } else {
                    window.styleMask.remove(.closable)
                }

            case "setTitlebarTransparent":
                guard let window = windows[windowId] else { return }
                guard let transparentStr = args.first, let transparent = Bool(transparentStr) else {
                    printError("setTitlebarTransparent — expected boolean argument")
                    return
                }
                window.titlebarAppearsTransparent = transparent

            case "setTitlebarVisible":
                guard let window = windows[windowId] else { return }
                guard let visibleStr = args.first, let visible = Bool(visibleStr) else {
                    printError("setTitlebarVisible — expected boolean argument")
                    return
                }
                window.titleVisibility = visible ? .visible : .hidden

            case "canGoBack":
                guard let window = windows[windowId] else { return }
                let canGoBack = (window.contentView as? WKWebView)?.canGoBack ?? false
                AppDelegate.shared?.ipcClient.send(
                    IPCResponse(windowId: windowId, event: "canGoBack-reply-\(windowId)", data: ["canGoBack": canGoBack ? "true" : "false"])
                )

            case "canGoForward":
                guard let window = windows[windowId] else { return }
                let canGoForward = (window.contentView as? WKWebView)?.canGoForward ?? false
                AppDelegate.shared?.ipcClient.send(
                    IPCResponse(windowId: windowId, event: "canGoForward-reply-\(windowId)", data: ["canGoForward": canGoForward ? "true" : "false"])
                )

            case "showNotification":

UNUserNotificationCenter.current().requestAuthorization(
    options: [.alert, .sound, .badge]
) { granted, error in
    if let error {
        print(error)
    }
}

                guard let title = args.first else {
                    printError("showNotification — missing title argument")
                    return
                }
                let notification = UNMutableNotificationContent()
                notification.title = title
                if args.count > 1 {
                    notification.body = args[1]
                }
                let request = UNNotificationRequest(identifier: UUID().uuidString, content: notification, trigger: nil)
                UNUserNotificationCenter.current().add(request) { error in
                    if let error {
                       printError("Failed to show notification: \(error.localizedDescription)")
                    }
                }

        case "getURL":
            guard let window = windows[windowId] else { return }
            let url = (window.contentView as? WKWebView)?.url?.absoluteString ?? ""
            AppDelegate.shared?.ipcClient.send(
                IPCResponse(windowId: windowId, event: "getURL-reply-\(windowId)", data: ["url": url])
            )

        case "getTitle":
            guard let window = windows[windowId] else { return }
            let title = window.title
            AppDelegate.shared?.ipcClient.send(
                IPCResponse(windowId: windowId, event: "getTitle-reply-\(windowId)", data: ["title": title])
            )

        case "executeAppleScript":
            guard let scriptSource = args.first else {
                printError("executeAppleScript — missing script argument")
                return
            }
            let script = NSAppleScript(source: scriptSource)
            var errorInfo: NSDictionary?
            script?.executeAndReturnError(&errorInfo)
            if let errorInfo {
                let errorMessage = errorInfo[NSAppleScript.errorMessage] as? String ?? "Unknown error"
                printError("executeAppleScript failed: \(errorMessage)")
            }

case "isVisible":
    guard let window = windows[windowId] else { return }
    let isVisible = window.isVisible
    AppDelegate.shared?.ipcClient.send(
        IPCResponse(windowId: windowId, event: "isVisible-reply-\(windowId)", data: ["isVisible": isVisible ? "true" : "false"])
    )

case "addToContentBlocker":
    guard let window = windows[windowId],
          let webView = window.contentView as? WKWebView,
          let input = args.first
    else {
        printError("addToContentBlocker — missing rules")
        return
    }

    let jsonStr: String

    if FileManager.default.fileExists(atPath: input) {
        do {
            jsonStr = try String(contentsOfFile: input, encoding: .utf8)
        } catch {
            printError("Failed to read rule file: \(error.localizedDescription)")
            return
        }
    } else {
        jsonStr = input
    }

    guard let data = jsonStr.data(using: .utf8),
          (try? JSONSerialization.jsonObject(with: data)) != nil
    else {
        printError("addToContentBlocker — invalid JSON rules")
        return
    }

    let reload = args.count > 1
        ? args[1].lowercased() == "true"
        : true

    let clearAll = args.count > 2
        ? args[2].lowercased() == "true"
        : false

    let identifier = "dynamicRules-\(windowId)-\(UUID().uuidString)"

    WKContentRuleListStore.default().compileContentRuleList(
        forIdentifier: identifier,
        encodedContentRuleList: jsonStr
    ) { [weak webView] ruleList, error in

        guard let webView else { return }

        if let error {
            printError("Failed to compile content blocker rules: \(error.localizedDescription)")
            return
        }

        guard let ruleList else {
            printError("Failed to compile content blocker rules: no rule list returned")
            return
        }

        let controller = webView.configuration.userContentController

        if clearAll {
            controller.removeAllContentRuleLists()
        }

        controller.add(ruleList)

        if reload {
            webView.reload()
        }
    }

    GetIPCClient().send(
        IPCResponse(windowId: windowId, event: "addToContentBlocker-reply-\(windowId)", data: ["status": "success"])
    )

        case "isSwipeNavEnabled":
            guard let window = windows[windowId],
                  let webView = window.contentView as? WKWebView else {
                printError("isSwipeNavEnabled — webview not found for window \(windowId)")
                return
            }
            let enabled = webView.allowsBackForwardNavigationGestures
            AppDelegate.shared?.ipcClient.send(
                IPCResponse(windowId: windowId, event: "isSwipeNavEnabled-reply-\(windowId)", data: ["enabled": enabled ? "true" : "false"])
            )

       case "forward":
           guard let window = windows[windowId] else { return }
            (window.contentView as? WKWebView)?.goForward()

        case "back":
            guard let window = windows[windowId] else { return }
            (window.contentView as? WKWebView)?.goBack()    


            case "reload":
                guard let window = windows[windowId] else { return }
                (window.contentView as? WKWebView)?.reload()

                    case "capturePage":
                        guard let window = windows[windowId] else { return }
                        (window.contentView as? WKWebView)?.takeSnapshot(with: nil) { image, error in
                            if let error {
                                printError("Failed to capture page: \(error.localizedDescription)")
                                return
                            }
                            guard let image = image else {
                                printError("Failed to capture page: no image returned")
                                return
                            }

                            guard let tiffData = image.tiffRepresentation,
                                  let bitmap = NSBitmapImageRep(data: tiffData),
                                  let pngData = bitmap.representation(using: .png, properties: [:]) else {
                                printError("Failed to capture page: unable to convert image to PNG")
                                return
                            }

                            let base64PNG = pngData.base64EncodedString()
                            AppDelegate.shared?.ipcClient.send(
                                IPCResponse(windowId: windowId, event: "capture-page-result-\(windowId)", data: ["image": base64PNG])
                            )
                        }

    case "print":
        guard let window = windows[windowId] else { return }
        let printInfo = NSPrintInfo.shared
        printInfo.horizontalPagination = .automatic
        printInfo.verticalPagination = .automatic
        printInfo.isHorizontallyCentered = true
        printInfo.isVerticallyCentered = true

        let printOperation = NSPrintOperation(view: window.contentView!, printInfo: printInfo)
        printOperation.run()

    case "setUserAgent":
        guard let window = windows[windowId] else { return }
        guard let userAgent = args.first else {
            printError("setUserAgent — missing user agent string argument")
            return
        }
        (window.contentView as? WKWebView)?.customUserAgent = userAgent

    case "evaluateJS":
        guard let window = windows[windowId] else { return }
        guard let script = args.first else {
            printError("evaluateJS — missing script argument")
            return
        }
        (window.contentView as? WKWebView)?.evaluateJavaScript(script) { result, error in
            if let error {
                printError("evaluateJS failed: \(error)")
            }
            let resultStr: String
            if let result = result {
                if JSONSerialization.isValidJSONObject(result) {
                    if let data = try? JSONSerialization.data(withJSONObject: result),
                       let jsonStr = String(data: data, encoding: .utf8) {
                        resultStr = jsonStr
                    } else {
                        resultStr = "\"[Unserializable Result]\""
                    }
                } else {
                    resultStr = "\"\(String(describing: result))\""
                }
            } else {
                resultStr = "null"
            }
            AppDelegate.shared?.ipcClient.send(
                IPCResponse(windowId: windowId, event: "evaluateJS-reply-\(windowId)", data: ["result": resultStr])
            )
        }

    case "prompt":
        guard let window = windows[windowId] else { return }
        guard let message = args.first else {
            printError("prompt — missing message argument")
            return
        }
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")

        let inputField = NSTextField(frame: NSRect(x: 0, y: 0, width: 200, height: 24))
        alert.accessoryView = inputField

        if args.count > 1 {
            inputField.stringValue = args[1]
        }

        alert.beginSheetModal(for: window) { response in
            if response == .alertFirstButtonReturn {
                let userInput = inputField.stringValue
                AppDelegate.shared?.ipcClient.send(
                    IPCResponse(windowId: windowId, event: "prompt-reply-\(windowId)", data: ["input": userInput])
                )
            } else {
                AppDelegate.shared?.ipcClient.send(
                    IPCResponse(windowId: windowId, event: "prompt-reply-\(windowId)", data: ["input": ""])
                )
            }
        }

    case "confirm":
        guard let window = windows[windowId] else { return }
        guard let message = args.first else {
            printError("confirm — missing message argument")
            return
        }
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")

        alert.beginSheetModal(for: window) { response in
            let confirmed = (response == .alertFirstButtonReturn)
            AppDelegate.shared?.ipcClient.send(
                IPCResponse(windowId: windowId, event: "confirm-reply-\(windowId)", data: ["confirmed": confirmed ? "true" : "false"])
            )
        }

    case "isFocused":
        guard let window = windows[windowId] else { return }
        let isFocused = window.isKeyWindow
        AppDelegate.shared?.ipcClient.send(
            IPCResponse(windowId: windowId, event: "isFocused-reply-\(windowId)", data: ["isFocused": isFocused ? "true" : "false"])
        )

    case "emitToRenderer":
        guard let window = windows[windowId] else { return }
        guard args.count >= 2 else {
            printError("emitToRenderer — expected channel and payload arguments")
            return
        }
        let channel = args[0]
        let payload = args[1]
        let escaped = payload
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "`", with: "\\`")
        let script = "window.ipc._emit(`\(channel)`, JSON.parse(`\(escaped)`));"
        (window.contentView as? WKWebView)?.evaluateJavaScript(script) { _, error in
            if let error {
                printError("emitToRenderer failed: \(error.localizedDescription)")
            }
        }

        case "setAlwaysOnTop":
            guard let window = windows[windowId] else { return }
            guard let alwaysOnTopStr = args.first, let alwaysOnTop = Bool(alwaysOnTopStr) else {
                printError("setAlwaysOnTop — expected boolean argument")
                return
            }
            window.level = alwaysOnTop ? .floating : .normal

        case "setContextMenu":
            print("Setting context menu for window \(windowId)")
            guard let window = windows[windowId] else { return }
            guard let jsonStr = args.first,
                  let data    = jsonStr.data(using: .utf8),
                  let desc    = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]]
            else {
                printError("setContextMenu — invalid JSON descriptor")
                return
            }
            
            let menu = buildContextMenu(from: desc, windowId: windowId)
            
            DispatchQueue.main.async {
                if let view = window.contentView {
                    print("Attaching context menu to content view for window \(windowId)")
                    view.menu = menu
                } else {
                    printError("setContextMenu — no content view to attach menu")
                }
            }

        case "setMenu":
    guard let jsonStr = args.first,
          let data    = jsonStr.data(using: .utf8),
          let desc    = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]]
    else {
        printError("setMenu — invalid JSON descriptor")
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
            printError("Unknown command '\(command)' for window \(windowId)")
        }
    }
}

// MARK: - WebView Navigation Delegate

final class WebViewNavigationDelegate: NSObject, WKNavigationDelegate {
    let windowId: Int

    init(windowId: Int) {
        self.windowId = windowId
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        let isFile = webView.url?.isFileURL ?? false
        let eventName = isFile ? "loadFile-reply-\(windowId)" : "loadURL-reply-\(windowId)"
        AppDelegate.shared?.ipcClient.send(
            IPCResponse(windowId: windowId, event: eventName, data: [:])
        )
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
            printError("Received malformed IPC message from renderer: \(message.body)")
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
            try { fn(payload); } catch(e) { console.printError('[ipc] listener error:', e); }
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
    private let authToken: String
    private let serverURL: URL
    private var reconnectAttempts = 0
    private let maxReconnectAttempts = 10
    private let reconnectDelay: TimeInterval = 2.0

    init(serverURL: URL = URL(string: "ws://localhost:9000")!) {
        let POSITRON_IPC_PORT = port ?? 9000
        self.serverURL = URL(string: "ws://localhost:\(POSITRON_IPC_PORT)")!
        self.authToken = AUTH_TOKEN
    }

    func connect() {
        guard reconnectAttempts < maxReconnectAttempts else {
            printError("Exceeded maximum reconnect attempts (\(maxReconnectAttempts)). Giving up.")
            return
        }
        let session = URLSession(configuration: .default)
        var request = URLRequest(url: serverURL)
        request.setValue(authToken, forHTTPHeaderField: "X-Positron-Auth-Token")
        webSocketTask = session.webSocketTask(with: request)
        webSocketTask?.resume()
        printError("INFO: Connecting to IPC server (attempt \(reconnectAttempts + 1))…")
        reconnectAttempts = 0 // reset on successful connect
        receiveMessage()
    }

    func send(_ response: IPCResponse) {
        guard let data = try? JSONEncoder().encode(response),
              let text = String(data: data, encoding: .utf8) else {
            printError("Failed to encode IPCResponse")
            return
        }
        webSocketTask?.send(.string(text)) { error in
            if let error {
                printError("Failed to send IPC response: \(error.localizedDescription)")
            }
        }
    }

    private func receiveMessage() {
        webSocketTask?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let error):
                printError("WebSocket error: \(error.localizedDescription).")
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
                    printError("Received unknown WebSocket message type")
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
            printError("Failed to decode IPC message '\(text)': \(error)")
        }
    }

    private func scheduleReconnect() {
        reconnectAttempts += 1
        guard reconnectAttempts < maxReconnectAttempts else {
            printError("Exceeded maximum reconnect attempts (\(maxReconnectAttempts)). Giving up.")
            return
        }
        printError("Reconnecting to \(serverURL) in \(reconnectDelay)s… (attempt \(reconnectAttempts)/\(maxReconnectAttempts))")
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

        AppDelegate.shared = self
        
        if Bundle.main.bundlePath.hasSuffix(".app") {
            startNodeProcess()
        }  

        ipcClient = IPCClient()
        ipcClient.connect()

        setupDefaultMenu()
    }


    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard let windowId = windows.first(where: { $0.value == sender })?.key else {
            return true
        }
        self.ipcClient.send(
            IPCResponse(windowId: windowId, event: "window-close-requested", data: [:])
        )

        return false
    }

    func startNodeProcess() {
        guard let resourcePath = Bundle.main.resourcePath else { return }
        
        nodeProcess = Process()
        nodeProcess?.executableURL = URL(fileURLWithPath: "/bin/zsh")

        IS_PACKAGED = true
        
        var command = """
        export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
        export POSITRON_PACKAGED=true
        export POSITRON_AUTH_TOKEN="\(AUTH_TOKEN)"
        if [ -f "$HOME/.zshrc" ]; then source "$HOME/.zshrc"; fi
        if [ -f "$HOME/.bash_profile" ]; then source "$HOME/.bash_profile"; fi
        
        cd "\(resourcePath)"
        
        if [ -f "positron-backend" ]; then
            exec "./positron-backend"
        else
            exec "node" "."
        fi

        """

        if let port = port {
            command.insert(contentsOf: "export POSITRON_IPC_PORT=\(port); ", at: command.startIndex)
        } else {
            printError("WARNING: Failed to get random open port for IPC. Defaulting to 9000, which may cause conflicts.")
        }

        nodeProcess?.arguments = ["-c", command]
        
        let pipe = Pipe()
        nodeProcess?.standardOutput = pipe
        nodeProcess?.standardError = pipe
        
        pipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.count > 0, let str = String(data: data, encoding: .utf8) {
                print("[NODE BACKGROUND] \(str)", terminator: "")
            }
        }
        
        nodeProcess?.terminationHandler = { _ in
            printError("INFO: Node process terminated. Shutting down app.")
            NSApp.terminate(nil)
        }

        do {
            try nodeProcess?.run()
        } catch {
            printError("Failed to start Node process: \(error)")
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

    // Window menu
    let windowMenuItem = NSMenuItem()
    mainMenu.addItem(windowMenuItem)
    let windowMenu = NSMenu(title: "Window")
    windowMenuItem.submenu = windowMenu
    windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.miniaturize(_:)), keyEquivalent: "m")
    windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.zoom(_:)), keyEquivalent: "")
    NSApp.windowsMenu = windowMenu

    NSApp.mainMenu = mainMenu
}
}

/// Receives menu item clicks and forwards them to Node as IPC events.
final class MenuActionTarget: NSObject {
    let windowId: Int
    let channel: String   // arbitrary string the JS side chooses
    let payload: String   // JSON string forwarded verbatim
    let label: String?     // for debugging

    init(windowId: Int, channel: String, payload: String, label: String?) {
        self.windowId = windowId
        self.channel  = channel
        self.payload  = payload
        self.label = label
    }

    @objc func fire(_ sender: Any?) {
        AppDelegate.shared?.ipcClient.send(
            IPCResponse(
                windowId: windowId,
                event: "menu-action",
                data: ["channel": channel, "payload": payload, "label": label ?? "label"]
            )
        )
    }
}

// MARK: - Safe Menu Retention & Subclasses

final class PositronMenuItem: NSMenuItem {
    var retainedTarget: PositronMenuTarget? {
        didSet {
            self.target = retainedTarget
        }
    }
}

final class PositronMenuTarget: NSObject {
    let windowId: Int
    let channel: String
    let payload: String
    let label: String?
    let isContextMenu: Bool

    init(windowId: Int, channel: String, payload: String, label: String?, isContextMenu: Bool) {
        self.windowId = windowId
        self.channel  = channel
        self.payload  = payload
        self.label    = label
        self.isContextMenu = isContextMenu
    }

    @objc func fire(_ sender: Any?) {
        let eventName = isContextMenu ? "context-menu-action" : "menu-action"
        AppDelegate.shared?.ipcClient.send(
            IPCResponse(
                windowId: windowId,
                event: eventName,
                data: ["channel": channel, "payload": payload, "label": label ?? "label"]
            )
        )
    }
}

// MARK: - Menu Builders

func buildMenu(from descriptor: [[String: Any]], windowId: Int) -> NSMenu {
    let menu = NSMenu()
    for topLevel in descriptor {
        let topItem = NSMenuItem()
        topItem.title = topLevel["label"] as? String ?? ""
        menu.addItem(topItem)

        let sub = NSMenu(title: topItem.title)
        topItem.submenu = sub

        if let role = topLevel["role"] as? String, role.lowercased() == "window" {
            NSApp.windowsMenu = sub
        } else if topItem.title.lowercased() == "window" {
            NSApp.windowsMenu = sub
        }

        if let items = topLevel["items"] as? [[String: Any]] {
            populateMenu(sub, with: items, windowId: windowId, isContextMenu: false)
        }
    }
    return menu
}

func buildContextMenu(from descriptor: [[String: Any]], windowId: Int) -> NSMenu {
    let menu = NSMenu()
    populateMenu(menu, with: descriptor, windowId: windowId, isContextMenu: true)
    return menu
}

private func populateMenu(_ menu: NSMenu, with items: [[String: Any]], windowId: Int, isContextMenu: Bool) {
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

        let target = PositronMenuTarget(
            windowId: windowId, 
            channel: channel, 
            payload: payload, 
            label: label, 
            isContextMenu: isContextMenu
        )
        
        // Use our subclass to guarantee the action target lives exactly as long as the item itself
        let menuItem = PositronMenuItem(title: label, action: #selector(PositronMenuTarget.fire(_:)), keyEquivalent: key)
        menuItem.retainedTarget = target

        if enabled == false {
            menu.autoenablesItems = false
            menuItem.isEnabled = enabled
        }

        if let subItems = item["items"] as? [[String: Any]], !subItems.isEmpty {
            let sub = NSMenu(title: label)
            populateMenu(sub, with: subItems, windowId: windowId, isContextMenu: isContextMenu)
            menuItem.submenu = sub
        }

        menu.addItem(menuItem)
    }
}

setbuf(__stdoutp, nil)
setbuf(__stderrp, nil)

signal(SIGINT) { _ in
    printError("INFO: Received SIGINT, shutting down…")
    AppDelegate.shared?.nodeProcess?.terminate()
    exit(0)
}

signal(SIGTERM) { _ in
    printError("INFO: Received SIGTERM, shutting down…")
    AppDelegate.shared?.nodeProcess?.terminate()
    exit(0)
} 

signal(SIGSEGV) { _ in
    printError("ERROR: Caught SIGSEGV (segmentation fault). This likely indicates a bug in the native code. Attempting to shut down gracefully…")
    AppDelegate.shared?.nodeProcess?.terminate()
    signal(SIGSEGV, SIG_DFL)
    raise(SIGSEGV)
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
