import assert from "node:assert/strict";
import test from "node:test";
import jwt from "jsonwebtoken";
import { createHarness, profile } from "./helpers/server-harness.mjs";

const configured = (overrides = {}) =>
  profile("sleeper@example.test", {
    bedTime: "21:00:00",
    wakeupTime: "06:35:00",
    finalStageStartTime: "04:00:00",
    midStageSleepLevel: -30,
    finalSleepLevel: 0,
    ...overrides,
  });
const payloads = (harness) =>
  harness.state.requests
    .filter(({ init }) => init.method === "PUT")
    .map(({ init }) => JSON.parse(init.body));
const events = (harness, name) =>
  harness.state.diagnostics
    .flatMap(({ diagnostic }) => diagnostic.events)
    .filter(({ event }) => event === name);

async function checkAt(now, { saved = configured(), status, ...options } = {}) {
  const harness = createHarness({
    now,
    profiles: [saved],
    ...(status ? { getStatus: () => status } : {}),
    ...options,
  });
  const response = await harness
    .load("~/app/api/temperatureCron/route")
    .GET(harness.request());
  assert.equal(response.status, 200);
  assert.equal((await response.json()).failureCount, 0);
  return harness;
}

function profileCaller(harness) {
  const token = jwt.sign({ email: "sleeper@example.test" }, "test-jwt-secret");
  return harness.load("~/server/api/routers/user").userRouter.createCaller({
    headers: new Headers({ cookie: `8slpAutht=${token}` }),
  });
}

function profileInput(overrides = {}) {
  return {
    bedTime: "21:00:00",
    wakeupTime: "06:35:00",
    initialSleepLevel: -20,
    midStageSleepLevel: -30,
    finalSleepLevel: 0,
    timezoneTZ: "America/Los_Angeles",
    ...overrides,
  };
}

test("an explicit 4 a.m. final stage commands zero independently of the 6:35 wake time and catches up on later runs", async () => {
  for (const time of ["04:00:00", "04:30:10", "05:00:10"]) {
    const harness = await checkAt(`2026-10-28T${time}-07:00`);
    assert.deepEqual(
      payloads(harness),
      [{ timeBased: { level: 0, durationSeconds: 0 }, currentLevel: 0 }],
      time,
    );
    const decision = events(harness, "command-stage-selected")[0].details;
    assert.equal(decision.selectedCommandStage, "final", time);
    assert.equal(decision.comparisonField, "reportedTargetLevel", time);
    const boundaries = events(harness, "adjusted-boundaries")[0].details;
    assert.equal(boundaries.finalStage, "2026-10-28T04:00:00", time);
    assert.equal(boundaries.wakeup, "2026-10-28T06:35:00", time);
  }
});

test("the explicit final stage never sends zero before 4 a.m., including the old 15-minute window", async () => {
  for (const time of ["03:30:00", "03:50:00", "03:59:59"]) {
    const harness = await checkAt(`2026-10-28T${time}-07:00`);
    assert.equal(
      payloads(harness).some(({ currentLevel }) => currentLevel === 0),
      false,
      time,
    );
  }
});

test("final control uses the reported target: physical lag does not resend, and a mismatched target is corrected", async () => {
  const converging = await checkAt("2026-10-28T05:00:00-07:00", {
    status: { isHeating: true, heatingLevel: -30, targetHeatingLevel: 0 },
  });
  assert.deepEqual(payloads(converging), []);
  assert.equal(
    events(converging, "set-level-skipped")[0].details.reason,
    "target-already-matches",
  );

  const wrongTarget = await checkAt("2026-10-28T05:00:00-07:00", {
    status: { isHeating: true, heatingLevel: 0, targetHeatingLevel: -30 },
  });
  assert.deepEqual(payloads(wrongTarget), [
    { timeBased: { level: 0, durationSeconds: 0 }, currentLevel: 0 },
  ]);
});

test("turning a side back on reasserts the final target even if its old reported target was zero", async () => {
  const harness = await checkAt("2026-10-28T05:00:00-07:00", {
    status: { isHeating: false, heatingLevel: 0, targetHeatingLevel: 0 },
  });
  assert.deepEqual(payloads(harness), [
    { currentState: { type: "smart" } },
    { timeBased: { level: 0, durationSeconds: 0 }, currentLevel: 0 },
  ]);
});

