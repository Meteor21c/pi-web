import test from "node:test";
import assert from "node:assert/strict";
import { createRelaySessionClient } from "./relay-session-client.ts";

const reply = (body, status = 200) => Response.json(body, { status });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

test("disabled gate never checks relay authentication", async () => {
  const client = createRelaySessionClient(false, () => { throw new Error("must not fetch"); });
  await client.initialize();
  assert.equal(client.getSnapshot().status, "disabled");
});

test("multiple subscribers initialize a single shared session request", async () => {
  let count = 0;
  const waiting = deferred();
  const client = createRelaySessionClient(true, () => { count++; return waiting.promise; });
  const a = client.initialize();
  const b = client.initialize();
  const c = client.recheck();
  assert.equal(count, 1);
  assert.equal(client.getSnapshot().status, "loading");
  waiting.resolve(reply({ ok: true, user: { email: "a@example.com" } }));
  await Promise.all([a, b, c]);
  assert.equal(client.getSnapshot().user.email, "a@example.com");
});

test("temporary failure is retryable and not mislabeled as expired", async () => {
  let count = 0;
  const client = createRelaySessionClient(true, async () => ++count === 1
    ? reply({ ok: false, reason: "relay-error" }, 503)
    : reply({ ok: true, user: { email: "a@example.com" } }));
  await client.initialize();
  assert.equal(client.getSnapshot().status, "error");
  assert.equal(client.getSnapshot().expired, false);
  await client.recheck();
  assert.equal(client.getSnapshot().status, "authenticated");
});

test("late me response cannot resurrect a signed out user", async () => {
  const waiting = deferred();
  const client = createRelaySessionClient(true, async (url) => url.endsWith("/me")
    ? waiting.promise : reply({ ok: true }));
  const checking = client.initialize();
  await client.logout();
  waiting.resolve(reply({ ok: true, user: { email: "old@example.com" } }));
  await checking;
  assert.equal(client.getSnapshot().status, "unauthenticated");
  assert.equal(client.getSnapshot().user, null);
});

test("failed logout retains authenticated state instead of reporting success", async () => {
  const client = createRelaySessionClient(true, async (url) => url.endsWith("/logout")
    ? reply({ ok: false }, 500)
    : reply({ ok: true, user: { email: "a@example.com" } }));
  await client.initialize();
  await assert.rejects(client.logout(), /logout-failed/);
  assert.equal(client.getSnapshot().status, "authenticated");
});

test("logout keeps the gate open when another saved account becomes active", async () => {
  const client = createRelaySessionClient(true, async (url) => url.endsWith("/logout")
    ? reply({ ok: true, nextSession: { ok: true, user: { id: 2, email: "second@example.com" } } })
    : reply({ ok: true, user: { id: 1, email: "first@example.com" } }));
  await client.initialize();
  await client.logout();
  assert.equal(client.getSnapshot().status, "authenticated");
  assert.equal(client.getSnapshot().user.email, "second@example.com");
});

test("late me cannot overwrite a freshly logged in account", async () => {
  const waiting = deferred();
  const client = createRelaySessionClient(true, async (url) => url.endsWith("/me")
    ? waiting.promise : reply({ ok: true, accountId: "acct-new", user: { email: "new@example.com" } }));
  const checking = client.initialize();
  assert.deepEqual(await client.login("new@example.com", "dummy-test-only"), { ok: true, accountId: "acct-new" });
  waiting.resolve(reply({ ok: true, user: { email: "old@example.com" } }));
  await checking;
  assert.equal(client.getSnapshot().user.email, "new@example.com");
});
