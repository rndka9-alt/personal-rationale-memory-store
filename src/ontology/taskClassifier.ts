export type TaskClassification = {
  intent: string;
  domain: string;
  mode: string;
  riskLevel: "low" | "medium" | "high";
  likelyArtifact: string;
  substantial: boolean;
};

export function classifyTask(task: string, explicitMode?: string, explicitDomains?: string[]): TaskClassification {
  const lowerTask = task.toLowerCase();
  const intent = lowerTask.includes("debug") || lowerTask.includes("fix") || lowerTask.includes("error")
    ? "debug"
    : lowerTask.includes("review")
      ? "review"
      : "design";

  const mode = explicitMode
    ?? (lowerTask.includes("implement") || lowerTask.includes("code") ? "coding" : "planning");

  const domain = explicitDomains && explicitDomains.length > 0
    ? explicitDomains[0] ?? "general"
    : lowerTask.includes("memory") || lowerTask.includes("rationale")
      ? "memory-system"
      : "development";

  const substantial = task.length > 80 || lowerTask.includes("architecture") || lowerTask.includes("implement");

  return {
    intent,
    domain,
    mode,
    riskLevel: substantial ? "medium" : "low",
    likelyArtifact: mode === "coding" ? "code" : "plan",
    substantial
  };
}

