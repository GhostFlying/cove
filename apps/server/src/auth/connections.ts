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
  // For an HTTP request: the principal object of the request and a promise resolved once its
  // answer was sent (or the request ended without one). A device revoking itself closes its
  // connections only after the request carrying the revocation was answered (auth/service.ts).
  readonly owner?: object;
  readonly answered?: Promise<void>;
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

  // Resolves once the request of `owner` (an HTTP request's principal object) was answered;
  // at once when no such request is registered.
  answered(deviceId: string, owner: object): Promise<void> {
    for (const connection of this.byDevice.get(deviceId) ?? [])
      if (connection.owner === owner) return connection.answered ?? connection.closed;
    return Promise.resolve();
  }

  // Closes every connection of the device, then waits up to `waitMs` for them to close. The number
  // still open when the wait ended: the revocation reports it rather than claiming success (D8).
  async closeDevice(deviceId: string, waitMs: number): Promise<number> {
    const targets = [...(this.byDevice.get(deviceId) ?? [])];
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
