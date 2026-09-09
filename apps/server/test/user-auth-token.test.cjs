const assert = require("node:assert/strict");
const { test } = require("node:test");
const jwt = require("jsonwebtoken");
const { UserAuthService } = require("../dist/user-auth/user-auth.service");

test("platform access tokens are valid for seven days", async () => {
  const database = { execute: async () => undefined };
  const environment = { values: { jwtSecret: "test-secret-that-is-longer-than-thirty-two-characters" } };
  const service = new UserAuthService(database, environment, {}, {}, {}, {});
  const result = await service.issueTokens("user-id", "test-device");
  const decoded = jwt.decode(result.access_token);
  assert.equal(result.expires_in, 7 * 24 * 60 * 60);
  assert.equal(decoded.exp - decoded.iat, 7 * 24 * 60 * 60);
});
