import Foundation
import OSLog

/// HTTP client for the the-brain daemon API (localhost:9420).
/// All network methods are nonisolated (safe to call from any context).

struct HealthResponse: Codable, Sendable {
    let status: String
    let pid: Int
    let uptime: Int
    let uptimeFormatted: String
    let activeProject: String
    let interactionCount: Int
    let mode: String?
}

struct StatsResponse: Codable, Sendable {
    let memories: MemoryStats
    let graphNodes: Int
    let lastConsolidation: Int?
    let lastTraining: Int?
    let lastTrainingDuration: Double?
    let lastTrainingLoss: Double?
    let interactionCount: Int
}

struct MemoryStats: Codable, Sendable {
    let total: Int
    let instant: Int
    let selection: Int
    let deep: Int
}

struct ActionResponse: Codable, Sendable {
    let consolidated: Bool?
    let trained: Bool?
    let error: String?
    let detail: String?
    let fragmentCount: Int?
    let duration: Double?
}

struct IngestFileResult: Codable, Sendable {
    let path: String
    let ingested: Bool
    let bytes: Int
    let error: String?
}

struct IngestResponse: Codable, Sendable {
    let ingested: Int?
    let total: Int?
    let results: [IngestFileResult]?
    let error: String?
    let detail: String?
}

@MainActor
final class DaemonClient: ObservableObject, @unchecked Sendable {
    private let baseURL: String
    private let authToken: String?

    init() {
        // Check for remote config via environment or local config
        if let remoteURL = ProcessInfo.processInfo.environment["THE_BRAIN_REMOTE_URL"] {
            self.baseURL = remoteURL.hasSuffix("/") ? String(remoteURL.dropLast()) : remoteURL
        } else {
            self.baseURL = "http://127.0.0.1:9420"
        }
        self.authToken = ProcessInfo.processInfo.environment["THE_BRAIN_AUTH_TOKEN"]
    }

    func fetchHealth() async -> HealthResponse? {
        await get("/api/health")
    }

    func fetchStats() async -> StatsResponse? {
        await get("/api/stats")
    }

    func consolidate() async -> ActionResponse? {
        await post("/api/consolidate")
    }

    func train() async -> ActionResponse? {
        await post("/api/train")
    }

    func ingestFiles(_ paths: [String]) async -> IngestResponse? {
        await post("/api/ingest-file", body: ["paths": paths])
    }

    // MARK: - Internal

    private nonisolated func get<T: Codable & Sendable>(_ path: String) async -> T? {
        guard let url = URL(string: "\(baseURL)\(path)") else { return nil }
        var request = URLRequest(url: url)
        if let token = authToken {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        do {
            let (data, _) = try await URLSession.shared.data(for: request)
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            os_log(.error, "the-brain GET %{public}@ failed: %{public}@", path, error.localizedDescription)
            return nil
        }
    }

    private nonisolated func post<T: Codable & Sendable>(_ path: String, body: Encodable? = nil) async -> T? {
        guard let url = URL(string: "\(baseURL)\(path)") else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token = authToken {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            // Safe: Encodable → JSON without force cast
            let encoder = JSONEncoder()
            request.httpBody = try? encoder.encode(body)
        }
        do {
            let (data, _) = try await URLSession.shared.data(for: request)
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            os_log(.error, "the-brain POST %{public}@ failed: %{public}@", path, error.localizedDescription)
            return nil
        }
    }
}
