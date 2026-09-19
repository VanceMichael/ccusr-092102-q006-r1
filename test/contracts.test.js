import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("标识线索包含语种与位置授权", async () => {
  const payload = JSON.parse(await readFile("fixtures/sign-report.json", "utf8"));
  assert.ok(payload.language);
  assert.equal(typeof payload.location_authorized, "boolean");
  assert.match(payload.photo_fingerprint, /^sha256:/);
});
