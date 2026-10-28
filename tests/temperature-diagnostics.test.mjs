import assert from "node:assert/strict";
import test from "node:test";
import jwt from "jsonwebtoken";
import { createHarness, profile, schema } from "./helpers/server-harness.mjs";

const plain = (value) => JSON.parse(JSON.stringify(value));
const eventsFor = (row, name) =>
  row.diagnostic.events.filter((entry) => entry.event === name);
const logsFor = (harness, name) =>
  harness.state.logs
    .flatMap(({ args }) => {
      try {
        return args
          .filter((arg) => typeof arg === "string")
          .map((arg) => JSON.parse(arg));
      } catch {
        return [];
      }
    })
    .filter((entry) => entry.event === name);

function callerFor(harness, email) {
  const cookieToken = jwt.sign({ email }, "test-jwt-secret");
  const headers = new Headers({ cookie: `8slpAutht=${cookieToken}` });
  return {
    caller: harness
      .load("~/server/api/routers/user")
      .userRouter.createCaller({ headers }),
    cookieToken,
  };
}

function diagnosticOptions(email, initialSleepLevel = -20) {
  const saved = profile(email).userTemperatureProfiles;
  return {
    email,
    source: "cron",
    profile: {
      bedTime: saved.bedTime,
      wakeupTime: saved.wakeupTime,
      timezone: saved.timezoneTZ,
      initialSleepLevel,
      midStageSleepLevel: saved.midStageSleepLevel,
      finalSleepLevel: saved.finalSleepLevel,
      updatedAt: saved.updatedAt.toISOString(),
    },
  };
}

test("a zero target reaches the real request, while another account's failure is reported without failing the cron transport", async () => {
  const harness = createHarness({
    profiles: [
      profile("alice@example.test"),
      profile("bob@example.test", { finalSleepLevel: 10 }),
    ],
    fetch: async (url) =>
      new Response("{}", {
        status: url.includes("bob@example.test") ? 503 : 200,
      }),
  });
  const response = await harness
    .load("~/app/api/temperatureCron/route")
    .GET(harness.request());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    success: false,
    successCount: 1,
    failureCount: 1,
    totalProfiles: 2,
  });

  const [successful, failed] = harness.state.diagnostics;
  assert.equal(successful.email, "alice@example.test");
  assert.equal(successful.diagnostic.outcome, "ok");
  assert.equal(failed.email, "bob@example.test");
  assert.equal(failed.diagnostic.outcome, "error");
  assert.notEqual(successful.id, failed.id);
  assert.ok(successful.diagnostic.finishedAt);
  assert.ok(failed.diagnostic.finishedAt);

  const aliceRequest = harness.state.requests.find(({ url }) =>
    url.includes("alice@example.test"),
  );
  assert.deepEqual(JSON.parse(aliceRequest.init.body), {
    timeBased: { level: 0, durationSeconds: 0 },
    currentLevel: 0,
  });
  assert.equal(
    eventsFor(successful, "temperature.command")[0].details.level,
    0,
  );
  assert.equal(harness.state.statusReads[1].options.cache, "no-store");
  assert.equal(
    eventsFor(successful, "heating-status-readback")[0].details
      .reportedTargetMatchesCommand,
    false,
  );
  assert.equal(eventsFor(failed, "operation-attempt-failed").length, 3);
  assert.equal(eventsFor(failed, "api.failure")[0].details.status, 503);
  assert.equal(eventsFor(successful, "profile-check-failed").length, 0);

  const insertSnapshots = harness.state.writes.filter(
    ({ kind, target }) => kind === "insert" && target.name === "diagnostics",
  );
  assert.equal(insertSnapshots.length, 4);
  assert.equal(insertSnapshots[0].values.diagnostic.outcome, "running");
  assert.equal(insertSnapshots[0].values.diagnostic.finishedAt, null);
  assert.equal(insertSnapshots[0].values.diagnostic.events.length, 1);
});

test("testTime simulates a transition without token refresh, temperature calls, or persisted history", async () => {
  const sleeper = profile("sleeper@example.test", { finalSleepLevel: 20 });
  sleeper.users.eightTokenExpiresAt = new Date("2000-01-01T00:00:00Z");
  const harness = createHarness({ profiles: [sleeper] });
  const timestamp = Date.parse("2026-10-27T04:30:10-07:00") / 1000;
  const response = await harness
    .load("~/app/api/temperatureCron/route")
    .GET(harness.request(`?testTime=${timestamp}`));
  assert.equal(response.status, 200);
  assert.equal(harness.state.statusReads.length, 0);
  assert.equal(harness.state.requests.length, 0);
  assert.equal(harness.state.tokenRefreshes.length, 0);
  assert.equal(harness.state.writes.length, 0);
  assert.equal(harness.state.diagnostics.length, 0);
  assert.ok(
    logsFor(harness, "schedule-clock").some(
      ({ details }) => details.simulated === true,
    ),
  );
  assert.ok(
    logsFor(harness, "command-stage-selected").some(
      ({ details }) => details.targetLevel === 20,
    ),
  );
});

