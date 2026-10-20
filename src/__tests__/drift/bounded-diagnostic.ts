import { createHash } from "node:crypto";
import { MAX_EVIDENCE_RECORD_BYTES } from "../../../scripts/drift-evidence-reporter.js";

// Vitest task ids are short; 64 characters leaves a margin for the envelope.
const TASK_ID_ALLOWANCE = "x".repeat(64);

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// Without this, JSON.stringify writes a Uint8Array as {"0":123,"1":34,...},
// which is about ten times the size of its base64 form.
const bytesAsBase64 = (_key: string, value: unknown) =>
  value instanceof Uint8Array && !Buffer.isBuffer(value)
    ? { encoding: "base64", bytes: Buffer.from(value).toString("base64") }
    : value;

/** Mirrors the evidence reporter's console record encoding and size check. */
export function fitsEvidenceRecord(line: string, taskId = TASK_ID_ALLOWANCE): boolean {
  const encoded = JSON.stringify({
    kind: "console",
    taskId,
    stream: "stdout",
    content: line + "\n",
  });
  return Buffer.byteLength(encoded) <= MAX_EVIDENCE_RECORD_BYTES;
}

/**
 * Serialize one AWS drift diagnostic console line so the evidence reporter can
 * still bind it to its test.
 *
 * The reporter replaces any console record over MAX_EVIDENCE_RECORD_BYTES with
 * `console-unavailable`. That taints the owning test, and one tainted live
 * assertion makes the collector withhold the whole observation artifact, so
 * the native drift gate cannot grade the run.
 *
 * SDK event bytes are written as base64. If the line is still too large, the
 * raw wire bytes and then the SDK events are replaced by their size and
 * SHA-256. The decoded events and all other fields stay as they are.
 */
export function boundedDiagnosticLine(
  record: Record<string, unknown> & { sdkEvents: unknown[] },
  wire: Buffer,
): string {
  const rawWire = { encoding: "base64", bytes: wire.toString("base64") };
  const wireDigest = { omitted: true, byteLength: wire.length, sha256: sha256(wire) };
  const full = JSON.stringify({ ...record, rawWire }, bytesAsBase64);
  if (fitsEvidenceRecord(full)) return full;
  const withoutWire = JSON.stringify({ ...record, rawWire: wireDigest }, bytesAsBase64);
  if (fitsEvidenceRecord(withoutWire)) return withoutWire;
  const events = Buffer.from(JSON.stringify(record.sdkEvents, bytesAsBase64));
  return JSON.stringify(
    {
      ...record,
      sdkEvents: {
        omitted: true,
        count: record.sdkEvents.length,
        byteLength: events.length,
        sha256: sha256(events),
      },
      rawWire: wireDigest,
    },
    bytesAsBase64,
  );
}
