"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { createPortal } from "react-dom";
import { useRouter, useSearchParams } from "next/navigation";
import { apiRequest } from "../../../lib/api";
import { getCachedUser } from "../../../lib/auth";
import { DiscardChangesDialog, useModalCloseGuard } from "../../../components/useModalCloseGuard";

const STATUS_OPTIONS = ["not_started", "in_progress", "waiting", "completed"];
const PRIORITY_OPTIONS = ["low", "medium", "high", "urgent"];
const TASK_TYPE_OPTIONS = ["general", "deadline", "court", "client_follow_up", "document", "billing", "other"];
const TASK_TABS = [
  ["all", "All Tasks"],
  ["my_tasks", "My Tasks"],
  ["due_today", "Due Today"],
  ["overdue", "Overdue"],
  ["in_progress", "In Progress"],
  ["completed", "Completed"],
  ["archived", "Archived"],
];
const DROPDOWN_MENU_GAP = 8;
const DROPDOWN_VIEWPORT_PADDING = 12;
const DROPDOWN_WIDTHS = {
  actions: 220,
  status: 196,
};
const DROPDOWN_ESTIMATED_HEIGHTS = {
  actions: 280,
  status: 196,
};

const initialForm = {
  client_id: "",
  case_id: "",
  assigned_to: "",
  title: "",
  description: "",
  task_type: "general",
  status: "not_started",
  priority: "medium",
  due_date: "",
  reminder_at: "",
  reminder_choice: "",
  custom_reminder_at: "",
  notes: "",
};
const REMINDER_OPTIONS = [
  { value: "", label: "No reminder" },
  { value: "0", label: "At due time" },
  { value: "5", label: "5 minutes before" },
  { value: "15", label: "15 minutes before" },
  { value: "30", label: "30 minutes before" },
  { value: "60", label: "1 hour before" },
  { value: "1440", label: "1 day before" },
  { value: "custom", label: "Custom date and time" },
];

function formatTaskDueDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function normalizeLabel(value) {
  return String(value || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function isCompleted(task) {
  return task?.status === "completed";
}

function isOverdue(task) {
  return Boolean(task?.is_overdue) && !isCompleted(task);
}

function utcDateKey(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

function isDueToday(task, todayKey) {
  return !task?.archived_at && !isCompleted(task) && utcDateKey(task?.due_date) === todayKey;
}

function matchesTaskTab(task, tab, currentUserId, todayKey) {
  const archived = Boolean(task.archived_at);
  if (tab === "archived") return archived;
  if (archived) return false;
  if (tab === "my_tasks") return Boolean(currentUserId) && Number(task.assigned_user_id || task.assigned_to || 0) === Number(currentUserId);
  if (tab === "due_today") return isDueToday(task, todayKey);
  if (tab === "overdue") return isOverdue(task);
  if (tab === "in_progress") return task.status === "in_progress";
  if (tab === "completed") return isCompleted(task);
  return true;
}

function tabFromLegacyFilter(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["my_tasks", "due_today", "overdue", "in_progress", "completed", "archived"].includes(normalized)) return normalized;
  return "all";
}

function taskEmptyMessage(activeTab, hasFilters) {
  if (hasFilters) return "No tasks matched your current filters.";
  const messages = {
    all: "No active tasks.",
    my_tasks: "No tasks are assigned to you.",
    due_today: "No tasks are due today.",
    overdue: "No overdue tasks.",
    in_progress: "No tasks are in progress.",
    completed: "No completed tasks.",
    archived: "No archived tasks.",
  };
  return messages[activeTab] || "No tasks matched this view.";
}

function getDropdownPosition(anchorElement, type) {
  if (!anchorElement || typeof window === "undefined") return null;

  const rect = anchorElement.getBoundingClientRect();
  const menuWidth = DROPDOWN_WIDTHS[type] || 220;
  const estimatedHeight = DROPDOWN_ESTIMATED_HEIGHTS[type] || 220;
  const spaceBelow = window.innerHeight - rect.bottom;
  const openUpward = spaceBelow < estimatedHeight && rect.top > spaceBelow;

  const baseLeft = type === "actions" ? rect.right - menuWidth : rect.left;
  const maxLeft = Math.max(DROPDOWN_VIEWPORT_PADDING, window.innerWidth - menuWidth - DROPDOWN_VIEWPORT_PADDING);
  const left = Math.min(Math.max(baseLeft, DROPDOWN_VIEWPORT_PADDING), maxLeft);

  return {
    left,
    top: openUpward ? rect.top - DROPDOWN_MENU_GAP : rect.bottom + DROPDOWN_MENU_GAP,
    openUpward,
    width: menuWidth,
  };
}

function buildTaskDetailHref(taskId, searchParams, extra = {}) {
  const params = new URLSearchParams(searchParams.toString());
  params.delete("task_id");
  params.delete("create");
  params.delete("due_date");
  Object.entries(extra).forEach(([key, value]) => {
    if (value === null || value === undefined || value === "") params.delete(key);
    else params.set(key, String(value));
  });
  const query = params.toString();
  return `/dashboard/tasks/${taskId}${query ? `?${query}` : ""}`;
}

function computeTaskReminderAt(form) {
  if (!form.reminder_choice || !form.due_date) return null;
  if (form.reminder_choice === "custom") {
    return form.custom_reminder_at ? new Date(form.custom_reminder_at) : null;
  }
  const due = new Date(form.due_date);
  if (Number.isNaN(due.getTime())) return null;
  due.setMinutes(due.getMinutes() - Number(form.reminder_choice));
  return due;
}

export default function TasksPage() {
  return (
    <Suspense fallback={<section className="dashboard-page-stack"><div className="vilo-state-block"><p className="vilo-state vilo-state--loading">Loading tasks...</p></div></section>}>
      <TasksPageContent />
    </Suspense>
  );
}

function TasksPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const titleInputRef = useRef(null);

  const [tasks, setTasks] = useState([]);
  const [cases, setCases] = useState([]);
  const [clients, setClients] = useState([]);
  const [team, setTeam] = useState([]);
  const [form, setForm] = useState(initialForm);
  const [createInitialForm, setCreateInitialForm] = useState(initialForm);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [createOpen, setCreateOpen] = useState(searchParams.get("create") === "1");
  const [activeDropdown, setActiveDropdown] = useState(null);
  const [statusSavingId, setStatusSavingId] = useState(null);
  const [currentUser, setCurrentUser] = useState(getCachedUser());
  const [activeTab, setActiveTab] = useState(tabFromLegacyFilter(searchParams.get("filter")));
  const [taskSearch, setTaskSearch] = useState("");
  const [assignedStaff, setAssignedStaff] = useState("");
  const [clientFilter, setClientFilter] = useState(searchParams.get("client_id") || "");
  const [caseFilter, setCaseFilter] = useState(searchParams.get("case_id") || "");
  const [statusFilter, setStatusFilter] = useState("");
  const [priorityFilter, setPriorityFilter] = useState("");
  const [dueFrom, setDueFrom] = useState("");
  const [dueTo, setDueTo] = useState("");
  const actionTriggerRefs = useRef(new Map());
  const statusTriggerRefs = useRef(new Map());

  const requestedClientId = Number(searchParams.get("client_id") || 0);
  const requestedCaseId = Number(searchParams.get("case_id") || 0);
  const requestedTaskId = Number(searchParams.get("task_id") || 0);
  const requestedDueDate = searchParams.get("due_date") || "";
  const requestedFilter = searchParams.get("filter") || "";

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [taskData, caseData, clientData, teamData] = await Promise.all([
        apiRequest("/api/v1/tasks?include_archived=true"),
        apiRequest("/api/v1/cases"),
        apiRequest("/api/v1/clients"),
        apiRequest("/api/v1/team"),
      ]);
      setTasks(taskData || []);
      setCases(caseData || []);
      setClients(clientData || []);
      setTeam((teamData || []).filter((user) => user.role !== "client"));
    } catch (err) {
      setError(err.message || "Unable to load tasks.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    function handleUserUpdated(event) {
      setCurrentUser(event.detail || getCachedUser());
    }
    window.addEventListener("vilo:user-updated", handleUserUpdated);
    return () => window.removeEventListener("vilo:user-updated", handleUserUpdated);
  }, []);

  const casesById = useMemo(() => new Map(cases.map((row) => [Number(row.id), row])), [cases]);
  const clientsById = useMemo(() => new Map(clients.map((row) => [Number(row.id), row])), [clients]);
  const teamById = useMemo(() => new Map(team.map((row) => [Number(row.id), row])), [team]);

  const requestedClient = requestedClientId ? clientsById.get(requestedClientId) : null;
  const requestedCase = requestedCaseId ? casesById.get(requestedCaseId) : null;

  useEffect(() => {
    setActiveTab(tabFromLegacyFilter(requestedFilter));
  }, [requestedFilter]);

  useEffect(() => {
    setClientFilter(requestedClientId ? String(requestedClientId) : "");
    setCaseFilter(requestedCaseId ? String(requestedCaseId) : "");
  }, [requestedCaseId, requestedClientId]);

  useEffect(() => {
    if (!requestedCaseId) return;
    const linkedCase = casesById.get(requestedCaseId);
    if (linkedCase?.client_id) setClientFilter(String(linkedCase.client_id));
  }, [casesById, requestedCaseId]);

  useEffect(() => {
    if (!requestedTaskId) return;
    router.replace(buildTaskDetailHref(requestedTaskId, searchParams));
  }, [requestedTaskId, router, searchParams]);

  useEffect(() => {
    const shouldOpen = searchParams.get("create") === "1";
    setCreateOpen(shouldOpen);
    if (!shouldOpen) return;

    const linkedCase = requestedCaseId ? casesById.get(requestedCaseId) : null;
    const derivedClientId = linkedCase ? Number(linkedCase.client_id || 0) : requestedClientId;

    setForm((current) => {
      const next = {
      ...current,
      client_id: derivedClientId ? String(derivedClientId) : current.client_id,
      case_id: requestedCaseId ? String(requestedCaseId) : current.case_id,
      due_date: requestedDueDate && !current.due_date ? `${requestedDueDate}T09:00` : current.due_date,
      };
      setCreateInitialForm(next);
      return next;
    });
  }, [casesById, requestedCaseId, requestedClientId, requestedDueDate, searchParams]);

  useEffect(() => {
    if (!createOpen) return;
    titleInputRef.current?.focus();
  }, [createOpen]);

  useEffect(() => {
    if (!activeDropdown) return undefined;

    function handlePointerDown(event) {
      const target = event.target;
      if (target instanceof Element && target.closest(".task-menu-anchor, .task-status-anchor, .task-overlay-menu")) return;
      setActiveDropdown(null);
    }

    function handleEscape(event) {
      if (event.key === "Escape") {
        setActiveDropdown(null);
      }
    }

    function handleViewportChange() {
      setActiveDropdown((current) => {
        if (!current) return null;
        const anchorMap = current.type === "actions" ? actionTriggerRefs.current : statusTriggerRefs.current;
        const anchorElement = anchorMap.get(current.taskId);
        const position = getDropdownPosition(anchorElement, current.type);
        return position ? { ...current, position } : null;
      });
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
  }, [activeDropdown]);

  const selectedClientId = Number(form.client_id || 0);
  const availableCases = useMemo(() => {
    if (!selectedClientId) return cases;
    return cases.filter((row) => Number(row.client_id) === selectedClientId);
  }, [cases, selectedClientId]);

  useEffect(() => {
    if (!form.case_id) return;
    const linkedCase = casesById.get(Number(form.case_id));
    if (!linkedCase) return;
    const nextClientId = String(linkedCase.client_id || "");
    if (nextClientId && nextClientId !== form.client_id) {
      setForm((current) => ({ ...current, client_id: nextClientId }));
    }
  }, [casesById, form.case_id, form.client_id]);

  const todayKey = new Date().toISOString().slice(0, 10);

  const taskCounts = useMemo(
    () => Object.fromEntries(TASK_TABS.map(([value]) => [value, tasks.filter((task) => matchesTaskTab(task, value, currentUser?.id, todayKey)).length])),
    [currentUser?.id, tasks, todayKey],
  );

  const filterCases = useMemo(() => {
    if (!clientFilter) return cases;
    return cases.filter((row) => Number(row.client_id) === Number(clientFilter));
  }, [cases, clientFilter]);

  const filteredTasks = useMemo(() => {
    const query = taskSearch.trim().toLowerCase();
    return tasks.filter((task) => {
      if (!matchesTaskTab(task, activeTab, currentUser?.id, todayKey)) return false;
      const linkedClient = task.client_id ? clientsById.get(Number(task.client_id)) : null;
      const linkedCase = task.case_id ? casesById.get(Number(task.case_id)) : null;
      const assignee = teamById.get(Number(task.assigned_user_id || task.assigned_to || 0));
      if (query) {
        const haystack = [
          task.title,
          task.description,
          linkedClient?.name,
          linkedCase?.title,
          linkedCase?.case_number,
          assignee?.name,
        ].filter(Boolean).join(" ").toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      if (assignedStaff && Number(task.assigned_user_id || task.assigned_to || 0) !== Number(assignedStaff)) return false;
      if (clientFilter && Number(task.client_id || 0) !== Number(clientFilter)) return false;
      if (caseFilter && Number(task.case_id || 0) !== Number(caseFilter)) return false;
      if (statusFilter && task.status !== statusFilter) return false;
      if (priorityFilter && task.priority !== priorityFilter) return false;
      const dueKey = utcDateKey(task.due_date);
      if (dueFrom && (!dueKey || dueKey < dueFrom)) return false;
      if (dueTo && (!dueKey || dueKey > dueTo)) return false;
      return true;
    });
  }, [activeTab, assignedStaff, caseFilter, casesById, clientFilter, clientsById, currentUser?.id, dueFrom, dueTo, priorityFilter, statusFilter, taskSearch, tasks, teamById, todayKey]);

  const hasActiveFilters = Boolean(taskSearch || assignedStaff || clientFilter || caseFilter || statusFilter || priorityFilter || dueFrom || dueTo);

  function updateQuery(nextParams) {
    const params = new URLSearchParams(searchParams.toString());
    Object.entries(nextParams).forEach(([key, value]) => {
      if (value === null || value === undefined || value === "") params.delete(key);
      else params.set(key, String(value));
    });
    const next = params.toString();
    router.push(next ? `/dashboard/tasks?${next}` : "/dashboard/tasks");
  }

  function changeTaskTab(nextTab) {
    setActiveTab(nextTab);
    updateQuery({ filter: nextTab === "all" ? null : nextTab });
  }

  function changeClientFilter(value) {
    setClientFilter(value);
    const selectedCase = caseFilter ? casesById.get(Number(caseFilter)) : null;
    const nextCase = selectedCase && value && Number(selectedCase.client_id) === Number(value) ? caseFilter : "";
    setCaseFilter(nextCase);
    updateQuery({ client_id: value || null, case_id: nextCase || null });
  }

  function changeCaseFilter(value) {
    setCaseFilter(value);
    const linkedCase = value ? casesById.get(Number(value)) : null;
    const nextClient = linkedCase?.client_id ? String(linkedCase.client_id) : clientFilter;
    if (linkedCase?.client_id) setClientFilter(nextClient);
    updateQuery({ case_id: value || null, client_id: nextClient || null });
  }

  function clearTaskFilters() {
    setTaskSearch("");
    setAssignedStaff("");
    setClientFilter("");
    setCaseFilter("");
    setStatusFilter("");
    setPriorityFilter("");
    setDueFrom("");
    setDueTo("");
    updateQuery({ client_id: null, case_id: null });
  }

  function handleOpenCreate() {
    setCreateInitialForm(initialForm);
    updateQuery({ create: "1" });
  }

  function handleCloseCreate() {
    setCreateOpen(false);
    setForm(initialForm);
    setCreateInitialForm(initialForm);
    updateQuery({ create: null, case_id: requestedTaskId ? null : searchParams.get("case_id"), due_date: null });
  }

  async function createTask(event) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    setSuccess("");

    try {
      const reminderAt = computeTaskReminderAt(form);
      await apiRequest("/api/v1/tasks", {
        method: "POST",
        body: JSON.stringify({
          title: form.title,
          description: form.description || null,
          client_id: form.client_id ? Number(form.client_id) : null,
          case_id: form.case_id ? Number(form.case_id) : null,
          assigned_to: form.assigned_to ? Number(form.assigned_to) : null,
          task_type: form.task_type,
          status: form.status,
          priority: form.priority,
          due_date: form.due_date ? new Date(form.due_date).toISOString() : null,
          reminder_at: reminderAt ? reminderAt.toISOString() : null,
          notes: form.notes || null,
        }),
      });

      setSuccess(reminderAt ? "Task created with reminder." : "Task created successfully.");
      setForm(initialForm);
      setCreateInitialForm(initialForm);
      setCreateOpen(false);
      updateQuery({ create: null });
      await load();
    } catch (err) {
      setError(err.message || "Unable to create task.");
    } finally {
      setSubmitting(false);
    }
  }

  async function updateTaskStatus(taskId, status) {
    setStatusSavingId(taskId);
    setError("");
    try {
      const updated = await apiRequest(`/api/v1/tasks/${taskId}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      setTasks((current) => current.map((task) => (Number(task.id) === Number(taskId) ? updated : task)));
      setActiveDropdown(null);
    } catch (err) {
      setError(err.message || "Unable to update task status.");
    } finally {
      setStatusSavingId(null);
    }
  }

  async function completeTask(taskId) {
    setError("");
    try {
      const updated = await apiRequest(`/api/v1/tasks/${taskId}/complete`, { method: "POST" });
      setTasks((current) => current.map((task) => (Number(task.id) === Number(taskId) ? updated : task)));
      setActiveDropdown(null);
    } catch (err) {
      setError(err.message || "Unable to complete task.");
    }
  }

  async function archiveTask(taskId) {
    setError("");
    try {
      const updated = await apiRequest(`/api/v1/tasks/${taskId}/archive`, { method: "POST" });
      setActiveDropdown(null);
      setTasks((current) => current.map((task) => (Number(task.id) === Number(taskId) ? updated : task)));
    } catch (err) {
      setError(err.message || "Unable to archive task.");
    }
  }

  async function deleteTask(taskId) {
    setError("");
    try {
      await apiRequest(`/api/v1/tasks/${taskId}`, { method: "DELETE" });
      setActiveDropdown(null);
      setTasks((current) => current.filter((task) => Number(task.id) !== Number(taskId)));
    } catch (err) {
      setError(err.message || "Unable to delete task.");
    }
  }

  function setTriggerRef(refMap, id, node) {
    if (node) refMap.current.set(id, node);
    else refMap.current.delete(id);
  }

  function toggleDropdown(taskId, type, anchorElement) {
    setActiveDropdown((current) => {
      if (current?.taskId === taskId && current.type === type) return null;
      const position = getDropdownPosition(anchorElement, type);
      if (!position) return null;
      return { taskId, type, position };
    });
  }

  function renderDropdownMenu(task, detailHref, editHref) {
    if (!activeDropdown || typeof document === "undefined" || Number(activeDropdown.taskId) !== Number(task.id)) return null;

    const menuClassName = `case-actions-menu task-overlay-menu ${activeDropdown.type === "status" ? "task-status-menu" : "task-actions-menu"}${activeDropdown.position.openUpward ? " task-overlay-menu--upward" : ""}`;
    const menuStyle = {
      left: `${activeDropdown.position.left}px`,
      top: `${activeDropdown.position.top}px`,
      width: `${activeDropdown.position.width}px`,
    };

    return createPortal(
      <div className={menuClassName} style={menuStyle} onClick={(event) => event.stopPropagation()}>
        {activeDropdown.type === "status"
          ? STATUS_OPTIONS.map((option) => (
              <button key={option} type="button" onClick={() => updateTaskStatus(task.id, option)}>
                {normalizeLabel(option)}
              </button>
            ))
          : (
            <>
              <button type="button" onClick={() => { setActiveDropdown(null); router.push(detailHref); }}>View Details</button>
              {task.case_id ? <Link href={`/dashboard/cases/${task.case_id}`} onClick={() => setActiveDropdown(null)}>View Case</Link> : <button type="button" disabled>View Case</button>}
              <button type="button" onClick={() => { setActiveDropdown(null); router.push(editHref); }}>Edit Task</button>
              {!isCompleted(task) ? <button type="button" onClick={() => completeTask(task.id)}>Mark as Complete</button> : null}
              <button type="button" onClick={() => archiveTask(task.id)}>Archive Task</button>
              <button type="button" className="is-danger" onClick={() => deleteTask(task.id)}>Delete Task</button>
            </>
          )}
      </div>,
      document.body,
    );
  }

  return (
    <section className="dashboard-page-stack">
      <div className="dashboard-page-heading dashboard-page-heading--split module-page-header tasks-page-header">
        <div>
          <h1>Tasks</h1>
          <p className="tasks-page-subtitle">Manage internal work, deadlines, and follow-ups.</p>
        </div>
        <button type="button" className="vilo-btn vilo-btn--primary module-create-button" onClick={handleOpenCreate}>+ Create Task</button>
      </div>

      {success ? <div className="vilo-state-block"><p className="vilo-state">{success}</p></div> : null}
      {error ? <div className="vilo-state-block"><p className="vilo-state vilo-state--error">{error}</p></div> : null}

      <article className="dashboard-card module-list-card tasks-list-card" aria-label="Tasks list">
        <div className="module-tabs-row" role="tablist" aria-label="Task views">
          {TASK_TABS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={activeTab === value}
              className={`case-tab-btn${activeTab === value ? " is-active" : ""}`}
              onClick={() => changeTaskTab(value)}
            >
              {label} ({taskCounts[value] || 0})
            </button>
          ))}
        </div>

        <div className="tasks-filter-grid">
          <label className="tasks-filter-search"><span>Search tasks</span><input type="search" value={taskSearch} onChange={(event) => setTaskSearch(event.target.value)} placeholder="Title, client, case/file, or assignee" /></label>
          <label><span>Assigned Staff</span><select value={assignedStaff} onChange={(event) => setAssignedStaff(event.target.value)}><option value="">All Staff</option>{team.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
          <label><span>Client</span><select value={clientFilter} onChange={(event) => changeClientFilter(event.target.value)}><option value="">All Clients</option>{clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}</select></label>
          <label><span>Case / File</span><select value={caseFilter} onChange={(event) => changeCaseFilter(event.target.value)}><option value="">All Cases / Files</option>{filterCases.map((caseRow) => <option key={caseRow.id} value={caseRow.id}>{caseRow.title}</option>)}</select></label>
          <label><span>Status</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="">All Statuses</option>{STATUS_OPTIONS.map((option) => <option key={option} value={option}>{normalizeLabel(option)}</option>)}</select></label>
          <label><span>Priority</span><select value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value)}><option value="">All Priorities</option>{PRIORITY_OPTIONS.map((option) => <option key={option} value={option}>{normalizeLabel(option)}</option>)}</select></label>
          <label><span>Due From</span><input type="date" value={dueFrom} onChange={(event) => setDueFrom(event.target.value)} /></label>
          <label><span>Due To</span><input type="date" value={dueTo} onChange={(event) => setDueTo(event.target.value)} /></label>
          <button type="button" className="vilo-btn vilo-btn--secondary" onClick={clearTaskFilters}>Clear Filters</button>
        </div>

        {requestedCase || requestedClient ? <div className="tasks-context-notice">
          <span>{requestedCase ? `Case / File context: ${requestedCase.title}` : `Client context: ${requestedClient.name}`}</span>
        </div> : null}

        <div className="case-tab-panel tasks-table-panel">
          {loading ? <p className="vilo-state vilo-state--loading">Loading tasks...</p> : null}
          {!loading && !filteredTasks.length ? <p className="vilo-state">{taskEmptyMessage(activeTab, hasActiveFilters)}</p> : null}
          {!loading && filteredTasks.length ? (
            <div className="vilo-table-wrap case-table-wrap tasks-table-wrap">
            <table className="team-table tasks-table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Client</th>
                  <th>Status</th>
                  <th>Priority</th>
                  <th>Due</th>
                  <th className="tasks-table__actions-col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredTasks.map((task) => {
                  const linkedCase = task.case_id ? casesById.get(Number(task.case_id)) : null;
                  const linkedClient = task.client_id ? clientsById.get(Number(task.client_id)) : null;
                  const detailHref = buildTaskDetailHref(task.id, searchParams);
                  const editHref = buildTaskDetailHref(task.id, searchParams, { edit: 1 });
                  return (
                    <tr
                      key={task.id}
                      className={`tasks-table-row${isCompleted(task) ? " is-completed" : ""}${task.archived_at ? " is-archived" : ""}${isOverdue(task) ? " is-overdue" : ""}`}
                      onClick={() => router.push(detailHref)}
                    >
                      <td>
                        <div className="tasks-table-title">
                          <strong>{task.title}</strong>
                          <span>{normalizeLabel(task.task_type || "general")}</span>
                        </div>
                      </td>
                      <td>
                        <div className="tasks-table-context">
                          <span>{linkedClient?.name || "No client linked"}</span>
                        </div>
                      </td>
                      <td className="task-status-cell" onClick={(event) => event.stopPropagation()}>
                        <div className="tasks-status-stack task-status-anchor">
                          <button
                            type="button"
                            className={`vilo-badge vilo-badge--${task.status} task-status-trigger`}
                            aria-expanded={activeDropdown?.type === "status" && activeDropdown?.taskId === task.id}
                            aria-haspopup="menu"
                            ref={(node) => setTriggerRef(statusTriggerRefs, task.id, node)}
                            onClick={(event) => {
                              event.stopPropagation();
                              toggleDropdown(task.id, "status", event.currentTarget);
                            }}
                          >
                            <span>{statusSavingId === task.id ? "Saving..." : normalizeLabel(task.status)}</span>
                            <span className="task-status-trigger__chevron" aria-hidden="true">▾</span>
                          </button>
                          {isOverdue(task) ? <span className="vilo-badge vilo-badge--overdue">Overdue</span> : null}
                          {activeDropdown?.type === "status" && activeDropdown?.taskId === task.id ? renderDropdownMenu(task, detailHref, editHref) : null}
                        </div>
                      </td>
                      <td><span className={`vilo-badge vilo-badge--priority-${task.priority}`}>{normalizeLabel(task.priority)}</span></td>
                      <td>
                        <div className="tasks-table-due">
                          <span className={isOverdue(task) ? "tasks-table-due__date is-overdue" : "tasks-table-due__date"}>{formatTaskDueDate(task.due_date)}</span>
                          {linkedCase ? <small>{linkedCase.title}</small> : null}
                        </div>
                      </td>
                      <td className="tasks-actions-cell" onClick={(event) => event.stopPropagation()}>
                        <div className="vilo-table-actions case-row-actions task-menu-anchor">
                          <button
                            type="button"
                            className="vilo-btn vilo-btn--ghost vilo-btn--xs task-action-trigger task-action-trigger--icon"
                            aria-label={`Task actions for ${task.title}`}
                            aria-expanded={activeDropdown?.type === "actions" && activeDropdown?.taskId === task.id}
                            aria-haspopup="menu"
                            ref={(node) => setTriggerRef(actionTriggerRefs, task.id, node)}
                            onClick={(event) => {
                              event.stopPropagation();
                              toggleDropdown(task.id, "actions", event.currentTarget);
                            }}
                          >
                            <span aria-hidden="true">⋯</span>
                          </button>
                          {activeDropdown?.type === "actions" && activeDropdown?.taskId === task.id ? renderDropdownMenu(task, detailHref, editHref) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          ) : null}
        </div>
      </article>

      {createOpen ? (
        <TaskEditorModal
          title="Create Task"
          submitLabel={submitting ? "Creating..." : "Create Task"}
          submitting={submitting}
          form={form}
          setForm={setForm}
          clients={clients}
          availableCases={availableCases}
          team={team}
          error={error}
          onClose={handleCloseCreate}
          onSubmit={createTask}
          titleInputRef={titleInputRef}
          dirty={JSON.stringify(form) !== JSON.stringify(createInitialForm)}
        />
      ) : null}
    </section>
  );
}

function TaskEditorModal({
  title,
  submitLabel,
  submitting,
  form,
  setForm,
  clients,
  availableCases,
  team,
  error,
  onClose,
  onSubmit,
  titleInputRef,
  dirty,
}) {
  const closeGuard = useModalCloseGuard({ open: true, isDirty: dirty, isSubmitting: submitting, onClose });
  return (
    <div className="vilo-modal-overlay" onClick={closeGuard.requestClose}>
      <div className="vilo-modal task-editor-modal" onClick={(event) => event.stopPropagation()}>
        <div className="vilo-modal__header">
          <div>
            <h3>{title}</h3>
            <p className="precedents-modal__copy">Capture the task owner, links, due date, and internal notes in one place.</p>
          </div>
          <button type="button" className="vilo-btn vilo-btn--ghost vilo-btn--xs" onClick={closeGuard.requestClose} disabled={submitting}>Close</button>
        </div>

        <form className="vilo-modal__body task-editor-modal__body" onSubmit={onSubmit}>
          <div className="vilo-form-grid">
            <input
              ref={titleInputRef}
              placeholder="Task title"
              value={form.title}
              onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
              required
            />
            <textarea
              placeholder="Description"
              value={form.description}
              onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
            />

            <div className="vilo-form-row-two">
              <select
                value={form.client_id}
                onChange={(event) => setForm((current) => ({ ...current, client_id: event.target.value, case_id: "" }))}
              >
                <option value="">Select client</option>
                {clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}
              </select>
              <select
                value={form.case_id}
                onChange={(event) => setForm((current) => ({ ...current, case_id: event.target.value }))}
              >
                <option value="">No linked case</option>
                {availableCases.map((caseRow) => <option key={caseRow.id} value={caseRow.id}>{caseRow.title}</option>)}
              </select>
            </div>

            <div className="vilo-form-row-two">
              <select
                value={form.assigned_to}
                onChange={(event) => setForm((current) => ({ ...current, assigned_to: event.target.value }))}
                required
              >
                <option value="">Assigned user</option>
                {team.map((user) => <option key={user.id} value={user.id}>{user.name} ({user.role})</option>)}
              </select>
              <select
                value={form.task_type}
                onChange={(event) => setForm((current) => ({ ...current, task_type: event.target.value }))}
              >
                {TASK_TYPE_OPTIONS.map((option) => <option key={option} value={option}>{normalizeLabel(option)}</option>)}
              </select>
            </div>

            <div className="vilo-form-row-two">
              <select
                value={form.status}
                onChange={(event) => setForm((current) => ({ ...current, status: event.target.value }))}
              >
                {STATUS_OPTIONS.map((option) => <option key={option} value={option}>{normalizeLabel(option)}</option>)}
              </select>
              <select
                value={form.priority}
                onChange={(event) => setForm((current) => ({ ...current, priority: event.target.value }))}
              >
                {PRIORITY_OPTIONS.map((option) => <option key={option} value={option}>{normalizeLabel(option)}</option>)}
              </select>
            </div>

            <div className="vilo-form-row-two">
              <input
                type="datetime-local"
                value={form.due_date}
                onChange={(event) => setForm((current) => ({ ...current, due_date: event.target.value }))}
                required
              />
              <select
                value={form.reminder_choice}
                onChange={(event) => setForm((current) => ({ ...current, reminder_choice: event.target.value, custom_reminder_at: "" }))}
              >
                {REMINDER_OPTIONS.map((option) => <option key={option.value || "none"} value={option.value}>{option.label}</option>)}
              </select>
            </div>

            {form.reminder_choice === "custom" ? (
              <input
                type="datetime-local"
                value={form.custom_reminder_at}
                onChange={(event) => setForm((current) => ({ ...current, custom_reminder_at: event.target.value }))}
              />
            ) : null}

            <textarea
              placeholder="Internal notes"
              value={form.notes}
              onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))}
            />
          </div>

          {error ? <p className="vilo-state vilo-state--error">{error}</p> : null}

          <div className="vilo-table-actions">
            <button type="button" className="vilo-btn vilo-btn--secondary" onClick={closeGuard.requestClose} disabled={submitting}>Cancel</button>
            <button type="submit" className="vilo-btn vilo-btn--primary" disabled={submitting}>{submitLabel}</button>
          </div>
        </form>
      </div>
      <DiscardChangesDialog open={closeGuard.confirmDiscard} onKeepEditing={closeGuard.keepEditing} onDiscard={closeGuard.discard} />
    </div>
  );
}
