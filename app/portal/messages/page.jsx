"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { apiRequest } from "../../../lib/api";
import { formatViloDate } from "../../../lib/dateFormat";

function formatConversationTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : formatViloDate(date, "");
}

function formatBubbleTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatDayLabel(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return "Today";
  return formatViloDate(date, "");
}

function sameDay(left, right) {
  return new Date(left).toDateString() === new Date(right).toDateString();
}

function getInitials(value) {
  const source = String(value || "Message").trim();
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] || ""}${parts[1][0] || ""}`.toUpperCase();
}

function IconBase({ children }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

function SearchIcon() {
  return (
    <IconBase>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </IconBase>
  );
}

function DotsIcon() {
  return (
    <IconBase>
      <path d="M5 12h.01" />
      <path d="M12 12h.01" />
      <path d="M19 12h.01" />
    </IconBase>
  );
}

function PaperclipIcon() {
  return (
    <IconBase>
      <path d="m21.4 11.1-8.8 8.8a5 5 0 1 1-7.1-7.1l9.1-9.1a3.5 3.5 0 1 1 5 5l-9.4 9.4a2 2 0 1 1-2.8-2.8l8.4-8.4" />
    </IconBase>
  );
}

function SendIcon() {
  return (
    <IconBase>
      <path d="M22 2 11 13" />
      <path d="m22 2-7 20-4-9-9-4 20-7Z" />
    </IconBase>
  );
}

export default function PortalMessagesPage() {
  const [conversations, setConversations] = useState([]);
  const [selected, setSelected] = useState(null);
  const [messages, setMessages] = useState([]);
  const [body, setBody] = useState("");
  const [composerRefs, setComposerRefs] = useState([]);
  const [showCasePicker, setShowCasePicker] = useState(false);
  const [caseSearch, setCaseSearch] = useState("");
  const [caseRows, setCaseRows] = useState([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [sendError, setSendError] = useState("");
  const [meId, setMeId] = useState(null);
  const threadEndRef = useRef(null);

  async function loadConversations() {
    const rows = await apiRequest("/api/v1/portal/messages/conversations");
    setConversations(rows || []);
    setSelected((prev) => {
      if (prev) return (rows || []).find((r) => r.id === prev.id) || ((rows || [])[0] || null);
      return (rows || [])[0] || null;
    });
  }

  async function loadMessages(conversationId) {
    setMessagesLoading(true);
    try {
      const rows = await apiRequest(`/api/v1/portal/messages/conversations/${conversationId}/messages`);
      setMessages(rows || []);
      await apiRequest(`/api/v1/portal/messages/conversations/${conversationId}/mark-read`, { method: "POST" });
    } finally {
      setMessagesLoading(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    Promise.all([loadConversations(), apiRequest("/api/v1/auth/me").then((me) => setMeId(me?.id || null))])
      .catch((err) => setError(err.message || "Failed to load conversations"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selected?.id) return;
    loadMessages(selected.id).catch((err) => setError(err.message || "Failed to load messages"));
  }, [selected?.id]);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, selected?.id]);

  async function sendMessage(e) {
    e.preventDefault();
    if (!selected?.id || !body.trim() || sending) return;
    setSending(true);
    setError("");
    setSendError("");
    try {
      await apiRequest(`/api/v1/portal/messages/conversations/${selected.id}/messages`, {
        method: "POST",
        body: JSON.stringify({ body: body.trim(), case_reference_ids: composerRefs.map((c) => c.id) }),
      });
      setBody("");
      setComposerRefs([]);
      await loadConversations();
      await loadMessages(selected.id);
    } catch (err) {
      setSendError(err.message || "Failed to send message");
    } finally {
      setSending(false);
    }
  }

  async function searchCases(q = "") {
    try {
      const rows = await apiRequest(`/api/v1/portal/messages/case-search?q=${encodeURIComponent(q)}`);
      setCaseRows(rows || []);
    } catch {
      setCaseRows([]);
    }
  }

  function onComposerKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(e);
    }
  }

  const filteredConversations = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((conv) => `${conv.title || ""} ${conv.latest_message?.body || ""} ${conv.case_title || ""}`.toLowerCase().includes(q));
  }, [conversations, query]);

  const selectedTitle = selected?.title || `Conversation #${selected?.id}`;
  const selectedSubtitle = selected?.case_title || `${selected?.participant_count || 0} participants`;

  return (
    <section className="dashboard-page-stack">
      {loading ? <div className="vilo-state-block"><p className="vilo-state vilo-state--loading">Loading conversations...</p></div> : null}
      {error ? <div className="vilo-state-block"><p className="vilo-state vilo-state--error">{error}</p></div> : null}

      <div className="messages-shell dashboard-card">
        <div className="messages-layout messages-layout--portal">
          <aside className="messages-sidebar">
            <div className="messages-sidebar__head">
              <h2>Messages</h2>
            </div>
            <div className="messages-sidebar__search">
              <label className="messages-search-field">
                <SearchIcon />
                <input placeholder="Search conversations" value={query} onChange={(e) => setQuery(e.target.value)} />
              </label>
            </div>
            <div className="messages-sidebar__list">
              {!filteredConversations.length ? (
                <div className="messages-empty-state">
                  <strong>No conversations</strong>
                  <span>No portal conversations are available yet.</span>
                </div>
              ) : null}
              {filteredConversations.map((conv) => (
                <button key={conv.id} type="button" className={`messages-conversation-item${selected?.id === conv.id ? " is-active" : ""}`} onClick={() => setSelected(conv)}>
                  <span className="messages-conversation-item__avatar">{getInitials(conv.title || "Conversation")}</span>
                  <span className="messages-conversation-item__main">
                    <span className="messages-conversation-item__top">
                      <strong>{conv.title || `Conversation #${conv.id}`}</strong>
                      <small>{formatConversationTime(conv.latest_message?.created_at || conv.updated_at)}</small>
                    </span>
                    <span className="messages-conversation-item__meta">{conv.case_title || "Portal conversation"}</span>
                    <span className="messages-conversation-item__bottom">
                      <span className="messages-conversation-item__preview">{conv.latest_message?.body || "No messages yet"}</span>
                      {conv.unread_count > 0 ? <em>{conv.unread_count}</em> : null}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </aside>

          <article className="messages-thread">
            {!selected ? (
              <div className="messages-empty">
                <div className="messages-empty-state messages-empty-state--thread">
                  <strong>No conversation selected</strong>
                  <span>Select a conversation from the list to view your messages.</span>
                </div>
              </div>
            ) : (
              <>
                <div className="messages-thread__head">
                  <div className="messages-thread__identity">
                    <span className="messages-thread__avatar">{getInitials(selectedTitle)}</span>
                    <div>
                      <h3>{selectedTitle}</h3>
                      <p>{selectedSubtitle}</p>
                      {selected.case_id ? (
                        <Link href={`/portal/cases/${selected.case_id}`} className="message-case-chip">
                          Case: {selected.case_title || `#${selected.case_id}`} ({selected.case_display_number || `CASE${String(selected.case_id).padStart(6, "0")}`})
                        </Link>
                      ) : null}
                    </div>
                  </div>
                  <div className="messages-thread__actions" aria-label="Conversation actions">
                    <button type="button" className="messages-icon-button" aria-label="More actions unavailable" title="More actions unavailable">
                      <DotsIcon />
                    </button>
                  </div>
                </div>

                <div className="messages-thread__body">
                  {messagesLoading ? (
                    <div className="messages-empty-state messages-empty-state--thread">
                      <strong>Loading messages</strong>
                      <span>Fetching your conversation history.</span>
                    </div>
                  ) : null}
                  {!messagesLoading && !messages.length ? (
                    <div className="messages-empty-state messages-empty-state--thread">
                      <strong>No messages yet</strong>
                      <span>Send the first portal message to start this thread.</span>
                    </div>
                  ) : null}
                  {!messagesLoading ? messages.map((msg, index) => {
                    const mine = meId && Number(msg.sender_id) === Number(meId);
                    const showDay = index === 0 || !sameDay(messages[index - 1]?.created_at, msg.created_at);
                    return (
                      <div key={msg.id}>
                        {showDay ? <div className="messages-day-separator"><span>{formatDayLabel(msg.created_at)}</span></div> : null}
                        <div className={`message-bubble-row${mine ? " is-mine" : ""}`}>
                          <div className={`message-bubble${mine ? " is-mine" : ""}`}>
                            {!mine ? <small className="message-bubble__sender">{msg.sender_name || `User #${msg.sender_id}`}</small> : null}
                            <p>{msg.body}</p>
                            {msg.case_references?.length ? (
                              <div className="message-bubble__refs">
                                {msg.case_references.map((ref) => (
                                  <Link key={`${msg.id}-${ref.case_id}`} href={`/portal/cases/${ref.case_id}`} className="message-case-chip">
                                    Case: {ref.case_title} ({ref.case_display_number || `#${ref.case_id}`})
                                  </Link>
                                ))}
                              </div>
                            ) : null}
                            <span className="message-bubble__time">{formatBubbleTime(msg.created_at)}</span>
                          </div>
                        </div>
                      </div>
                    );
                  }) : null}
                  <div ref={threadEndRef} />
                </div>

                <form className="messages-thread__composer" onSubmit={sendMessage}>
                  {composerRefs.length ? (
                    <div className="message-composer-refs">
                      {composerRefs.map((row) => (
                        <span key={row.id} className="message-case-chip">
                          Case: {row.title} ({row.display_number || `#${row.id}`})
                          <button type="button" onClick={() => setComposerRefs((prev) => prev.filter((item) => item.id !== row.id))}>×</button>
                        </span>
                      ))}
                    </div>
                  ) : null}
                  <div className="messages-composer__main">
                    <div className="messages-composer__input-wrap">
                      <textarea placeholder="Write a message..." value={body} onChange={(e) => setBody(e.target.value)} onKeyDown={onComposerKeyDown} required />
                      <div className="messages-composer__tools">
                        <button
                          type="button"
                          className="messages-link-case-button"
                          onClick={async () => {
                            setShowCasePicker(true);
                            if (!caseRows.length) await searchCases("");
                          }}
                        >
                          <PaperclipIcon />
                          <span>Link Case</span>
                        </button>
                      </div>
                    </div>
                    <button type="submit" className="vilo-btn vilo-btn--primary messages-send-button" disabled={sending || !body.trim()}>
                      <SendIcon />
                      <span>{sending ? "Sending..." : "Send"}</span>
                    </button>
                  </div>
                  {sendError ? <p className="vilo-state vilo-state--error">{sendError}</p> : null}
                </form>
              </>
            )}
          </article>
        </div>
      </div>

      {showCasePicker ? (
        <div className="vilo-modal-overlay" onClick={() => setShowCasePicker(false)}>
          <div className="vilo-modal" onClick={(e) => e.stopPropagation()}>
            <div className="vilo-modal__header">
              <h3>Link Case</h3>
              <button type="button" className="vilo-btn vilo-btn--ghost vilo-btn--xs" onClick={() => setShowCasePicker(false)}>Close</button>
            </div>
            <div className="vilo-modal__body">
              <div className="vilo-form-grid">
                <label className="messages-search-field">
                  <SearchIcon />
                  <input
                    placeholder="Search your cases"
                    value={caseSearch}
                    onChange={async (e) => {
                      const next = e.target.value;
                      setCaseSearch(next);
                      await searchCases(next);
                    }}
                  />
                </label>
                <div className="messages-case-search-list">
                  {!caseRows.length ? (
                    <div className="messages-empty-state">
                      <strong>No cases found</strong>
                      <span>No accessible portal cases matched your search.</span>
                    </div>
                  ) : null}
                  {caseRows.map((row) => (
                    <button
                      key={row.id}
                      type="button"
                      className="messages-case-search-item"
                      onClick={() => {
                        setComposerRefs((prev) => (prev.some((item) => item.id === row.id) ? prev : [...prev, row]));
                        setShowCasePicker(false);
                      }}
                    >
                      <strong>{row.title}</strong>
                      <span>{row.display_number || `#${row.id}`}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
