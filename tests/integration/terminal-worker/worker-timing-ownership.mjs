export function createObservedSubmit({ submit, now, makeId, describeBytes, onStart, onTerminal }) {
  const records = [];
  const terminal = (tick, record, phase, detail, outcome) => {
    record.terminal = { phase, tick: tick.toString(), outcome: outcome ?? null, detail };
    onTerminal(tick, record, phase, detail, outcome);
  };
  const invoke = (bytes, callback) => {
    const record = {
      sampleId: makeId(records.length),
      length: bytes.length,
      ...describeBytes(bytes),
      lateSettlements: [],
    };
    records.push(record);
    onStart(now(), record);
    let admission;
    try {
      admission = submit(bytes, (settled) => {
        const tick = now();
        if (record.terminal)
          record.lateSettlements.push({ tick: tick.toString(), settlement: settled });
        else {
          const written = settled.kind === "written" && settled.writtenBytes === record.length;
          terminal(
            tick,
            record,
            written ? "end" : "outcome",
            { settlement: settled },
            written ? undefined : "settlement-unknown",
          );
        }
        callback(settled);
      });
    } catch (error) {
      record.admissionReturnTick = now().toString();
      terminal(now(), record, "outcome", { error: String(error) }, "native-submit-threw");
      throw error;
    }
    const returnTick = now();
    record.admission = admission;
    record.admissionReturnTick = returnTick.toString();
    if (admission.kind !== "accepted" && !record.terminal)
      terminal(returnTick, record, "outcome", { admission }, `admission-${admission.kind}`);
    return admission;
  };
  const observePublicResult = (record, result) => {
    if (!record) return;
    const tick = now();
    record.publicResult = result;
    record.publicResultTick = tick.toString();
    if (record.admission?.kind === "accepted" && !record.terminal)
      terminal(
        tick,
        record,
        "outcome",
        { admission: record.admission, publicResult: result },
        "public-result-without-native-settlement",
      );
  };
  return { invoke, records, observePublicResult };
}

export function createObservedShutdown({
  shutdown,
  now,
  onStart,
  onReturn,
  onTerminal,
  ownerFacts,
}) {
  let attempted = false;
  let result;
  return {
    get attempted() {
      return attempted;
    },
    get result() {
      return result;
    },
    async run(reason) {
      if (attempted) throw Error("observed shutdown may be invoked only once");
      attempted = true;
      onStart(now(), { reason });
      let promise;
      try {
        promise = shutdown(reason);
      } catch (error) {
        const tick = now();
        onReturn(tick, { kind: "threw", error: String(error) });
        onTerminal(tick, "outcome", { error: String(error) }, "shutdown-threw");
        throw error;
      }
      onReturn(now(), { kind: "promise-returned" });
      let receipts;
      try {
        receipts = await promise;
      } catch (error) {
        onTerminal(now(), "outcome", { error: String(error) }, "shutdown-rejected");
        throw error;
      }
      let facts;
      try {
        facts = ownerFacts();
      } catch (error) {
        onTerminal(
          now(),
          "outcome",
          { receipts, error: String(error) },
          "owner-observation-failed",
        );
        throw error;
      }
      const receipt = receipts?.length === 1 ? receipts[0] : undefined;
      if (
        receipt?.ownershipEvidence === "closure-proven" &&
        receipt.writer?.kind === "closed" &&
        receipt.leader?.kind === "exit-observed" &&
        typeof facts.observerExitTick === "bigint" &&
        typeof facts.writerCloseTick === "bigint" &&
        facts.owners === 0
      ) {
        const later =
          facts.observerExitTick > facts.writerCloseTick
            ? facts.observerExitTick
            : facts.writerCloseTick;
        result = { kind: "closure-proven", receipts, facts };
        onTerminal(later, "end", {
          receipt,
          observerExitTick: facts.observerExitTick.toString(),
          writerCloseTick: facts.writerCloseTick.toString(),
          owners: facts.owners,
        });
      } else {
        result = { kind: "closure-uncertain", receipts, facts };
        onTerminal(
          now(),
          "outcome",
          {
            receipts,
            observerExitTick: facts.observerExitTick?.toString(),
            writerCloseTick: facts.writerCloseTick?.toString(),
            owners: facts.owners,
          },
          "closure-uncertain",
        );
      }
      return receipts;
    },
  };
}
