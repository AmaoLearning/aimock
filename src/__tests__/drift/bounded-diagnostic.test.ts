import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAX_EVIDENCE_RECORD_BYTES } from "../../../scripts/drift-evidence-reporter.js";
import { boundedDiagnosticLine, fitsEvidenceRecord } from "./bounded-diagnostic.js";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// Shape of the live Bedrock invoke K9 stream=true record observed on the
// scheduled main drift run: ~318 SDK chunk events plus ~90KiB of raw wire.
function liveK9StreamRecord(chunkCount = 318, chunkBytes = 280) {
  const sdkEvents = Array.from({ length: chunkCount }, (_, index) => ({
    chunk: { bytes: new Uint8Array(chunkBytes).fill(97 + (index % 26)) },
  }));
  const decoded = { wire: "invoke", stream: true, events: [{ type: "message_stop" }] };
  const record = { cell: { wire: "invoke", fault: "K9", stream: true }, sdkEvents, decoded };
  const wire = Buffer.alloc(chunkCount * chunkBytes, 0x62);
  return { record, wire };
}

describe("boundedDiagnosticLine", () => {
  it("keeps a small record complete, with byte arrays as base64", () => {
    const wire = Buffer.from("raw-wire");
    const line = boundedDiagnosticLine(
      { cell: "x", sdkEvents: [{ chunk: { bytes: new Uint8Array([123, 125]) } }] },
      wire,
    );
    expect(JSON.parse(line)).toEqual({
      cell: "x",
      sdkEvents: [{ chunk: { bytes: { encoding: "base64", bytes: "e30=" } } }],
      rawWire: { encoding: "base64", bytes: wire.toString("base64") },
    });
  });

  it("bounds the live K9 stream record that the reporter used to drop", () => {
    const { record, wire } = liveK9StreamRecord();
    // The pre-fix line: JSON.stringify with the raw wire inline.
    const unbounded = JSON.stringify({
      ...record,
      rawWire: { encoding: "base64", bytes: wire.toString("base64") },
    });
    expect(fitsEvidenceRecord(unbounded)).toBe(false);

    const line = boundedDiagnosticLine(record, wire);
    expect(fitsEvidenceRecord(line)).toBe(true);
    const parsed = JSON.parse(line);
    expect(parsed.decoded).toEqual(record.decoded);
    expect(parsed.sdkEvents).toHaveLength(record.sdkEvents.length);
    expect(parsed.sdkEvents[0].chunk.bytes).toEqual({
      encoding: "base64",
      bytes: Buffer.from(record.sdkEvents[0].chunk.bytes).toString("base64"),
    });
    expect(parsed.rawWire).toEqual({ encoding: "base64", bytes: wire.toString("base64") });
  });

  it("digests the raw wire when the base64 events and wire together exceed the limit", () => {
    const { record, wire } = liveK9StreamRecord(318, 400);
    const line = boundedDiagnosticLine(record, wire);
    expect(fitsEvidenceRecord(line)).toBe(true);
    const parsed = JSON.parse(line);
    expect(parsed.decoded).toEqual(record.decoded);
    expect(parsed.sdkEvents).toHaveLength(318);
    expect(parsed.rawWire).toEqual({
      omitted: true,
      byteLength: wire.length,
      sha256: sha256(wire),
    });
  });

  it("digests the SDK events too when they alone exceed the record limit", () => {
    const { record, wire } = liveK9StreamRecord(400, 1024);
    const line = boundedDiagnosticLine(record, wire);
    expect(fitsEvidenceRecord(line)).toBe(true);
    const parsed = JSON.parse(line);
    expect(parsed.decoded).toEqual(record.decoded);
    expect(parsed.sdkEvents).toMatchObject({ omitted: true, count: 400 });
    expect(parsed.sdkEvents.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.rawWire).toMatchObject({ omitted: true, byteLength: wire.length });
  });
});

describe("fitsEvidenceRecord", () => {
  it("applies the reporter limit to the JSON-encoded console record", () => {
    // Quotes are escaped once more inside the record, so a line under the
    // limit by raw length can still exceed it once encoded.
    const quoted = '"'.repeat(MAX_EVIDENCE_RECORD_BYTES / 2);
    expect(Buffer.byteLength(quoted)).toBeLessThan(MAX_EVIDENCE_RECORD_BYTES);
    expect(fitsEvidenceRecord(quoted)).toBe(false);
    expect(fitsEvidenceRecord("x".repeat(1024))).toBe(true);
  });
});
