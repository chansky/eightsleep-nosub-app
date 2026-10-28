import type { NextRequest } from "next/server";
import { db } from "~/server/db";
import { userTemperatureProfile, users } from "~/server/db/schema";
import { eq } from "drizzle-orm";
import { obtainFreshAccessToken } from "~/server/eight/auth";
import { type HeatingStatus, type Token } from "~/server/eight/types";
import { setHeatingLevel, turnOnSide, turnOffSide } from "~/server/eight/eight";
import { getCurrentHeatingStatus } from "~/server/eight/user";
import type { DiagnosticSource } from "~/lib/temperature-diagnostics";
import {
  describeDiagnosticError,
  pruneTemperatureDiagnostics,
  recordDiagnosticEvent,
  withTemperatureDiagnostic,
} from "~/server/temperature-diagnostics";

export const runtime = "nodejs";
export const maxDuration = 60;

function createDateWithTime(baseDate: Date, timeString: string): Date {
  const [hours, minutes] = timeString.split(":").map(Number);
  if (
    hours === undefined ||
    minutes === undefined ||
    isNaN(hours) ||
    isNaN(minutes) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    throw new Error(`Invalid time string: ${timeString}`);
  }
  const result = new Date(baseDate);
  result.setHours(hours, minutes, 0, 0);
  return result;
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function isWithinTimeRange(
  current: Date,
  target: Date,
  rangeMinutes: number,
): boolean {
  const diffMs = Math.abs(current.getTime() - target.getTime());
  return diffMs <= rangeMinutes * 60 * 1000;
}

async function retryApiCall<T>(
  operation: string,
  apiCall: () => Promise<T>,
  retries = 3,
): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await apiCall();
    } catch (error) {
      recordDiagnosticEvent("operation-attempt-failed", {
        operation,
        attempt: i + 1,
        attempts: retries,
        willRetry: i < retries - 1,
        error: describeDiagnosticError(error),
      });
      if (i === retries - 1) throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, 1000 * Math.pow(2, i)),
      );
    }
  }
  throw new Error(
    "This should never happen due to the for loop, but TypeScript doesn't know that",
  );
}

interface SleepCycle {
  preHeatingTime: Date;
  bedTime: Date;
  midStageTime: Date;
  finalStageTime: Date;
  wakeupTime: Date;
}

function createSleepCycle(
  baseDate: Date,
  bedTimeStr: string,
  wakeupTimeStr: string,
): SleepCycle {
  const preHeatingTime = createDateWithTime(baseDate, bedTimeStr);
  preHeatingTime.setHours(preHeatingTime.getHours() - 1); // Set pre-heating to 1 hour before bedtime

  const bedTime = createDateWithTime(baseDate, bedTimeStr);
  let wakeupTime = createDateWithTime(baseDate, wakeupTimeStr);

  // Adjust wakeupTime if it's before bedTime (i.e., it's on the next day)
  if (wakeupTime <= bedTime) {
    wakeupTime = addDays(wakeupTime, 1);
  }

  const midStageTime = new Date(bedTime.getTime() + 60 * 60 * 1000);
  const finalStageTime = new Date(wakeupTime.getTime() - 2 * 60 * 60 * 1000);

  return { preHeatingTime, bedTime, midStageTime, finalStageTime, wakeupTime };
}

function adjustTimeToCurrentCycle(
  cycleStart: Date,
  currentTime: Date,
  timeInCycle: Date,
): Date {
  let adjustedTime = new Date(timeInCycle);

  // If the time in the cycle is before the cycle start, it means it's on the next day
  if (timeInCycle < cycleStart) {
    adjustedTime = addDays(adjustedTime, 1);
  }

  // If the adjusted time is in the future relative to the current time, move it back by one day
  if (
    adjustedTime > currentTime &&
    adjustedTime.getTime() - currentTime.getTime() > 12 * 60 * 60 * 1000
  ) {
    adjustedTime = addDays(adjustedTime, -1);
  }

  return adjustedTime;
}

