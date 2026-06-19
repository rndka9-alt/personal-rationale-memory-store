export type NoteRecord = {
  id: string;
  content: string;
  topic?: string;
  sourceConversation?: {
    messages: Array<{
      role: "user" | "assistant";
      text: string;
    }>;
  };
  upvotes: number;
  downvotes: number;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
};
