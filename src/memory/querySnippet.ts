const querySnippetMaxCharacters = 300;
const matchWindowCharacters = 200;
const windowLeadingContextCharacters = 60;
const windowTrailingContextCharacters = 120;
const minimumQueryTermCharacters = 2;
const minimumTrimmedTermCharacters = 3;
const maximumTermTrimCharacters = 2;
const maximumMatchPositions = 400;
const headSnippetMaxCharacters = 500;

type MatchPosition = {
  position: number;
  term: string;
};

export function flattenBodyText(body: string) {
  return body
    .split("\n")
    .map((line) => line.replace(/^#{1,6}\s+/, "").replace(/^[-*]\s+/, "").trim())
    .filter((line) => line.length > 0)
    .join(" ");
}

export function buildHeadSnippet(body: string) {
  const flattened = flattenBodyText(body);
  if (flattened.length <= headSnippetMaxCharacters) {
    return flattened;
  }
  return `${flattened.slice(0, headSnippetMaxCharacters)}…`;
}

// 발췌는 쿼리 단어가 가장 다양하게 모인 창을 고른다 — 첫 등장 위치는 파일 경로 같은 저정보 구간일 수 있다
export function buildQuerySnippet(body: string, query: string) {
  const terms = tokenizeQuery(query);
  const matches = collectMatchPositions(body, terms);
  if (matches.length === 0) {
    return null;
  }

  const window = pickDensestWindow(matches);
  const windowStart = Math.max(0, window.start - windowLeadingContextCharacters);
  const windowEnd = Math.min(body.length, window.end + windowTrailingContextCharacters);
  const rawText = body.slice(windowStart, windowEnd).replace(/\s+/g, " ").trim();
  const clippedText = rawText.slice(0, querySnippetMaxCharacters);
  const leadingMark = windowStart > 0 ? "…" : "";
  const trailingMark = windowEnd < body.length || clippedText.length < rawText.length ? "…" : "";
  return `${leadingMark}${clippedText}${trailingMark}`;
}

function tokenizeQuery(query: string) {
  return [...new Set(
    query
      .split(/[\s,.·…?!()\[\]"'`~—:;/]+/)
      .map((term) => term.trim())
      .filter((term) => term.length >= minimumQueryTermCharacters)
  )];
}

// 공백 제거 텍스트 위에서 매칭해 띄어쓰기 차이를 흡수하고, 원문 위치로 되돌릴 매핑을 유지한다
function collectMatchPositions(body: string, terms: string[]) {
  const loweredBody = body.toLowerCase();
  const normalizedCharacters: string[] = [];
  const originalPositions: number[] = [];
  for (let index = 0; index < loweredBody.length; index++) {
    if (/\s/.test(loweredBody[index])) {
      continue;
    }
    normalizedCharacters.push(loweredBody[index]);
    originalPositions.push(index);
  }
  const normalizedBody = normalizedCharacters.join("");

  const matches: MatchPosition[] = [];
  for (const term of terms) {
    const normalizedTerm = term.toLowerCase().replace(/\s+/g, "");
    for (const candidate of buildTermCandidates(normalizedTerm)) {
      let found = false;
      let searchFrom = 0;
      let matchIndex;
      while (
        (matchIndex = normalizedBody.indexOf(candidate, searchFrom)) !== -1 &&
        matches.length < maximumMatchPositions
      ) {
        matches.push({ position: originalPositions[matchIndex], term: normalizedTerm });
        found = true;
        searchFrom = matchIndex + 1;
      }
      if (found) {
        break;
      }
    }
  }
  return matches;
}

// 조사·어미가 붙은 쿼리 단어를 위해 끝을 최대 2자까지 깎은 prefix로 재시도한다
function buildTermCandidates(normalizedTerm: string) {
  const candidates = [normalizedTerm];
  const shortestLength = Math.max(minimumTrimmedTermCharacters, normalizedTerm.length - maximumTermTrimCharacters);
  for (let length = normalizedTerm.length - 1; length >= shortestLength; length--) {
    candidates.push(normalizedTerm.slice(0, length));
  }
  return candidates;
}

function pickDensestWindow(matches: MatchPosition[]) {
  const sorted = [...matches].sort((a, b) => a.position - b.position);
  let best = { start: sorted[0].position, end: sorted[0].position, distinctTermCount: 0 };
  for (let startIndex = 0; startIndex < sorted.length; startIndex++) {
    const distinctTerms = new Set<string>();
    let end = sorted[startIndex].position;
    for (
      let endIndex = startIndex;
      endIndex < sorted.length && sorted[endIndex].position - sorted[startIndex].position <= matchWindowCharacters;
      endIndex++
    ) {
      distinctTerms.add(sorted[endIndex].term);
      end = sorted[endIndex].position;
    }
    if (distinctTerms.size > best.distinctTermCount) {
      best = { start: sorted[startIndex].position, end, distinctTermCount: distinctTerms.size };
    }
  }
  return best;
}
