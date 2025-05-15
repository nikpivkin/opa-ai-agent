export type Message = {
  role: "user" | "system" | "assistant";
  content: string;
};

export type ChatSession = {
  id: string;
  title: string;
  messages: Message[];
};
