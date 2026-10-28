import { z } from "zod";
import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";
import { db } from "~/server/db";
import { temperatureDiagnostics, users, userTemperatureProfile } from "~/server/db/schema";
import { cookies } from "next/headers";
import {
  authenticate,
  obtainFreshAccessToken,
  AuthError,
} from "~/server/eight/auth";
import { and, desc, eq, gte } from "drizzle-orm";
import { type Token } from "~/server/eight/types";
import { TRPCError } from "@trpc/server";
import { adjustTemperature } from "~/app/api/temperatureCron/route";
import jwt from "jsonwebtoken";
import { getTemperatureSchedule } from "~/lib/temperature-schedule";

class DatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseError";
  }
}

// Database errors can contain query parameters, including stored credentials.
// Keep authentication and database logging to an explicit, safe classification.
function logUserError(context: string, error: unknown) {
  console.error(context, {
    kind: error instanceof AuthError ? "auth"
      : error instanceof TRPCError ? "rpc"
      : error instanceof DatabaseError ? "database" : "unexpected",
    status: error instanceof AuthError ? error.statusCode : undefined,
  });
}

const checkAuthCookie = async (headers: Headers) => {
  const cookies = headers.get("cookie");
  if (!cookies) {
    throw new AuthError(`Auth request failed. No cookies found.`, 401);
  }

  const token = cookies
    .split("; ")
    .find((row) => row.startsWith("8slpAutht="))
    ?.split("=")[1];

  if (!token) {
    throw new AuthError(`Auth request failed. No cookies found.`, 401);
  }
  let decoded;
  try {
    decoded = z.object({ email: z.string().email() }).parse(
      jwt.verify(token, process.env.JWT_SECRET!),
    );
  } catch {
    throw new AuthError(`Auth request failed. Invalid token.`, 401);
  }

  return decoded;
};

