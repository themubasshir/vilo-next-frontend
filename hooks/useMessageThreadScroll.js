"use client";

import { useLayoutEffect, useRef, useState } from "react";

export const MESSAGE_BOTTOM_THRESHOLD = 80;
export function isNearBottom(container) {
  return container.scrollHeight - container.scrollTop - container.clientHeight <= MESSAGE_BOTTOM_THRESHOLD;
}

// Scroll UI only: fetching and read acknowledgements stay with each message page.
export default function useMessageThreadScroll(conversationId, messages, loading) {
  const threadRef = useRef(null);
  const threadContentRef = useRef(null);
  const threadEndRef = useRef(null);
  const pinned = useRef(true);
  const geometry = useRef({ height: 0, contentHeight: 0 });
  const previous = useRef({ conversationId: null, ids: new Set() });
  const [hasNewMessages, setHasNewMessages] = useState(false);

  function scrollLatest() {
    const container = threadRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
      geometry.current = { height: container.clientHeight, contentHeight: container.scrollHeight };
    }
  }
  function prepareLatest() {
    pinned.current = true;
    setHasNewMessages(false);
  }
  function jumpToLatest() {
    prepareLatest();
    scrollLatest();
  }
  function onThreadScroll() {
    const container = threadRef.current;
    if (!container) return;
    // Browser layout changes can emit scroll events before ResizeObserver runs.
    // Keep an already pinned reader pinned; only unchanged geometry implies scrolling away.
    if (pinned.current && (geometry.current.height !== container.clientHeight || geometry.current.contentHeight !== container.scrollHeight)) {
      scrollLatest();
      return;
    }
    geometry.current = { height: container.clientHeight, contentHeight: container.scrollHeight };
    pinned.current = isNearBottom(container);
    if (pinned.current) setHasNewMessages(false);
  }

  useLayoutEffect(() => {
    if (previous.current.conversationId !== conversationId) {
      previous.current = { conversationId, ids: new Set() };
      prepareLatest();
    }
    if (!conversationId || loading) return;
    const added = messages.some(message => !previous.current.ids.has(message.id));
    if (pinned.current) scrollLatest();
    else if (added) setHasNewMessages(true);
    previous.current.ids = new Set(messages.map(message => message.id));
  }, [conversationId, messages, loading]);

  useLayoutEffect(() => {
    const container = threadRef.current;
    const content = threadContentRef.current;
    if (!container || !content) return;
    // Covers attachment layout and composer/viewport resizing without polling.
    const observer = new ResizeObserver(() => {
      if (pinned.current) scrollLatest();
    });
    observer.observe(container);
    observer.observe(content);
    return () => observer.disconnect();
  }, [conversationId]);

  return { threadRef, threadContentRef, threadEndRef, onThreadScroll, jumpToLatest, prepareLatest, hasNewMessages };
}