test("a missed final transition explicitly records why -30 was retained", async () => {
  const harness = createHarness({
    now: "2026-10-27T05:00:10-07:00",
    profiles: [profile("sleeper@example.test", { wakeupTime: "06:35:00" })],
  });
  await harness.load("~/app/api/temperatureCron/route").GET(harness.request());
  assert.equal(harness.state.requests.length, 0);
  const row = harness.state.diagnostics[0];
  const evaluated = eventsFor(row, "schedule-evaluation")[0].details;
  assert.equal(evaluated.currentSleepStage, "final");
  assert.equal(evaluated.withinWindow.finalStage, false);
  assert.ok(evaluated.minutesFromBoundary.finalStage > 25);
  const skipped = eventsFor(row, "temperature-change-skipped")[0].details;
  assert.equal(skipped.reason, "missed-final-window");
  assert.equal(skipped.currentLevel, -30);
  assert.equal(skipped.configuredFinalLevel, 0);

  const alreadyCommanded = createHarness({
    now: "2026-10-27T05:00:10-07:00",
    profiles: [profile("sleeper@example.test", { wakeupTime: "06:35:00" })],
    getStatus: () => ({
      isHeating: true,
      heatingLevel: -30,
      targetHeatingLevel: 0,
    }),
  });
  await alreadyCommanded
    .load("~/app/api/temperatureCron/route")
    .GET(alreadyCommanded.request());
  assert.equal(
    eventsFor(
      alreadyCommanded.state.diagnostics[0],
      "temperature-change-skipped",
    )[0].details.reason,
    "outside-window",
  );
});

test("unavailable diagnostic storage cannot prevent normal temperature control or expose database error contents", async () => {
  const secret = "private-database-connection-and-parameters";
  const harness = createHarness({ diagnosticWriteError: new Error(secret) });
  const response = await harness
    .load("~/app/api/temperatureCron/route")
    .GET(harness.request());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).successCount, 1);
  assert.equal(harness.state.requests.length, 1);
  assert.equal(JSON.parse(harness.state.requests[0].init.body).currentLevel, 0);
  assert.equal(logsFor(harness, "diagnostic-persistence-failed").length, 2);
  assert.equal(logsFor(harness, "diagnostic-retention-failed").length, 1);
  assert.equal(JSON.stringify(harness.state.logs).includes(secret), false);
});

test("overlapping diagnostic contexts keep events isolated and finish their own snapshots", async () => {
  const harness = createHarness();
  const { withTemperatureDiagnostic, recordDiagnosticEvent } = harness.load(
    "~/server/temperature-diagnostics",
  );
  let releaseFirst;
  const interleave = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  await Promise.all([
    withTemperatureDiagnostic(
      diagnosticOptions("alice@example.test", -10),
      async () => {
        recordDiagnosticEvent("marker", { owner: "first-before" });
        await interleave;
        recordDiagnosticEvent("marker", { owner: "first-after" });
      },
    ),
    withTemperatureDiagnostic(
      diagnosticOptions("bob@example.test", -20),
      async () => {
        recordDiagnosticEvent("marker", { owner: "second" });
        releaseFirst();
      },
    ),
  ]);
  recordDiagnosticEvent("outside-context", {});
  const alice = harness.state.diagnostics.find(
    ({ email }) => email === "alice@example.test",
  );
  const bob = harness.state.diagnostics.find(
    ({ email }) => email === "bob@example.test",
  );
  assert.deepEqual(
    plain(eventsFor(alice, "marker").map(({ details }) => details.owner)),
    ["first-before", "first-after"],
  );
  assert.deepEqual(
    plain(eventsFor(bob, "marker").map(({ details }) => details.owner)),
    ["second"],
  );
  assert.equal(eventsFor(alice, "outside-context").length, 0);
  assert.equal(eventsFor(bob, "outside-context").length, 0);
  assert.equal(alice.diagnostic.outcome, "ok");
  assert.equal(bob.diagnostic.outcome, "ok");
});

