import { resolve } from "node:path";
import { openManagedPage, withManagedBrowser } from "../dist/probes/node/managed-browser.js";

const builtRoot = resolve(
  process.env.COVE_VIEW_BROWSER_ROOT ?? resolve(import.meta.dirname, "../dist/view-browser"),
);

export async function withViewPage(work) {
  const { value } = await withManagedBrowser(
    async (context) => {
      const page = await openManagedPage(context);
      await page.waitForFunction("window.coveQuery?.ready === true", null, {
        timeout: context.remaining(5_000, "V1 xterm ready"),
      });
      context.assertPageErrors();
      return work(page);
    },
    "query",
    builtRoot,
  );
  return value;
}
