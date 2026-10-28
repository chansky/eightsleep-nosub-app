import { relations } from "drizzle-orm";
import type { TemperatureDiagnostic } from "~/lib/temperature-diagnostics";
import {
  index,
  integer,
  jsonb,
  pgTableCreator,
  text,
  time,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const createTable = pgTableCreator((name) => `8slp_${name}`); // also in drizzle.config.ts

export const users = createTable("users", {
  email: varchar("email", { length: 255 }).notNull().primaryKey(),
  eightUserId: varchar("eightUserId", { length: 255 }).notNull(),
  eightAccessToken: text("access_token").notNull(),
  eightRefreshToken: text("refresh_token").notNull(),
  eightTokenExpiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const userTemperatureProfile = createTable("userTemperatureProfiles", {
  email: varchar('email', { length: 255 }).references(() => users.email).primaryKey(),
  bedTime: time("bedTime").notNull(),
  wakeupTime: time("wakeupTime").notNull(),
  initialSleepLevel: integer("initialSleepLevel").notNull(),
  midStageSleepLevel: integer("midStageSleepLevel").notNull(),
  finalSleepLevel: integer("finalSleepLevel").notNull(),
  finalStageStartTime: time("finalStageStartTime"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  timezoneTZ: varchar("timezone", { length: 50 }).notNull(),
});

// Only sanitized temperature-control diagnostics belong here; never tokens or API bodies.
export const temperatureDiagnostics = createTable("temperatureDiagnostics", {
  id: uuid("id").primaryKey(),
  email: varchar("email", { length: 255 }).notNull().references(() => users.email),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  diagnostic: jsonb("diagnostic").$type<TemperatureDiagnostic>().notNull(),
}, (table) => ({
  userStartedAtIndex: index("8slp_diagnostics_user_started_idx").on(table.email, table.startedAt),
  startedAtIndex: index("8slp_diagnostics_started_idx").on(table.startedAt),
}));

export const usersRelations = relations(users, ({ one }) => ({
  temperatureProfile: one(userTemperatureProfile, {
    fields: [users.email],
    references: [userTemperatureProfile.email],
  }),
}));

export const userTemperatureProfileRelations = relations(userTemperatureProfile, ({ one }) => ({
  user: one(users, {
    fields: [userTemperatureProfile.email],
    references: [users.email],
  }),
}));
