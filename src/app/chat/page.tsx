import type { Metadata } from "next";

import { ChatScreen } from "@/components/chat-screen";
import { APP_NAME } from "@/lib/pwa/constants";

export const metadata: Metadata = {
  title: `Chat · ${APP_NAME}`,
};

export default function ChatPage() {
  return (
    <main className="chat-shell">
      <header className="chat-shell__header">
        <h1>Chat</h1>
      </header>
      <ChatScreen />
    </main>
  );
}
