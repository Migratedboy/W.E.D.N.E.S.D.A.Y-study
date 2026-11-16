import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword, hashSessionToken, safeCompareCode } from "../lib/auth.js";

test("passwords round-trip", () => {
  const stored = hashPassword("correct horse battery staple");
  assert.ok(verifyPassword("correct horse battery staple", stored));
});

test("a wrong password is rejected", () => {
  const stored = hashPassword("hunter2hunter2");
  assert.equal(verifyPassword("hunter2hunter3", stored), false);
  assert.equal(verifyPassword("", stored), false);
});

test("hashes are salted, so the same password hashes differently", () => {
  assert.notEqual(hashPassword("same-password"), hashPassword("same-password"));
});

test("a malformed stored hash is rejected without throwing", () => {
  assert.equal(verifyPassword("x", ""), false);
  assert.equal(verifyPassword("x", null), false);
  assert.equal(verifyPassword("x", "nocolonhere"), false);
});

test("session tokens are stored hashed and are not reversible back to the token", () => {
  const token = "a".repeat(64);
  const hashed = hashSessionToken(token);
  assert.equal(hashed.length, 64);
  assert.notEqual(hashed, token);
  assert.equal(hashSessionToken(token), hashed, "deterministic for lookup");
});

test("distinct session tokens hash to distinct values", () => {
  assert.notEqual(hashSessionToken("token-a"), hashSessionToken("token-b"));
});

test("verification codes compare correctly", () => {
  assert.ok(safeCompareCode("123456", "123456"));
  assert.equal(safeCompareCode("123456", "123457"), false);
  assert.equal(safeCompareCode("123456", ""), false);
});

test("code comparison does not throw on different-length input", () => {
  assert.equal(safeCompareCode("123456", "1234567890"), false);
  assert.equal(safeCompareCode("", ""), true, "both pad to 000000");
});
