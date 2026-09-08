"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { apiRequest } from "../../../lib/api";
import { formatViloDate } from "../../../lib/dateFormat";

const initialForm = {
  conversation_type: "internal",
  title: "",
  first_message: "",
};

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

function conversationLabel(conv) {
  return conv.title || `${conv.conversation_type} #${conv.id}`;
}

function titleCase(value) {
  return String(value || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function userLabel(user) {
  if (!user) return "User";
  return user.name || user.email || "User";
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

function UsersIcon() {
  return (
    <IconBase>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </IconBase>
  );
}

export default function MessagesPage() {
  return (
    <Suspense fallback={<section className="dashboard-page-stack"><div className="vilo-state-block"><p className="vilo-state vilo-state--loading">Loading messages...</p></div></section>}>
      <MessagesPageContent />
    </Suspense>
  );
}

function MessagesPageContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const threadEndRef = useRef(null);
  const firstMessageRef = useRef(null);

  const [conversations, setConversations] = useState([]);
  const [cases, setCases] = useState([]);
  const [clients, setClients] = useState([]);
  const [users, setUsers] = useState([]);
  const [selected, setSelected] = useState(null);
  const [threadParticipants, setThreadParticipants] = useState([]);
  const [createParticipants, setCreateParticipants] = useState([]);
  const [messages, setMessages] = useState([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [messageBody, setMessageBody] = useState("");
  const [composerRefs, setComposerRefs] = useState([]);
  const [caseSearch, setCaseSearch] = useState("");
  const [caseSearchRows, setCaseSearchRows] = useState([]);
  const [showCasePicker, setShowCasePicker] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [participantQuery, setParticipantQuery] = useState("");
  const [participantRows, setParticipantRows] = useState([]);
  const [participantLoading, setParticipantLoading] = useState(false);
  const [participantError, setParticipantError] = useState("");
  const [form, setForm] = useState(initialForm);
  const [selectedCase, setSelectedCase] = useState(null);
  const [createCaseQuery, setCreateCaseQuery] = useState("");
  const [createCaseRows, setCreateCaseRows] = useState([]);
  const [createCaseLoading, setCreateCaseLoading] = useState(false);
  const [createCaseError, setCreateCaseError] = useState("");
  const [loading, setLoading] = useState(true);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [sendError, setSendError] = useState("");
  const [createError, setCreateError] = useState("");
  const [meId, setMeId] = useState(null);

  const requestedClientId = Number(searchParams.get("client_id") || 0);

  const usersById = useMemo(
    () => new Map(users.map((user) => [Number(user.id), user])),
    [users],
  );

  const clientsById = useMemo(
    () => new Map(clients.map((client) => [Number(client.id), client])),
    [clients],
  );

  const casesById = useMemo(
    () => new Map(cases.map((caseRow) => [Number(caseRow.id), caseRow])),
    [cases],
  );

  async function loadUsers(search = "", currentUserId = meId) {
    setParticipantLoading(true);
    setParticipantError("");
    try {
      const rows = await apiRequest(`/api/v1/users${search ? `?search=${encodeURIComponent(search)}` : ""}`);
      const usable = (rows || []).filter((user) => Number(user.id) !== Number(currentUserId || 0));
      setUsers((current) => {
        const map = new Map(current.map((user) => [Number(user.id), user]));
        usable.forEach((user) => map.set(Number(user.id), user));
        return Array.from(map.values());
      });
      setParticipantRows(usable);
    } catch (err) {
      setParticipantError(err.message || "Failed to load users");
      setParticipantRows([]);
    } finally {
      setParticipantLoading(false);
    }
  }

  async function searchCases(q = "", mode = "composer") {
    const setter = mode === "composer" ? setCaseSearchRows : setCreateCaseRows;
    const setLoadingState = mode === "composer" ? setShowCasePicker : null;
    if (mode === "create") {
      setCreateCaseLoading(true);
      setCreateCaseError("");
    }
    try {
      const rows = await apiRequest(`/api/v1/conversations/cases/search?q=${encodeURIComponent(q)}`);
      setter(rows || []);
    } catch (err) {
      setter([]);
      if (mode === "create") setCreateCaseError(err.message || "Failed to load cases");
    } finally {
      if (mode === "create") setCreateCaseLoading(false);
      if (mode === "composer" && setLoadingState) setLoadingState(true);
    }
  }

  async function loadConversations(targetConversationId = null) {
    const rows = await apiRequest("/api/v1/conversations");
    setConversations(rows || []);
    setSelected((prev) => {
      if (targetConversationId) {
        const direct = (rows || []).find((row) => Number(row.id) === Number(targetConversationId));
        if (direct) return direct;
      }
      if (prev) {
        const next = (rows || []).find((row) => row.id === prev.id);
        return next || ((rows || [])[0] || null);
      }
      return (rows || [])[0] || null;
    });
  }

  async function loadMessages(conversationId) {
    setMessagesLoading(true);
    try {
      const rows = await apiRequest(`/api/v1/conversations/${conversationId}/messages`);
      setMessages(rows || []);
      await apiRequest(`/api/v1/conversations/${conversationId}/mark-read`, { method: "POST" });
    } finally {
      setMessagesLoading(false);
    }
  }

  async function loadParticipants(conversationId) {
    const rows = await apiRequest(`/api/v1/conversations/${conversationId}/participants`);
    setThreadParticipants(rows || []);
  }

  async function init() {
    setLoading(true);
    setError("");
    try {
      const [caseRows, clientRows, me] = await Promise.all([
        apiRequest("/api/v1/cases"),
        apiRequest("/api/v1/clients"),
        apiRequest("/api/v1/auth/me"),
      ]);
      setCases(caseRows || []);
      setClients(clientRows || []);
      setMeId(me?.id || null);
      await Promise.all([loadConversations(), loadUsers("", me?.id || null)]);
    } catch (err) {
      setError(err.message || "Failed to load messaging workspace");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    init();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (searchParams.get("create") === "1") {
      setShowCreateModal(true);
    }
  }, [searchParams]);

  useEffect(() => {
    if (searchParams.get("create") !== "1" || !requestedClientId) return;
    const targetClient = clients.find((client) => Number(client.id) === requestedClientId);
    const relatedCase = cases.find((caseRow) => Number(caseRow.client_id) === requestedClientId);
    const clientUser = users.find((user) => Number(user.id) === Number(targetClient?.user_id || 0)) || null;

    setForm((current) => ({
      ...current,
      conversation_type: clientUser && relatedCase ? "client" : current.conversation_type,
      title: current.title || (targetClient ? `Message: ${targetClient.name}` : current.title),
    }));

    if (relatedCase) setSelectedCase(relatedCase);
    if (clientUser) {
      setCreateParticipants((current) => (current.some((user) => Number(user.id) === Number(clientUser.id)) ? current : [clientUser, ...current]));
    }
  }, [cases, clients, requestedClientId, searchParams, users]);

  useEffect(() => {
    const conversationId = Number(searchParams.get("conversation") || 0);
    if (!conversationId || !conversations.length) return;
    const target = conversations.find((row) => Number(row.id) === conversationId);
    if (target) {
      setSelected((prev) => (prev?.id === target.id ? prev : target));
    }
  }, [conversations, searchParams]);

  useEffect(() => {
    if (!selected?.id) return;
    Promise.all([loadMessages(selected.id), loadParticipants(selected.id)])
      .catch((err) => setError(err.message || "Failed to load messages"));
  }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, selected?.id]);

  useEffect(() => {
    if (!showCreateModal) return;
    firstMessageRef.current?.focus();
  }, [showCreateModal]);

  useEffect(() => {
    if (!showCreateModal) return;
    const handle = setTimeout(() => {
      loadUsers(participantQuery.trim(), meId);
    }, 180);
    return () => clearTimeout(handle);
  }, [participantQuery, showCreateModal]); // eslint-disable-line react-hooks/exhaustive-deps

  const filteredConversations = useMemo(() => {
    const q = query.trim().toLowerCase();
    return conversations.filter((conv) => {
      if (filter === "unread" && !(conv.unread_count > 0)) return false;
      if (["internal", "client", "group"].includes(filter) && conv.conversation_type !== filter) return false;
      if (!q) return true;
      const blob = `${conv.title || ""} ${conv.latest_message?.body || ""} ${conv.conversation_type || ""} ${conv.case_title || ""}`.toLowerCase();
      return blob.includes(q);
    });
  }, [conversations, filter, query]);

  const selectedTitle = selected ? conversationLabel(selected) : "";
  const selectedConversationCase = selected?.case_id ? casesById.get(Number(selected.case_id)) : null;
  const selectedCaseLabel = selected?.case_display_number || (selectedCase ? `CASE${String(selectedCase.id).padStart(6, "0")}` : "");
  const selectedParticipantNames = useMemo(() => {
    if (!threadParticipants.length) return [];
    return threadParticipants.map((participant) => {
      const user = usersById.get(Number(participant.user_id));
      return userLabel(user);
    });
  }, [threadParticipants, usersById]);

  const requestedClient = useMemo(
    () => clients.find((client) => Number(client.id) === requestedClientId) || null,
    [clients, requestedClientId],
  );

  const availableParticipantRows = useMemo(() => {
    const selectedIds = new Set(createParticipants.map((user) => Number(user.id)));
    return participantRows.filter((user) => !selectedIds.has(Number(user.id)));
  }, [createParticipants, participantRows]);

  const availableCreateCaseRows = useMemo(() => {
    if (!requestedClientId) return createCaseRows;
    return createCaseRows.filter((row) => Number(casesById.get(Number(row.id))?.client_id) === requestedClientId);
  }, [casesById, createCaseRows, requestedClientId]);

  function updateRoute(paramsPatch) {
    const params = new URLSearchParams(searchParams.toString());
    Object.entries(paramsPatch).forEach(([key, value]) => {
      if (value === null || value === undefined || value === "") params.delete(key);
      else params.set(key, String(value));
    });
    const next = params.toString();
    router.replace(next ? `${pathname}?${next}` : pathname);
  }

  function openConversation(conv) {
    setSelected(conv);
    updateRoute({ conversation: conv.id, create: null });
  }

  function openCreateModal() {
    setShowCreateModal(true);
    updateRoute({ create: 1 });
  }

  function closeCreateModal() {
    setShowCreateModal(false);
    setForm(initialForm);
    setSelectedCase(null);
    setCreateParticipants([]);
    setParticipantQuery("");
    setCreateCaseQuery("");
    setCreateCaseRows([]);
    setCreateError("");
    updateRoute({ create: null });
  }

  function addCaseRef(row) {
    setComposerRefs((prev) => (prev.some((item) => item.id === row.id) ? prev : [...prev, row]));
    setShowCasePicker(false);
    setCaseSearch("");
  }

  function addParticipant(user) {
    setCreateParticipants((prev) => (prev.some((row) => Number(row.id) === Number(user.id)) ? prev : [...prev, user]));
    setParticipantQuery("");
  }

  function removeParticipant(userId) {
    setCreateParticipants((prev) => prev.filter((row) => Number(row.id) !== Number(userId)));
  }

  function removeCaseRef(caseId) {
    setComposerRefs((prev) => prev.filter((row) => Number(row.id) !== Number(caseId)));
  }

  function chooseConversationCase(row) {
    const fullCase = casesById.get(Number(row.id)) || row;
    setSelectedCase(fullCase);
    setCreateCaseQuery("");
  }

  function removeConversationCase() {
    setSelectedCase(null);
  }

  async function createConversation(event) {
    event.preventDefault();
    if (creating) return;
    setCreateError("");

    const participantIds = createParticipants.map((user) => Number(user.id));
    if (!form.title.trim() || !form.first_message.trim() || !participantIds.length) {
      setCreateError("Conversation title, participants, and first message are required.");
      return;
    }
    if (form.conversation_type === "client" && !selectedCase?.id) {
      setCreateError("Client conversations must link to a case.");
      return;
    }

    setCreating(true);
    try {
      const created = await apiRequest("/api/v1/conversations", {
        method: "POST",
        body: JSON.stringify({
          conversation_type: form.conversation_type,
          title: form.title.trim(),
          case_id: selectedCase?.id ? Number(selectedCase.id) : null,
          participant_ids: participantIds,
        }),
      });

      try {
        await apiRequest(`/api/v1/conversations/${created.id}/messages`, {
          method: "POST",
          body: JSON.stringify({
            body: form.first_message.trim(),
            case_reference_ids: [],
          }),
        });
      } catch (err) {
        await loadConversations(created.id);
        setSelected(created);
        setMessages([]);
        setCreateError("Conversation created, but the first message failed to send. Open the thread and resend it.");
        setCreating(false);
        return;
      }

      await loadConversations(created.id);
      setSelected(created);
      closeCreateModal();
      updateRoute({ conversation: created.id });
    } catch (err) {
      setCreateError(err.message || "Failed to create conversation");
    } finally {
      setCreating(false);
    }
  }

  async function sendMessage(event) {
    event.preventDefault();
    if (!selected?.id || !messageBody.trim() || sending) return;
    setSending(true);
    setError("");
    setSendError("");
    try {
      await apiRequest(`/api/v1/conversations/${selected.id}/messages`, {
        method: "POST",
        body: JSON.stringify({
          body: messageBody.trim(),
          case_reference_ids: composerRefs.map((caseRow) => caseRow.id),
        }),
      });
      setMessageBody("");
      setComposerRefs([]);
      await loadConversations(selected.id);
      await loadMessages(selected.id);
    } catch (err) {
      setSendError(err.message || "Failed to send message");
    } finally {
      setSending(false);
    }
  }

  function onComposerKeyDown(event) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage(event);
    }
  }

  const createDisabled = !form.title.trim() || !form.first_message.trim() || !createParticipants.length || (form.conversation_type === "client" && !selectedCase?.id) || creating;

  return (
    <section className="dashboard-page-stack">
      {error ? <div className="vilo-state-block"><p className="vilo-state vilo-state--error">{error}</p></div> : null}
      {loading ? <div className="vilo-state-block"><p className="vilo-state vilo-state--loading">Loading messages...</p></div> : null}

      <div className="messages-shell dashboard-card">
        <div className="messages-layout">
          <aside className="messages-sidebar">
            <div className="messages-sidebar__head">
              <div>
                <p className="messages-sidebar__eyebrow">Conversations</p>
                <h2>Messages</h2>
              </div>
              <button type="button" className="vilo-btn vilo-btn--secondary messages-sidebar__new" onClick={openCreateModal}>
                + New Message
              </button>
            </div>

            <div className="messages-sidebar__search">
              <label className="messages-search-field">
                <SearchIcon />
                <input placeholder="Search conversations" value={query} onChange={(event) => setQuery(event.target.value)} />
              </label>
            </div>

            <div className="messages-filters">
              {["all", "unread", "internal", "client", "group"].map((key) => (
                <button key={key} type="button" className={filter === key ? "case-tab-btn is-active" : "case-tab-btn"} onClick={() => setFilter(key)}>
                  {key[0].toUpperCase() + key.slice(1)}
                </button>
              ))}
            </div>

            <div className="messages-sidebar__list">
              {!filteredConversations.length ? (
                <div className="messages-empty-state">
                  <strong>{query.trim() ? "No results" : "No conversations"}</strong>
                  <span>{query.trim() ? "Try another search term." : "Start a new thread to begin messaging."}</span>
                </div>
              ) : null}
              {filteredConversations.map((conv) => {
                const active = selected?.id === conv.id;
                return (
                  <button key={conv.id} type="button" className={`messages-conversation-item${active ? " is-active" : ""}`} onClick={() => openConversation(conv)}>
                    <span className="messages-conversation-item__avatar">{getInitials(conversationLabel(conv))}</span>
                    <span className="messages-conversation-item__main">
                      <span className="messages-conversation-item__top">
                        <strong>{conversationLabel(conv)}</strong>
                        <small>{formatConversationTime(conv.latest_message?.created_at || conv.updated_at)}</small>
                      </span>
                      <span className="messages-conversation-item__meta">
                        {conv.case_title || titleCase(conv.conversation_type)} · {conv.participant_count || 0} participant{conv.participant_count === 1 ? "" : "s"}
                      </span>
                      <span className="messages-conversation-item__bottom">
                        <span className="messages-conversation-item__preview">{conv.latest_message?.body || "No messages yet"}</span>
                        {conv.unread_count > 0 ? <em>{conv.unread_count}</em> : null}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </aside>

          <article className="messages-thread">
            {!selected ? (
              <div className="messages-empty">
                <div className="messages-empty-state messages-empty-state--thread">
                  <strong>No conversation selected</strong>
                  <span>Choose a conversation from the list to view the thread.</span>
                </div>
              </div>
            ) : (
              <>
                <div className="messages-thread__head">
                  <div className="messages-thread__identity">
                    <span className="messages-thread__avatar">{getInitials(selectedTitle)}</span>
                    <div>
                      <div className="messages-thread__headline">
                        <h3>{selectedTitle}</h3>
                        <span className={`vilo-badge vilo-badge--${selected.conversation_type === "internal" ? "draft" : "active"}`}>{titleCase(selected.conversation_type)}</span>
                      </div>
                      <p>{selectedParticipantNames.length ? selectedParticipantNames.join(", ") : `${selected.participant_count || 0} participants`}</p>
                      {selected.case_id ? (
                        <Link href={`/dashboard/cases/${selected.case_id}`} className="message-case-chip">
                          Case: {selected.case_title || selectedConversationCase?.title || `#${selected.case_id}`} ({selectedCaseLabel})
                        </Link>
                      ) : (
                        <span className="messages-thread__case-empty">No case linked</span>
                      )}
                    </div>
                  </div>
                  <div className="messages-thread__actions" aria-label="Message actions">
                    <button type="button" className="messages-icon-button" aria-label="More actions unavailable" title="More actions unavailable">
                      <DotsIcon />
                    </button>
                  </div>
                </div>

                <div className="messages-thread__body">
                  {messagesLoading ? (
                    <div className="messages-empty-state messages-empty-state--thread">
                      <strong>Loading messages</strong>
                      <span>Fetching the latest thread history.</span>
                    </div>
                  ) : null}
                  {!messagesLoading && !messages.length ? (
                    <div className="messages-empty-state messages-empty-state--thread">
                      <strong>No messages yet</strong>
                      <span>Send the first message to start this conversation.</span>
                    </div>
                  ) : null}
                  {!messagesLoading ? messages.map((msg, index) => {
                    const mine = meId && Number(msg.sender_id) === Number(meId);
                    const showDay = index === 0 || !sameDay(messages[index - 1]?.created_at, msg.created_at);
                    const showSender = !mine && selected.conversation_type === "group";
                    return (
                      <div key={msg.id}>
                        {showDay ? <div className="messages-day-separator"><span>{formatDayLabel(msg.created_at)}</span></div> : null}
                        <div className={`message-bubble-row${mine ? " is-mine" : ""}`}>
                          <div className={`message-bubble${mine ? " is-mine" : ""}`}>
                            {showSender ? <small className="message-bubble__sender">{msg.sender_name || "User"}</small> : null}
                            <p>{msg.body}</p>
                            {msg.case_references?.length ? (
                              <div className="message-bubble__refs">
                                {msg.case_references.map((ref) => (
                                  <Link key={`${msg.id}-${ref.case_id}`} href={`/dashboard/cases/${ref.case_id}`} className="message-case-chip">
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
                          <button type="button" onClick={() => removeCaseRef(row.id)}>×</button>
                        </span>
                      ))}
                    </div>
                  ) : null}
                  <div className="messages-composer__main">
                    <div className="messages-composer__input-wrap">
                      <textarea
                        placeholder="Write a message..."
                        value={messageBody}
                        onChange={(event) => setMessageBody(event.target.value)}
                        onKeyDown={onComposerKeyDown}
                        required
                      />
                      <div className="messages-composer__tools">
                        <div className="messages-composer__hint">
                          <UsersIcon />
                          <span>{selectedParticipantNames.length ? selectedParticipantNames.join(", ") : "Conversation participants"}</span>
                        </div>
                        <button
                          type="button"
                          className="messages-link-case-button"
                          onClick={async () => {
                            setShowCasePicker(true);
                            if (!caseSearchRows.length) await searchCases("");
                          }}
                        >
                          <PaperclipIcon />
                          <span>Link Case</span>
                        </button>
                      </div>
                    </div>
                    <button type="submit" className="vilo-btn vilo-btn--primary messages-send-button" disabled={sending || !messageBody.trim()}>
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

      {showCreateModal ? (
        <div className="vilo-modal-overlay" onClick={closeCreateModal}>
          <div className="vilo-modal messages-create-modal" onClick={(event) => event.stopPropagation()}>
            <form className="messages-create-modal__shell" onSubmit={createConversation}>
              <div className="vilo-modal__header">
                <h3>New Message</h3>
                <button type="button" className="vilo-btn vilo-btn--ghost vilo-btn--xs" onClick={closeCreateModal}>Close</button>
              </div>
              <div className="vilo-modal__body messages-create-modal__body">
                <div className="messages-create-form">
                {requestedClient ? (
                  <p className="vilo-card-copy">
                    Client context: <strong>{requestedClient.name}</strong>
                  </p>
                ) : null}

                <section className="messages-create-section">
                  <div className="messages-create-section__head">
                    <strong>Conversation details</strong>
                    <span>Choose the conversation type and set a clear title.</span>
                  </div>
                  <div className="messages-type-toggle" role="tablist" aria-label="Conversation type">
                    {["internal", "client", "group"].map((type) => (
                      <button
                        key={type}
                        type="button"
                        className={form.conversation_type === type ? "messages-type-toggle__btn is-active" : "messages-type-toggle__btn"}
                        onClick={() => setForm((current) => ({ ...current, conversation_type: type }))}
                      >
                        {titleCase(type)}
                      </button>
                    ))}
                  </div>
                  <input
                    placeholder="Conversation title"
                    value={form.title}
                    onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
                    required
                  />
                </section>

                <section className="messages-create-section">
                  <div className="messages-create-section__head">
                    <strong>Linked case</strong>
                    <span>Optional, but required for client conversations.</span>
                  </div>
                  {selectedCase ? (
                    <div className="messages-selection-chips">
                      <span className="message-case-chip">
                        Case: {selectedCase.title} ({selectedCase.display_number || `CASE${String(selectedCase.id).padStart(6, "0")}`})
                        <button type="button" onClick={removeConversationCase}>×</button>
                      </span>
                    </div>
                  ) : (
                    <span className="messages-thread__case-empty">No case linked</span>
                  )}
                  <label className="messages-search-field">
                    <SearchIcon />
                    <input
                      placeholder="Search case title or number"
                      value={createCaseQuery}
                      onChange={async (event) => {
                        const next = event.target.value;
                        setCreateCaseQuery(next);
                        await searchCases(next, "create");
                      }}
                    />
                  </label>
                  <div className="messages-case-search-list">
                    {createCaseLoading ? <div className="messages-empty-state"><strong>Loading cases</strong><span>Searching accessible cases.</span></div> : null}
                    {!createCaseLoading && createCaseError ? <div className="messages-empty-state"><strong>Case search failed</strong><span>{createCaseError}</span></div> : null}
                    {!createCaseLoading && !createCaseError && createCaseQuery.trim() && !availableCreateCaseRows.length ? (
                      <div className="messages-empty-state"><strong>No cases found</strong><span>No accessible cases matched your search.</span></div>
                    ) : null}
                    {availableCreateCaseRows.map((row) => (
                      <button key={row.id} type="button" className="messages-case-search-item" onClick={() => chooseConversationCase(row)}>
                        <strong>{row.title}</strong>
                        <span>{row.display_number || `#${row.id}`}</span>
                      </button>
                    ))}
                  </div>
                </section>

                <section className="messages-create-section">
                  <div className="messages-create-section__head">
                    <strong>Participants</strong>
                    <span>Search by name or email and select one or more participants.</span>
                  </div>
                  {createParticipants.length ? (
                    <div className="messages-selection-chips">
                      {createParticipants.map((user) => (
                        <span key={user.id} className="messages-user-chip">
                          <strong>{userLabel(user)}</strong>
                          <small>{user.email}</small>
                          <button type="button" onClick={() => removeParticipant(user.id)}>×</button>
                        </span>
                      ))}
                    </div>
                  ) : null}
                  <label className="messages-search-field">
                    <SearchIcon />
                    <input
                      placeholder="Search users by name or email"
                      value={participantQuery}
                      onChange={(event) => setParticipantQuery(event.target.value)}
                    />
                  </label>
                  <div className="messages-case-search-list">
                    {participantLoading ? <div className="messages-empty-state"><strong>Loading users</strong><span>Searching organization users.</span></div> : null}
                    {!participantLoading && participantError ? <div className="messages-empty-state"><strong>User search failed</strong><span>{participantError}</span></div> : null}
                    {!participantLoading && !participantError && participantQuery.trim() && !availableParticipantRows.length ? (
                      <div className="messages-empty-state"><strong>No users found</strong><span>No organization users matched your search.</span></div>
                    ) : null}
                    {availableParticipantRows.map((user) => (
                      <button key={user.id} type="button" className="messages-case-search-item" onClick={() => addParticipant(user)}>
                        <strong>{userLabel(user)}</strong>
                        <span>{user.email}</span>
                      </button>
                    ))}
                  </div>
                </section>

                <section className="messages-create-section">
                  <div className="messages-create-section__head">
                    <strong>First message</strong>
                    <span>This is required and will open the new thread immediately after creation.</span>
                  </div>
                  <textarea
                    ref={firstMessageRef}
                    placeholder="Write the first message"
                    value={form.first_message}
                    onChange={(event) => setForm((current) => ({ ...current, first_message: event.target.value }))}
                    required
                  />
                </section>
                </div>
              </div>
              <div className="messages-create-modal__footer">
                <div className="messages-create-modal__footer-copy">
                  {createError ? <p className="vilo-state vilo-state--error">{createError}</p> : <span>Conversation type, participants, title, and first message are required.</span>}
                </div>
                <div className="messages-create-form__footer">
                  <button type="button" className="vilo-btn vilo-btn--secondary" onClick={closeCreateModal}>Cancel</button>
                  <button type="submit" className="vilo-btn vilo-btn--primary" disabled={createDisabled}>
                    {creating ? "Creating..." : "Create Conversation"}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {showCasePicker ? (
        <div className="vilo-modal-overlay" onClick={() => setShowCasePicker(false)}>
          <div className="vilo-modal" onClick={(event) => event.stopPropagation()}>
            <div className="vilo-modal__header">
              <h3>Link Case</h3>
              <button type="button" className="vilo-btn vilo-btn--ghost vilo-btn--xs" onClick={() => setShowCasePicker(false)}>Close</button>
            </div>
            <div className="vilo-modal__body">
              <div className="vilo-form-grid">
                <label className="messages-search-field">
                  <SearchIcon />
                  <input
                    placeholder="Search case title or number"
                    value={caseSearch}
                    onChange={async (event) => {
                      const next = event.target.value;
                      setCaseSearch(next);
                      await searchCases(next);
                    }}
                  />
                </label>
                <div className="messages-case-search-list">
                  {!caseSearchRows.length ? (
                    <div className="messages-empty-state">
                      <strong>No cases found</strong>
                      <span>No accessible cases matched your search.</span>
                    </div>
                  ) : null}
                  {caseSearchRows.map((row) => (
                    <button key={row.id} type="button" className="messages-case-search-item" onClick={() => addCaseRef(row)}>
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
