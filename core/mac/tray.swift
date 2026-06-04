import Cocoa

class TrayManager {
    static let shared = TrayManager()
    var statusItem: NSStatusItem?

    func setupTray() {
        if statusItem == nil {
            statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
            if let button = statusItem?.button {
                button.title = "App"
            }
        }
    }

    func setMenu(_ menu: NSMenu) {
        statusItem?.menu = menu
    }

    func setTitle(_ title: String) {
        statusItem?.button?.title = title
    }

    func setIcon(_ iconPath: String) {
        guard let button = statusItem?.button else { return printError("Tray button not initialized") }

        if iconPath.isEmpty {
            DispatchQueue.main.async {
                button.image = nil
                button.imagePosition = .imageLeft
            }
            return
        }

        guard FileManager.default.fileExists(atPath: iconPath) else {
            printError("Icon path does not exist: \(iconPath)")
            return
        }

        DispatchQueue.main.async {
            if let img = NSImage(contentsOfFile: iconPath) {
                img.size = NSSize(width: 18, height: 18)
                img.isTemplate = true
                button.image = img
                button.imagePosition = .imageLeft
            } else {
                button.image = nil
                button.imagePosition = .imageLeft
            }
        }
    }
}

public struct TrayExtension {    
    public static func handle(windowId: Int, args: [String]) {

        if(args.last == "setTitle") {
            TrayManager.shared.setTitle(args[0])
            return
        }

        if(args.last == "setIcon") {
            TrayManager.shared.setIcon(args[0])
            return
        }

        guard let descString = args.first,
              let data = descString.data(using: .utf8),
              let desc = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            printError("tray setMenu — invalid JSON descriptor")
            return
        }

        if args.last == "setMenu" {
             TrayManager.shared.setMenu(buildContextMenu(from: desc, windowId: windowId))
             return
        }

        DispatchQueue.main.async {

            TrayManager.shared.setupTray()

            let title = args.count > 1 ? args[1] : ""
            TrayManager.shared.setTitle(title)

            let imagePath = args.count > 2 ? args[2] : nil
            if let imagePath = imagePath {
                TrayManager.shared.setIcon(imagePath)
            }

            let menu = buildContextMenu(from: desc, windowId: windowId)
            TrayManager.shared.setMenu(menu)
        }
    }
}
