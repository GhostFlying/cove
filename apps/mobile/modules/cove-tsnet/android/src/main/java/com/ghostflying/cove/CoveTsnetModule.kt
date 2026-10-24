package com.ghostflying.cove

import android.util.Base64
import android.net.ConnectivityManager
import com.ghostflying.cove.mobile.Client
import com.ghostflying.cove.mobile.Entry
import com.ghostflying.cove.mobile.Mobile
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import go.Seq
import java.io.File
import java.util.concurrent.Executors
import org.json.JSONObject

class CoveTsnetModule : Module() {
  private val ownership = Any()
  private val controlQueue = Executors.newSingleThreadExecutor()
  private val eventQueue = Executors.newSingleThreadExecutor()
  private var client: Client? = null
  private var networkMonitor: AndroidNetwork? = null
  private var epoch = 0L
  private var clientGeneration = 0L
  private var stopped = true
  private var foreground = true
  private var entrySequence = 0
  private val entries = mutableMapOf<Int, Entry>()

  private fun current(generation: Long): Client = synchronized(ownership) {
    check(!stopped && generation == clientGeneration) { "Native node generation expired" }
    client ?: throw IllegalStateException("Native node is closed")
  }

  private fun stopNative(generation: Long? = null) {
    val owned = synchronized(ownership) {
      if (generation != null && generation != clientGeneration) return
      epoch += 1
      stopped = true
      entries.clear()
      client
    }
    owned?.stop()
  }

  // Neither executor blocks the JS thread. The pull has its own queue so it
  // cannot prevent login/close from running; Stop wakes both Go contexts.
  private fun async(promise: Promise, body: () -> Any?) {
    controlQueue.execute {
      try { promise.resolve(body()) }
      catch (error: Exception) {
        // The Go classifier returns constants only, never the original message,
        // auth key, URL or remote body. A rejection still leaves effects unknown.
        val failure = JSONObject(Mobile.controlFailureJSON((error.message ?: "").take(4096)))
        promise.reject(failure.getString("code"), failure.getString("reason"), null)
      }
    }
  }

