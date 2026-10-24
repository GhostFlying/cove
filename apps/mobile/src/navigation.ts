import type { RunRef } from "@cove/protocol/identity";

export type Route =
  | { screen: "servers" }
  | { screen: "server"; profileId: string }
  | { screen: "task"; profileId: string; taskId: string }
  | { screen: "terminal"; profileId: string; tabId: string; run: RunRef }
  | { screen: "operations"; profileId: string }
  | { screen: "devices"; profileId: string };

// Purely local navigation. No business event, instance restart or transport reconnect calls it.
export function parentRoute(route: Route): Route {
  return route.screen === "servers" || route.screen === "server"
    ? { screen: "servers" }
    : { screen: "server", profileId: route.profileId };
}
