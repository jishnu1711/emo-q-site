import assert from "node:assert/strict";
import test from "node:test";
import { resolveRequestPath } from "../../backend/server.mjs";

test("root resolves to the Echo Q interface", () => {
  assert.match(resolveRequestPath("/"), /[\\/]frontend[\\/]index\.html$/);
});

test("path traversal is rejected", () => {
  assert.equal(resolveRequestPath("/../../Windows/win.ini"), null);
});
