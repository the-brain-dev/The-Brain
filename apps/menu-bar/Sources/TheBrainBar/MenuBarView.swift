import SwiftUI

/// Menu bar dropdown view showing brain status and quick actions.
struct MenuBarView: View {
    @ObservedObject var daemon: DaemonClient
    var health: HealthResponse?

    @State private var stats: StatsResponse?
    @State private var actionMessage: String?
    @State private var isLoading = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // ── Header ──────────────────────────────────
            HStack {
                Circle()
                    .fill(health != nil ? Color.green : Color.red)
                    .frame(width: 8, height: 8)
                Text("the-brain")
                    .font(.headline)
                Spacer()
                if let h = health {
                    Text("PID \(h.pid)")
                        .font(.caption)
                        .foregroundColor(.secondary)
                } else {
                    Text("Offline")
                        .font(.caption)
                        .foregroundColor(.red)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)

            Divider()

            // ── Stats ────────────────────────────────────
            if let s = stats {
                VStack(spacing: 6) {
                    StatRow(label: "Memories",
                            value: "\(s.memories.total) (I:\(s.memories.instant) S:\(s.memories.selection) D:\(s.memories.deep))")
                    StatRow(label: "Graph nodes", value: "\(s.graphNodes)")
                    StatRow(label: "Interactions", value: "\(s.interactionCount)")
                    if let last = s.lastTraining {
                        StatRow(label: "Last training", value: formatRelative(last))
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            } else if health != nil {
                HStack {
                    ProgressView()
                        .scaleEffect(0.7)
                    Text("Loading stats...")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            }

            if let msg = actionMessage {
                Text(msg)
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 4)
            }

            Divider()

            // ── Actions ──────────────────────────────────
            VStack(spacing: 0) {
                ActionButton(title: "🔄 Consolidate", disabled: isLoading) {
                    await runAction("Consolidating...") {
                        await daemon.consolidate()
                    }
                }
                .disabled(health == nil)

                ActionButton(title: "🏋️ Train LoRA", disabled: isLoading) {
                    await runAction("Training...") {
                        await daemon.train()
                    }
                }
                .disabled(health == nil || stats?.memories.deep == 0)

                ActionButton(title: "📊 Dashboard", disabled: isLoading) {
                    openDashboard()
                }
                .disabled(health == nil)

                ActionButton(title: "📖 Open Wiki", disabled: isLoading) {
                    openWiki()
                }
                .disabled(health == nil)

                ActionButton(title: "⏱️ Timeline", disabled: isLoading) {
                    if let url = URL(string: "http://localhost:9420/timeline") {
                        NSWorkspace.shared.open(url)
                    }
                }
                .disabled(health == nil)
            }

            Divider()

            // ── Quit ─────────────────────────────────────
            Button(action: { NSApplication.shared.terminate(nil) }) {
                HStack {
                    Text("Quit TheBrainBar")
                        .font(.caption)
                    Spacer()
                    Text("⌘Q")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            }
            .buttonStyle(.plain)
        }
        .frame(width: 290)
        .onAppear {
            Task { await loadStats() }
        }
    }

    // MARK: - Actions

    private func loadStats() async {
        stats = await daemon.fetchStats()
    }

    private func runAction(_ message: String, action: @escaping () async -> ActionResponse?) async {
        isLoading = true
        actionMessage = message
        let result = await action()
        if let r = result {
            if r.consolidated == true {
                actionMessage = "Consolidated ✓"
            } else if r.trained == true {
                actionMessage = "Trained \(r.fragmentCount ?? 0) fragments in \(String(format: "%.1f", r.duration ?? 0))s ✓"
            } else if let err = r.error {
                actionMessage = "Error: \(err)"
            } else {
                actionMessage = "Done ✓"
            }
        } else {
            actionMessage = "Daemon unreachable"
        }
        isLoading = false
        await loadStats()

        // Clear message after 4s
        try? await Task.sleep(nanoseconds: 4_000_000_000)
        actionMessage = nil
    }

    private func openDashboard() {
        let task = Process()
        task.launchPath = "/usr/bin/env"
        task.arguments = [
            "bun", "run",
            myBrainCLIPath(),
            "dashboard"
        ]
        try? task.run()
    }

    private func openWiki() {
        // Open in browser via the wiki serve command
        let task = Process()
        task.launchPath = "/usr/bin/env"
        task.arguments = [
            "bun", "run",
            myBrainCLIPath(),
            "wiki", "serve", "--port", "3333"
        ]
        try? task.run()

        // Give it a moment to start, then open browser
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
            if let url = URL(string: "http://localhost:3333") {
                NSWorkspace.shared.open(url)
            }
        }
    }

    private func formatRelative(_ timestamp: Int) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(timestamp) / 1000)
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}

// MARK: - Subviews

struct StatRow: View {
    let label: String
    let value: String

    var body: some View {
        HStack {
            Text(label)
                .font(.caption)
                .foregroundColor(.secondary)
            Spacer()
            Text(value)
                .font(.caption)
                .monospacedDigit()
        }
    }
}

struct ActionButton: View {
    let title: String
    var disabled: Bool = false
    let action: @MainActor () async -> Void

    var body: some View {
        Button(action: {
            Task { @MainActor in await action() }
        }) {
            HStack {
                Text(title)
                    .font(.caption)
                Spacer()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.4 : 1.0)
    }
}

// MARK: - Helpers

/// Resolve the path to the-brain CLI entry point.
/// Tries: THE_BRAIN_HOME env var, ~/Projects/Private/the-brain, ~/the-brain
private func myBrainCLIPath() -> String {
    if let env = ProcessInfo.processInfo.environment["THE_BRAIN_HOME"] {
        return env + "/apps/cli/src/index.ts"
    }
    let home = NSHomeDirectory()
    let candidates = [
        home + "/Projects/Private/the-brain",
        home + "/the-brain",
    ]
    for dir in candidates {
        let cliPath = dir + "/apps/cli/src/index.ts"
        if FileManager.default.fileExists(atPath: cliPath) {
            return cliPath
        }
    }
    // Fallback to default project location
    return home + "/Projects/Private/the-brain/apps/cli/src/index.ts"
}
