const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createIpAccessMiddleware,
  ipMatchesRule,
  normalizeClientIp,
  parseIpRule,
  IpAccessControlService,
} = require("../dist/common/ip-access-control.service.js");

test("normalizes exact addresses and CIDR networks", () => {
  assert.equal(parseIpRule("203.0.113.25").cidr, "203.0.113.25/32");
  assert.equal(parseIpRule("203.0.113.25/24").cidr, "203.0.113.0/24");
  assert.equal(parseIpRule("2001:db8::12/64").cidr, "2001:db8::/64");
  assert.equal(normalizeClientIp("::ffff:203.0.113.8"), "203.0.113.8");
});

test("matches IPv4, mapped IPv4 and IPv6 without crossing families", () => {
  assert.equal(ipMatchesRule("203.0.113.9", "203.0.113.0/24"), true);
  assert.equal(ipMatchesRule("::ffff:203.0.113.9", "203.0.113.0/24"), true);
  assert.equal(ipMatchesRule("203.0.114.9", "203.0.113.0/24"), false);
  assert.equal(ipMatchesRule("2001:db8::99", "2001:db8::/48"), true);
  assert.equal(ipMatchesRule("203.0.113.9", "2001:db8::/48"), false);
});

test("service uses enabled rules and refuses to lock out the current administrator", async () => {
  const writes = [];
  const database = {
    query: async (sql) => {
      if (sql.includes("COUNT(*)")) return [{ count: 0 }];
      if (sql.includes("WHERE enabled = 1")) return [{ cidr: "198.51.100.0/24" }];
      return [];
    },
    execute: async (sql, args) => { writes.push([sql, args]); return {}; },
  };
  const service = new IpAccessControlService(database, { record: async () => {} });
  assert.equal(await service.isBlocked("198.51.100.42"), true);
  assert.equal(await service.isBlocked("203.0.113.42"), false);
  await assert.rejects(
    service.create("admin-id", { cidr: "203.0.113.0/24", enabled: true }, "203.0.113.42"),
    /会立即阻止你当前的管理端 IP/,
  );
  assert.equal(writes.length, 0);
});

test("middleware rejects blocked callers before routing and allows other callers", async () => {
  const response = () => ({
    statusCode: 0, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  });
  const blockedResponse = response(); let blockedNext = false;
  await createIpAccessMiddleware({ isBlocked: async () => true })({ ip: "203.0.113.8", socket: {} }, blockedResponse, () => { blockedNext = true; });
  assert.equal(blockedResponse.statusCode, 403);
  assert.equal(blockedResponse.body.code, "IP_ACCESS_DENIED");
  assert.equal(blockedNext, false);

  const allowedResponse = response(); let allowedNext = false;
  await createIpAccessMiddleware({ isBlocked: async () => false })({ ip: "203.0.113.9", socket: {} }, allowedResponse, () => { allowedNext = true; });
  assert.equal(allowedNext, true);
});
