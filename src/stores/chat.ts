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

export let chatSessions = persist(
  writable<Sessions>({
    [DEFAULT_SESSION_ID]: {
      id: DEFAULT_SESSION_ID,
      title: "New conversation",
      messages: [],
    },
  }),
  createIndexedDBStorage(),
  CHAT_SESSIONS_KEY,
);