export const userRouter = createTRPCRouter({
  checkLoginState: publicProcedure.query(async ({ ctx }) => {
    try {
      let decoded;
      try {
        decoded = await checkAuthCookie(ctx.headers);
      } catch (error) {
        if (error instanceof AuthError) {
          return { loginRequired: true };
        }
        throw error;
      }
      const email = decoded.email;

      const userList = await db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .execute();

      if (userList.length !== 1 || userList[0] === undefined) {
        return { loginRequired: true };
      }

      const user = userList[0];

      // check if token is expired, and if so, refresh it
      if (user.eightTokenExpiresAt < new Date()) {
        console.log("Token expired, refreshing for user", user.email);
        try {
          const {
            eightAccessToken,
            eightRefreshToken,
            eightExpiresAtPosix: expiresAt,
          } = await obtainFreshAccessToken(
            user.eightRefreshToken,
            user.eightUserId,
          );

          await db
            .update(users)
            .set({
              eightAccessToken,
              eightRefreshToken,
              eightTokenExpiresAt: new Date(expiresAt),
            })
            .where(eq(users.email, email))
            .execute();

          return { loginRequired: false };
        } catch (error) {
          logUserError("Token renewal failed", error);
          return { loginRequired: true };
        }
      }
      return { loginRequired: false };
    } catch (error) {
      logUserError("Error in checkLoginState", error);
      throw new Error(
        "An unexpected error occurred while checking login state.",
      );
    }
  }),

  login: publicProcedure
    .input(
      z.object({
        email: z.string().email(),
        password: z.string(),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        const authResult = await authenticateUser(input.email, input.password);

        const approvedEmails = process.env.APPROVED_EMAILS!.split(",").map(email => email.toLowerCase());

        if (!approvedEmails.includes(input.email.toLowerCase())) {
          throw new AuthError("Email not approved");
        }

        await saveUserToDatabase(input.email, authResult);

        const jwtSecret = process.env.JWT_SECRET;
        if (!jwtSecret) {
          throw new Error("JWT_SECRET is not defined in the environment");
        }

        const token = jwt.sign({ email: input.email }, jwtSecret, {
          expiresIn: "90d",
        });
        const threeMonthsInSeconds = 90 * 24 * 60 * 60; // 90 days

        cookies().set("8slpAutht", token, {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "strict",
          maxAge: threeMonthsInSeconds,
          path: "/",
        });
        console.log("Saving token to cookie.");

        // Set HTTP-only cookie
        return {
          success: true,
        };
      } catch (error) {
        logUserError("Error in login process", error);
        if (error instanceof AuthError) {
          throw new Error(`Authentication failed: ${error.message}`);
        } else if (error instanceof DatabaseError) {
          throw new Error(
            "Failed to save login information. Please try again.",
          );
        } else {
          throw new Error(
            "An unexpected error occurred. Please try again later.",
          );
        }
      }
    }),
  logout: publicProcedure.mutation(async () => {
    try {
      cookies().set("8slpAutht", "", {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        maxAge: 0,
        path: "/",
      });
      return {
        success: true,
      };
    } catch (error) {
      logUserError("Error during logout", error);
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "An unexpected error occurred during logout.",
      });
    }
  }),

  getUserTemperatureProfile: publicProcedure.query(async ({ ctx }) => {
    try {
      const decoded = await checkAuthCookie(ctx.headers);

      const profile = await db.query.userTemperatureProfile.findFirst({
        where: eq(userTemperatureProfile.email, decoded.email),
      });

      if (!profile) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Temperature profile not found for this user.",
        });
      }

      return profile;
    } catch (error) {
      logUserError("Error fetching user temperature profile", error);
      if (error instanceof TRPCError) throw error;
      if (error instanceof AuthError) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Please sign in again to edit your temperature profile." });
      }
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message:
          "An unexpected error occurred while fetching the temperature profile.",
      });
    }
  }),

  getTemperatureDiagnostics: publicProcedure.query(async ({ ctx }) => {
    let email: string;
    try {
      email = (await checkAuthCookie(ctx.headers)).email;
    } catch {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "Please sign in again to view temperature history.",
      });
    }

    try {
      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const rows = await db
        .select({ diagnostic: temperatureDiagnostics.diagnostic })
        .from(temperatureDiagnostics)
        .where(and(
          eq(temperatureDiagnostics.email, email),
          gte(temperatureDiagnostics.startedAt, cutoff),
        ))
        .orderBy(desc(temperatureDiagnostics.startedAt))
        // Bound the JSON response even when many requests/retries were recorded.
        .limit(100);

      return { email, runs: rows.map((row) => row.diagnostic) };
    } catch (error) {
      logUserError("Error fetching temperature diagnostics", error);
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Temperature history could not be loaded. Try Refresh; if this continues, check the deployment logs and diagnostics database migration.",
      });
    }
  }),

  updateUserTemperatureProfile: publicProcedure
    .input(
      z.object({
        bedTime: z.string().time(),
        wakeupTime: z.string().time(),
        initialSleepLevel: z.number().int().min(-100).max(100),
        midStageSleepLevel: z.number().int().min(-100).max(100),
        finalSleepLevel: z.number().int().min(-100).max(100),
        finalStageStartTime: z.string().time().nullable().optional(),
        timezoneTZ: z.string().max(50),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      try {
        const decoded = await checkAuthCookie(ctx.headers);
        // Older clients omit this field; preserve their existing override rather
        // than resetting it when they save the rest of their profile.
        const existingProfile = input.finalStageStartTime === undefined
          ? await db.query.userTemperatureProfile.findFirst({
              where: eq(userTemperatureProfile.email, decoded.email),
            })
          : undefined;
        const finalStageStartTime = input.finalStageStartTime === undefined
          ? existingProfile?.finalStageStartTime ?? null
          : input.finalStageStartTime;
        try {
          getTemperatureSchedule({ ...input, finalStageStartTime });
        } catch (error) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: error instanceof Error ? error.message : "Invalid temperature schedule.",
          });
        }
        const updatedProfile = {
          email: decoded.email,
          bedTime: input.bedTime,
          wakeupTime: input.wakeupTime,
          initialSleepLevel: input.initialSleepLevel,
          midStageSleepLevel: input.midStageSleepLevel,
          finalSleepLevel: input.finalSleepLevel,
          finalStageStartTime,
          timezoneTZ: input.timezoneTZ,
          updatedAt: new Date(),
        };

        await db
          .insert(userTemperatureProfile)
          .values(updatedProfile)
          .onConflictDoUpdate({
            target: userTemperatureProfile.email,
            set: {
              bedTime: input.bedTime,
              wakeupTime: input.wakeupTime,
              initialSleepLevel: input.initialSleepLevel,
              midStageSleepLevel: input.midStageSleepLevel,
              finalSleepLevel: input.finalSleepLevel,
              ...(input.finalStageStartTime !== undefined ? { finalStageStartTime } : {}),
              timezoneTZ: input.timezoneTZ,
              updatedAt: new Date(),
            },
          })
          .execute();

        console.info("Temperature profile saved", { email: decoded.email });
        await adjustTemperature(undefined, "profile-save");

        return { success: true, email: decoded.email };
      } catch (error) {
        logUserError("Error updating user temperature profile", error);
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            "An unexpected error occurred while updating the temperature profile.",
        });
      }
    }),

  deleteUserTemperatureProfile: publicProcedure.mutation(async ({ ctx }) => {
    try {
      const decoded = await checkAuthCookie(ctx.headers);
      const email = decoded.email;

      // Delete user temperature profile
      const result = await db
        .delete(userTemperatureProfile)
        .where(eq(userTemperatureProfile.email, email))
        .execute();

      if (result.rowCount === 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Temperature profile not found for this user.",
        });
      }

      return {
        success: true,
        message: "User temperature profile deleted successfully",
      };
    } catch (error) {
      logUserError("Error deleting user temperature profile", error);
      if (error instanceof TRPCError) {
        throw error;
      }
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message:
          "An unexpected error occurred while deleting the user temperature profile.",
      });
    }
  }),
});

async function authenticateUser(email: string, password: string) {
  try {
    return await authenticate(email, password);
  } catch (error) {
    if (error instanceof AuthError) {
      throw error; // Propagate the AuthError with its specific message
    } else {
      throw new AuthError("Failed to authenticate user");
    }
  }
}

async function saveUserToDatabase(email: string, authResult: Token) {
  try {
    await db
      .insert(users)
      .values({
        email,
        eightAccessToken: authResult.eightAccessToken,
        eightRefreshToken: authResult.eightRefreshToken,
        eightTokenExpiresAt: new Date(authResult.eightExpiresAtPosix),
        eightUserId: authResult.eightUserId,
      })
      .onConflictDoUpdate({
        target: users.email,
        set: {
          eightAccessToken: authResult.eightAccessToken,
          eightRefreshToken: authResult.eightRefreshToken,
          eightTokenExpiresAt: new Date(authResult.eightExpiresAtPosix),
          eightUserId: authResult.eightUserId,
        },
      })
      .execute();
  } catch (error) {
    logUserError("Database operation failed", error);
    throw new DatabaseError("Failed to save user token to database.");
  }
}
