import { describe, expect, it } from "vitest";
import { vmFactsFromInspect, parseMachineInspect, parseSystemProfilerGpu } from "../src/main/aboutFacts";

describe("aboutFacts", () => {
  it("reads VM Resources from podman machine inspect", () => {
    const r = parseMachineInspect(JSON.stringify([{ Resources: { CPUs: 6, Memory: 8192, DiskSize: 100 } }]));
    expect(r).toMatchObject({ state: "ok", cpus: 6, memory_mib: 8192, disk_gib: 100, source: "machine" });
  });
  it("falls back to init defaults, labelled, when Resources is absent", () => {
    expect(parseMachineInspect("[{}]")).toMatchObject({ cpus: 2, memory_mib: 4096, disk_gib: 40, source: "default" });
  });
  it("unparseable inspect is unknown, not defaults", () => {
    expect(parseMachineInspect("nope").state).toBe("unknown");
  });
  it("a rejected inspect is unknown, not the init defaults", async () => {
    expect(await vmFactsFromInspect(Promise.reject(new Error("timeout")))).toMatchObject({ state: "unknown" });
  });
  it("Apple GPU shares system memory and prints no VRAM", () => {
    const out = parseSystemProfilerGpu(JSON.stringify({ SPDisplaysDataType: [{ sppci_model: "Apple M2", sppci_cores: "10" }] }));
    expect(out).toBe("Apple M2, 10 cores, shares system memory");
  });
  it("Intel GPU shows VRAM; garbage is unknown, never no-GPU", () => {
    expect(parseSystemProfilerGpu(JSON.stringify({ SPDisplaysDataType: [{ sppci_model: "AMD Radeon", spdisplays_vram: "4 GB" }] }))).toContain("4 GB VRAM");
    expect(parseSystemProfilerGpu("x")).toMatchObject({ state: "unknown" });
    expect(parseSystemProfilerGpu("{}")).toMatchObject({ state: "unknown" });
  });
});
