import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { initTRPC } from "@trpc/server";

const root = fileURLToPath(new URL("../../", import.meta.url));
const nativeRequire = createRequire(path.join(root, "package.json"));

function table(name, columns) {
  return Object.fromEntries([
    ["name", name],
    ...columns.map((column) => [column, { table: name, column }]),
  ]);
}

export const schema = {
  users: table("users", ["email"]),
  userTemperatureProfile: table("profiles", ["email"]),
  temperatureDiagnostics: table("diagnostics", [
    "id",
    "email",
    "startedAt",
    "diagnostic",
  ]),
};

const expression =
  (operation) =>
  (...args) => ({ operation, args });

function matches(row, filter) {
  if (!filter) return true;
  const [column, value] = filter.args;
  if (filter.operation === "and")
    return filter.args.every((part) => matches(row, part));
  if (filter.operation === "or")
    return filter.args.some((part) => matches(row, part));
  const source =
    column.table === "profiles"
      ? (row.userTemperatureProfiles ?? row)
      : column.table === "users"
        ? (row.users ?? row)
        : row;
  if (filter.operation === "eq") return source[column.column] === value;
  if (filter.operation === "lt") return source[column.column] < value;
  if (filter.operation === "gte") return source[column.column] >= value;
  throw new Error(`Unsupported test filter: ${filter.operation}`);
}

export function profile(email, overrides = {}) {
  return {
    users: {
      email,
      eightUserId: `private-user-${email}`,
      eightAccessToken: `private-access-${email}`,
      eightRefreshToken: `private-refresh-${email}`,
      eightTokenExpiresAt: new Date("2100-01-01T00:00:00Z"),
    },
    userTemperatureProfiles: {
      email,
      bedTime: "21:00:00",
      wakeupTime: "06:30:00",
      timezoneTZ: "America/Los_Angeles",
      initialSleepLevel: -20,
      midStageSleepLevel: -30,
      finalSleepLevel: 0,
      updatedAt: new Date("2026-10-27T00:00:00Z"),
      ...overrides,
    },
  };
}

