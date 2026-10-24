package com.ghostflying.cove

import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.system.Os
import com.ghostflying.cove.mobile.Client
import org.json.JSONArray
import org.json.JSONObject

// The SDK supplies real LinkProperties because app UIDs cannot enumerate Go's
// NETLINK_ROUTE on Android 30+. This class neither creates a VPN nor binds the
// process to a network; it observes the OS selection for one native generation.
internal class AndroidNetwork(
  private val manager: ConnectivityManager,
  private val current: () -> Client?,
) {
  private val callback = object : ConnectivityManager.NetworkCallback() {
    override fun onAvailable(network: Network) = refresh()
    override fun onLost(network: Network) = refresh()
    override fun onLinkPropertiesChanged(network: Network, properties: LinkProperties) = refresh()
    override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) = refresh()
  }

  fun start() { manager.registerDefaultNetworkCallback(callback) }

  fun close() {
    // Also covers a registration whose Binder response failed after effect.
    try { manager.unregisterNetworkCallback(callback) }
    catch (_: IllegalArgumentException) { }
  }

  private fun refresh() {
    val owned = current() ?: return
    try {
      val snapshot = snapshot(manager)
      if (current() === owned) owned.networkChanged(snapshot)
    } catch (_: Exception) {
      // Keeping an old interface view would pretend an unverified path is live.
      // Stop settles the bounded native stream; reconnection remains explicit.
      if (current() === owned) owned.stop()
    }
  }

  companion object {
    fun snapshot(manager: ConnectivityManager): String {
      try {
        val active = manager.activeNetwork
        val activeProperties = active?.let { manager.getLinkProperties(it) }
        val activeName = activeProperties?.interfaceName ?: ""
        val byName = linkedMapOf<String, Pair<LinkProperties, NetworkCapabilities>>()
        // Put the actual default network last so duplicate physical names use
        // its current LinkProperties, not a secondary network's older view.
        val networks = manager.allNetworks.filter { it != active } + listOfNotNull(active)
        check(networks.size <= 32)
        for (network in networks) {
          val properties = manager.getLinkProperties(network) ?: continue
          val capabilities = manager.getNetworkCapabilities(network) ?: continue
          val name = properties.interfaceName ?: continue
          check(name.isNotEmpty() && name.length <= 64)
          byName[name] = Pair(properties, capabilities)
        }
        check(byName.size <= 16)
        var addressCount = 0
        val interfaces = JSONArray()
        for ((name, state) in byName) {
          val (properties, capabilities) = state
          val index = Os.if_nametoindex(name)
          check(index > 0 && properties.mtu in 0..65535)
          check(properties.linkAddresses.size <= 32)
          val addresses = JSONArray()
          for (address in properties.linkAddresses) {
            addressCount += 1
            check(addressCount <= 128)
            val ip = address.address.hostAddress?.substringBefore('%') ?: error("No SDK address")
            addresses.put("$ip/${address.prefixLength}")
          }
          interfaces.put(JSONObject().put("name", name).put("index", index)
            .put("mtu", properties.mtu)
            .put("up", capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_SUSPENDED))
            .put("addresses", addresses))
        }
        check(activeName.isEmpty() || byName.containsKey(activeName))
        return JSONObject().put("defaultRoute", activeName).put("interfaces", interfaces).toString().also {
          check(it.toByteArray(Charsets.UTF_8).size <= 32768)
        }
      } catch (_: Exception) {
        // Only this fixed diagnostic is eligible for the control-error mapper.
        throw IllegalStateException("native netmon SDK snapshot unavailable")
      }
    }
  }
}