test("API diagnostics retain endpoint and schema failure details without credentials, identifiers, or response bodies", async () => {
  const secret = "SENSITIVE_RESPONSE_AND_QUERY_VALUE";
  const harness = createHarness({
    fetch: async () => Response.json({ level: secret }),
  });
  const { withTemperatureDiagnostic } = harness.load(
    "~/server/temperature-diagnostics",
  );
  const { fetchWithAuth } = harness.load("~/server/eight/eight");
  const { z } = harness.load("zod");
  const token = {
    ...profile("private@example.test").users,
    eightExpiresAtPosix: 0,
  };
  const url = `https://api.example.test/v1/users/private-user-id/devices/private-device-id?access_token=${secret}`;
  await assert.rejects(
    withTemperatureDiagnostic(diagnosticOptions("private@example.test"), () =>
      fetchWithAuth(url, token, z.object({ level: z.number() })),
    ),
  );
  const row = harness.state.diagnostics[0];
  const request = eventsFor(row, "api.request")[0].details;
  assert.equal(
    request.endpoint,
    "api.example.test/v1/users/:userId/devices/:deviceId",
  );
  const failure = eventsFor(row, "api.failure")[0].details;
  assert.deepEqual(plain(failure.issues), [
    { path: ["level"], code: "invalid_type" },
  ]);
  const exported = JSON.stringify({
    diagnostic: row.diagnostic,
    logs: harness.state.logs,
  });
  for (const value of [
    secret,
    token.eightAccessToken,
    token.eightRefreshToken,
    token.eightUserId,
    "private-user-id",
    "private-device-id",
  ]) {
    assert.equal(
      exported.includes(value),
      false,
      `Diagnostics leaked ${value}`,
    );
  }
  assert.equal(row.diagnostic.outcome, "error");
});

test("the history endpoint authenticates the session and cannot be redirected to another account", async () => {
  const harness = createHarness({
    profiles: [profile("alice@example.test"), profile("bob@example.test")],
  });
  await harness.load("~/app/api/temperatureCron/route").GET(harness.request());
  const { caller, cookieToken } = callerFor(harness, "alice@example.test");
  const result = await caller.getTemperatureDiagnostics({
    email: "bob@example.test",
  });
  assert.equal(result.email, "alice@example.test");
  assert.equal(result.runs.length, 1);
  assert.equal(
    result.runs[0].id,
    harness.state.diagnostics.find(
      ({ email }) => email === "alice@example.test",
    ).id,
  );
  assert.notEqual(
    result.runs[0].id,
    harness.state.diagnostics.find(({ email }) => email === "bob@example.test")
      .id,
  );
  assert.equal(JSON.stringify(harness.state.logs).includes(cookieToken), false);
  assert.equal(JSON.stringify(result).includes("private-access"), false);

  const unauthenticated = harness
    .load("~/server/api/routers/user")
    .userRouter.createCaller({ headers: new Headers() });
  await assert.rejects(unauthenticated.getTemperatureDiagnostics(), {
    code: "UNAUTHORIZED",
  });
  const tampered = harness
    .load("~/server/api/routers/user")
    .userRouter.createCaller({
      headers: new Headers({
        cookie: `8slpAutht=${jwt.sign({ email: "bob@example.test" }, "wrong-key")}`,
      }),
    });
  await assert.rejects(tampered.getTemperatureDiagnostics(), {
    code: "UNAUTHORIZED",
  });
});

test("empty history and failed history queries have different outcomes, and retention only removes old diagnostics", async () => {
  const emptyHarness = createHarness();
  const { caller } = callerFor(emptyHarness, "alice@example.test");
  assert.deepEqual(plain(await caller.getTemperatureDiagnostics()), {
    email: "alice@example.test",
    runs: [],
  });

  const secret = "postgres-secret-query-values";
  const brokenHarness = createHarness({
    diagnosticReadError: new Error(secret),
  });
  const broken = callerFor(brokenHarness, "alice@example.test");
  await assert.rejects(broken.caller.getTemperatureDiagnostics(), {
    code: "INTERNAL_SERVER_ERROR",
  });
  assert.equal(
    JSON.stringify(brokenHarness.state.logs).includes(secret),
    false,
  );

  const retentionHarness = createHarness({
    diagnostics: [
      {
        id: "old",
        email: "alice@example.test",
        startedAt: new Date("2026-10-01T00:00:00Z"),
        diagnostic: {},
      },
      {
        id: "new",
        email: "alice@example.test",
        startedAt: new Date("2026-10-26T00:00:00Z"),
        diagnostic: {},
      },
    ],
  });
  await retentionHarness
    .load("~/server/temperature-diagnostics")
    .pruneTemperatureDiagnostics();
  assert.deepEqual(
    retentionHarness.state.diagnostics.map(({ id }) => id),
    ["new"],
  );
  assert.equal(retentionHarness.state.writes.length, 1);
  assert.equal(
    retentionHarness.state.writes[0].target.name,
    schema.temperatureDiagnostics.name,
  );
});

