export type ProjectContext = {
  name: string;
  repo?: string;
  root?: string;
};

export type ReviewQueueItem = {
  id: string;
  type: string;
  acceptanceState: string;
  reviewState: string;
  decisionState: string;
  /** Deprecated compatibility field. Use acceptanceState/reviewState/decisionState. */
  status: string;
  title: string;
  summary?: string;
  canonicalPath: string;
  scope: string;
  sourceKind?: string;
  sourceRef?: string;
  project?: ProjectContext;
  confidence: number;
  useCount: number;
  lastUsedAt?: string;
  openRefinementOpinionCount: number;
  reviewPriorityScore: number;
  reviewPriorityReasons: string[];
  metadata: Record<string, unknown>;
};

export type RationaleEntry = {
  frontmatter: {
    id: string;
    type: string;
    acceptanceState: string;
    reviewState: string;
    decisionState: string;
    /** Deprecated compatibility field. Use acceptanceState/reviewState/decisionState. */
    status: string;
    scope: string;
    domains: string[];
    intents: string[];
    modes: string[];
    confidence: number;
    project?: ProjectContext;
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

export type RefinementOpinion = {
  id: string;
  entryId: string;
  opinionType: string;
  status: string;
  body: string;
  suggestedPatch?: Record<string, unknown>;
  sourceKind: string;
  sourceRef?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type ReviewQueueDetail = {
  entry: RationaleEntry;
  review: CandidateReview;
  usage: {
    useCount: number;
    lastUsedAt?: string;
  };
  refinementOpinions: RefinementOpinion[];
};

export type ReviewAction = "accept" | "keep_candidate" | "needs_revision" | "deprecate";

export type RefinementOpinionAction = "resolve" | "reject" | "apply_patch";
