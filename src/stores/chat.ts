import {
  persist,
  createIndexedDBStorage,
} from "@macfja/svelte-persistent-store";
import { writable } from "svelte/store";

import type { ChatSession } from "../lib/types/chat";

const DEFAULT_SESSION_ID = "default";
const CHAT_SESSIONS_KEY = "chat-sessions";

type Sessions = {
  [sessiondID: string]: ChatSession;
};

export let currentSessionId = writable(DEFAULT_SESSION_ID);

function defaultChat(): ChatSession {
  return {
    id: DEFAULT_SESSION_ID,
    title: "New conversation",
    messages: [],
  };
}

export function switchToNewChat() {
  const id = crypto.randomUUID();
  chatSessions.update((sessions) => {
    sessions[id] = defaultChat();
    return sessions;
  });
  currentSessionId.set(id);
}

export let chatSessions = persist(
  writable<Sessions>({
    [DEFAULT_SESSION_ID]: defaultChat(),
  }),
  createIndexedDBStorage(),
  CHAT_SESSIONS_KEY,
);