// Execute the real TS server modules with only I/O replaced. Every test owns its
// module cache, clock, database, logger and network boundary; no live calls occur.
export function createHarness(options = {}) {
  const state = {
    profiles: options.profiles ?? [profile("sleeper@example.test")],
    diagnostics: options.diagnostics ?? [],
    writes: [],
    queries: [],
    requests: [],
    logs: [],
    statusReads: [],
    tokenRefreshes: [],
    signalTimeouts: [],
  };
  const now = new Date(options.now ?? "2026-10-27T04:30:10-07:00");
  class Clock extends Date {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }
    static now() {
      return now.getTime();
    }
  }
  const consoleMock = Object.fromEntries(
    ["log", "info", "warn", "error"].map((level) => [
      level,
      (...args) => state.logs.push({ level, args }),
    ]),
  );

  function builder(kind, target, selection) {
    const operation = { kind, target, selection };
    let promise;
    function execute() {
      promise ??= Promise.resolve().then(async () => {
        const { target, filter } = operation;
        if (kind === "select") {
          state.queries.push(operation);
          if (
            target === schema.temperatureDiagnostics &&
            options.diagnosticReadError
          )
            throw options.diagnosticReadError;
          if (
            target === schema.userTemperatureProfile &&
            options.profileReadError
          )
            throw options.profileReadError;
          let rows =
            target === schema.temperatureDiagnostics
              ? state.diagnostics
              : target === schema.users
                ? state.profiles.map((row) => row.users)
                : state.profiles;
          rows = rows.filter((row) => matches(row, filter));
          if (operation.orderBy && target === schema.temperatureDiagnostics) {
            rows = [...rows].sort(
              (a, b) => Number(b.startedAt) - Number(a.startedAt),
            );
          }
          if (operation.limit !== undefined)
            rows = rows.slice(0, operation.limit);
          if (selection)
            rows = rows.map((row) =>
              Object.fromEntries(
                Object.keys(selection).map((key) => [key, row[key]]),
              ),
            );
          return rows;
        }
        state.writes.push(structuredClone(operation));
        if (target === schema.temperatureDiagnostics) {
          await options.beforeDiagnosticWrite?.(operation);
        }
        if (
          target === schema.temperatureDiagnostics &&
          options.diagnosticWriteError
        )
          throw options.diagnosticWriteError;
        if (target === schema.temperatureDiagnostics && kind === "insert") {
          const existing = state.diagnostics.findIndex(
            (row) => row.id === operation.values.id,
          );
          const saved = structuredClone(operation.values);
          if (existing < 0) state.diagnostics.push(saved);
          else if (!operation.ignoreConflict)
            state.diagnostics[existing] = {
              ...state.diagnostics[existing],
              ...(operation.conflict?.set ?? saved),
            };
        }
        if (target === schema.temperatureDiagnostics && kind === "update") {
          state.diagnostics = state.diagnostics.map((row) =>
            matches(row, filter)
              ? { ...row, ...structuredClone(operation.values) }
              : row,
          );
        }
        if (target === schema.temperatureDiagnostics && kind === "delete") {
          state.diagnostics = state.diagnostics.filter(
            (row) => !matches(row, filter),
          );
        }
        return { rowCount: 1 };
      });
      return promise;
    }
    const chain = {
      from(value) {
        operation.target = value;
        return chain;
      },
      innerJoin() {
        return chain;
      },
      where(value) {
        operation.filter = value;
        return chain;
      },
      orderBy(value) {
        operation.orderBy = value;
        return chain;
      },
      limit(value) {
        operation.limit = value;
        return chain;
      },
      values(value) {
        operation.values = value;
        return chain;
      },
      set(value) {
        operation.values = value;
        return chain;
      },
      onConflictDoUpdate(value) {
        operation.conflict = value;
        return chain;
      },
      onConflictDoNothing() {
        operation.ignoreConflict = true;
        return chain;
      },
      execute,
      then(resolve, reject) {
        return execute().then(resolve, reject);
      },
    };
    return chain;
  }

  const db = {
    select: (selection) => builder("select", undefined, selection),
    insert: (target) => builder("insert", target),
    update: (target) => builder("update", target),
    delete: (target) => builder("delete", target),
    query: {
      userTemperatureProfile: {
        findFirst: async ({ where }) =>
          state.profiles.find((row) => matches(row, where))
            ?.userTemperatureProfiles,
      },
    },
  };
  class AuthError extends Error {
    constructor(message, statusCode) {
      super(message);
      this.name = "AuthError";
      this.statusCode = statusCode;
    }
  }
  const trpc = initTRPC.create();
  const mocks = {
    "server-only": {},
    "~/server/db": { db },
    "~/server/db/schema": schema,
    "drizzle-orm": Object.fromEntries(
      ["eq", "lt", "gte", "and", "or", "desc"].map((name) => [
        name,
        expression(name),
      ]),
    ),
    "next/headers": { cookies: () => ({ set() {} }) },
    "~/server/api/trpc": {
      createTRPCRouter: trpc.router,
      publicProcedure: trpc.procedure,
    },
    "~/server/eight/auth": {
      AuthError,
      obtainFreshAccessToken: async (...args) => {
        state.tokenRefreshes.push(args);
        if (options.refreshError) throw options.refreshError;
        throw new Error("Unexpected token refresh in test");
      },
    },
    "~/server/eight/user": {
      getCurrentHeatingStatus: async (token, requestOptions) => {
        state.statusReads.push({
          userId: token.eightUserId,
          options: requestOptions,
        });
        return options.getStatus
          ? options.getStatus(token, requestOptions)
          : { isHeating: true, heatingLevel: -30, targetHeatingLevel: -30 };
      },
    },
    ...options.mocks,
  };
  const context = vm.createContext({
    Date: Clock,
    Error,
    TypeError,
    RangeError,
    URL,
    URLSearchParams,
    Headers,
    Response,
    structuredClone,
    AbortSignal: {
      timeout(milliseconds) {
        state.signalTimeouts.push(milliseconds);
        const controller = new AbortController();
        setTimeout(
          () =>
            controller.abort(
              new DOMException("Test readback deadline", "TimeoutError"),
            ),
          Math.min(milliseconds, 5),
        );
        return controller.signal;
      },
    },
    process: {
      env: {
        CRON_SECRET: "test-cron-secret",
        JWT_SECRET: "test-jwt-secret",
        NODE_ENV: "test",
      },
    },
    console: consoleMock,
    // Keep timers asynchronous so successful I/O wins its deadline. Cap delays
    // to exercise retry and timeout behavior without seconds of test latency.
    setTimeout: (fn, milliseconds) => setTimeout(fn, Math.min(milliseconds, 5)),
    clearTimeout,
    fetch: async (url, init = {}) => {
      state.requests.push({ url, init });
      if (options.fetch) return options.fetch(url, init);
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const cache = new Map();
  function load(specifier, from = path.join(root, "placeholder.ts")) {
    if (Object.hasOwn(mocks, specifier)) return mocks[specifier];
    if (!specifier.startsWith("~/") && !specifier.startsWith("."))
      return nativeRequire(specifier);
    let filename = specifier.startsWith("~/")
      ? path.join(root, "src", specifier.slice(2))
      : path.resolve(path.dirname(from), specifier);
    if (!path.extname(filename))
      filename += existsSync(`${filename}.ts`) ? ".ts" : "/index.ts";
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), {
      fileName: filename,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
    });
    const compiled = vm.runInContext(
      `(function(require, module, exports) {\n${outputText}\n})`,
      context,
      { filename },
    );
    compiled((name) => load(name, filename), module, module.exports);
    return module.exports;
  }
  return {
    state,
    load,
    request: (search = "") => ({
      headers: new Headers({ authorization: "Bearer test-cron-secret" }),
      nextUrl: new URL(`https://app.example.test/api/temperatureCron${search}`),
    }),
  };
}
