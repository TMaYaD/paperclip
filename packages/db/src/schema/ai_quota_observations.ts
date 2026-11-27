import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, doublePrecision, index, check } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { connectionGrants, toolConnections } from "./tool_access.js";

/**
 * History of a managed AI connection's plan-usage windows, as read from the
 * provider for the Costs quota cards and subscription budgets. Providers
 * report usage only as a percentage of an undisclosed allowance; keeping the
 * readings lets operators compare them with recorded token usage over time.
 * One row per window per kept reading; the reader dedupes unchanged readings.
 */
export const aiQuotaObservations = pgTable("ai_quota_observations", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  connectionId: uuid("connection_id").notNull().references(() => toolConnections.id, { onDelete: "cascade" }),
  grantId: uuid("grant_id").references(() => connectionGrants.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  windowKey: text("window_key").notNull(),
  windowLabel: text("window_label"),
  usedPercent: doublePrecision("used_percent").notNull(),
  resetsAt: timestamp("resets_at", { withTimezone: true }),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  series: index("ai_quota_observations_series_idx").on(table.companyId, table.connectionId, table.windowKey, table.observedAt),
  validPercent: check("ai_quota_observations_used_percent", sql`${table.usedPercent} >= 0 and ${table.usedPercent} <= 100`),
}));
