import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// User-facing copy must not contain em dashes (card 41f5bf3b requirement).
// Comments are exempt: only lines that are not comment lines are checked.
const dir = join(__dirname, "../src/renderer/screens");
describe("renderer copy", () => {
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".tsx"))) {
    it(`${f} has no em dash in user-facing text`, () => {
      const bad = readFileSync(join(dir, f), "utf8")
        .split("\n")
        .filter((l) => l.includes("—") && !/^\s*(\/\/|\/?\*)/.test(l));
      expect(bad).toEqual([]);
    });
  }
});
