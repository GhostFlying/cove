function causalError(primary, secondary) {
  const causes = [...(primary ? [primary] : []), ...secondary];
  if (causes.length < 2) return causes[0];
  return new AggregateError(causes, "timing fixture finalization failed");
}

export function finalizeTimingRun({ primary, preserveEvidence, cleanupDelivery }) {
  const secondary = [];
  try {
    preserveEvidence();
  } catch (error) {
    secondary.push(error);
  }
  try {
    cleanupDelivery();
  } catch (error) {
    secondary.push(error);
  }
  return causalError(primary, secondary);
}

export function finalizeTimingCycle({ primary, preserveEvidence, cleanupDirectory }) {
  const secondary = [];
  try {
    preserveEvidence();
  } catch (error) {
    secondary.push(error);
  }
  // A failed receipt keeps the task directory, but never blocks owned cleanup elsewhere.
  if (!primary && secondary.length === 0) {
    try {
      cleanupDirectory();
    } catch (error) {
      secondary.push(error);
    }
  }
  return causalError(primary, secondary);
}
