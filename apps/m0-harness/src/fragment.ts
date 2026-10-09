export interface ConnectionInfo {
  readonly endpoint: string;
  readonly serverId: string;
  readonly instance: string;
  readonly secret: string;
  readonly cwd: string;
  readonly shell: string;
}

const FIELDS = ["endpoint", "serverId", "instance", "secret", "cwd", "shell"] as const;

// Connection details travel in the URL fragment, which browsers never send to a server.
// The fragment is dropped from the address bar and the current history entry as soon as it
// has been read, before anything can fail, so the secret does not linger in the visible URL
// or session history. The page therefore cannot be reloaded; open the printed URL again.
export function takeConnectionInfo(
  location: Pick<Location, "hash" | "pathname" | "search">,
  history: Pick<History, "replaceState" | "state">,
): ConnectionInfo | string {
  const params = new URLSearchParams(location.hash.slice(1));
  if (location.hash) history.replaceState(history.state, "", location.pathname + location.search);
  const missing = FIELDS.filter((field) => !params.get(field));
  if (missing.length)
    return (
      `This page needs the connection URL printed by \`cove server start --harness\` ` +
      `(missing: ${missing.join(", ")}).`
    );
  const value = (field: (typeof FIELDS)[number]) => params.get(field)!;
  return {
    endpoint: value("endpoint"),
    serverId: value("serverId"),
    instance: value("instance"),
    secret: value("secret"),
    cwd: value("cwd"),
    shell: value("shell"),
  };
}

export type RendererChoice = "webgl" | "dom";

// The renderer choice is not secret, so it travels in the query string, which survives the
// fragment removal above. Without it the view picks its own default, so the URL printed by
// `cove server start --harness` needs no renderer parameter.
export function readRendererChoice(
  location: Pick<Location, "search">,
): { renderer?: RendererChoice } | string {
  const value = new URLSearchParams(location.search).get("renderer");
  if (value === null) return {};
  if (value === "webgl" || value === "dom") return { renderer: value };
  return `Unknown renderer "${value}"; use renderer=webgl, renderer=dom or omit it.`;
}
