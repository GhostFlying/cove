export function createDrainEpochTracker({ now, snapshot, onStart, onEnd }) {
  let current;
  let retiring;
  let lastDrained;
  let nextId = 0;
  let armed = false;
  const epochs = [];

  const beforeDrain = () => {
    if (!current) return;
    retiring = { epoch: current, tick: now() };
    current = undefined;
  };
  const afterDrain = () => {
    if (!retiring) return;
    const { epoch, tick } = retiring;
    retiring = undefined;
    epoch.after = snapshot();
    epoch.reblockedBy = current?.sampleId ?? null;
    onEnd(tick, epoch);
    lastDrained = epoch;
  };

  return {
    get current() {
      return current;
    },
    get lastDrained() {
      return lastDrained;
    },
    epochs,
    arm() {
      armed = true;
    },
    disarm() {
      armed = false;
    },
    noteWriteReturn(accepted, detail = {}) {
      const tick = now();
      if (!armed || accepted || current) return;
      const epoch = { sampleId: `epoch:${nextId++}`, ...detail, before: snapshot() };
      current = epoch;
      epochs.push(epoch);
      onStart(tick, epoch);
      queueMicrotask(() =>
        queueMicrotask(() => {
          epoch.blockedSnapshot = snapshot();
        }),
      );
    },
    attachBefore(writer) {
      writer.prependListener("drain", beforeDrain);
    },
    attachAfter(writer) {
      writer.on("drain", afterDrain);
    },
  };
}
