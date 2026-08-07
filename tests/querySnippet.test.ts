import { describe, expect, it } from "vitest";
import { buildHeadSnippet, buildQuerySnippet, flattenBodyText } from "../src/memory/querySnippet.js";

const longFiller = "무관한 배경 설명이 이어진다. ".repeat(30);

describe("buildQuerySnippet", () => {
  it("쿼리 단어 주변을 발췌하고 잘린 양쪽 경계에 ellipsis를 붙인다", () => {
    const body = `${longFiller}k3s v1.25 / OpenReplay v1.19 전부 구버전(EOL 지남)이다.${longFiller}`;
    const snippet = buildQuerySnippet(body, "OpenReplay EOL 구버전");

    expect(snippet).toContain("EOL 지남");
    expect(snippet?.startsWith("…")).toBe(true);
    expect(snippet?.endsWith("…")).toBe(true);
  });

  it("본문 띄어쓰기가 달라도 매칭한다", () => {
    const body = `${longFiller}셀프 호스팅 구성은 EC2 위에서 돌아간다.`;

    expect(buildQuerySnippet(body, "셀프호스팅")).toContain("셀프 호스팅 구성");
  });

  it("조사가 붙은 쿼리 단어를 어간 prefix로 매칭한다", () => {
    const body = `${longFiller}버저닝 도입 당시의 결정이 기록되어 있다.`;

    expect(buildQuerySnippet(body, "버저닝을 추가")).toContain("버저닝 도입");
  });

  it("대소문자를 무시하고 매칭한다", () => {
    const body = `${longFiller}OpenReplay tracker 버전 불일치가 원인이다.`;

    expect(buildQuerySnippet(body, "openreplay 버전")).toContain("OpenReplay tracker");
  });

  it("쿼리 단어가 여러 곳에 흩어져 있으면 distinct 단어가 가장 많이 모인 창을 고른다", () => {
    const body = `여기는 kyverno 언급만 있다. ${longFiller}결론 구간에는 kyverno v1.10 EOL 상태가 함께 적혀 있다.`;

    expect(buildQuerySnippet(body, "kyverno EOL")).toContain("kyverno v1.10 EOL");
  });

  it("매칭되는 단어가 없으면 null을 돌려준다", () => {
    expect(buildQuerySnippet("전혀 다른 주제의 본문이다.", "OpenReplay kyverno")).toBeNull();
  });

  it("창을 300자로 자르면 끝에 ellipsis를 붙인다", () => {
    const body = `시작 keyword ${"긴 내용이 계속 이어진다 ".repeat(50)}`;
    const snippet = buildQuerySnippet(body, "keyword");

    expect(snippet?.length).toBeLessThanOrEqual(302);
    expect(snippet?.endsWith("…")).toBe(true);
  });
});

describe("buildHeadSnippet", () => {
  it("500자를 넘으면 잘라내고 ellipsis를 붙인다", () => {
    const snippet = buildHeadSnippet("가".repeat(600));

    expect(snippet.length).toBe(501);
    expect(snippet.endsWith("…")).toBe(true);
  });

  it("500자 이하면 마커 없이 그대로 돌려준다", () => {
    expect(buildHeadSnippet("짧은 본문")).toBe("짧은 본문");
  });
});

describe("flattenBodyText", () => {
  it("마크다운 헤딩과 불릿 마커를 벗기고 한 줄로 합친다", () => {
    expect(flattenBodyText("## 결론\n- 항목 하나\n본문 문장")).toBe("결론 항목 하나 본문 문장");
  });
});
