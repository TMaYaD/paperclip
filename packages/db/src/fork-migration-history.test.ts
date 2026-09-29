import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

// Hashes and timestamps shipped by the fork before upstream occupied 0278–0280.
const legacy = [
  ["0289_flashy_devos", "b60125ef023fa2f3a263762a86948e0a571b37fb0e3c03954d5b8e88e753fef3", 1789481839880],
  ["0290_flippant_cable", "3b501ce5f5698c7139b46e9b51d64e04e620f5c04ab45f817fc570f0f37f0f2d", 1790481816894],
  ["0291_dapper_lockheed", "b54c0a5115466526e96db13d3bdf080aeac5134c91254cc3db3ce9d479dab601", 1790498853575],
] as const;

it("preserves deployed budget migration hashes after renumbering", async () => {
  for (const [tag, hash] of legacy) {
    const sql = await readFile(new URL(`./migrations/${tag}.sql`, import.meta.url));
    expect(createHash("sha256").update(sql).digest("hex")).toBe(hash);
  }
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("fork migration history", () => {
  it("recognizes old timestamps by hash without reapplying budget migrations", async () => {
    const database = await startEmbeddedPostgresTestDatabase("fork-migration-history-");
    const sql = postgres(database.connectionString, { max: 1 });
    try {
      for (const [, hash, timestamp] of legacy) {
        await sql`UPDATE drizzle.__drizzle_migrations SET created_at = ${timestamp} WHERE hash = ${hash}`;
      }
      expect((await inspectMigrations(database.connectionString)).status).toBe("upToDate");
      const before = await sql`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`;
      await applyPendingMigrations(database.connectionString);
      expect(await sql`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`).toEqual(before);
    } finally {
      await sql.end();
      await database.cleanup();
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
