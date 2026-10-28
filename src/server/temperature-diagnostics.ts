import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { lt } from "drizzle-orm";
import { ZodError } from "zod";
import type {
  DiagnosticProfile,
  DiagnosticSource,
  TemperatureDiagnostic,
} from "~/lib/temperature-diagnostics";
import { db } from "~/server/db";
import { temperatureDiagnostics } from "~/server/db/schema";

const activeDiagnostic = new AsyncLocalStorage<TemperatureDiagnostic>();
const retentionMs = 7 * 24 * 60 * 60 * 1000;
const diagnosticStorageDeadlineMs = 1_500;

class DiagnosticStorageTimeoutError extends Error {
  readonly code = "DIAGNOSTIC_STORAGE_TIMEOUT";
}

async function withDiagnosticStorageDeadline<T>(
  operation: PromiseLike<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new DiagnosticStorageTimeoutError()),
      diagnosticStorageDeadlineMs,
    );
  });
  try {
    // Promise.race keeps rejection handlers on the database promise even if its
    // deadline wins, so a late database failure cannot become unhandled.
    return await Promise.race([Promise.resolve(operation), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// Never include an exception's message, stack, cause, request, or response body:
// SDK and validation errors can contain credentials or entire API responses.
export function describeDiagnosticError(
  error: unknown,
): Record<string, unknown> {
  const details: Record<string, unknown> = {
    name: error instanceof Error ? error.constructor.name : "UnknownError",
  };
  if (error && typeof error === "object") {
    if ("status" in error && typeof error.status === "number") {
      details.status = error.status;
    } else if ("statusCode" in error && typeof error.statusCode === "number") {
      details.status = error.statusCode;
    }
    if (
      "code" in error &&
      typeof error.code === "string" &&
      /^[A-Z0-9_]{1,40}$/.test(error.code)
    ) {
      details.code = error.code;
    }
  }
  if (error instanceof ZodError) {
    details.issues = error.issues.map(({ path, code }) => ({ path, code }));
  }
  return details;
}

export function recordDiagnosticEvent(
  event: string,
  details: Record<string, unknown>,
): void {
  const diagnostic = activeDiagnostic.getStore();
  const entry = { at: new Date().toISOString(), event, details };
  diagnostic?.events.push(entry);
  console.log(
    JSON.stringify({
      component: "temperature-diagnostics",
      diagnosticId: diagnostic?.id ?? null,
      source: diagnostic?.source ?? null,
      ...entry,
    }),
  );
}

async function persistDiagnostic(
  email: string,
  diagnostic: TemperatureDiagnostic,
): Promise<void> {
  try {
    // Serialize a snapshot now; later events must not mutate the initial running row.
    const snapshot = structuredClone(diagnostic);
    const insert = db.insert(temperatureDiagnostics).values({
      id: snapshot.id,
      email,
      startedAt: new Date(snapshot.startedAt),
      diagnostic: snapshot,
    });
    await withDiagnosticStorageDeadline(
      snapshot.finishedAt
        ? insert.onConflictDoUpdate({
            target: temperatureDiagnostics.id,
            set: { diagnostic: snapshot },
          })
        : // A timed-out start write can finish after the final write. It must
          // never replace the completed snapshot with the initial running row.
          insert.onConflictDoNothing({ target: temperatureDiagnostics.id }),
    );
  } catch (error) {
    recordDiagnosticEvent("diagnostic-persistence-failed", {
      phase: diagnostic.finishedAt ? "finish" : "start",
      error: describeDiagnosticError(error),
    });
  }
}

export async function pruneTemperatureDiagnostics(): Promise<void> {
  try {
    // Only this diagnostic table is subject to retention; never delete profiles/users.
    await withDiagnosticStorageDeadline(
      db
        .delete(temperatureDiagnostics)
        .where(
          lt(
            temperatureDiagnostics.startedAt,
            new Date(Date.now() - retentionMs),
          ),
        ),
    );
  } catch (error) {
    recordDiagnosticEvent("diagnostic-retention-failed", {
      error: describeDiagnosticError(error),
    });
  }
}

export async function withTemperatureDiagnostic(
  options: {
    email: string;
    source: DiagnosticSource;
    profile: DiagnosticProfile;
  },
  callback: () => Promise<void>,
): Promise<void> {
  const diagnostic: TemperatureDiagnostic = {
    id: randomUUID(),
    source: options.source,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    outcome: "running",
    profile: options.profile,
    events: [],
  };
  await activeDiagnostic.run(diagnostic, async () => {
    recordDiagnosticEvent("profile-check-started", {
      profile: options.profile,
      levelUnit: "raw (-100..100)",
    });
    if (options.source !== "test")
      await persistDiagnostic(options.email, diagnostic);
    try {
      await callback();
      diagnostic.outcome = "ok";
      recordDiagnosticEvent("profile-check-completed", { outcome: "ok" });
    } catch (error) {
      diagnostic.outcome = "error";
      recordDiagnosticEvent("profile-check-failed", {
        error: describeDiagnosticError(error),
      });
      throw error;
    } finally {
      diagnostic.finishedAt = new Date().toISOString();
      if (options.source !== "test")
        await persistDiagnostic(options.email, diagnostic);
    }
  });
}
