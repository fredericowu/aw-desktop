// @vitest-environment node
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const { refresh } = createRequire(import.meta.url)("../build/refresh-yml-dmg.js");

const YML = `version: 0.1.6
files:
  - url: A-0.1.6-arm64-mac.zip
    sha512: ZIPHASH
    size: 10
  - url: A-0.1.6-arm64.dmg
    sha512: OLD
    size: 1
path: A-0.1.6-arm64-mac.zip
sha512: ZIPHASH
`;

describe("refresh-yml-dmg", () => {
  it("rewrites only the dmg entry", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dmg-"));
    const dmg = path.join(dir, "A-0.1.6-arm64.dmg");
    fs.writeFileSync(dmg, "stapled-bytes");
    const out = refresh(YML, dmg);
    const sha = crypto.createHash("sha512").update("stapled-bytes").digest("base64");
    expect(out).toContain(`sha512: ${sha}`);
    expect(out).toContain("size: 13");
    expect(out.match(/ZIPHASH/g)).toHaveLength(2);
    expect(out).toContain("size: 10");
  });
  it("matches the hyphenated manifest name for a DMG with a space on disk", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dmg-"));
    const dmg = path.join(dir, "AW Desktop-0.1.6-arm64.dmg");
    fs.writeFileSync(dmg, "stapled-bytes");
    const yml = YML.replace("A-0.1.6-arm64.dmg", "AW-Desktop-0.1.6-arm64.dmg");
    expect(refresh(yml, dmg)).toContain("size: 13");
  });
  it("throws when the dmg has no entry", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dmg-"));
    const dmg = path.join(dir, "Other.dmg");
    fs.writeFileSync(dmg, "x");
    expect(() => refresh(YML, dmg)).toThrow();
  });
});