interface TestMode {
  enabled: boolean;
  currentTime: Date;
}

// These are wall-clock values in the profile's timezone, not UTC instants.
function localDateTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function statusDetails(status: HeatingStatus): Record<string, unknown> {
  return {
    isHeating: status.isHeating,
    currentLevel: status.heatingLevel,
    targetLevel: status.targetHeatingLevel,
    heatingDuration: status.heatingDuration,
    levelUnit: "raw (-100..100)",
  };
}

export async function adjustTemperature(
  testMode?: TestMode,
  source: DiagnosticSource = "cron",
): Promise<{
  successCount: number;
  failureCount: number;
  totalProfiles: number;
}> {
  const summary = { successCount: 0, failureCount: 0, totalProfiles: 0 };
  const diagnosticSource = testMode?.enabled ? "test" : source;
  try {
    const profiles = await db
      .select()
      .from(userTemperatureProfile)
      .innerJoin(users, eq(userTemperatureProfile.email, users.email));

    summary.totalProfiles = profiles.length;

    for (const profile of profiles) {
      try {
        const savedProfile = profile.userTemperatureProfiles;
        await withTemperatureDiagnostic(
          {
            email: profile.users.email,
            source: diagnosticSource,
            profile: {
              bedTime: savedProfile.bedTime,
              wakeupTime: savedProfile.wakeupTime,
              timezone: savedProfile.timezoneTZ,
              initialSleepLevel: savedProfile.initialSleepLevel,
              midStageSleepLevel: savedProfile.midStageSleepLevel,
              finalSleepLevel: savedProfile.finalSleepLevel,
              updatedAt: savedProfile.updatedAt.toISOString(),
            },
          },
          async () => {
            let token: Token = {
              eightAccessToken: profile.users.eightAccessToken,
              eightRefreshToken: profile.users.eightRefreshToken,
              eightExpiresAtPosix: profile.users.eightTokenExpiresAt.getTime(),
              eightUserId: profile.users.eightUserId,
            };

            const now = testMode?.enabled ? testMode.currentTime : new Date();
            const tokenExpiry = {
              expiresAtUtc: new Date(token.eightExpiresAtPosix).toISOString(),
              secondsUntilExpiry: Math.round(
                (token.eightExpiresAtPosix - now.getTime()) / 1000,
              ),
            };

            if (
              !testMode?.enabled &&
              now.getTime() > token.eightExpiresAtPosix
            ) {
              recordDiagnosticEvent("token-refresh-started", tokenExpiry);
              try {
                token = await obtainFreshAccessToken(
                  token.eightRefreshToken,
                  token.eightUserId,
                );
                await db
                  .update(users)
                  .set({
                    eightAccessToken: token.eightAccessToken,
                    eightRefreshToken: token.eightRefreshToken,
                    eightTokenExpiresAt: new Date(token.eightExpiresAtPosix),
                  })
                  .where(eq(users.email, profile.users.email));
                recordDiagnosticEvent("token-refresh-succeeded", {
                  expiresAtUtc: new Date(
                    token.eightExpiresAtPosix,
                  ).toISOString(),
                  secondsUntilExpiry: Math.round(
                    (token.eightExpiresAtPosix - Date.now()) / 1000,
                  ),
                });
              } catch (error) {
                recordDiagnosticEvent("token-refresh-failed", {
                  error: describeDiagnosticError(error),
                });
                throw error;
              }
            } else {
              recordDiagnosticEvent("token-refresh-skipped", {
                reason: testMode?.enabled ? "test-mode" : "token-not-expired",
                ...tokenExpiry,
              });
            }

            const userTemperatureProfile = profile.userTemperatureProfiles;
            const userNow = new Date(
              now.toLocaleString("en-US", {
                timeZone: userTemperatureProfile.timezoneTZ,
              }),
            );

            recordDiagnosticEvent("schedule-clock", {
              instantUtc: now.toISOString(),
              localTime: localDateTime(userNow),
              timezone: userTemperatureProfile.timezoneTZ,
              calculationHostTimezone:
                Intl.DateTimeFormat().resolvedOptions().timeZone,
              simulated: !!testMode?.enabled,
            });

            // Create the sleep cycle based on the user's bed time and wake-up time
            const sleepCycle = createSleepCycle(
              userNow,
              userTemperatureProfile.bedTime,
              userTemperatureProfile.wakeupTime,
            );

            // Adjust all times in the cycle to the current day
            const cycleStart = sleepCycle.preHeatingTime;
            const adjustedCycle: SleepCycle = {
              preHeatingTime: adjustTimeToCurrentCycle(
                cycleStart,
                userNow,
                sleepCycle.preHeatingTime,
              ),
              bedTime: adjustTimeToCurrentCycle(
                cycleStart,
                userNow,
                sleepCycle.bedTime,
              ),
              midStageTime: adjustTimeToCurrentCycle(
                cycleStart,
                userNow,
                sleepCycle.midStageTime,
              ),
              finalStageTime: adjustTimeToCurrentCycle(
                cycleStart,
                userNow,
                sleepCycle.finalStageTime,
              ),
              wakeupTime: adjustTimeToCurrentCycle(
                cycleStart,
                userNow,
                sleepCycle.wakeupTime,
              ),
            };

            recordDiagnosticEvent("adjusted-boundaries", {
              preHeating: localDateTime(adjustedCycle.preHeatingTime),
              bedTime: localDateTime(adjustedCycle.bedTime),
              midStage: localDateTime(adjustedCycle.midStageTime),
              finalStage: localDateTime(adjustedCycle.finalStageTime),
              wakeup: localDateTime(adjustedCycle.wakeupTime),
              timezone: userTemperatureProfile.timezoneTZ,
            });

            let heatingStatus: HeatingStatus;
            if (testMode?.enabled) {
              heatingStatus = {
                isHeating: false,
                heatingLevel: 0,
                targetHeatingLevel: 0,
                heatingDuration: 0,
              };
            } else {
              heatingStatus = await retryApiCall("get-heating-status", () =>
                getCurrentHeatingStatus(token),
              );
            }
            recordDiagnosticEvent("heating-status-before", {
              ...statusDetails(heatingStatus),
              simulated: !!testMode?.enabled,
            });

            const isNearPreHeating = isWithinTimeRange(
              userNow,
              adjustedCycle.preHeatingTime,
              15,
            );
            const isNearBedTime = isWithinTimeRange(
              userNow,
              adjustedCycle.bedTime,
              15,
            );
            const isNearMidStage = isWithinTimeRange(
              userNow,
              adjustedCycle.midStageTime,
              15,
            );
            const isNearFinalStage = isWithinTimeRange(
              userNow,
              adjustedCycle.finalStageTime,
              15,
            );
            const isNearWakeup = isWithinTimeRange(
              userNow,
              adjustedCycle.wakeupTime,
              15,
            );

            // Determine current sleep stage
            let currentSleepStage = "outside sleep cycle";
            if (
              userNow >= adjustedCycle.preHeatingTime &&
              userNow < adjustedCycle.bedTime
            ) {
              currentSleepStage = "pre-heating";
            } else if (
              userNow >= adjustedCycle.bedTime &&
              userNow < adjustedCycle.midStageTime
            ) {
              currentSleepStage = "initial";
            } else if (
              userNow >= adjustedCycle.midStageTime &&
              userNow < adjustedCycle.finalStageTime
            ) {
              currentSleepStage = "mid";
            } else if (
              userNow >= adjustedCycle.finalStageTime &&
              userNow < adjustedCycle.wakeupTime
            ) {
              currentSleepStage = "final";
            }

            const minutesFrom = (boundary: Date) =>
              Math.round((userNow.getTime() - boundary.getTime()) / 600) / 100;
            recordDiagnosticEvent("schedule-evaluation", {
              currentSleepStage,
              windowMinutes: 15,
              windowIsSymmetric: true,
              minutesFromBoundary: {
                preHeating: minutesFrom(adjustedCycle.preHeatingTime),
                bedTime: minutesFrom(adjustedCycle.bedTime),
                midStage: minutesFrom(adjustedCycle.midStageTime),
                finalStage: minutesFrom(adjustedCycle.finalStageTime),
                wakeup: minutesFrom(adjustedCycle.wakeupTime),
              },
              withinWindow: {
                preHeating: isNearPreHeating,
                bedTime: isNearBedTime,
                midStage: isNearMidStage,
                finalStage: isNearFinalStage,
                wakeup: isNearWakeup,
              },
            });

            let writeAttempted = false;
            let commandedLevel: number | null = null;
            try {
              if (
                isNearPreHeating ||
                isNearBedTime ||
                isNearMidStage ||
                isNearFinalStage ||
                isNearWakeup
              ) {
                let targetLevel: number;
                let sleepStage: string;

                if (
                  isNearPreHeating ||
                  (isNearBedTime && userNow < adjustedCycle.bedTime)
                ) {
                  targetLevel = userTemperatureProfile.initialSleepLevel;
                  sleepStage = "pre-heating";
                } else if (
                  isNearBedTime ||
                  (isNearMidStage && userNow < adjustedCycle.midStageTime)
                ) {
                  targetLevel = userTemperatureProfile.initialSleepLevel;
                  sleepStage = "initial";
                } else if (
                  isNearMidStage ||
                  (isNearFinalStage && userNow < adjustedCycle.finalStageTime)
                ) {
                  targetLevel = userTemperatureProfile.midStageSleepLevel;
                  sleepStage = "mid";
                } else {
                  targetLevel = userTemperatureProfile.finalSleepLevel;
                  sleepStage = "final";
                }

                recordDiagnosticEvent("command-stage-selected", {
                  currentSleepStage,
                  selectedCommandStage: sleepStage,
                  targetLevel,
                  currentLevel: heatingStatus.heatingLevel,
                  reportedTargetLevel: heatingStatus.targetHeatingLevel,
                  comparisonField: "currentLevel",
                });

                if (!heatingStatus.isHeating) {
                  if (testMode?.enabled) {
                    recordDiagnosticEvent("would-turn-on", {});
                  } else {
                    recordDiagnosticEvent("turn-on-requested", {});
                    writeAttempted = true;
                    await retryApiCall("turn-on", () =>
                      turnOnSide(token, profile.users.eightUserId),
                    );
                    recordDiagnosticEvent("turn-on-accepted", {});
                  }
                } else {
                  recordDiagnosticEvent("turn-on-skipped", {
                    reason: "already-on",
                  });
                }
                if (heatingStatus.heatingLevel !== targetLevel) {
                  if (testMode?.enabled) {
                    recordDiagnosticEvent("would-set-level", { targetLevel });
                  } else {
                    commandedLevel = targetLevel;
                    recordDiagnosticEvent("set-level-requested", {
                      targetLevel,
                    });
                    writeAttempted = true;
                    await retryApiCall("set-heating-level", () =>
                      setHeatingLevel(
                        token,
                        profile.users.eightUserId,
                        targetLevel,
                      ),
                    );
                    recordDiagnosticEvent("set-level-accepted", {
                      targetLevel,
                    });
                  }
                } else {
                  recordDiagnosticEvent("set-level-skipped", {
                    reason: "level-already-matches",
                    targetLevel,
                    currentLevel: heatingStatus.heatingLevel,
                    reportedTargetLevel: heatingStatus.targetHeatingLevel,
                  });
                }
              } else if (
                heatingStatus.isHeating &&
                userNow > adjustedCycle.wakeupTime &&
                !isWithinTimeRange(userNow, adjustedCycle.wakeupTime, 15)
              ) {
                // Only turn off heating if it's more than 15 minutes past wake-up time
                if (testMode?.enabled) {
                  recordDiagnosticEvent("would-turn-off", {
                    reason: "past-wakeup-window",
                  });
                } else {
                  recordDiagnosticEvent("turn-off-requested", {
                    reason: "past-wakeup-window",
                  });
                  writeAttempted = true;
                  await retryApiCall("turn-off", () =>
                    turnOffSide(token, profile.users.eightUserId),
                  );
                  recordDiagnosticEvent("turn-off-accepted", {});
                }
              } else {
                const missedFinalWindow =
                  currentSleepStage === "final" &&
                  minutesFrom(adjustedCycle.finalStageTime) > 15 &&
                  heatingStatus.heatingLevel !==
                    userTemperatureProfile.finalSleepLevel &&
                  heatingStatus.targetHeatingLevel !==
                    userTemperatureProfile.finalSleepLevel;
                recordDiagnosticEvent("temperature-change-skipped", {
                  reason: missedFinalWindow
                    ? "missed-final-window"
                    : "outside-window",
                  currentSleepStage,
                  selectedCommandStage: null,
                  currentLevel: heatingStatus.heatingLevel,
                  reportedTargetLevel: heatingStatus.targetHeatingLevel,
                  configuredFinalLevel: userTemperatureProfile.finalSleepLevel,
                });
              }
            } finally {
              if (writeAttempted && !testMode?.enabled) {
                try {
                  const observed = await getCurrentHeatingStatus(token, {
                    cache: "no-store",
                    signal: AbortSignal.timeout(3_000),
                  });
                  recordDiagnosticEvent("heating-status-readback", {
                    ...statusDetails(observed),
                    commandedLevel,
                    reportedTargetMatchesCommand:
                      commandedLevel === null
                        ? null
                        : observed.targetHeatingLevel === commandedLevel,
                    observation:
                      "immediate-api-readback; not confirmation of physical temperature",
                  });
                } catch (error) {
                  recordDiagnosticEvent("heating-status-readback-failed", {
                    error: describeDiagnosticError(error),
                    diagnosticOnly: true,
                  });
                }
              }
            }
          },
        );
        summary.successCount += 1;
      } catch (error) {
        summary.failureCount += 1;
        recordDiagnosticEvent("profile-adjustment-failed", {
          error: describeDiagnosticError(error),
        });
      }
    }
    if (diagnosticSource !== "test") await pruneTemperatureDiagnostics();
    recordDiagnosticEvent("adjustment-run-completed", {
      source: diagnosticSource,
      ...summary,
    });
    return summary;
  } catch (error) {
    recordDiagnosticEvent("profile-query-failed", {
      error: describeDiagnosticError(error),
    });
    throw error;
  }
}

export async function GET(request: NextRequest): Promise<Response> {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  } else {
    try {
      const testTimeParam = request.nextUrl.searchParams.get("testTime");
      let summary;
      if (testTimeParam) {
        const testTime = new Date(Number(testTimeParam) * 1000);
        if (isNaN(testTime.getTime())) {
          throw new Error("Invalid testTime parameter");
        }
        summary = await adjustTemperature({
          enabled: true,
          currentTime: testTime,
        });
      } else {
        summary = await adjustTemperature();
      }
      const success = summary.failureCount === 0;
      // Keep completed batches HTTP 200: repeated per-account API failures must
      // not cause the external scheduler to disable checks for healthy accounts.
      return Response.json({ success, ...summary });
    } catch (error) {
      recordDiagnosticEvent("cron-run-failed", {
        error: describeDiagnosticError(error),
      });
      return new Response("Internal server error", { status: 500 });
    }
  }
}
