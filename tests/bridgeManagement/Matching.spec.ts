import { describe, expect, it } from "vitest";
import {
  nameSimilarity,
  normalizeName,
  scoreMatch,
  suggestMatches,
} from "../../src/bridgeManagement/Matching";

const candidate = (network: string, name: string, createdAt?: string) => ({
  key: `${network}:${name}`,
  network,
  name,
  createdAt,
});

describe("normalizeName", () => {
  it("folds case, accents, ligatures and separators", () => {
    expect(normalizeName("  Café–Team  ")).toBe("cafe team");
    expect(normalizeName("Fußball-Verein")).toBe("fussball verein");
    expect(normalizeName("Ｔｒａｉｎｉｎｇ & Co")).toBe("training and co");
  });
});

describe("nameSimilarity", () => {
  it.each([
    ["Britstadt Volunteers", "Britstadt Volunteers 🚒"],
    ["Training & Exercises", "Training and Exercises"],
    ["Fußball Verein", "Fussball-Verein"],
    ["Café Team", "CAFE TEAM"],
    ["Britstadt Volunteers", "Britstadt Volunteers (WhatsApp)"],
    ["東京チーム", "東京 チーム"],
  ])("treats %s and %s as the same group", (left, right) => {
    expect(nameSimilarity(left, right)).toBeGreaterThanOrEqual(0.9);
  });

  it.each([
    ["Neighbourhood Watch", "Neighborhood Watch"],
    ["Volunteer", "Volunteers Britstadt"],
    ["Hiking Club Berlin", "Hiking Club"],
    ["Family Mueller", "Family Müller"],
  ])("finds %s and %s similar", (left, right) => {
    expect(nameSimilarity(left, right)).toBeGreaterThanOrEqual(0.6);
  });

  it.each([
    ["Equipment & Logistics", "Britstadt Volunteers"],
    ["Japan Exchange Team", "Britstadt Volunteers"],
    ["Team A", "Team B"],
    ["Class of 2024", "Class of 2025"],
    ["Chat", "Group"],
    ["Book club", "Bike club"],
  ])("keeps %s and %s apart", (left, right) => {
    expect(nameSimilarity(left, right)).toBeLessThan(0.5);
  });
});

describe("scoreMatch", () => {
  it("never suggests a group because of its creation time alone", () => {
    expect(
      scoreMatch(
        { name: "Britstadt Volunteers", createdAt: "2026-09-20T10:00:00Z" },
        candidate("line", "Japan Exchange Team", "2026-09-20T10:05:00Z"),
      ),
    ).toBeNull();
  });

  it("uses close creation times to strengthen a name match", () => {
    const near = scoreMatch(
      { name: "Training & Exercises", createdAt: "2026-09-22T16:30:00Z" },
      candidate("signal", "Training Exercise", "2026-09-22T16:45:00Z"),
    );
    const far = scoreMatch(
      { name: "Training & Exercises", createdAt: "2026-09-22T16:30:00Z" },
      candidate("signal", "Training Exercise", "2025-01-01T00:00:00Z"),
    );
    expect(near!.score).toBeGreaterThan(far!.score);
    expect(near!.reasons).toContain("Created within the hour");
  });
});

describe("suggestMatches", () => {
  const groups = [
    candidate("whatsapp", "Britstadt Volunteers"),
    candidate("whatsapp", "Equipment & Logistics"),
    candidate("signal", "Britstadt Volunteers"),
    candidate("signal", "Britstadt Volunteers Archive"),
    candidate("line", "Britstadt volunteer"),
    candidate("line", "Japan Exchange Team"),
  ];

  it("returns the best group per network, strongest first", () => {
    const matches = suggestMatches({ name: "Britstadt Volunteers" }, groups);
    expect(matches.map((match) => match.candidate.key)).toEqual([
      "signal:Britstadt Volunteers",
      "whatsapp:Britstadt Volunteers",
      "line:Britstadt volunteer",
    ]);
    expect(matches[0].confidence).toBe("strong");
  });

  it("skips the reference network and networks already in the room", () => {
    const matches = suggestMatches(
      { name: "Britstadt Volunteers", network: "whatsapp" },
      groups,
      { excludeNetworks: ["signal"] },
    );
    expect(matches.map((match) => match.candidate.network)).toEqual(["line"]);
  });

  it("shows a runner-up when two groups on one network are equally plausible", () => {
    const matches = suggestMatches({ name: "Hiking Club" }, [
      candidate("signal", "Hiking Club North"),
      candidate("signal", "Hiking Club South"),
    ]);
    expect(matches).toHaveLength(2);
  });
});
