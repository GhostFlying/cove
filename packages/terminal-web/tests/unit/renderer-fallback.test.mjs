import { expect, test } from "vitest";
import { RendererFallback, WEBGL_RETRY_DELAY_MS } from "../../dist/src/xterm-renderer.js";

// Fake addons and timers drive the per-view fallback state machine without a GPU. The browser
// harness test covers the same transitions with the real WebGL addon.
function rig({ preferred = "webgl", failLoads = 0, onChange } = {}) {
  const log = [];
  const addons = [];
  const timers = [];
  let loadsToFail = failLoads;
  const changes = [];
  const renderers = new RendererFallback(
    preferred,
    {
      createAddon() {
        const addon = { id: addons.length, lossListeners: new Set(), disposed: false };
        addons.push(addon);
        return addon;
      },
      loadAddon(terminal, addon) {
        if (loadsToFail > 0) {
          loadsToFail--;
          log.push(`load-fail ${terminal.name} ${addon.id}`);
          throw new Error("WebGL2 not supported");
        }
        log.push(`load ${terminal.name} ${addon.id}`);
      },
      onContextLoss(addon, listener) {
        addon.lossListeners.add(listener);
        return { dispose: () => addon.lossListeners.delete(listener) };
      },
      clearTextureAtlas(addon) {
        log.push(`atlas ${addon.id}`);
      },
      disposeAddon(addon) {
        addon.disposed = true;
        log.push(`dispose ${addon.id}`);
      },
      refresh(terminal) {
        log.push(`refresh ${terminal.name}`);
      },
      setTimer(callback, delayMs) {
        const timer = { callback, delayMs, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimer(timer) {
        timer.cleared = true;
      },
    },
    (renderer) => {
      changes.push(renderer);
      onChange?.(renderer, renderers);
    },
  );
  const loseContext = (addon) => {
    for (const listener of [...addon.lossListeners]) listener();
  };
  const fireTimers = () => {
    for (const timer of timers.splice(0)) if (!timer.cleared) timer.callback();
  };
  const failNextLoad = () => loadsToFail++;
  return { renderers, log, addons, timers, changes, loseContext, fireTimers, failNextLoad };
}

const terminal = (name) => ({ name });

test("an explicit DOM preference never creates an addon", () => {
  const { renderers, addons, changes } = rig({ preferred: "dom" });
  renderers.attach(terminal("a"));
  renderers.attach(terminal("b"));
  expect(renderers.active).toBe("dom");
  expect(addons).toEqual([]);
  expect(changes).toEqual([]);
});

test("a WebGL load failure falls back to DOM and is not retried for later terminals", () => {
  const { renderers, log, addons, timers, changes } = rig({ failLoads: 1 });
  const first = terminal("a");
  renderers.attach(first);
  expect(renderers.active).toBe("dom");
  expect(addons[0].disposed).toBe(true);
  expect(addons[0].lossListeners.size).toBe(0);
  expect(log).toEqual(["load-fail a 0", "dispose 0", "refresh a"]);
  expect(timers).toEqual([]);
  renderers.detach(first);
  renderers.attach(terminal("b"));
  expect(addons).toHaveLength(1);
  expect(renderers.active).toBe("dom");
  expect(changes).toEqual([]);
});

test("a first context loss falls back to DOM and one delayed retry restores WebGL", () => {
  const { renderers, log, addons, timers, changes, loseContext, fireTimers } = rig();
  renderers.attach(terminal("a"));
  expect(renderers.active).toBe("webgl");
  log.length = 0;
  loseContext(addons[0]);
  expect(renderers.active).toBe("dom");
  expect(addons[0].disposed).toBe(true);
  expect(log).toEqual(["dispose 0", "refresh a"]);
  expect(timers.map((timer) => timer.delayMs)).toEqual([WEBGL_RETRY_DELAY_MS]);
  fireTimers();
  expect(renderers.active).toBe("webgl");
  expect(log.slice(2)).toEqual(["load a 1", "refresh a"]);
  expect(changes).toEqual(["webgl", "dom", "webgl"]);
});

test("a second context loss stays on DOM for the life of the view", () => {
  const { renderers, addons, timers, changes, loseContext, fireTimers } = rig();
  const first = terminal("a");
  renderers.attach(first);
  loseContext(addons[0]);
  fireTimers();
  loseContext(addons[1]);
  expect(renderers.active).toBe("dom");
  expect(addons[1].disposed).toBe(true);
  expect(timers).toEqual([]);
  // A rebuilt xterm for a later baseline does not reopen WebGL.
  renderers.detach(first);
  renderers.attach(terminal("b"));
  expect(addons).toHaveLength(2);
  expect(renderers.active).toBe("dom");
  expect(changes).toEqual(["webgl", "dom", "webgl", "dom"]);
});

test("a failed retry load stays on DOM", () => {
  const { renderers, addons, timers, changes, loseContext, fireTimers, failNextLoad } = rig();
  const first = terminal("a");
  renderers.attach(first);
  loseContext(addons[0]);
  failNextLoad();
  fireTimers();
  expect(renderers.active).toBe("dom");
  expect(addons[1].disposed).toBe(true);
  expect(timers).toEqual([]);
  renderers.detach(first);
  renderers.attach(terminal("b"));
  expect(addons).toHaveLength(2);
  expect(changes).toEqual(["webgl", "dom"]);
});

test("a retry pending across a rebuild upgrades the successor terminal only", () => {
  const { renderers, log, addons, loseContext, fireTimers } = rig();
  const first = terminal("a");
  renderers.attach(first);
  loseContext(addons[0]);
  renderers.detach(first);
  const second = terminal("b");
  renderers.attach(second);
  // The successor waits for the scheduled retry instead of spending it immediately.
  expect(addons).toHaveLength(1);
  expect(renderers.active).toBe("dom");
  fireTimers();
  expect(log.at(-2)).toBe("load b 1");
  expect(renderers.active).toBe("webgl");
});

test("a loss from a retired addon is ignored", () => {
  const { renderers, addons, timers, loseContext } = rig();
  const first = terminal("a");
  renderers.attach(first);
  const retired = addons[0];
  const listeners = [...retired.lossListeners];
  renderers.detach(first);
  renderers.attach(terminal("b"));
  expect(retired.lossListeners.size).toBe(0);
  for (const listener of listeners) listener();
  expect(renderers.active).toBe("webgl");
  expect(timers).toEqual([]);
  loseContext(addons[1]);
  expect(timers).toHaveLength(1);
});

test("reveal rebuilds the glyph atlas only while WebGL is loaded", () => {
  const { renderers, log, addons, loseContext } = rig();
  renderers.attach(terminal("a"));
  renderers.reveal();
  expect(log.at(-1)).toBe("atlas 0");
  loseContext(addons[0]);
  log.length = 0;
  renderers.reveal();
  expect(log).toEqual([]);
});

test("dispose releases the addon and cancels a pending retry", () => {
  const loaded = rig();
  loaded.renderers.attach(terminal("a"));
  loaded.renderers.dispose();
  expect(loaded.addons[0].disposed).toBe(true);
  expect(loaded.renderers.active).toBe("dom");

  const pending = rig();
  pending.renderers.attach(terminal("a"));
  pending.loseContext(pending.addons[0]);
  const [timer] = pending.timers;
  pending.renderers.dispose();
  expect(timer.cleared).toBe(true);
  timer.callback();
  expect(pending.addons).toHaveLength(1);
  pending.renderers.attach(terminal("b"));
  expect(pending.addons).toHaveLength(1);
  expect(pending.changes).toEqual(["webgl", "dom"]);
});

test("throwing addon and terminal calls still degrade to DOM", () => {
  const changes = [];
  const renderers = new RendererFallback(
    "webgl",
    {
      createAddon: () => {
        throw new Error("no canvas");
      },
      loadAddon: () => {},
      onContextLoss: () => ({ dispose() {} }),
      clearTextureAtlas: () => {},
      disposeAddon: () => {
        throw new Error("unexpected");
      },
      refresh: () => {
        throw new Error("disposed");
      },
      setTimer: () => 0,
      clearTimer: () => {},
    },
    (renderer) => changes.push(renderer),
  );
  expect(() => renderers.attach(terminal("a"))).not.toThrow();
  expect(renderers.active).toBe("dom");
  expect(changes).toEqual([]);
});

test("a listener that disposes on the loss notification leaves no retry timer behind", () => {
  const { renderers, addons, timers, changes, loseContext } = rig({
    onChange: (renderer, owner) => {
      if (renderer === "dom") owner.dispose();
    },
  });
  renderers.attach(terminal("a"));
  loseContext(addons[0]);
  expect(changes).toEqual(["webgl", "dom"]);
  expect(timers.filter((timer) => !timer.cleared)).toEqual([]);
  expect(addons).toHaveLength(1);
});
