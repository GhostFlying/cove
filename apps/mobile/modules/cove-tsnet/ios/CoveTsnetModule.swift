import ExpoModulesCore
import Foundation
import UIKit
import CoveTsnet

public class CoveTsnetModule: Module {
  private let ownership = NSRecursiveLock()
  private let controlQueue = DispatchQueue(label: "com.ghostflying.cove.tsnet.control")
  private let eventQueue = DispatchQueue(label: "com.ghostflying.cove.tsnet.events")
  private var client: CoveMobileClient?
  private var epoch: UInt64 = 0
  private var clientGeneration: UInt64 = 0
  private var stopped = true
  private var foreground = true
  private var entrySequence = 0
  private var entries: [Int: CoveMobileEntry] = [:]
  private var notifications: [NSObjectProtocol] = []

  private func locked<T>(_ body: () throws -> T) rethrows -> T {
    ownership.lock()
    defer { ownership.unlock() }
    return try body()
  }

  private func current(_ generation: UInt64) throws -> CoveMobileClient {
    try locked {
      guard generation == clientGeneration, !stopped, let owned = client else { throw nativeError() }
      return owned
    }
  }

  private func nativeError() -> NSError {
    NSError(domain: "CoveNative", code: 1, userInfo: [NSLocalizedDescriptionKey: "Native node operation failed"])
  }

  private func stopNative(_ generation: UInt64? = nil) {
    let owned = locked { () -> CoveMobileClient? in
      if let generation, generation != clientGeneration { return nil }
      epoch &+= 1
      stopped = true
      entries.removeAll()
      return client
    }
    owned?.stop()
  }

  private func perform(_ promise: Promise, _ body: @escaping () throws -> Any?) {
    controlQueue.async {
      do { promise.resolve(try body()) }
      catch { promise.reject("COVE_NATIVE", "Native node operation failed") }
    }
  }

  public func definition() -> ModuleDefinition {
    Name("CoveTsnet")

    OnCreate {
      self.notifications = [
        NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil) { [weak self] _ in
          self?.locked { self?.foreground = false }
          self?.stopNative()
        },
        NotificationCenter.default.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: nil) { [weak self] _ in
          self?.locked { self?.foreground = true }
        },
      ]
    }

    AsyncFunction("open") { (hostname: String, controlURL: String, promise: Promise) in
      self.perform(promise) {
        let opening: (UInt64, CoveMobileClient?) = try self.locked {
          guard self.foreground else { throw self.nativeError() }
          self.epoch &+= 1
          // Revoke the old generation before drain/construction, so a delayed
          // JS Stop for that node cannot cancel this already pending open.
          self.clientGeneration = self.epoch
          self.stopped = true
          let owned = self.client
          self.client = nil
          self.entries.removeAll()
          return (self.epoch, owned)
        }
        let observed = opening.0
        let previous = opening.1
        previous?.stop()
        previous?.close()
        var directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("cove-tsnet", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try directory.setResourceValues(values)
        var error: NSError?
        guard let created = CoveMobileNew(directory.path, hostname, controlURL, &error) else { throw self.nativeError() }
        let accepted = self.locked { () -> Bool in
          guard self.foreground && self.epoch == observed else { return false }
          self.client = created
          self.clientGeneration = observed
          self.stopped = false
          self.entrySequence = 0
          return true
        }
        guard accepted else { created.stop(); created.close(); throw self.nativeError() }
        return ["generation": observed, "status": try created.statusJSON()] as [String: Any]
      }
    }
    AsyncFunction("status") { (generation: UInt64, promise: Promise) in self.perform(promise) { try self.current(generation).statusJSON() } }
    AsyncFunction("login") { (generation: UInt64, authKey: String, promise: Promise) in self.perform(promise) { try self.current(generation).login(authKey) } }
    AsyncFunction("logout") { (generation: UInt64, promise: Promise) in self.perform(promise) { try self.current(generation).logout() } }
    AsyncFunction("close") { (generation: UInt64, promise: Promise) in
      let owned = self.locked { generation == self.clientGeneration ? self.client : nil }
      self.stopNative(generation)
      self.perform(promise) {
        owned?.close()
        self.locked { if self.client === owned { self.client = nil } }
        return nil
      }
    }
    AsyncFunction("nextEvent") { (generation: UInt64, timeout: Int, promise: Promise) in
      let owned = try self.current(generation)
      self.eventQueue.async {
        do { promise.resolve(try owned.nextEvent(timeout)) }
        catch { promise.reject("COVE_NATIVE_CLOSED", "Native event stream closed") }
      }
    }

    Function("stop") { (generation: UInt64) in self.stopNative(generation) }
    Function("openEntry") { (generation: UInt64, peerID: String, port: Int) -> Int in
      try self.locked {
        guard self.entries.count < 8, self.entrySequence < Int.max else { throw self.nativeError() }
        let entry: CoveMobileEntry? = try self.current(generation).openEntry(peerID, port: port)
        guard let entry else { throw self.nativeError() }
        self.entrySequence += 1
        self.entries[self.entrySequence] = entry
        return self.entrySequence
      }
    }
    Function("closeEntry") { (generation: UInt64, id: Int) in self.locked { generation == self.clientGeneration ? self.entries.removeValue(forKey: id) : nil }?.close() }
    Function("post") { (generation: UInt64, entryID: Int, id: Int64, path: String, headers: String, body: String, limit: Int) -> Bool in
      guard body.utf8.count <= 87384, headers.utf8.count <= 16384, let data = Data(base64Encoded: body),
        let entry = self.locked({ generation == self.clientGeneration && !self.stopped ? self.entries[entryID] : nil }) else { return false }
      do { try entry.post(id, path: path, headersJSON: headers, body: data, maxResponseBytes: limit); return true }
      catch { return false }
    }
    Function("openSocket") { (generation: UInt64, entryID: Int, id: Int64, path: String) -> Bool in
      guard let entry = self.locked({ generation == self.clientGeneration && !self.stopped ? self.entries[entryID] : nil }) else { return false }
      do { try entry.openSocket(id, path: path); return true }
      catch { return false }
    }
    Function("send") { (generation: UInt64, id: Int64, binary: Bool, body: String) -> String in
      guard body.utf8.count <= 349528, let data = Data(base64Encoded: body), let owned = try? self.current(generation) else { return "not-sent" }
      return owned.send(id, binary: binary, data: data)
    }
    Function("cancel") { (generation: UInt64, id: Int64) in self.locked { generation == self.clientGeneration ? self.client : nil }?.cancel(id) ?? "not-sent" }
    Function("release") { (generation: UInt64, id: Int64) in self.locked { generation == self.clientGeneration ? self.client : nil }?.release(id) }

    OnDestroy {
      self.locked { self.foreground = false }
      self.notifications.forEach { NotificationCenter.default.removeObserver($0) }
      self.notifications.removeAll()
      self.stopNative()
      let owned = self.locked { self.client }
      self.controlQueue.async { owned?.close() }
    }
  }
}
