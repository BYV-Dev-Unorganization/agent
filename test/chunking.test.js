import test from "node:test";
import assert from "node:assert/strict";
import { countCodePoints, countUtf8Bytes, packTextGroups, splitTextLossless } from "../src/chunking.js";

test("ASCII chunks preserve all text and respect character and byte budgets", () => {
  const input = "alpha beta gamma. ".repeat(1800);
  const chunks = splitTextLossless(input, { maxChars: 500, maxBytes: 700 });
  assert.equal(chunks.join(""), input);
  assert.ok(chunks.every((part) => countCodePoints(part) <= 500));
  assert.ok(chunks.every((part) => countUtf8Bytes(part) <= 700));
});

test("Unicode chunks preserve emoji and multibyte characters", () => {
  const input = "😀漢字 café مرحبا 🌏\n".repeat(500);
  const chunks = splitTextLossless(input, { maxChars: 180, maxBytes: 450 });
  assert.equal(chunks.join(""), input);
  assert.ok(chunks.every((part) => countCodePoints(part) <= 180));
  assert.ok(chunks.every((part) => countUtf8Bytes(part) <= 450));
  assert.equal(countCodePoints("😀"), 1);
  assert.equal(countUtf8Bytes("😀"), 4);
});

test("group packing preserves order and respects both budgets", () => {
  const items = Array.from({ length: 40 }, (_, i) => "item-" + i + "-" + "x".repeat(40));
  const groups = packTextGroups(items, { maxBytes: 400, maxChars: 400 });
  assert.deepEqual(groups.flat(), items);
  for (const group of groups) {
    assert.ok(countUtf8Bytes(group.join("\n\n")) <= 400);
    assert.ok(countCodePoints(group.join("\n\n")) <= 400);
  }
});

test("empty input returns no chunks and impossible limits throw", () => {
  assert.deepEqual(splitTextLossless(""), []);
  assert.throws(() => splitTextLossless("😀", { maxBytes: 2 }), RangeError);
});

test("150,000 Unicode code points can be split losslessly within the configured budgets", () => {
  const input = "😀".repeat(150000);
  const chunks = splitTextLossless(input, { maxChars: 5000, maxBytes: 9000 });
  assert.equal(chunks.join(""), input);
  assert.equal(countCodePoints(chunks.join("")), 150000);
  assert.equal(countUtf8Bytes(chunks.join("")), 600000);
  assert.ok(chunks.every((part) => countCodePoints(part) <= 5000));
  assert.ok(chunks.every((part) => countUtf8Bytes(part) <= 9000));
});
