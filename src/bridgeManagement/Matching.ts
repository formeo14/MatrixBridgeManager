export type MatchConfidence = "strong" | "likely" | "possible";

export interface MatchCandidate {
  key: string;
  network: string;
  name: string;
  createdAt?: string;
}

export interface MatchResult<T extends MatchCandidate = MatchCandidate> {
  candidate: T;
  score: number;
  confidence: MatchConfidence;
  reasons: string[];
}

const STOP_WORDS = new Set([
  "an",
  "and",
  "the",
  "of",
  "for",
  "und",
  "der",
  "die",
  "das",
  "de",
  "la",
  "le",
  "et",
  "group",
  "groupe",
  "gruppe",
  "chat",
  "official",
  "offiziell",
]);

const NETWORK_WORDS = new Set([
  "whatsapp",
  "wa",
  "signal",
  "line",
  "telegram",
  "tg",
  "matrix",
  "discord",
  "slack",
]);

const DAY_MS = 86400000;
const CJK =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;

export function normalizeName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase()
    .replace(/ß/g, "ss")
    .replace(/[&+]/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function nameTokens(value: string): string[] {
  const words = normalizeName(value).split(" ").filter(Boolean);
  const meaningful = words.filter(
    (word) => !STOP_WORDS.has(word) && !NETWORK_WORDS.has(word),
  );
  const tokens = meaningful.length ? meaningful : words;
  return tokens.flatMap((token) =>
    CJK.test(token) && token.length > 2
      ? Array.from({ length: token.length - 1 }, (_, index) =>
          token.slice(index, index + 2),
        )
      : [token],
  );
}

function stem(token: string): string {
  return token.length > 4 ? token.replace(/(es|en|er|s|n|e)$/u, "") : token;
}

function editDistance(left: string, right: string): number {
  const previous = Array.from(
    { length: right.length + 1 },
    (_, index) => index,
  );
  for (let i = 1; i <= left.length; i++) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const above = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[right.length];
}

export function tokenSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  if (
    stem(left) === stem(right) ||
    stem(left) === right ||
    left === stem(right)
  )
    return 0.95;
  const shorter = left.length < right.length ? left : right;
  const longer = shorter === left ? right : left;
  if (shorter.length >= 3 && longer.startsWith(shorter))
    return 0.6 + 0.3 * (shorter.length / longer.length);
  if (shorter.length < 4) return 0;
  const ratio = 1 - editDistance(left, right) / longer.length;
  return ratio >= 0.75 ? ratio * 0.9 : 0;
}

function softOverlap(left: string[], right: string[]): number {
  if (!left.length || !right.length) return 0;
  const best = (token: string, others: string[]) =>
    Math.max(...others.map((other) => tokenSimilarity(token, other)));
  const total =
    left.reduce((sum, token) => sum + best(token, right), 0) +
    right.reduce((sum, token) => sum + best(token, left), 0);
  return total / (left.length + right.length);
}

function containment(left: string[], right: string[]): number {
  const [shorter, longer] =
    left.length <= right.length ? [left, right] : [right, left];
  if (!shorter.length || shorter.join("").length < 4) return 0;
  const covered = shorter.every((token) =>
    longer.some((other) => tokenSimilarity(token, other) >= 0.9),
  );
  return covered ? 0.72 + 0.13 * (shorter.length / longer.length) : 0;
}

function trigrams(value: string): Map<string, number> {
  const compact = ` ${normalizeName(value).replace(/ /g, "")} `;
  const grams = new Map<string, number>();
  for (let index = 0; index + 3 <= compact.length; index++) {
    const gram = compact.slice(index, index + 3);
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  return grams;
}

function trigramDice(left: string, right: string): number {
  const a = trigrams(left);
  const b = trigrams(right);
  let shared = 0;
  let total = 0;
  for (const [gram, count] of a) {
    shared += Math.min(count, b.get(gram) ?? 0);
    total += count;
  }
  for (const count of b.values()) total += count;
  return total ? (2 * shared) / total : 0;
}

export function nameSimilarity(left: string, right: string): number {
  const a = normalizeName(left);
  const b = normalizeName(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const leftTokens = nameTokens(left);
  const rightTokens = nameTokens(right);
  if (leftTokens.join(" ") === rightTokens.join(" ")) return 0.97;
  const labels = (tokens: string[]) =>
    new Set(tokens.filter((token) => /^(\p{N}+|\p{L})$/u.test(token)));
  const leftLabels = labels(leftTokens);
  const rightLabels = labels(rightTokens);
  if (
    leftLabels.size &&
    rightLabels.size &&
    ![...leftLabels].some((label) => rightLabels.has(label))
  )
    return 0.3;
  const blended =
    0.65 * softOverlap(leftTokens, rightTokens) + 0.35 * trigramDice(a, b);
  return Math.min(
    0.96,
    Math.max(blended, containment(leftTokens, rightTokens)),
  );
}

function createdDistance(left?: string, right?: string): number | undefined {
  const distance = Math.abs(Date.parse(left ?? "") - Date.parse(right ?? ""));
  return Number.isFinite(distance) ? distance : undefined;
}

export function scoreMatch(
  reference: { name: string; createdAt?: string },
  candidate: MatchCandidate,
): Omit<MatchResult, "candidate"> | null {
  const name = nameSimilarity(reference.name, candidate.name);
  if (name < 0.45) return null;
  const reasons: string[] = [
    name >= 0.97
      ? "Same name"
      : name >= 0.8
        ? "Nearly the same name"
        : "Similar name",
  ];
  let score = name;
  const distance = createdDistance(reference.createdAt, candidate.createdAt);
  if (distance !== undefined) {
    if (distance <= 2 * DAY_MS) {
      score += 0.12 * Math.exp(-distance / (0.5 * DAY_MS));
      reasons.push(
        distance < 3600000
          ? "Created within the hour"
          : distance < DAY_MS
            ? "Created the same day"
            : "Created within two days",
      );
    } else if (distance > 180 * DAY_MS) score -= 0.05;
  }
  score = Math.max(0, Math.min(1, score));
  if (score < 0.5) return null;
  return {
    score,
    confidence: score >= 0.9 ? "strong" : score >= 0.72 ? "likely" : "possible",
    reasons,
  };
}

export function suggestMatches<T extends MatchCandidate>(
  reference: { name: string; createdAt?: string; network?: string },
  candidates: T[],
  options: { excludeNetworks?: Iterable<string>; perNetwork?: number } = {},
): MatchResult<T>[] {
  const excluded = new Set(options.excludeNetworks ?? []);
  if (reference.network) excluded.add(reference.network);
  const perNetwork = options.perNetwork ?? 2;
  const byNetwork = new Map<string, MatchResult<T>[]>();
  for (const candidate of candidates) {
    if (excluded.has(candidate.network)) continue;
    const match = scoreMatch(reference, candidate);
    if (!match) continue;
    const list = byNetwork.get(candidate.network) ?? [];
    list.push({ candidate, ...match });
    byNetwork.set(candidate.network, list);
  }
  const results: MatchResult<T>[] = [];
  for (const list of byNetwork.values()) {
    list.sort((a, b) => b.score - a.score);
    const [best, second] = list;
    results.push(best);
    if (perNetwork > 1 && second && best.score - second.score < 0.08)
      results.push(...list.slice(1, perNetwork));
  }
  return results.sort(
    (a, b) =>
      b.score - a.score ||
      a.candidate.name.localeCompare(b.candidate.name) ||
      a.candidate.network.localeCompare(b.candidate.network),
  );
}
