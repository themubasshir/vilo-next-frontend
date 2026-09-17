"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import DocumentFileSelection, { formatAttachmentSize } from "../../../components/DocumentFileSelection";
import ProtectedFilePreviewModal, { useProtectedFilePreview } from "../../../components/ProtectedFilePreviewModal";
import { apiRequest, apiUpload, apiDownload } from "../../../lib/api";
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

function DetailsIcon() {
  return (
    <IconBase>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M14 4v16" />
      <path d="M17 9h1" />
      <path d="M17 13h1" />
    </IconBase>
  );
}

function ArrowLeftIcon() {
  return (
    <IconBase>
      <path d="m15 18-6-6 6-6" />
    </IconBase>
  );
}

function FileIcon() {
  return (
    <IconBase>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6" />
    </IconBase>
  );
}

function attachmentTypeLabel(attachment) {
  const subtype = String(attachment?.file_type || "").split("/")[1];
  const extension = String(attachment?.file_name || "").split(".").pop();
  return String(subtype || extension || "File").replace("jpeg", "JPG").toUpperCase();
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
  const selectedRef = useRef(null);
  const threadVisible = useRef(true);
  const threadRequests = useRef(new Map());
  const summaryRequest = useRef(null);
  const pollInFlight = useRef(false);
  const handledConversation = useRef(null);
  const loadedThread = useRef(null);
  const localRoute = useRef(null);
  const readThrough = useRef(new Map());

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
  const [attachmentDrafts, setAttachmentDrafts] = useState({});
  const attachments = attachmentDrafts[selected?.id] || [];
  const setAttachments = (files) => setAttachmentDrafts((current) => ({ ...current, [selected.id]: files }));
  const [firstAttachments, setFirstAttachments] = useState([]);
  const [pendingConversation, setPendingConversation] = useState(null);
  const { preview, openPreview, closePreview } = useProtectedFilePreview();
  const [composerRefs, setComposerRefs] = useState([]);
  const [caseSearch, setCaseSearch] = useState("");
  const [caseSearchRows, setCaseSearchRows] = useState([]);
  const [showCasePicker, setShowCasePicker] = useState(false);
  const [casePickerMode, setCasePickerMode] = useState("message");
  const [casePickerSelection, setCasePickerSelection] = useState(null);
  const [caseLinkSaving, setCaseLinkSaving] = useState(false);
  const [caseLinkError, setCaseLinkError] = useState("");
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
  const [currentUser, setCurrentUser] = useState(null);
  const [showDetails, setShowDetails] = useState(false);
  const [showAddParticipant, setShowAddParticipant] = useState(false);
  const [participantActionLoading, setParticipantActionLoading] = useState(false);

  selectedRef.current = selected;
  threadVisible.current = !showCreateModal && !showCasePicker;

  const requestedClientId = Number(searchParams.get("client_id") || 0);

  const usersById = useMemo(
    () => new Map([...(currentUser ? [currentUser] : []), ...users].map((user) => [Number(user.id), user])),
    [currentUser, users],
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
    if (!summaryRequest.current) {
      summaryRequest.current = apiRequest("/api/v1/conversations").finally(() => { summaryRequest.current = null; });
    }
    const rows = await summaryRequest.current;
    const summaries = (rows || []).map((conv) => {
      const cutoff = readThrough.current.get(conv.id);
      return cutoff && conv.latest_message && new Date(conv.latest_message.created_at) <= new Date(cutoff) ? { ...conv, unread_count: 0 } : conv;
    });
    setConversations(summaries);
    setSelected((prev) => {
      if (targetConversationId) {
        const direct = summaries.find((row) => Number(row.id) === Number(targetConversationId));
        if (direct) return direct;
      }
      if (prev) {
        const next = summaries.find((row) => row.id === prev.id);
        return next || null;
      }
      const requested = Number(searchParams.get("conversation") || 0);
      if (requested) return summaries.find((row) => Number(row.id) === requested) || null;
      return null;
    });
    return summaries;
  }

  async function loadMessages(conversationId, background = false) {
    if (threadRequests.current.has(conversationId)) return threadRequests.current.get(conversationId);
    if (!background) setMessagesLoading(true);
    const request = (async () => {
      try {
        const rows = await apiRequest(`/api/v1/conversations/${conversationId}/messages`);
        if (selectedRef.current?.id !== conversationId) return;
        setMessages((previous) => JSON.stringify(previous) === JSON.stringify(rows || []) ? previous : rows || []);
        if (document.visibilityState !== "visible" || !threadVisible.current) return;
        // Only acknowledge messages actually fetched, leaving later arrivals unread.
        const latest = rows?.[rows.length - 1];
        if (latest) {
          await apiRequest(`/api/v1/conversations/${conversationId}/mark-read?read_through=${encodeURIComponent(latest.created_at)}`, { method: "POST" });
        }
        if (selectedRef.current?.id !== conversationId) return;
        if (latest) readThrough.current.set(conversationId, latest.created_at);
        const acknowledge = (conv) => conv?.id === conversationId && (!conv.latest_message || (latest && new Date(conv.latest_message.created_at) <= new Date(latest.created_at))) ? { ...conv, unread_count: 0 } : conv;
        setConversations((current) => current.map(acknowledge));
        setSelected(acknowledge);
        loadedThread.current = { id: conversationId, updated_at: selectedRef.current?.updated_at, latest_id: latest?.id };
      } finally {
        threadRequests.current.delete(conversationId);
        if (selectedRef.current?.id === conversationId) setMessagesLoading(false);
      }
    })();
    threadRequests.current.set(conversationId, request);
    return request;
  }

  async function loadParticipants(conversationId) {
    const rows = await apiRequest(`/api/v1/conversations/${conversationId}/participants`);
    if (selectedRef.current?.id === conversationId) setThreadParticipants(rows || []);
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
      setCurrentUser(me || null);
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
    if (!conversationId) { handledConversation.current = null; return; }
    if (handledConversation.current === conversationId || !conversations.length) return;
    const target = conversations.find((row) => Number(row.id) === conversationId);
    if (target) {
      handledConversation.current = conversationId;
      setSelected((prev) => (prev?.id === target.id ? prev : target));
    }
  }, [conversations, searchParams]);

  useEffect(() => {
    if (localRoute.current === searchParams.toString()) return;
    const routeFilter = searchParams.get("filter");
    setFilter(["unread", "internal", "client", "group"].includes(routeFilter) ? routeFilter : "all");
  }, [searchParams]);

  useEffect(() => {
    if (loading) return;
    let stopped = false;
    const refresh = async (forceThread = false) => {
      if (stopped || pollInFlight.current || document.visibilityState !== "visible") return;
      pollInFlight.current = true;
      try {
        const rows = await loadConversations();
        if (stopped) return;
        const active = rows.find((row) => row.id === selectedRef.current?.id);
        const loaded = loadedThread.current;
        if (active && threadVisible.current && (forceThread || active.unread_count > 0 || loaded?.id !== active.id || loaded?.updated_at !== active.updated_at || loaded?.latest_id !== active.latest_message?.id)) {
          await loadMessages(active.id, true);
        }
      } catch (err) {
        if (!stopped) setError(err.message || "Messages could not be refreshed");
      } finally {
        pollInFlight.current = false;
      }
    };
    const interval = window.setInterval(() => refresh(), 25_000);
    const onVisible = () => { if (document.visibilityState === "visible") refresh(true); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { stopped = true; window.clearInterval(interval); document.removeEventListener("visibilitychange", onVisible); };
  }, [loading]); // eslint-disable-line react-hooks/exhaustive-deps

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
    if (!showCreateModal && !showAddParticipant) return;
    const handle = setTimeout(() => {
      loadUsers(participantQuery.trim(), meId);
    }, 180);
    return () => clearTimeout(handle);
  }, [participantQuery, showAddParticipant, showCreateModal]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const selectedCaseLabel = selected?.case_display_number || (selectedConversationCase ? `CASE${String(selectedConversationCase.id).padStart(6, "0")}` : "");
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

  const unreadTotal = useMemo(
    () => conversations.reduce((total, conversation) => total + Number(conversation.unread_count || 0), 0),
    [conversations],
  );

  const sharedFiles = useMemo(() => {
    const seen = new Set();
    return messages.flatMap((message) => message.attachments || []).filter((attachment) => {
      if (seen.has(attachment.id)) return false;
      seen.add(attachment.id);
      return true;
    });
  }, [messages]);

  const availableThreadParticipantRows = useMemo(() => {
    const participantIds = new Set(threadParticipants.map((participant) => Number(participant.user_id)));
    return participantRows.filter((user) => !participantIds.has(Number(user.id)));
  }, [participantRows, threadParticipants]);

  function updateRoute(paramsPatch) {
    const params = new URLSearchParams(searchParams.toString());
    Object.entries(paramsPatch).forEach(([key, value]) => {
      if (value === null || value === undefined || value === "") params.delete(key);
      else params.set(key, String(value));
    });
    const next = params.toString();
    localRoute.current = next;
    router.replace(next ? `${pathname}?${next}` : pathname);
  }

  function openConversation(conv) {
    selectedRef.current = conv;
    setSelected(conv);
    updateRoute({ conversation: conv.id, create: null });
  }

  function closeConversationOnMobile() {
    selectedRef.current = null;
    setSelected(null);
    setMessages([]);
    setThreadParticipants([]);
    setShowDetails(false);
    updateRoute({ conversation: null });
  }

  function chooseFilter(nextFilter) {
    setFilter(nextFilter);
    updateRoute({ filter: nextFilter === "all" ? null : nextFilter });
  }

  function openCreateModal() {
    setShowCreateModal(true);
    updateRoute({ create: 1 });
  }

  function closeCreateModal(force = false) {
    if (creating && force !== true) return;
    setShowCreateModal(false);
    setForm(initialForm);
    setFirstAttachments([]);
    setPendingConversation(null);
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
    setCasePickerSelection(null);
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

  async function openCasePicker(mode = "message") {
    setCasePickerMode(mode);
    setCasePickerSelection(mode === "conversation" && selected?.case_id ? {
      id: selected.case_id,
      title: selected.case_title || selectedConversationCase?.title || `Case #${selected.case_id}`,
      display_number: selectedCaseLabel,
      client_name: selectedConversationCase?.client_name || selectedConversationCase?.client?.name || null,
    } : null);
    setCaseLinkError("");
    setCaseSearch("");
    setShowCasePicker(true);
    await searchCases("");
  }

  async function updateConversationCase(caseId) {
    if (!selected?.id || caseLinkSaving) return;
    setCaseLinkSaving(true);
    setCaseLinkError("");
    try {
      const updated = await apiRequest(`/api/v1/conversations/${selected.id}`, {
        method: "PATCH",
        body: JSON.stringify({ case_id: caseId }),
      });
      setSelected(updated);
      selectedRef.current = updated;
      setConversations((current) => current.map((row) => row.id === updated.id ? updated : row));
      setShowCasePicker(false);
      setCasePickerSelection(null);
      setCaseSearch("");
    } catch (err) {
      setCaseLinkError(err.message || "Failed to update the related case");
    } finally {
      setCaseLinkSaving(false);
    }
  }

  function confirmCasePicker() {
    if (!casePickerSelection) return;
    if (casePickerMode === "conversation") updateConversationCase(Number(casePickerSelection.id));
    else addCaseRef(casePickerSelection);
  }

  async function addThreadParticipant(user) {
    if (!selected?.id || participantActionLoading) return;
    setParticipantActionLoading(true);
    setParticipantError("");
    try {
      await apiRequest(`/api/v1/conversations/${selected.id}/participants`, {
        method: "POST",
        body: JSON.stringify({ user_id: Number(user.id), role: user.role === "client" ? "client" : "member" }),
      });
      await Promise.all([loadParticipants(selected.id), loadConversations(selected.id)]);
      setShowAddParticipant(false);
      setParticipantQuery("");
    } catch (err) {
      setParticipantError(err.message || "Failed to add participant");
    } finally {
      setParticipantActionLoading(false);
    }
  }

  async function deleteConversation() {
    if (!selected?.id || participantActionLoading) return;
    if (!window.confirm(`Delete “${selectedTitle}”? This action cannot be undone.`)) return;
    setParticipantActionLoading(true);
    setError("");
    try {
      await apiRequest(`/api/v1/conversations/${selected.id}`, { method: "DELETE" });
      readThrough.current.delete(selected.id);
      selectedRef.current = null;
      setSelected(null);
      setMessages([]);
      setThreadParticipants([]);
      setShowDetails(false);
      updateRoute({ conversation: null });
      await loadConversations();
    } catch (err) {
      setError(err.message || "Failed to delete conversation");
    } finally {
      setParticipantActionLoading(false);
    }
  }

  async function createConversation(event) {
    event.preventDefault();
    if (creating) return;
    setCreateError("");

    const participantIds = createParticipants.map((user) => Number(user.id));
    if (!form.title.trim() || (!form.first_message.trim() && !firstAttachments.length) || !participantIds.length) {
      setCreateError("Conversation title, participants, and first message are required.");
      return;
    }
    if (form.conversation_type === "client" && !selectedCase?.id) {
      setCreateError("Client conversations must link to a case.");
      return;
    }

    setCreating(true);
    try {
      const created = pendingConversation || await apiRequest("/api/v1/conversations", {
        method: "POST",
        body: JSON.stringify({
          conversation_type: form.conversation_type,
          title: form.title.trim(),
          case_id: selectedCase?.id ? Number(selectedCase.id) : null,
          participant_ids: participantIds,
        }),
      });

      setPendingConversation(created);
      try {
        await sendMessageRequest(created.id, form.first_message.trim(), [], firstAttachments);
      } catch (err) {
        await loadConversations(created.id);
        setSelected(created);
        setMessages([]);
        setCreateError(`Conversation created, but the message was not sent: ${err.message || "Upload failed"}. Retry to send to the same conversation.`);
        setCreating(false);
        return;
      }

      setSelected(created);
      closeCreateModal(true);
      updateRoute({ conversation: created.id });
      await loadConversations(created.id);
    } catch (err) {
      setCreateError(err.message || "Failed to create conversation");
    } finally {
      setCreating(false);
    }
  }

  async function sendMessageRequest(conversationId, body, references, files) {
    if (!files.length) return apiRequest(`/api/v1/conversations/${conversationId}/messages`, {
      method: "POST", body: JSON.stringify({ body, case_reference_ids: references }),
    });
    const data = new FormData();
    data.append("body", body);
    references.forEach((id) => data.append("case_reference_ids", String(id)));
    files.forEach((file) => data.append("files", file));
    return apiUpload(`/api/v1/conversations/${conversationId}/messages-with-attachments`, data);
  }

  async function downloadAttachment(attachment) {
    try { await apiDownload(`/api/v1/conversations/attachments/${attachment.id}/download`); }
    catch (err) { setSendError(err.message || "Download failed"); }
  }

  async function sendMessage(event) {
    event.preventDefault();
    if (!selected?.id || (!messageBody.trim() && !attachments.length) || sending) return;
    setSending(true);
    setError("");
    setSendError("");
    try {
      await sendMessageRequest(selected.id, messageBody.trim(), composerRefs.map((row) => row.id), attachments);
      setAttachments([]);
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

  const createDisabled = !form.title.trim() || (!form.first_message.trim() && !firstAttachments.length) || !createParticipants.length || (form.conversation_type === "client" && !selectedCase?.id) || creating;

  return (
    <section className="dashboard-page-stack">
      {error ? <div className="vilo-state-block"><p className="vilo-state vilo-state--error">{error}</p></div> : null}
      {loading ? <div className="vilo-state-block"><p className="vilo-state vilo-state--loading">Loading messages...</p></div> : null}

      <div className="messages-shell dashboard-card">
        <div className={`messages-layout messages-layout--dashboard${selected ? " has-selection" : ""}`}>
          <aside className="messages-sidebar">
            <div className="messages-sidebar__head">
              <div>
                <h2>Messages</h2>
              </div>
              <button type="button" className="vilo-btn vilo-btn--secondary messages-sidebar__new" onClick={openCreateModal}>
                + New Message
              </button>
            </div>

            <div className="messages-sidebar__search">
              <label className="messages-search-field">
                <SearchIcon />
                <input aria-label="Search conversations" placeholder="Search conversations..." value={query} onChange={(event) => setQuery(event.target.value)} />
              </label>
            </div>

            <div className="messages-filters">
              {["all", "unread", "internal", "client", "group"].map((key) => (
                <button key={key} type="button" className={filter === key ? "case-tab-btn is-active" : "case-tab-btn"} onClick={() => chooseFilter(key)}>
                  <span>{key[0].toUpperCase() + key.slice(1)}</span>
                  {key === "unread" && unreadTotal > 0 ? <span className="messages-filter-count">{unreadTotal}</span> : null}
                </button>
              ))}
            </div>

            <div className="messages-sidebar__list">
              {!filteredConversations.length ? (
                <div className="messages-empty-state">
                  <strong>{query.trim() ? "No conversations found." : filter === "unread" ? "No unread conversations." : "No conversations found."}</strong>
                  <span>{query.trim() ? "Try another search term." : filter === "unread" ? "You’re all caught up." : "Start a new thread to begin messaging."}</span>
                </div>
              ) : null}
              {filteredConversations.map((conv) => {
                const active = selected?.id === conv.id;
                return (
                  <button key={conv.id} type="button" className={`messages-conversation-item${active ? " is-active" : ""}${conv.unread_count > 0 ? " is-unread" : ""}`} aria-label={`${conversationLabel(conv)}, ${conv.unread_count > 0 ? `${conv.unread_count} unread messages` : "Read"}`} onClick={() => openConversation(conv)}>
                    <span className="messages-conversation-item__avatar">{getInitials(conversationLabel(conv))}</span>
                    <span className="messages-conversation-item__main">
                      <span className="messages-conversation-item__top">
                        <strong>{conversationLabel(conv)}</strong>
                        <small>{formatConversationTime(conv.latest_message?.created_at || conv.updated_at)}</small>
                      </span>
                      <span className="messages-conversation-item__meta">
                        {titleCase(conv.conversation_type)} · {conv.case_title || (conv.conversation_type === "client" ? "No case linked" : `${conv.participant_count || 0} participant${conv.participant_count === 1 ? "" : "s"}`)}
                      </span>
                      <span className="messages-conversation-item__bottom">
                        <span className="messages-conversation-item__preview">{conv.latest_message?.body || (conv.latest_message?.attachments?.length ? `${conv.latest_message.attachments.length} attachment${conv.latest_message.attachments.length === 1 ? "" : "s"}` : "No messages yet")}</span>
                        {conv.unread_count > 0 ? <em>{conv.unread_count} new</em> : null}
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
                  <span>Select a conversation to view messages.</span>
                </div>
              </div>
            ) : (
              <>
                <div className="messages-thread__head">
                  <div className="messages-thread__identity">
                    <button type="button" className="messages-icon-button messages-thread__back" aria-label="Back to conversations" onClick={closeConversationOnMobile}>
                      <ArrowLeftIcon />
                    </button>
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
                    <button type="button" className="messages-details-toggle" aria-label="Open conversation details" onClick={() => setShowDetails(true)}>
                      <DetailsIcon />
                      <span>Details</span>
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
                    const senderName = mine ? userLabel(currentUser) : (msg.sender_name || userLabel(usersById.get(Number(msg.sender_id))));
                    const previous = messages[index - 1];
                    const startsGroup = index === 0 || Number(previous?.sender_id) !== Number(msg.sender_id) || !sameDay(previous?.created_at, msg.created_at);
                    return (
                      <div key={msg.id}>
                        {showDay ? <div className="messages-day-separator"><span>{formatDayLabel(msg.created_at)}</span></div> : null}
                        <div className={`message-bubble-row${mine ? " is-mine" : ""}`}>
                          {!mine ? <span className={`message-bubble-row__avatar${startsGroup ? "" : " is-placeholder"}`} aria-hidden={!startsGroup}>{startsGroup ? getInitials(senderName) : ""}</span> : null}
                          <div className={`message-bubble${mine ? " is-mine" : ""}`}>
                            {!mine && startsGroup ? <small className="message-bubble__sender">{senderName}</small> : null}
                            {msg.body ? <p>{msg.body}</p> : null}
                            {msg.attachments?.length ? <div className="message-attachments">
                              {msg.attachments.map((attachment) => <div key={attachment.id} className="message-attachment">
                                <span className="message-attachment__icon"><FileIcon /></span>
                                <span className="message-attachment__meta">
                                  <strong title={attachment.file_name}>{attachment.file_name}</strong>
                                  <small>{attachmentTypeLabel(attachment)} · {formatAttachmentSize(attachment.file_size)}</small>
                                </span>
                                <div className="message-attachment__actions">
                                  {["application/pdf", "image/jpeg", "image/png"].includes(attachment.file_type) ? <button type="button" onClick={(event) => { event.stopPropagation(); openPreview({ path: `/api/v1/conversations/attachments/${attachment.id}/view`, downloadPath: `/api/v1/conversations/attachments/${attachment.id}/download`, filename: attachment.file_name }); }} aria-label={`Preview ${attachment.file_name}`}>View</button> : null}
                                  <button type="button" onClick={(event) => { event.stopPropagation(); downloadAttachment(attachment); }} aria-label={`Download ${attachment.file_name}`}>Download</button>
                                </div>
                              </div>)}
                            </div> : null}
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
                          {mine ? <span className={`message-bubble-row__avatar is-mine${startsGroup ? "" : " is-placeholder"}`} aria-hidden={!startsGroup}>{startsGroup ? getInitials(senderName) : ""}</span> : null}
                        </div>
                      </div>
                    );
                  }) : null}
                  <div ref={threadEndRef} />
                </div>

                <form className="messages-thread__composer" onSubmit={sendMessage}>
                  <div className="messages-composer__input-wrap">
                      <textarea
                        aria-label="Message"
                        placeholder="Type a message..."
                        value={messageBody}
                        onChange={(event) => setMessageBody(event.target.value)}
                        onKeyDown={onComposerKeyDown}
                        disabled={sending}
                      />
                      {attachments.length ? <div className="messages-composer__attachments" aria-live="polite">
                        {attachments.map((file) => <span className="messages-composer__attachment-chip" key={`${file.name}-${file.size}-${file.lastModified}`}>
                          <FileIcon />
                          <span title={file.name}>{file.name} · {formatAttachmentSize(file.size)}</span>
                          <button type="button" disabled={sending} aria-label={`Remove ${file.name}`} onClick={() => setAttachments(attachments.filter((entry) => entry !== file))}>×</button>
                        </span>)}
                      </div> : null}
                      {composerRefs.length ? (
                        <div className="message-composer-refs">
                          {composerRefs.map((row) => (
                            <span key={row.id} className="message-case-chip">
                              Case: {row.title} ({row.display_number || `#${row.id}`})
                              <button type="button" aria-label={`Remove case reference ${row.title}`} onClick={() => removeCaseRef(row.id)}>×</button>
                            </span>
                          ))}
                        </div>
                      ) : null}
                      <div className="messages-composer__tools">
                        <div className="messages-composer__tools-left">
                          <DocumentFileSelection key={selected.id} files={attachments} onChange={setAttachments} disabled={sending} maxFiles={5} compact showSelection={false} label="message attachments"><PaperclipIcon /><span>Attach</span></DocumentFileSelection>
                        <button
                          type="button"
                          className="messages-link-case-button"
                          onClick={() => openCasePicker("message")}
                        >
                          <span>Tag Message to Case</span>
                        </button>
                        </div>
                        <button type="submit" className="vilo-btn vilo-btn--primary messages-send-button" disabled={sending || (!messageBody.trim() && !attachments.length)}>
                          <SendIcon />
                          <span>{sending ? "Sending..." : "Send"}</span>
                        </button>
                      </div>
                  </div>
                  {sendError ? <p className="vilo-state vilo-state--error">{sendError}</p> : null}
                </form>
              </>
            )}
          </article>

          {selected && showDetails ? <button type="button" className="messages-details-backdrop" aria-label="Close conversation details" onClick={() => setShowDetails(false)} /> : null}
          <aside className={`messages-details${showDetails ? " is-open" : ""}`} aria-label="Conversation details">
            {selected ? <>
              <div className="messages-details__head">
                <div>
                  <span>Conversation</span>
                  <h3>Details</h3>
                </div>
                <button type="button" className="messages-icon-button messages-details__close" aria-label="Close conversation details" onClick={() => setShowDetails(false)}>×</button>
              </div>
              <div className="messages-details__body">
                <section className="messages-details__section">
                  <h4>Related Case</h4>
                  {selected.case_id ? <div className="messages-related-case">
                    <strong>{selected.case_title || selectedConversationCase?.title || `Case #${selected.case_id}`}</strong>
                    {selectedCaseLabel ? <span>{selectedCaseLabel}</span> : null}
                    <div className="messages-related-case__actions">
                      <Link href={`/dashboard/cases/${selected.case_id}`} className="vilo-btn vilo-btn--secondary vilo-btn--xs">Open Case</Link>
                      <button type="button" className="vilo-btn vilo-btn--ghost vilo-btn--xs" onClick={() => openCasePicker("conversation")}>Change Link</button>
                      <button type="button" className="messages-details__text-action" disabled={caseLinkSaving} onClick={() => updateConversationCase(null)}>Remove Link</button>
                    </div>
                  </div> : <div className="messages-details__empty">
                    <span>No case linked.</span>
                    <button type="button" className="vilo-btn vilo-btn--secondary vilo-btn--xs" onClick={() => openCasePicker("conversation")}>Link to Case</button>
                  </div>}
                </section>

                <section className="messages-details__section">
                  <h4>Shared Files <span>{sharedFiles.length}</span></h4>
                  {sharedFiles.length ? <div className="messages-shared-files">
                    {sharedFiles.map((attachment) => <div key={attachment.id} className="messages-shared-file">
                      <span className="message-attachment__icon"><FileIcon /></span>
                      <span className="message-attachment__meta">
                        <strong title={attachment.file_name}>{attachment.file_name}</strong>
                        <small>{attachmentTypeLabel(attachment)} · {formatAttachmentSize(attachment.file_size)}</small>
                      </span>
                      <span className="messages-shared-file__actions">
                        {["application/pdf", "image/jpeg", "image/png"].includes(attachment.file_type) ? <button type="button" onClick={() => openPreview({ path: `/api/v1/conversations/attachments/${attachment.id}/view`, downloadPath: `/api/v1/conversations/attachments/${attachment.id}/download`, filename: attachment.file_name })} aria-label={`Preview ${attachment.file_name}`}>View</button> : null}
                        <button type="button" onClick={() => downloadAttachment(attachment)} aria-label={`Download ${attachment.file_name}`}>Download</button>
                      </span>
                    </div>)}
                  </div> : <p className="messages-details__empty-copy">No shared files.</p>}
                </section>

                <section className="messages-details__section">
                  <div className="messages-details__section-head">
                    <h4>Participants <span>{threadParticipants.length}</span></h4>
                    <button type="button" className="messages-details__text-action" onClick={() => { setParticipantQuery(""); setParticipantError(""); setShowAddParticipant(true); }}>+ Add</button>
                  </div>
                  <div className="messages-participant-list">
                    {threadParticipants.map((participant) => {
                      const user = usersById.get(Number(participant.user_id));
                      const name = userLabel(user);
                      return <div key={participant.user_id} className="messages-participant">
                        <span className="messages-participant__avatar">{getInitials(name)}</span>
                        <span><strong>{name}</strong><small>{titleCase(user?.role || participant.role)}</small></span>
                      </div>;
                    })}
                    {!threadParticipants.length ? <p className="messages-details__empty-copy">No participants to display.</p> : null}
                  </div>
                </section>

                <section className="messages-details__section messages-details__section--actions">
                  <h4>Conversation Actions</h4>
                  <button type="button" className="vilo-btn vilo-btn--danger" disabled={participantActionLoading} onClick={deleteConversation}>Delete Conversation</button>
                </section>
              </div>
            </> : <div className="messages-empty-state messages-empty-state--thread"><strong>Conversation details</strong><span>Select a conversation to view its context.</span></div>}
          </aside>
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

                <fieldset className="messages-conversation-fields" disabled={creating || Boolean(pendingConversation)}>
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
                    required
                    value={form.title}
                    onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
                    disabled={creating}
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

                </fieldset>
                <section className="messages-create-section">
                  <div className="messages-create-section__head">
                    <strong>First message</strong>
                    <span>Add text or attach a document to start the thread.</span>
                  </div>
                  <textarea
                    ref={firstMessageRef}
                    placeholder="Write the first message"
                    value={form.first_message}
                    onChange={(event) => setForm((current) => ({ ...current, first_message: event.target.value }))}
                    disabled={creating}
                  />
                  <DocumentFileSelection files={firstAttachments} onChange={setFirstAttachments} disabled={creating} maxFiles={5} compact label="first message attachments"><PaperclipIcon /><span>Attach documents</span></DocumentFileSelection>
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
                    {creating ? "Sending..." : pendingConversation ? "Retry Message" : "Create Conversation"}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {showAddParticipant && selected ? (
        <div className="vilo-modal-overlay" onClick={() => setShowAddParticipant(false)}>
          <div className="vilo-modal messages-participant-modal" onClick={(event) => event.stopPropagation()}>
            <div className="vilo-modal__header">
              <h3>Add Participant</h3>
              <button type="button" className="vilo-btn vilo-btn--ghost vilo-btn--xs" onClick={() => setShowAddParticipant(false)}>Close</button>
            </div>
            <div className="vilo-modal__body">
              <div className="vilo-form-grid">
                <label className="messages-search-field">
                  <SearchIcon />
                  <input autoFocus aria-label="Search users to add" placeholder="Search users by name or email" value={participantQuery} onChange={(event) => setParticipantQuery(event.target.value)} />
                </label>
                {participantError ? <p className="vilo-state vilo-state--error">{participantError}</p> : null}
                <div className="messages-case-search-list">
                  {participantLoading ? <div className="messages-empty-state"><strong>Loading users</strong><span>Searching organization users.</span></div> : null}
                  {!participantLoading && !availableThreadParticipantRows.length ? <div className="messages-empty-state"><strong>No users found</strong><span>Everyone matching this search is already in the conversation.</span></div> : null}
                  {availableThreadParticipantRows.map((user) => <button key={user.id} type="button" className="messages-case-search-item" disabled={participantActionLoading} onClick={() => addThreadParticipant(user)}>
                    <strong>{userLabel(user)}</strong>
                    <span>{titleCase(user.role)}</span>
                  </button>)}
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <ProtectedFilePreviewModal preview={preview} onClose={closePreview} />

      {showCasePicker ? (
        <div className="vilo-modal-overlay" onClick={() => setShowCasePicker(false)}>
          <div className="vilo-modal messages-case-picker-modal" onClick={(event) => event.stopPropagation()}>
            <div className="vilo-modal__header">
              <div>
                <h3>{casePickerMode === "conversation" ? "Link Conversation to Case" : "Tag Message to Case"}</h3>
                <p>{casePickerMode === "conversation" ? "Choose the Case/File related to this entire conversation." : "Add a Case/File reference to this message only."}</p>
              </div>
              <button type="button" className="vilo-btn vilo-btn--ghost vilo-btn--xs" onClick={() => setShowCasePicker(false)}>Close</button>
            </div>
            <div className="vilo-modal__body">
              <div className="vilo-form-grid">
                <label className="messages-search-field">
                  <SearchIcon />
                  <input
                    autoFocus
                    aria-label="Search cases"
                    placeholder="Search title, Case/File number, or client"
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
                    <button key={row.id} type="button" className={`messages-case-search-item${Number(casePickerSelection?.id) === Number(row.id) ? " is-selected" : ""}`} aria-pressed={Number(casePickerSelection?.id) === Number(row.id)} onClick={() => setCasePickerSelection(row)}>
                      <span className="messages-case-search-item__copy">
                        <strong>{row.title}</strong>
                        <span>{row.display_number || `#${row.id}`}</span>
                        {row.client_name ? <small>{row.client_name}</small> : null}
                      </span>
                      <span className="messages-case-search-item__check" aria-hidden="true">{Number(casePickerSelection?.id) === Number(row.id) ? "✓" : ""}</span>
                    </button>
                  ))}
                </div>
                {caseLinkError ? <p className="vilo-state vilo-state--error">{caseLinkError}</p> : null}
              </div>
            </div>
            <div className="vilo-modal__footer messages-case-picker-modal__footer">
              {casePickerMode === "conversation" && selected?.case_id ? <button type="button" className="vilo-btn vilo-btn--danger" disabled={caseLinkSaving} onClick={() => updateConversationCase(null)}>Remove Link</button> : <span />}
              <div>
                <button type="button" className="vilo-btn vilo-btn--secondary" disabled={caseLinkSaving} onClick={() => setShowCasePicker(false)}>Cancel</button>
                <button type="button" className="vilo-btn vilo-btn--primary" disabled={!casePickerSelection || caseLinkSaving} onClick={confirmCasePicker}>
                  {caseLinkSaving ? "Saving..." : casePickerMode === "conversation" ? "Link Selected Case" : "Tag Selected Case"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
