export type TaskClassification = {
  intent: string;
  intents: string[];
  domain: string;
  domains: string[];
  mode: string;
  modes: string[];
  riskLevel: "low" | "medium" | "high";
  likelyArtifact: string;
  substantial: boolean;
  trivial: boolean;
  fileHints: string[];
  reasons: string[];
};

export function classifyTask(task: string, explicitMode?: string, explicitDomains?: string[]): TaskClassification {
  const lowerTask = task.toLowerCase();
  const reasons: string[] = [];
  const intents = unique([
    ...matchIntent(lowerTask, reasons),
    "design"
  ]);
  const modes = unique([
    ...(explicitMode ? [explicitMode] : matchMode(lowerTask, reasons)),
    "planning"
  ]);
  const domains = unique([
    ...(explicitDomains && explicitDomains.length > 0 ? explicitDomains : matchDomain(lowerTask, reasons)),
    "development"
  ]);
  const fileHints = extractFileHints(task);
  const likelyArtifact = inferArtifact(lowerTask, fileHints, reasons);
  const trivial = inferTrivial(lowerTask, task, reasons);
  const substantial = !trivial && (
    task.length > 80
    || lowerTask.includes("architecture")
    || lowerTask.includes("implement")
    || lowerTask.includes("design")
    || lowerTask.includes("tradeoff")
  );
  const riskLevel = inferRiskLevel(lowerTask, substantial, trivial, reasons);

  return {
    intent: intents[0] ?? "design",
    intents,
    domain: domains[0] ?? "development",
    domains,
    mode: modes[0] ?? "planning",
    modes,
    riskLevel,
    likelyArtifact,
    substantial,
    trivial,
    fileHints,
    reasons
  };
}

function matchIntent(lowerTask: string, reasons: string[]) {
  const intents: string[] = [];
  if (includesAny(lowerTask, ["debug", "troubleshoot", "error", "fail", "bug", "fix"])) {
    intents.push("debug");
    reasons.push("debug keywords");
  }
  if (includesAny(lowerTask, ["review", "검토", "리뷰"])) {
    intents.push("review");
    reasons.push("review keywords");
  }
  if (includesAny(lowerTask, ["compare", "tradeoff", "choose", "선택", "비교"])) {
    intents.push("compare");
    reasons.push("comparison keywords");
  }
  if (includesAny(lowerTask, ["plan", "design", "architecture", "설계", "계획"])) {
    intents.push("design");
    reasons.push("design keywords");
  }
  return intents;
}

function matchMode(lowerTask: string, reasons: string[]) {
  if (includesAny(lowerTask, ["implement", "code", "coding", "build", "구현", "수정"])) {
    reasons.push("implementation keywords");
    return ["coding"];
  }
  if (includesAny(lowerTask, ["review", "검토", "리뷰"])) {
    reasons.push("review mode keywords");
    return ["review"];
  }
  return ["planning"];
}

function matchDomain(lowerTask: string, reasons: string[]) {
  const domains: string[] = [];
  if (includesAny(lowerTask, ["memory", "rationale", "ontology", "embedding", "mcp", "메모리", "기억"])) {
    domains.push("memory-system");
    reasons.push("memory-system keywords");
  }
  if (includesAny(lowerTask, ["docker", "compose", "cloudflare", "tunnel", "postgres", "deploy"])) {
    domains.push("operations");
    reasons.push("operations keywords");
  }
  return domains.length > 0 ? domains : ["development"];
}

function inferArtifact(lowerTask: string, fileHints: string[], reasons: string[]) {
  if (fileHints.some((fileHint) => fileHint.endsWith(".md") || fileHint.endsWith(".mdx"))) {
    reasons.push("markdown file hint");
    return "documentation";
  }
  if (fileHints.length > 0 || includesAny(lowerTask, ["code", "implement", "typescript", ".ts", "구현"])) {
    reasons.push("code artifact hint");
    return "code";
  }
  if (includesAny(lowerTask, ["docker", "compose", "env", "config"])) {
    reasons.push("configuration artifact hint");
    return "configuration";
  }
  return "plan";
}

function inferTrivial(lowerTask: string, task: string, reasons: string[]) {
  const trivial = task.length < 60 && includesAny(lowerTask, ["typo", "rename", "format", "오타"]);
  if (trivial) {
    reasons.push("trivial task keywords");
  }
  return trivial;
}

function inferRiskLevel(lowerTask: string, substantial: boolean, trivial: boolean, reasons: string[]): "low" | "medium" | "high" {
  if (trivial) {
    return "low";
  }
  if (includesAny(lowerTask, ["security", "auth", "delete", "migration", "destructive", "보안", "삭제"])) {
    reasons.push("high risk keywords");
    return "high";
  }
  return substantial ? "medium" : "low";
}

function extractFileHints(task: string) {
  const matches = task.match(/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+/g);
  return matches ? unique(matches) : [];
}

function includesAny(value: string, candidates: string[]) {
  return candidates.some((candidate) => value.includes(candidate));
}

function unique(values: string[]) {
  return [...new Set(values)];
}