test("the final stage follows the account's timezone and keeps overnight boundaries in one cycle", async () => {
  for (const [timezoneTZ, instant, localDate] of [
    ["America/Los_Angeles", "2026-10-28T11:00:00Z", "2026-10-28"],
    ["America/New_York", "2026-10-28T08:00:00Z", "2026-10-28"],
    ["Asia/Tokyo", "2026-10-27T19:00:00Z", "2026-10-28"],
  ]) {
    const harness = await checkAt(instant, {
      saved: configured({ timezoneTZ }),
    });
    assert.equal(payloads(harness)[0].currentLevel, 0, timezoneTZ);
    assert.equal(
      events(harness, "adjusted-boundaries")[0].details.finalStage,
      `${localDate}T04:00:00`,
      timezoneTZ,
    );
  }

  const beforeMidnight = await checkAt("2026-10-28T04:00:00-07:00", {
    saved: configured({ finalStageStartTime: "23:30:00" }),
  });
  const boundaries = events(beforeMidnight, "adjusted-boundaries")[0].details;
  assert.equal(boundaries.finalStage, "2026-10-27T23:30:00");
  assert.equal(boundaries.wakeup, "2026-10-28T06:35:00");
  assert.equal(payloads(beforeMidnight)[0].currentLevel, 0);

  const afterMidnightBedtime = await checkAt("2026-10-28T04:00:00-07:00", {
    saved: configured({ bedTime: "00:30:00", wakeupTime: "08:00:00" }),
  });
  assert.equal(
    events(afterMidnightBedtime, "adjusted-boundaries")[0].details.finalStage,
    "2026-10-28T04:00:00",
  );
  assert.equal(payloads(afterMidnightBedtime)[0].currentLevel, 0);
});

test("profiles without an override retain wake-minus-two-hours timing and wakeup shutoff remains unchanged", async () => {
  for (const finalStageStartTime of [undefined, null]) {
    const saved = configured({ finalStageStartTime });
    const early = await checkAt("2026-10-28T04:00:00-07:00", { saved });
    assert.equal(
      payloads(early).some(({ currentLevel }) => currentLevel === 0),
      false,
    );
    const onTime = await checkAt("2026-10-28T04:35:00-07:00", { saved });
    assert.equal(payloads(onTime)[0].currentLevel, 0);
    assert.equal(
      events(onTime, "adjusted-boundaries")[0].details.finalStage,
      "2026-10-28T04:35:00",
    );
    const late = await checkAt("2026-10-28T05:00:00-07:00", { saved });
    assert.equal(payloads(late)[0].currentLevel, 0);
  }
  const afterWake = await checkAt("2026-10-28T07:00:00-07:00");
  assert.deepEqual(payloads(afterWake), [{ currentState: { type: "off" } }]);
  const midday = await checkAt("2026-10-28T12:00:00-07:00", {
    status: { isHeating: false, heatingLevel: -30, targetHeatingLevel: -30 },
  });
  assert.deepEqual(payloads(midday), []);
});

test("profile updates reject an explicit final start outside the sleep cycle", async () => {
  for (const finalStageStartTime of [
    "20:00:00",
    "21:30:00",
    "06:35:00",
    "08:00:00",
  ]) {
    const harness = createHarness({ profiles: [configured()] });
    await assert.rejects(
      profileCaller(harness).updateUserTemperatureProfile(
        profileInput({ finalStageStartTime }),
      ),
      { code: "BAD_REQUEST" },
    );
    assert.equal(harness.state.writes.length, 0, finalStageStartTime);
    assert.equal(harness.state.requests.length, 0, finalStageStartTime);
  }
});

test("omitting the new field preserves an existing override, while explicit null restores automatic timing", async () => {
  const harness = createHarness({ profiles: [configured()] });
  const caller = profileCaller(harness);
  await caller.updateUserTemperatureProfile(
    profileInput({ finalSleepLevel: 10 }),
  );
  assert.equal(
    harness.state.profiles[0].userTemperatureProfiles.finalStageStartTime,
    "04:00:00",
  );
  await assert.rejects(
    caller.updateUserTemperatureProfile(
      profileInput({ bedTime: "05:00:00", wakeupTime: "14:00:00" }),
    ),
    { code: "BAD_REQUEST" },
  );
  assert.equal(
    harness.state.profiles[0].userTemperatureProfiles.bedTime,
    "21:00:00",
  );
  await caller.updateUserTemperatureProfile(
    profileInput({ finalStageStartTime: null }),
  );
  assert.equal(
    harness.state.profiles[0].userTemperatureProfiles.finalStageStartTime,
    null,
  );
});
