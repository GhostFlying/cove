import { expect, test } from "vitest";
import {
  queryBytes,
  expectedLiveReplies,
} from "../../../tests/fixtures/terminal/engine/recovery-cases.mjs";
import { model, output, appearance, control, holder, utf8, string } from "./driver.mjs";

const collected = () => {
  const replies = [];
  return {
    replies,
    engine: model({
      onAutomaticOutput: (item) =>
        replies.push({
          ...item,
          bytes: item.bytes.slice(),
          text: string(item.bytes),
        }),
    }),
  };
};

test("Q01 nine advertised query families emit exact authoritative bytes", async () => {
  const { engine, replies } = collected();
  try {
    let seq = 0;
    for (const [id, input] of Object.entries(queryBytes)) {
      expect((await engine.apply(output(++seq), input)).ok).toBe(true);
      expect(replies.at(-1).bytes).toEqual(expectedLiveReplies[id]);
      expect(replies.at(-1).atSeq).toBe(seq);
      expect(replies.at(-1).kind).toBe("query");
    }
    expect(replies).toHaveLength(9);
  } finally {
    engine.dispose();
  }
});

test("Q02 capture and barrier never reissue a live query", async () => {
  const { engine, replies } = collected();
  try {
    await engine.captureBaseline();
    await engine.capturePreview();
    await engine.apply(output(1), utf8("\u001b[5n"));
    await engine.barrier();
    await engine.captureBaseline();
    await engine.capturePreview();
    expect(replies.map(({ text }) => text)).toEqual(["\u001b[0n"]);
  } finally {
    engine.dispose();
  }
});

test("Q03 known appearance replies and unknown palette stay distinct", async () => {
  const { engine, replies } = collected();
  try {
    await engine.apply(output(1), utf8("\u001b]4;99;?\u0007\u001b]10;?\u0007"));
    expect(replies.map(({ text }) => text)).toEqual(["\u001b]10;rgb:ffff/ffff/ffff\u001b\\"]);
    expect((await engine.barrier()).value.knownPaletteIndices).toEqual([1]);
  } finally {
    engine.dispose();
  }
});

test("Q04 explicit appearance replacement is ordered with subsequent queries", async () => {
  const { engine, replies } = collected();
  try {
    await engine.apply(
      appearance(1, { foreground: "1111/2222/3333", background: "0000/0000/0000", palette: [] }),
    );
    await engine.apply(output(2), utf8("\u001b]10;?\u0007\u001b]4;1;?\u0007"));
    expect(replies.map(({ text }) => text)).toEqual(["\u001b]10;rgb:1111/2222/3333\u001b\\"]);
    const state = (await engine.barrier()).value;
    expect(state.appearance.foreground).toBe("1111/2222/3333");
    expect(state.knownPaletteIndices).toEqual([]);
  } finally {
    engine.dispose();
  }
});

test("Q05 split mixed OSC setter/query preserves order and ST/BEL termination", async () => {
  const { engine, replies } = collected();
  try {
    await engine.apply(output(1), utf8("\u001b]4;1;#aabb"));
    await engine.apply(output(2), utf8("cc;1;?\u0007\u001b]11;#123\u001b\\\u001b]11;?\u001b\\"));
    expect(replies.map(({ text }) => text)).toEqual([
      "\u001b]4;1;rgb:aaaa/bbbb/cccc\u001b\\",
      "\u001b]11;rgb:1111/2222/3333\u001b\\",
    ]);
  } finally {
    engine.dispose();
  }
});

test("Q06 color reset changes known query replies and checkpoint appearance", async () => {
  const { engine, replies } = collected();
  try {
    await engine.apply(output(1), utf8("\u001b]10;#123456\u0007\u001b]10;?\u0007"));
    await engine.apply(output(2), utf8("\u001b]110\u0007\u001b]10;?\u0007"));
    expect(replies.map(({ text }) => text)).toEqual([
      "\u001b]10;rgb:1212/3434/5656\u001b\\",
      "\u001b]10;rgb:ffff/ffff/ffff\u001b\\",
    ]);
    expect((await engine.captureBaseline()).baseline.appearance.foreground).toBe("ffff/ffff/ffff");
  } finally {
    engine.dispose();
  }
});

test("Q07 mode 1004 reports presence transitions but not holder swaps", async () => {
  const { engine, replies } = collected();
  try {
    await engine.apply(control(1, holder("a")));
    await engine.apply(output(2), utf8("\u001b[?1004h"));
    await engine.apply(control(3, holder("b")));
    await engine.apply(control(4, null));
    await engine.apply(control(5, holder("a")));
    await engine.apply(output(6), utf8("\u001b[?1004l"));
    await engine.apply(control(7, null));
    expect(replies.map(({ kind, text }) => [kind, text])).toEqual([
      ["focus", "\u001b[O"],
      ["focus", "\u001b[I"],
    ]);
  } finally {
    engine.dispose();
  }
});

test("Q08 sink failure faults model and disposal prevents later emission", async () => {
  let calls = 0;
  const engine = model({
    onAutomaticOutput: () => {
      calls++;
      throw new Error("secret");
    },
  });
  expect((await engine.apply(output(1), utf8("\u001b[5n"))).error.code).toBe("faulted");
  expect((await engine.apply(output(2), utf8("\u001b[5n"))).error.code).toBe("faulted");
  expect(calls).toBe(1);
  engine.dispose();
  expect((await engine.barrier()).error.code).toBe("disposed");
});
