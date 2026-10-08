import { describe, expect, it } from "vite-plus/test";

import { findingsWindowStart, parseBotFindings } from "./BotMorning.ts";

const HEADER = [
  "# Findings",
  "",
  "One line per bot per nightly sleep, newest last.",
  "Format: `<date> | <bot> | pattern|proposal|none | <what, evidence> | <fix or stream, cost>`",
].join("\n");

describe("parseBotFindings", () => {
  it("reads well-formed pattern and proposal lines after the header", () => {
    const findings = parseBotFindings(
      [
        HEADER,
        "2026-10-08 | chief-of-staff | pattern | re-asked for the same PR twice | dedupe asks, 1h",
        "2026-10-08 | omni-triager | proposal | triage pages at night | stream night-triage, small",
      ].join("\n"),
      Date.parse("2026-10-07T20:00:00.000Z"),
    );
    expect(findings).toMatchObject([
      {
        botId: "chief-of-staff",
        kind: "pattern",
        what: "re-asked for the same PR twice",
        fix: "dedupe asks, 1h",
      },
      {
        botId: "omni-triager",
        kind: "proposal",
        what: "triage pages at night",
        fix: "stream night-triage, small",
      },
    ]);
  });

  it("skips none, malformed and unknown-kind lines", () => {
    expect(
      parseBotFindings(
        [
          HEADER,
          "2026-10-08 | chief-of-staff | none | quiet night | -",
          "2026-10-08 | chief-of-staff | pattern | missing fix field",
          "yesterday | chief-of-staff | pattern | bad date | fix",
          "2026-10-08 |  | pattern | no bot | fix",
          "2026-10-08 | chief-of-staff | idea | unknown kind | fix",
          "2026-10-08 | chief-of-staff | pattern |  | empty what",
        ].join("\n"),
        0,
      ),
    ).toEqual([]);
  });

  it("keeps lines dated within the window and drops older ones", () => {
    const awaySince = Date.parse("2026-10-07T21:00:00.000Z");
    const now = Date.parse("2026-10-08T07:00:00.000Z");
    const findings = parseBotFindings(
      [
        "2026-10-05 | chief-of-staff | pattern | old | fix",
        "2026-10-06 | chief-of-staff | pattern | before the last day | fix",
        "2026-10-07 | chief-of-staff | pattern | within the last day | fix",
        "2026-10-07T06:00:00.000Z | chief-of-staff | pattern | too early that day | fix",
        "2026-10-08T03:00:00.000Z | chief-of-staff | proposal | overnight | fix",
      ].join("\n"),
      findingsWindowStart(awaySince, now),
    );
    expect(findings.map((finding) => finding.what)).toEqual(["within the last day", "overnight"]);
  });

  it("widens the window to a long absence", () => {
    const awaySince = Date.parse("2026-10-04T21:00:00.000Z");
    const now = Date.parse("2026-10-08T07:00:00.000Z");
    expect(
      parseBotFindings(
        "2026-10-05 | chief-of-staff | pattern | while away | fix",
        findingsWindowStart(awaySince, now),
      ).map((finding) => finding.what),
    ).toEqual(["while away"]);
  });

  it("gives each line a stable id and keeps pipes inside the fix", () => {
    const line = "2026-10-08 | chief-of-staff | pattern | what | fix a | fix b";
    const [first] = parseBotFindings(line, 0);
    const [second] = parseBotFindings(`${HEADER}\n  ${line}  \n`, 0);
    expect(first!.fix).toBe("fix a | fix b");
    expect(second!.id).toBe(first!.id);
    expect(parseBotFindings(`${line}!`, 0)[0]!.id).not.toBe(first!.id);
  });
});
