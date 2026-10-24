import { NativePairingFailure } from "./pairing.js";

/** Only app-authored messages and fixed protocol categories reach product UI. */
export class ActionError extends Error {}
export function actionMessage(error: unknown): string {
  if (error instanceof ActionError) return error.message;
  if (error instanceof NativePairingFailure)
    return `Pairing ${error.stage} failed (${error.redemptionDisposition}). Do not reuse the invitation; recover a saved slot or request a new invitation.`;
  return "Action could not be verified. Its effect may be unknown; inspect Operations before trying a new action.";
}
