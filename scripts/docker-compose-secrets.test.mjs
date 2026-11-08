import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

for (const file of ["docker-compose.yml", "docker-compose.quickstart.yml"]) {
  test(`${file} requires and forwards the session signing secret`, () => {
    const compose = readFileSync(new URL(`../docker/${file}`, import.meta.url), "utf8");
    assert.match(compose, /^\s+BETTER_AUTH_SECRET: "\$\{BETTER_AUTH_SECRET:\?BETTER_AUTH_SECRET must be set\}"$/m);
  });
}