  override fun definition() = ModuleDefinition {
    Name("CoveTsnet")

    AsyncFunction("open") { hostname: String, controlURL: String, promise: Promise ->
      async(promise) {
        val opening = synchronized(ownership) {
          check(foreground) { "Application is backgrounded" }
          epoch += 1
          // Revoke the old generation before draining/constructing. A delayed
          // JS Stop for that old node must not invalidate this pending open.
          clientGeneration = epoch
          stopped = true
          val previous = client
          client = null
          entries.clear()
          Triple(epoch, previous, networkMonitor.also { networkMonitor = null })
        }
        val observed = opening.first
        val previous = opening.second
        previous?.stop()
        try { opening.third?.close() } finally { previous?.close() }
        val context = appContext.reactContext ?: error("Application context unavailable")
        Seq.setContext(context.applicationContext)
        val state = File(context.noBackupFilesDir, "cove-tsnet")
        val manager = context.getSystemService(ConnectivityManager::class.java)
          ?: error("native netmon SDK service unavailable")
        Mobile.setAndroidNetworkInterfaces(AndroidNetwork.snapshot(manager))
        val created = Mobile.new_(state.absolutePath, hostname, controlURL)
        val network = AndroidNetwork(manager) {
          synchronized(ownership) {
            if (foreground && !stopped && clientGeneration == observed && client === created) created else null
          }
        }
        try {
          network.start()
          // Refresh after registration closes the initial snapshot/subscription
          // gap. Later callbacks are bound to this exact client and generation.
          created.networkChanged(AndroidNetwork.snapshot(manager))
          val accepted = synchronized(ownership) {
            if (!foreground || epoch != observed) false
            else {
              client = created
              networkMonitor = network
              clientGeneration = observed
              stopped = false
              entrySequence = 0
              true
            }
          }
          check(accepted) { "Native node open was cancelled" }
          mapOf("generation" to observed, "status" to created.statusJSON())
        } catch (error: Exception) {
          stopNative(observed)
          synchronized(ownership) {
            if (client === created) client = null
            if (networkMonitor === network) networkMonitor = null
          }
          try { network.close() } finally { created.close() }
          throw error
        }
      }
    }
    AsyncFunction("status") { generation: Long, promise: Promise -> async(promise) { current(generation).statusJSON() } }
    AsyncFunction("login") { generation: Long, authKey: String, promise: Promise -> async(promise) { current(generation).login(authKey) } }
    AsyncFunction("logout") { generation: Long, promise: Promise -> async(promise) { current(generation).logout() } }
    AsyncFunction("close") { generation: Long, promise: Promise ->
      val owned = synchronized(ownership) { if (generation == clientGeneration) Pair(client, networkMonitor.also { networkMonitor = null }) else Pair(null, null) }
      stopNative(generation)
      async(promise) {
        try {
          try { owned.second?.close() } finally { owned.first?.close() }
        } finally {
          synchronized(ownership) { if (client === owned.first) client = null }
        }
        null
      }
    }
    AsyncFunction("nextEvent") { generation: Long, timeout: Long, promise: Promise ->
      val owned = current(generation)
      eventQueue.execute {
        try { promise.resolve(owned.nextEvent(timeout)) }
        catch (_: Exception) { promise.reject("COVE_NATIVE_CLOSED", "Native event stream closed", null) }
      }
    }

    Function("stop") { generation: Long -> stopNative(generation) }
    Function("openEntry") { generation: Long, peerID: String, port: Int -> synchronized(ownership) {
      check(entries.size < 8 && entrySequence < Int.MAX_VALUE) { "Native entry capacity" }
      val entry = current(generation).openEntry(peerID, port.toLong())
      val id = ++entrySequence
      entries[id] = entry
      id
    } }
    Function("closeEntry") { generation: Long, id: Int -> synchronized(ownership) { if (generation == clientGeneration) entries.remove(id) else null }?.close() }
    Function("post") { generation: Long, entryID: Int, id: Long, path: String, headers: String, body: String, limit: Int ->
      if (body.length > 87384 || headers.length > 16384) false
      else try {
        val entry = synchronized(ownership) { if (!stopped && generation == clientGeneration) entries[entryID] else null }
        if (entry == null) false
        else { entry.post(id, path, headers, Base64.decode(body, Base64.DEFAULT), limit.toLong()); true }
      } catch (_: Exception) { false }
    }
    Function("openSocket") { generation: Long, entryID: Int, id: Long, path: String ->
      try {
        val entry = synchronized(ownership) { if (!stopped && generation == clientGeneration) entries[entryID] else null }
        if (entry == null) false else { entry.openSocket(id, path); true }
      } catch (_: Exception) { false }
    }
    Function("send") { generation: Long, id: Long, binary: Boolean, body: String ->
      if (body.length > 349528) "not-sent"
      else try { current(generation).send(id, binary, Base64.decode(body, Base64.DEFAULT)) }
      catch (_: IllegalArgumentException) { "not-sent" }
      catch (_: IllegalStateException) { "not-sent" }
    }
    Function("cancel") { generation: Long, id: Long -> synchronized(ownership) { if (generation == clientGeneration) client else null }?.cancel(id) ?: "not-sent" }
    Function("release") { generation: Long, id: Long -> synchronized(ownership) { if (generation == clientGeneration) client else null }?.release(id) }

    OnActivityEntersBackground {
      synchronized(ownership) { foreground = false }
      stopNative()
    }
    OnActivityEntersForeground { synchronized(ownership) { foreground = true } }
    OnDestroy {
      synchronized(ownership) { foreground = false }
      stopNative()
      val owned = synchronized(ownership) { Pair(client.also { client = null }, networkMonitor.also { networkMonitor = null }) }
      controlQueue.execute { try { owned.second?.close() } finally { owned.first?.close() } }
      controlQueue.shutdown()
      eventQueue.shutdown()
    }
  }
}
