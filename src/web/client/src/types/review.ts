export type ProjectContext = {
  name: string;
  repo?: string;
  root?: string;
};

export type UsageFeedbackCounts = {
  appliedCount: number;
  helpfulCount: number;
  unhelpfulCount: number;
  dismissedCount: number;
  positiveCount: number;
  negativeCount: number;
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
  createdAt?: string;
  usageFeedback: UsageFeedbackCounts;
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
  body: string;
  rawMarkdown: string;
};

export type CandidateReview = {
  id: string;
  title: string;
  strengths: string[];
  cautions: string[];
};

export type ReviewQueueDetail = {
  entry: RationaleEntry;
  review: CandidateReview;
  usage: {
    useCount: number;
    lastUsedAt?: string;
    feedback: UsageFeedbackCounts;
  };
};

export type ReviewAction = "accept" | "keep_candidate" | "needs_revision" | "deprecate";
