export type ReviewQueueItem = {
  id: string;
  type: string;
  status: string;
  title: string;
  summary?: string;
  canonicalPath: string;
  scope: string;
  sourceKind?: string;
  sourceRef?: string;
  confidence: number;
  metadata: Record<string, unknown>;
};

export type RationaleEntry = {
  frontmatter: {
    id: string;
    type: string;
    status: string;
    scope: string;
    domains: string[];
    intents: string[];
    modes: string[];
    confidence: number;
    metadata: Record<string, unknown>;
    source?: {
      kind: string;
      ref: string;
    };
  };
  title: string;
  situation?: string;
  goal?: string;
  constraints: string[];
  decision?: string;
  rationale: string;
  rejectedAlternatives: Array<{
    option: string;
    reason: string;
  }>;
  tradeoff?: string;
  reuseWhen: string[];
  avoidWhen: string[];
  rawMarkdown: string;
};

export type CandidateReview = {
  id: string;
  title: string;
  score: number;
  recommendation: "accept" | "revise" | "deprecate";
  missingSections: string[];
  strengths: string[];
  cautions: string[];
};

export type ReviewQueueDetail = {
  entry: RationaleEntry;
  review: CandidateReview;
};

export type ReviewAction = "accept" | "keep_candidate" | "needs_revision" | "deprecate";