test("history returns only the newest 100 records to bound the response", async () => {
  const harness = createHarness({
    diagnostics: Array.from({ length: 110 }, (_, index) => ({
      id: `run-${index}`,
      email: "alice@example.test",
      startedAt: new Date(Date.parse("2026-10-26T00:00:00Z") + index * 1000),
      diagnostic: { id: `run-${index}` },
    })),
  });
  const { caller } = callerFor(harness, "alice@example.test");
  const result = await caller.getTemperatureDiagnostics();
  assert.equal(result.runs.length, 100);
  assert.equal(result.runs[0].id, "run-109");
  assert.equal(result.runs[99].id, "run-10");
});

test(
  "hung diagnostic start, finish and cleanup writes cannot stop temperature commands, and late failures stay handled",
  { timeout: 5000 },
  async () => {
    const rejectWrites = [];
    const harness = createHarness({
      beforeDiagnosticWrite: () =>
        new Promise((_resolve, reject) => {
          rejectWrites.push(reject);
        }),
    });
    const response = await harness
      .load("~/app/api/temperatureCron/route")
      .GET(harness.request());
    assert.equal(response.status, 200);
    assert.equal((await response.json()).successCount, 1);
    assert.equal(harness.state.requests.length, 1);
    assert.equal(
      JSON.parse(harness.state.requests[0].init.body).currentLevel,
      0,
    );
    assert.equal(rejectWrites.length, 3);
    assert.deepEqual(
      logsFor(harness, "diagnostic-persistence-failed").map(
        ({ details }) => details.error.code,
      ),
      ["DIAGNOSTIC_STORAGE_TIMEOUT", "DIAGNOSTIC_STORAGE_TIMEOUT"],
    );
    assert.equal(
      logsFor(harness, "diagnostic-retention-failed")[0].details.error.code,
      "DIAGNOSTIC_STORAGE_TIMEOUT",
    );
    for (const reject of rejectWrites)
      reject(new Error("private-late-database-error"));
    // Node's test runner fails the test on an unhandled rejection after this turn.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      JSON.stringify(harness.state.logs).includes(
        "private-late-database-error",
      ),
      false,
    );
  },
);

test(
  "a delayed initial history insert cannot replace an already completed record",
  { timeout: 5000 },
  async () => {
    let releaseInitial;
    const initialWrite = new Promise((resolve) => {
      releaseInitial = resolve;
    });
    const harness = createHarness({
      beforeDiagnosticWrite: (operation) =>
        operation.kind === "insert" &&
        operation.values.diagnostic.outcome === "running"
          ? initialWrite
          : undefined,
    });
    await harness
      .load("~/app/api/temperatureCron/route")
      .GET(harness.request());
    assert.equal(harness.state.diagnostics.length, 1);
    const completed = plain(harness.state.diagnostics[0].diagnostic);
    assert.equal(completed.outcome, "ok");
    assert.ok(completed.finishedAt);
    assert.ok(
      completed.events.some(({ event }) => event === "set-level-accepted"),
    );
    releaseInitial();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(plain(harness.state.diagnostics[0].diagnostic), completed);
  },
);

test(
  "a timed-out readback is diagnostic only and does not block the next account",
  { timeout: 5000 },
  async () => {
    const harness = createHarness({
      profiles: [profile("alice@example.test"), profile("bob@example.test")],
      getStatus: (_token, options) => {
        if (!options?.signal)
          return {
            isHeating: true,
            heatingLevel: -30,
            targetHeatingLevel: -30,
          };
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(options.signal.reason),
            { once: true },
          );
        });
      },
    });
    const response = await harness
      .load("~/app/api/temperatureCron/route")
      .GET(harness.request());
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      success: true,
      successCount: 2,
      failureCount: 0,
      totalProfiles: 2,
    });
    assert.equal(harness.state.requests.length, 2);
    assert.deepEqual(harness.state.signalTimeouts, [3000, 3000]);
    for (const row of harness.state.diagnostics) {
      assert.equal(row.diagnostic.outcome, "ok");
      const failed = eventsFor(row, "heating-status-readback-failed")[0];
      assert.equal(failed.details.diagnosticOnly, true);
      assert.equal(eventsFor(row, "set-level-accepted").length, 1);
    }
  },
);
