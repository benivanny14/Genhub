// =============================================================================
// GENHUB - Launch setup checklist (assessment rules + leak guarantee)
//
// The admin Setup tab renders whatever assessSetup() returns, so the single
// property that must never break is: no secret value reaches the browser. If it
// ever did, every API key in the config would leak into page HTML, screenshots
// and browser history at once - which is why that gets its own suite here rather
// than a comment asking people to be careful.
// =============================================================================

import { describe, it, expect, afterEach } from "vitest";

import {
  SETUP_GROUPS,
  SETUP_ITEMS,
  assessSetup,
  classifyValue,
  parseEnvFile,
  summariseValue,
} from "@/lib/setup-check";
import checklistData from "@/lib/setup-checklist.json";

// ---------------------------------------------------------------------------
// The checklist is data, so it can be wrong in ways code cannot be: a duplicated
// key means one item silently reports another's status, and a missing step means
// the page tells an operator to do nothing.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// The rules themselves are shared data now, compiled by both the app and
// scripts/setup-env.mjs. If someone edits one side's pattern and not the other's,
// these assertions are what catches it.
// ---------------------------------------------------------------------------
describe("shared classification rules", () => {
  it("classify the same value identically from either entry point", () => {
    // classifyValue is the app's only entry point; the script compiles the same
    // two regex sources. If the JSON is missing them, this test cannot even
    // reach the assertions - which is the point.
    const rules = (checklistData as { rules?: { placeholder: string; local: string } }).rules;
    expect(rules, "setup-checklist.json must carry `rules`").toBeDefined();
    expect(rules!.placeholder).toBeTruthy();
    expect(rules!.local).toBeTruthy();

    const placeholder = new RegExp(rules!.placeholder, "i");
    const local = new RegExp(rules!.local, "i");
    const scriptSays = (value: string) =>
      local.test(value) ? "local" : placeholder.test(value) ? "placeholder" : "ok";

    for (const value of [
      "dev-token-secret-abcdefghijklmnopqrstuvwxyz01",
      "http://localhost:3000",
      "rediss://default:AXxx@evolving-fox-12345.upstash.io:6379",
      "https://genhub.co.tz",
    ]) {
      const app = classifyValue(value, { key: "X" }).state;
      expect(scriptSays(value), value).toBe(app);
    }
  });
});

