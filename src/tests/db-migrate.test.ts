// =============================================================================
// GENHUB - `npm run db:deploy` has to run at all
//
// The command was `prisma migrate deploy`, and the Prisma CLI reads `.env` while
// this repo keeps DATABASE_URL in `.env.local` on purpose (putting it in `.env`
// turns off the rail that keeps money-moving suites off the live database — see
// src/tests/setup-env.ts). So the documented deploy command could not run from a
// clean checkout:
//
//   Error code: P1012
//   error: Environment variable not found: DATABASE_URL.
//
// The migration existed, the database existed, and nothing joined them — which is
// how a coupon table shipped unapplied. These tests pin the wrapper that fixed
// it: which file it loads, that it refuses instead of printing P1012, that it
// says which database it is about to change WITHOUT printing the password, and
// that the npm script still points at the wrapper rather than back at the CLI.
//
// Pure helpers only — no database, no child process.
// =============================================================================

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  COMMANDS,
  DESTRUCTIVE,
  describeDatabaseUrl,
  isLocalHost,
  parseArgv,
  prismaBinary,
  redactDatabaseUrl,
} from "../../scripts/db-migrate.mjs";

// Not read as `process.env.X`: src/tests/env-template.test.ts demands that every
// key written that way is documented in .env.example, and these are synthetic.
function readPackageJson() {
  return JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
}

const NEON =
  "postgresql://genhub_user:s3cr3t-p4ssword@ep-jolly-mode-b522yqh0-pooler.c-7.us-east-2.aws.neon.tech/neondb?sslmode=require&schema=public";

describe("describeDatabaseUrl", () => {
  it("names the host, database and schema a migration would touch", () => {
    expect(describeDatabaseUrl(NEON)).toMatchObject({
      protocol: "postgresql",
      host: "ep-jolly-mode-b522yqh0-pooler.c-7.us-east-2.aws.neon.tech",
      database: "neondb",
      schema: "public",
      user: "genhub_user",
    });
  });

  it("reports a string it cannot parse instead of throwing", () => {
    // A password pasted where a URL belongs is the common case, and it must not
    // crash the one command whose job is to say what went wrong.
    expect(describeDatabaseUrl("hunter2-not-a-url")).toBeNull();
    expect(describeDatabaseUrl("")).toBeNull();
  });

  it("defaults the schema when the URL does not name one", () => {
    expect(describeDatabaseUrl("postgresql://u:p@db.example.com/app")?.schema).toBe("public");
  });
});

describe("redactDatabaseUrl", () => {
  it("keeps the parts worth reading and removes the password", () => {
    const redacted = redactDatabaseUrl(NEON);

    expect(redacted).not.toContain("s3cr3t-p4ssword");
    expect(redacted).toContain("ep-jolly-mode-b522yqh0-pooler.c-7.us-east-2.aws.neon.tech");
    expect(redacted).toContain("***");
  });

  it("never falls back to printing an unparseable string as-is", () => {
    // The string nobody can parse is exactly the one that may contain a secret,
    // so the fallback has to be a placeholder rather than the input.
    const redacted = redactDatabaseUrl("s3cr3t-p4ssword");

    expect(redacted).not.toContain("s3cr3t");
  });

  it("leaves a URL with no password alone", () => {
    expect(redactDatabaseUrl("postgresql://u@db.example.com/app")).toBe(
      "postgresql://u@db.example.com/app"
    );
  });
});

describe("parseArgv", () => {
  it("defaults to deploy", () => {
    expect(parseArgv([]).command).toBe("deploy");
  });

  it("does not mistake the value of --env-from for the command", () => {
    // The bug this avoids: the path is a bare word, so a "first non-flag arg"
    // scan reports `.env.vercel` as the command and refuses to run.
    const parsed = parseArgv(["--env-from", ".env.vercel"]);

    expect(parsed.command).toBe("deploy");
    expect(parsed.envFrom).toBe(".env.vercel");
  });

  it("accepts --env-from=<path>", () => {
    expect(parseArgv(["--env-from=.env.vercel", "status"])).toMatchObject({
      command: "status",
      envFrom: ".env.vercel",
    });
  });

  it("collects arguments it does not know instead of forwarding them", () => {
    expect(parseArgv(["deploy", "--force", "extra"]).unknown).toEqual(["extra"]);
  });
});

describe("command table", () => {
  it("deploy is `prisma migrate deploy`", () => {
    expect(COMMANDS.deploy).toEqual(["migrate", "deploy"]);
  });

  it("marks only the commands that can rewrite a schema", () => {
    expect(DESTRUCTIVE.has("migrate")).toBe(true);
    expect(DESTRUCTIVE.has("push")).toBe(true);
    // Applying migrations and reading status are additive — they must not be
    // gated behind the "this can reset your database" warning, or the warning
    // stops meaning anything.
    expect(DESTRUCTIVE.has("deploy")).toBe(false);
    expect(DESTRUCTIVE.has("status")).toBe(false);
  });

  it("covers every db: script that needs the database", () => {
    const { scripts } = readPackageJson();
    for (const name of Object.keys(COMMANDS)) {
      expect(scripts[`db:${name}`]).toBe(`node scripts/db-migrate.mjs ${name}`);
    }
  });

  it("does not go back to the CLI that cannot read .env.local", () => {
    // The regression itself: with DATABASE_URL in .env.local only, a bare
    // `prisma migrate deploy` exits 1 with P1012 and applies nothing.
    for (const body of Object.values(readPackageJson().scripts)) {
      expect(body).not.toMatch(/^prisma (migrate|db|studio)/);
    }
  });
});

describe("prismaBinary", () => {
  it("runs the CLI with this Node instead of the Windows .cmd shim", () => {
    // `node_modules/.bin/prisma` is a batch file on Windows, so it needs
    // cmd.exe — which splits its command line on spaces. This checkout lives at
    // "...\Desktop\Genz after work", where that produced
    //   'C:\...\Genz' is not recognized as an internal or external command
    // after the script had already named the database it was about to migrate.
    const bin = prismaBinary();

    expect(bin.shell).toBe(false);
    expect(bin.command).toBe(process.execPath);
    expect(bin.args.join(" ")).toMatch(/prisma/);
  });
});

describe("the refusal path", () => {
  it("explains the missing DATABASE_URL instead of printing P1012", () => {
    // End to end, with the variable forced empty: this is the experience that
    // used to be `Error code: P1012 / Environment variable not found`.
    const result = spawnSync(process.execPath, ["scripts/db-migrate.mjs", "deploy"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: "" },
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(2);
    expect(output).not.toContain("P1012");
    expect(output).toContain("DATABASE_URL");
    expect(output).toContain(".env.local");
    expect(output).toContain("--env-from");
  });
});

describe("isLocalHost", () => {
  it("recognises this machine", () => {
    expect(isLocalHost("localhost")).toBe(true);
    expect(isLocalHost("127.0.0.1")).toBe(true);
  });

  it("does not mistake a managed host for a local one", () => {
    expect(isLocalHost("ep-jolly-mode-b522yqh0-pooler.c-7.us-east-2.aws.neon.tech")).toBe(false);
  });
});
