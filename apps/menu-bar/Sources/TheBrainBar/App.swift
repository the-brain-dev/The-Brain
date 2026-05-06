import SwiftUI
import AppKit
import UniformTypeIdentifiers
import UserNotifications

/// Menu bar app entry point.
/// Creates an NSStatusItem with drag & drop support and a SwiftUI menu.
@main
struct TheBrainBarApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        Settings { EmptyView() }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, @unchecked Sendable {
    private var statusItem: NSStatusItem!
    private var daemon: DaemonClient!
    private var timer: Timer?
    private var host: NSHostingView<MenuBarView>?
    private var connected = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        daemon = DaemonClient()

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)

        // Create custom view with drag & drop support
        let dropView = DropStatusView(frame: NSRect(x: 0, y: 0, width: 40, height: 24))
        dropView.statusText = "🧠"
        dropView.onDrop = { [weak self] urls in
            await self?.handleDroppedFiles(urls)
        }
        statusItem.view = dropView

        // SwiftUI menu
        let menuView = MenuBarView(daemon: daemon)
        let hostingView = NSHostingView(rootView: menuView)
        hostingView.frame = NSRect(x: 0, y: 0, width: 300, height: 360)
        self.host = hostingView

        let menu = NSMenu()
        let item = NSMenuItem()
        item.view = hostingView
        menu.addItem(item)

        // Attach menu to status item (via the custom view's mouse handling)
        dropView.onClick = { [weak self] in
            guard let self else { return }
            self.statusItem.menu = menu
            self.statusItem.button?.performClick(nil)
            self.statusItem.menu = nil  // Reset so next click still works
        }

        // Poll health every 5 seconds
        timer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { [weak self] _ in
            guard let self else { return }
            Task { @MainActor in
                await self.pollHealth()
            }
        }

        Task { await pollHealth() }
    }

    func applicationWillTerminate(_ notification: Notification) {
        timer?.invalidate()
    }

    private func pollHealth() async {
        let health = await daemon.fetchHealth()
        let wasConnected = connected
        connected = health != nil

        if let dropView = statusItem.view as? DropStatusView {
            dropView.connected = connected
        }

        // Only recreate the view on connection state change, not every poll
        if let h = health, let view = host, wasConnected != connected {
            view.rootView = MenuBarView(daemon: daemon, health: h)
        }
    }

    private func handleDroppedFiles(_ urls: [URL]) async {
        let filePaths = urls.map { $0.path }

        // Visual feedback: briefly change icon
        if let dropView = statusItem.view as? DropStatusView {
            dropView.showIngestFeedback()
        }

        // Send to daemon
        guard let result = await daemon.ingestFiles(filePaths) else {
            return
        }

        // Show notification
        let count = result.ingested ?? 0
        let content = UNMutableNotificationContent()
        content.title = "the-brain"
        content.body = "Ingested \(count) of \(filePaths.count) file\(filePaths.count == 1 ? "" : "s")"
        let request = UNNotificationRequest(
            identifier: UUID().uuidString,
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request)
    }
}

/// Custom NSView for the menu bar that supports drag & drop of files.
final class DropStatusView: NSView {
    var statusText = "🧠"
    var connected = false
    var onDrop: (([URL]) async -> Void)?
    var onClick: (() -> Void)?

    private var isHighlighted = false
    private var feedbackTimer: Timer?

    override init(frame: NSRect) {
        super.init(frame: frame)
        // Register for file URL drags
        registerForDraggedTypes([.fileURL])
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) not implemented")
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)

        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 14),
        ]

        let text = isHighlighted ? "📥" : statusText
        let size = (text as NSString).size(withAttributes: attrs)

        let x = (bounds.width - size.width) / 2
        let y = (bounds.height - size.height) / 2

        (text as NSString).draw(at: NSPoint(x: x, y: y), withAttributes: attrs)

        if !connected {
            // Dim when daemon not reachable
            NSColor.white.withAlphaComponent(0.4).setFill()
        }
    }

    // MARK: - Drag & Drop

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        // Check if files are being dragged
        let pasteboard = sender.draggingPasteboard
        if let urls = pasteboard.readObjects(forClasses: [NSURL.self], options: nil) as? [URL],
           urls.count > 0 {
            isHighlighted = true
            needsDisplay = true
            return .copy
        }
        return []
    }

    override func draggingExited(_ sender: NSDraggingInfo?) {
        isHighlighted = false
        needsDisplay = true
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let pasteboard = sender.draggingPasteboard
        guard let urls = pasteboard.readObjects(forClasses: [NSURL.self], options: nil) as? [URL],
              urls.count > 0 else {
            return false
        }

        isHighlighted = false
        needsDisplay = true

        // Handle drop asynchronously
        Task { @MainActor in
            await onDrop?(urls)
        }

        return true
    }

    // MARK: - Click

    override func mouseDown(with event: NSEvent) {
        onClick?()
    }

    // MARK: - Feedback

    func showIngestFeedback() {
        statusText = "✅"
        needsDisplay = true
        feedbackTimer?.invalidate()
        feedbackTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: false) { [weak self] _ in
            Task { @MainActor in
                self?.statusText = "🧠"
                self?.needsDisplay = true
            }
        }
    }
}