describe("checklist integrity", () => {
  it("has the groups and items the setup flow expects", () => {
    const itemsWithKeys = SETUP_ITEMS.filter((i) => i.key);
    const manual = SETUP_ITEMS.filter((i) => !i.key);

    expect(SETUP_GROUPS.length).toBeGreaterThan(0);
    expect(itemsWithKeys.length).toBe(17);
    // Two steps are work in someone else's dashboard, not a variable: the
    // HarakaPay float, and the Bunny pull zone's Allowed Referrers list — which
    // refuses the manifest and every segment of any host it does not name, so a
    // missing entry there is a video that only spins (see probeSignedPlayback).
    expect(manual).toHaveLength(2);
    const manualText = manual
      .map((i) => [i.title, ...(i.steps || [])].join(" "))
      .join(" ");
    expect(manualText).toMatch(/float/i);
    expect(manualText).toMatch(/Referrers/i);
  });

  it("never lists the same variable twice", () => {
    const keys = SETUP_ITEMS.map((i) => i.key).filter(Boolean) as string[];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("always says where to get a value and how", () => {
    for (const item of SETUP_ITEMS) {
      expect(item.site, `${item.id} site`).toBeTruthy();
      expect(item.steps.length, `${item.id} steps`).toBeGreaterThan(0);
      expect(item.title, `${item.id} title`).toBeTruthy();
    }
  });

  it("gives every acceptable alternative its own rule", () => {
    // Upstash hands out two pairs (REST and TCP) and either is valid, but they
    // need DIFFERENT rules: the REST endpoint is https:// while a TCP URL must be
    // rediss://. A shared rule would reject one of the two correct answers.
    const redis = SETUP_ITEMS.find((i) => i.id === "redis_url");
    expect(redis?.anyOf?.map((a) => a.key)).toEqual([
      "UPSTASH_REDIS_REST_URL",
      "REDIS_URL",
    ]);

    const rules = (key: string) => {
      const alt = redis!.anyOf!.find((a) => a.key === key)!;
      return { key: alt.key, must: alt.must };
    };

    const rest = rules("UPSTASH_REDIS_REST_URL");
    // A synthetic host on purpose: a test must not carry anyone's real endpoint.
    // It must also not read as a placeholder, or the assertion tests the
    // placeholder rule instead of the https:// rule it is here for.
    expect(classifyValue("https://cache-1a2b3c.upstash.io", rest).state).toBe("ok");
    expect(classifyValue("rediss://default:pw@host:6379", rest).state).toBe("wrong");

    const tcp = rules("REDIS_URL");
    expect(classifyValue("rediss://default:pw@host:6379", tcp).state).toBe("ok");
    // Plaintext Redis is still refused — TLS is not optional for a managed host.
    expect(classifyValue("redis://cache.internal:6379", tcp).state).toBe("wrong");
    expect(classifyValue("redis://localhost:6379", tcp).state).toBe("local");
  });
});

// ---------------------------------------------------------------------------
// Classification: what an operator needs to be told about one value.
// ---------------------------------------------------------------------------
describe("classifyValue", () => {
  const item = (over: Partial<{ key: string; must: string; forbid: string }> = {}) => ({
    key: "DATABASE_URL",
    ...over,
  });

  it("reports an empty value as missing", () => {
    expect(classifyValue("", item()).state).toBe("missing");
    expect(classifyValue("   ".trim(), item()).state).toBe("missing");
  });

  it("treats localhost as a warning, not a failure", () => {
    // Right while developing, fatal once deployed. preflight draws the same line.
    expect(classifyValue("postgresql://user@localhost:5432/genhub", item()).state).toBe("local");
    expect(classifyValue("http://127.0.0.1:6379", item()).state).toBe("local");
  });

  it("catches the placeholders people actually type", () => {
    for (const value of [
      // The exact value that was sitting in .env.local while the app called it
      // configured and the terminal called it a stopgap. It is here so that the
      // two can never quietly disagree about it again.
      "dev-token-secret-abcdefghijklmnopqrstuvwxyz01",
      "dev-freebuff-secret-value-here",
      "change-me",
      "your-api-key",
      "example-key-1234567890",
      "placeholder",
      "xxxx",
    ]) {
      expect(classifyValue(value, item()).state, value).toBe("placeholder");
    }
  });

  it("does NOT flag values that only look suspicious", () => {
    // A false positive is not harmless: it tells an operator their correct
    // configuration is wrong, and they go and "fix" it.
    for (const value of [
      "rediss://default:AXxx@evolving-fox-12345.upstash.io:6379", // Upstash's real username is `default`
      "genhub-test", // an honest library name
      "vz-abc123.b-cdn.net",
      "smtp.resend.com",
      "https://genhub.co.tz",
      "123456", // a Bunny library id
    ]) {
      expect(classifyValue(value, item({ key: "BUNNY_CDN_HOSTNAME" })).state, value).toBe("ok");
    }
  });

  it("enforces a required substring", () => {
    const redis = item({ key: "REDIS_URL", must: "rediss://" });
    expect(classifyValue("redis://default:pw@host:6379", redis).state).toBe("wrong");
    expect(classifyValue("rediss://default:pw@host:6379", redis).state).toBe("ok");
  });

  it("enforces a forbidden substring", () => {
    const cdn = item({ key: "BUNNY_CDN_HOSTNAME", forbid: "https://" });
    expect(classifyValue("https://vz-abc.b-cdn.net", cdn).state).toBe("wrong");
    expect(classifyValue("vz-abc.b-cdn.net", cdn).state).toBe("ok");
  });

  it("requires a real https URL for the public app URL", () => {
    const appUrl = item({ key: "NEXT_PUBLIC_APP_URL", must: "https://" });
    expect(classifyValue("http://localhost:3000", appUrl).state).toBe("local");
    expect(classifyValue("myapp.com", appUrl).state).toBe("wrong");
    expect(classifyValue("http://myapp.com", appUrl).state).toBe("wrong");
    expect(classifyValue("https://genhub.co.tz", appUrl).state).toBe("ok");
  });

  it("accepts a genuine value", () => {
    expect(
      classifyValue(
        "postgresql://u:p@ep-cool-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require",
        item({ key: "DATABASE_URL", must: "-pooler" })
      ).state
    ).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// Masking.
// ---------------------------------------------------------------------------
describe("summariseValue", () => {
  it("never echoes a secret, only its shape", () => {
    const secret = "re_AbCdEf1234567890";
    const shown = summariseValue(secret, true);
    expect(shown).toBe("set · 19 characters");
    expect(shown).not.toContain(secret);
    expect(shown).not.toContain("AbCdEf");
  });

  it("shows non-secret values, truncated when long", () => {
    expect(summariseValue("https://genhub.co.tz", false)).toBe("https://genhub.co.tz");
    const long = "x".repeat(120);
    const shown = summariseValue(long, false)!;
    expect(shown.length).toBeLessThanOrEqual(70);
    expect(shown.endsWith("...")).toBe(true);
  });

  it("has nothing to show for an empty value", () => {
    expect(summariseValue("", false)).toBeNull();
    expect(summariseValue("", true)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// .env.local parsing must match what the app itself sees.
// ---------------------------------------------------------------------------
describe("parseEnvFile", () => {
  it("strips inline comments the way dotenv does", () => {
    // The bug this prevents: the app reads a clean URL while the checker reads
    // "https://genhub.co.tz   # live" and reports a false failure.
    const parsed = parseEnvFile("NEXT_PUBLIC_APP_URL=https://genhub.co.tz   # live\n");
    expect(parsed.NEXT_PUBLIC_APP_URL).toBe("https://genhub.co.tz");
  });

  it("keeps a quoted value verbatim, hash included", () => {
    expect(parseEnvFile('SMTP_PASS="re_ab#cd"').SMTP_PASS).toBe("re_ab#cd");
    expect(parseEnvFile("SMTP_PASS='re_x#y'").SMTP_PASS).toBe("re_x#y");
  });

  it("tolerates export, spacing and blank lines", () => {
    const parsed = parseEnvFile(
      ["export FOO=bar", "", "  BAZ = qux  ", "# a comment line", "not a var"].join("\n")
    );
    expect(parsed.FOO).toBe("bar");
    expect(parsed.BAZ).toBe("qux");
    expect(parsed["#"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The whole report, and the one guarantee that matters.
// ---------------------------------------------------------------------------
describe("assessSetup", () => {
  const PLANTED = [
    "BUNNY_STREAM_API_KEY",
    "BUNNY_TOKEN_SECRET",
    "BUNNY_STORAGE_ACCESS_KEY",
    "SMTP_PASS",
  ] as const;

  afterEach(() => {
    for (const key of PLANTED) delete process.env[key];
  });

  it("counts every item exactly once", () => {
    const report = assessSetup();
    const items = report.groups.flatMap((g) => g.items);
    expect(items).toHaveLength(SETUP_ITEMS.length);
    // Three buckets, not two: a dashboard step nobody has ticked off is neither
    // "collected" nor something the app can see is missing. It used to be
    // counted as todo forever, which is why the admin badge never cleared.
    expect(report.summary.done + report.summary.todo + report.summary.manual).toBe(
      SETUP_ITEMS.length
    );
  });

  it("reports the env file it actually read", () => {
    const report = assessSetup();
    expect(report.envFile.path).toContain(".env.local");
  });

  it("NEVER puts a secret value in the payload the admin page receives", () => {
    const markers = ["SUPERSECRET-Alpha-9931", "SUPERSECRET-Beta-9932", "SUPERSECRET-Gamma-9933", "SUPERSECRET-Delta-9934"];
    PLANTED.forEach((key, i) => {
      process.env[key] = markers[i];
    });

    // Serialise it the way the API route does - a leak anywhere in the object
    // would travel to the browser in exactly this string.
    const payload = JSON.stringify(assessSetup());

    for (const marker of markers) {
      expect(payload, `${marker} leaked into the API payload`).not.toContain(marker);
    }

    // And every sensitive item must describe itself only by shape.
    for (const group of assessSetup().groups) {
      for (const item of group.items) {
        if (!item.sensitive || !item.display) continue;
        expect(item.display, item.key!).toMatch(/^set · \d+ characters$/);
      }
    }
  });

  it("flags a value written after boot so the page can say 'restart'", () => {
    // assessSetup prefers .env.local over process.env, so an edit is visible
    // immediately even though the running server still holds the old value.
    const report = assessSetup();
    for (const group of report.groups) {
      for (const item of group.items) {
        expect(typeof item.restartPending).toBe("boolean");
      }
    }
  });

  it("marks the dashboard-only step as not-yet-done and gives it no variable", () => {
    const manual = assessSetup()
      .groups.flatMap((g) => g.items)
      .find((i) => i.key === null);
    expect(manual).toBeDefined();
    expect(manual!.state).toBe("missing");
    expect(manual!.display).toBeNull();
    expect(manual!.manual).toBe(true);
    expect(manual!.manualDone).toBe(false);
  });

  it("lets an operator tick a dashboard step off, so the count can reach zero", () => {
    const step = SETUP_ITEMS.find((i) => !i.key)!;

    const report = assessSetup([step.id]);
    const item = report.groups.flatMap((g) => g.items).find((i) => i.id === step.id)!;

    expect(item.state).toBe("ok");
    expect(item.manualDone).toBe(true);
    expect(report.summary.manual).toBe(
      SETUP_ITEMS.filter((i) => !i.key).length - 1
    );
    // A ticked manual step is collected, not still-to-do.
    expect(report.summary.done).toBe(assessSetup().summary.done + 1);
  });

  it("reports manual steps separately from what the app can verify", () => {
    const report = assessSetup();
    const manualCount = SETUP_ITEMS.filter((i) => !i.key).length;

    expect(report.summary.manual).toBe(manualCount);
    // Nothing a manual step does may show up as an unfinished CONFIG item: that
    // is the number an operator can actually act on, and it must mean only that.
    expect(report.summary.todo).toBe(SETUP_ITEMS.length - manualCount - report.summary.done);
  });
});
