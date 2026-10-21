// The open connections of each device (m2 D8): its terminal WebSockets and its HTTP requests in
// flight. A transport registers a connection in the same synchronous step in which it admitted the
// device's credential, and the revocation marks the device revoked and closes its connections in
// one synchronous step as well (auth/service.ts). JavaScript runs those steps one at a time, so a
// connection is either admitted before the revocation, and then registered and closed here, or
// admitted after it, and then refused DEVICE_REVOKED: none escapes both.

export type DeviceConnection = {
  // Closes the connection for revocation: a WebSocket with the policy close code, an HTTP request
  // by destroying its socket, which drops a response not sent yet. Must not throw.
  close(): void;
  // Resolves once the connection is physically closed.
  readonly closed: Promise<void>;
  // The principal object of the request, for an HTTP request: a device revoking itself keeps the
  // request that carries the revocation, so that it gets its answer.
  readonly owner?: object;
};

export class DeviceConnections {
  private readonly byDevice = new Map<string, Set<DeviceConnection>>();

  // Registers a connection until it closes; the returned function forgets it earlier.
  register(deviceId: string, connection: DeviceConnection): () => void {
    let set = this.byDevice.get(deviceId);
    if (!set) this.byDevice.set(deviceId, (set = new Set()));
    set.add(connection);
    const forget = (): void => {
      const current = this.byDevice.get(deviceId);
      if (!current?.delete(connection)) return;
      if (current.size === 0) this.byDevice.delete(deviceId);
    };
    void connection.closed.then(forget, forget);
    return forget;
  }

  count(deviceId: string): number {
    return this.byDevice.get(deviceId)?.size ?? 0;
  }

  // Closes every connection of the device but `except`'s, then waits up to `waitMs` for them to
  // close. The number still open when the wait ended: the revocation reports it rather than
  // claiming success (D8).
  async closeDevice(deviceId: string, waitMs: number, except?: object): Promise<number> {
    const targets = [...(this.byDevice.get(deviceId) ?? [])].filter(
      (connection) => except === undefined || connection.owner !== except,
    );
    for (const connection of targets) {
      try {
        connection.close();
      } catch {
        // A failed close request proves nothing; the wait below counts the connection.
      }
    }
    let open = targets.length;
    const settled = targets.map((connection) =>
      connection.closed.then(
        () => void open--,
        () => void open--,
      ),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(settled),
      new Promise<void>((done) => (timer = setTimeout(done, waitMs))),
    ]);
    clearTimeout(timer);
    return open;
  }
}
