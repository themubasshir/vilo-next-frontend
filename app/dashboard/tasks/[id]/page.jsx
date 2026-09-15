"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { apiRequest } from "../../../../lib/api";
import { getCachedUser } from "../../../../lib/auth";
import { formatViloDate, formatViloDateTime } from "../../../../lib/dateFormat";
import ViloDateInput from "../../../../components/ViloDateInput";
import { combineTaskDueDateTime, formatTaskDueTime, splitTaskDueDateTime } from "../../../../lib/taskDueDateTime";

const STATUS_OPTIONS = ["not_started", "in_progress", "waiting", "completed"];
const PRIORITY_OPTIONS = ["low", "medium", "high", "urgent"];
const TASK_TYPE_OPTIONS = ["general", "deadline", "court", "client_follow_up", "document", "billing", "other"];

function normalizeLabel(value) {
  return String(value || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatDateTime(value) {
  return formatViloDateTime(value);
}

function isCompleted(task) {
  return task?.status === "completed";
}

function isOverdue(task) {
  return Boolean(task?.is_overdue) && !isCompleted(task);
}

function toDateTimeLocal(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset();
  const localDate = new Date(date.getTime() - offset * 60000);
  return localDate.toISOString().slice(0, 16);
}

function buildInitialForm(task) {
  const due = splitTaskDueDateTime(task?.due_date);
  return {
    client_id: task?.client_id ? String(task.client_id) : "",
    case_id: task?.case_id ? String(task.case_id) : "",
    assigned_to: task?.assigned_user_id || task?.assigned_to ? String(task.assigned_user_id || task.assigned_to) : "",
    title: task?.title || "",
    description: task?.description || "",
    task_type: task?.task_type || "general",
    status: task?.status || "not_started",
    priority: task?.priority || "medium",
    due_date: due.due_date,
    due_time: due.due_time,
    original_due_date: task?.due_date || null,
    reminder_at: toDateTimeLocal(task?.reminder_at),
    notes: task?.notes || "",
  };
}

export default function TaskDetailPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const taskId = Number(params.id);
  const titleInputRef = useRef(null);

  const [task, setTask] = useState(null);
  const [cases, setCases] = useState([]);
  const [clients, setClients] = useState([]);
  const [team, setTeam] = useState([]);
  const [form, setForm] = useState(buildInitialForm(null));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [editOpen, setEditOpen] = useState(searchParams.get("edit") === "1");
  const [currentUser, setCurrentUser] = useState(getCachedUser());
  const canEditTask = currentUser?.role === "admin" || currentUser?.role === "partner";
  const canDeleteTask = currentUser?.role === "admin";

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [taskData, caseData, clientData, teamData] = await Promise.all([
        apiRequest(`/api/v1/tasks/${taskId}`),
        apiRequest("/api/v1/cases"),
        apiRequest("/api/v1/clients"),
        apiRequest("/api/v1/team"),
      ]);
      setTask(taskData);
      setCases(caseData || []);
      setClients(clientData || []);
      setTeam((teamData || []).filter((user) => user.role !== "client"));
      setForm(buildInitialForm(taskData));
    } catch (err) {
      setError(err.message || "Unable to load task.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (taskId) load();
  }, [taskId]);

  useEffect(() => {
    function handleUserUpdated(event) {
      setCurrentUser(event.detail || getCachedUser());
    }
    window.addEventListener("vilo:user-updated", handleUserUpdated);
    return () => window.removeEventListener("vilo:user-updated", handleUserUpdated);
  }, []);

  useEffect(() => {
    const shouldOpen = searchParams.get("edit") === "1";
    setEditOpen(shouldOpen && canEditTask);
    if (shouldOpen && canEditTask && task) setForm(buildInitialForm(task));
  }, [canEditTask, searchParams, task]);

  useEffect(() => {
    if (!editOpen) return;
    titleInputRef.current?.focus();
  }, [editOpen]);

  const casesById = useMemo(() => new Map(cases.map((row) => [Number(row.id), row])), [cases]);
  const clientsById = useMemo(() => new Map(clients.map((row) => [Number(row.id), row])), [clients]);
  const teamById = useMemo(() => new Map(team.map((row) => [Number(row.id), row])), [team]);

  const linkedCase = task?.case_id ? casesById.get(Number(task.case_id)) : null;
  const linkedClient = task?.client_id ? clientsById.get(Number(task.client_id)) : null;
  const createdByUser = teamById.get(Number(task?.created_by || 0)) || null;
  const assignedUser = teamById.get(Number(task?.assigned_user_id || task?.assigned_to || 0)) || null;
  const availableCases = useMemo(() => {
    const selectedClientId = Number(form.client_id || 0);
    if (!selectedClientId) return cases;
    return cases.filter((row) => Number(row.client_id) === selectedClientId);
  }, [cases, form.client_id]);

  function updateSearchParam(key, value) {
    const next = new URLSearchParams(searchParams.toString());
    if (value === null || value === undefined || value === "") next.delete(key);
    else next.set(key, String(value));
    const query = next.toString();
    router.replace(query ? `/dashboard/tasks/${taskId}?${query}` : `/dashboard/tasks/${taskId}`);
  }

  async function patchTask(payload, successMessage = "Task updated.") {
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      const updated = await apiRequest(`/api/v1/tasks/${taskId}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      setTask(updated);
      setForm(buildInitialForm(updated));
      setSuccess(successMessage);
      return updated;
    } catch (err) {
      setError(err.message || "Unable to update task.");
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function handleSave(event) {
    event.preventDefault();
    const originalDue = splitTaskDueDateTime(form.original_due_date);
    const dueUnchanged = originalDue.due_date === form.due_date && originalDue.due_time === form.due_time;
    const updated = await patchTask({
      client_id: form.client_id ? Number(form.client_id) : null,
      case_id: form.case_id ? Number(form.case_id) : null,
      assigned_to: form.assigned_to ? Number(form.assigned_to) : null,
      title: form.title.trim(),
      description: form.description.trim() || null,
      task_type: form.task_type,
      status: form.status,
      priority: form.priority,
      due_date: dueUnchanged ? form.original_due_date : combineTaskDueDateTime(form.due_date, form.due_time),
      reminder_at: form.reminder_at ? new Date(form.reminder_at).toISOString() : null,
      notes: form.notes.trim() || null,
    }, "Task updated successfully.");

    if (updated) {
      setEditOpen(false);
      updateSearchParam("edit", null);
    }
  }

  async function handleStatusChange(nextStatus) {
    await patchTask({ status: nextStatus }, "Task status updated.");
  }

  async function handlePriorityChange(nextPriority) {
    await patchTask({ priority: nextPriority }, "Task priority updated.");
  }

  async function completeTask() {
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      const updated = await apiRequest(`/api/v1/tasks/${taskId}/complete`, { method: "POST" });
      setTask(updated);
      setForm(buildInitialForm(updated));
      setSuccess("Task marked complete.");
    } catch (err) {
      setError(err.message || "Unable to complete task.");
    } finally {
      setSaving(false);
    }
  }

  async function deleteTask() {
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      await apiRequest(`/api/v1/tasks/${taskId}`, { method: "DELETE" });
      router.push("/dashboard/tasks");
    } catch (err) {
      setError(err.message || "Unable to delete task.");
      setSaving(false);
    }
  }

  if (loading) {
    return <section className="dashboard-page-stack"><div className="vilo-state-block"><p className="vilo-state vilo-state--loading">Loading task...</p></div></section>;
  }

  if (!task) {
    return <section className="dashboard-page-stack"><div className="vilo-state-block"><p className="vilo-state vilo-state--error">{error || "Task not found."}</p></div></section>;
  }

  return (
    <section className="dashboard-page-stack task-detail-page">
      <div className="task-detail-page__topbar">
        <div className="task-detail-page__heading">
          <p className="task-detail-page__crumb"><Link href="/dashboard/tasks">Task List</Link> / Task #{task.id}</p>
          <h1>{task.title}</h1>
          <p className="vilo-card-copy">Dedicated task detail for status changes, linked records, and editing.</p>
        </div>
        <div className="task-detail-page__actions">
          {canEditTask ? <button type="button" className="vilo-btn vilo-btn--secondary" onClick={() => updateSearchParam("edit", "1")}>Edit Task</button> : null}
          {!isCompleted(task) ? <button type="button" className="vilo-btn vilo-btn--primary" onClick={completeTask} disabled={saving}>Mark Complete</button> : null}
        </div>
      </div>

      {success ? <div className="vilo-state-block"><p className="vilo-state">{success}</p></div> : null}
      {error ? <div className="vilo-state-block"><p className="vilo-state vilo-state--error">{error}</p></div> : null}

      <div className="task-detail-layout">
        <article className={`dashboard-card task-detail-hero${isCompleted(task) ? " is-completed" : ""}${isOverdue(task) ? " is-overdue" : ""}`}>
          <div className="task-detail-hero__head">
            <div className="task-detail-hero__summary">
              <div className="task-detail-hero__badges">
                <span className={`vilo-badge vilo-badge--${task.status}`}>{normalizeLabel(task.status)}</span>
                <span className={`vilo-badge vilo-badge--priority-${task.priority}`}>{normalizeLabel(task.priority)}</span>
                {task.is_overdue ? <span className="vilo-badge vilo-badge--overdue">Overdue</span> : null}
              </div>
              <p>{task.description || "No description provided."}</p>
            </div>

            <div className="task-detail-hero__controls">
              <label>
                <span>Status</span>
                <select value={task.status} onChange={(event) => handleStatusChange(event.target.value)} disabled={saving}>
                  {STATUS_OPTIONS.map((option) => <option key={option} value={option}>{normalizeLabel(option)}</option>)}
                </select>
              </label>
              {canEditTask ? <label>
                <span>Priority</span>
                <select value={task.priority} onChange={(event) => handlePriorityChange(event.target.value)} disabled={saving}>
                  {PRIORITY_OPTIONS.map((option) => <option key={option} value={option}>{normalizeLabel(option)}</option>)}
                </select>
              </label> : null}
            </div>
          </div>

          <div className="task-detail-grid">
            <div className="task-detail-grid__item"><span>Linked client</span><strong>{linkedClient?.name || "No client linked"}</strong></div>
            <div className="task-detail-grid__item"><span>Linked case</span><strong>{linkedCase?.title || "No case linked"}</strong></div>
            <div className="task-detail-grid__item"><span>Assigned user</span><strong>{assignedUser?.name || "Unassigned"}</strong></div>
            <div className="task-detail-grid__item"><span>Task type</span><strong>{normalizeLabel(task.task_type || "general")}</strong></div>
            <div className="task-detail-grid__item"><span>Due Date</span><strong>{formatViloDate(task.due_date)}</strong></div>
            <div className="task-detail-grid__item"><span>Due Time</span><strong>{formatTaskDueTime(task.due_date)}</strong></div>
            <div className="task-detail-grid__item"><span>Reminder</span><strong>{formatDateTime(task.reminder_at)}</strong></div>
            <div className="task-detail-grid__item"><span>Created by</span><strong>{createdByUser?.name || `User #${task.created_by || "-"}`}</strong></div>
            <div className="task-detail-grid__item"><span>Created</span><strong>{formatDateTime(task.created_at)}</strong></div>
            <div className="task-detail-grid__item"><span>Last updated</span><strong>{formatDateTime(task.updated_at)}</strong></div>
            <div className="task-detail-grid__item"><span>Task ID</span><strong>#{task.id}</strong></div>
          </div>

          <div className="task-detail-notes">
            <span>Notes</span>
            <p>{task.notes || "No internal notes."}</p>
          </div>

          <div className="task-detail-page__footer-actions">
            <Link className="vilo-btn vilo-btn--secondary" href="/dashboard/tasks">Back to Task List</Link>
            {task.client_id ? <Link className="vilo-btn vilo-btn--secondary" href={`/dashboard/clients/${task.client_id}`}>Open Client</Link> : null}
            {task.case_id ? <Link className="vilo-btn vilo-btn--secondary" href={`/dashboard/cases/${task.case_id}`}>Open Case</Link> : null}
            {canDeleteTask ? <button type="button" className="vilo-btn vilo-btn--danger" onClick={deleteTask} disabled={saving}>Delete Task</button> : null}
          </div>
        </article>
      </div>

      {editOpen && canEditTask ? (
        <div className="vilo-modal-overlay" onClick={() => updateSearchParam("edit", null)}>
          <div className="vilo-modal task-editor-modal" onClick={(event) => event.stopPropagation()}>
            <div className="vilo-modal__header">
              <div>
                <h3>Edit Task</h3>
                <p className="precedents-modal__copy">Update the task title, linked records, assignee, dates, and internal notes.</p>
              </div>
              <button type="button" className="vilo-btn vilo-btn--ghost vilo-btn--xs" onClick={() => updateSearchParam("edit", null)}>Close</button>
            </div>

            <form className="vilo-modal__body task-editor-modal__body" onSubmit={handleSave}>
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
                  <label>
                    <span>Due Date</span>
                    <ViloDateInput
                      value={form.due_date}
                      onChange={(value) => setForm((current) => ({ ...current, due_date: value }))}
                      required
                    />
                  </label>
                  <label>
                    <span>Due Time (optional)</span>
                    <input type="time" value={form.due_time} onChange={(event) => setForm((current) => ({ ...current, due_time: event.target.value }))} />
                  </label>
                </div>
                <div className="vilo-form-row-two">
                  <ViloDateInput
                    includeTime
                    value={form.reminder_at}
                    onChange={(value) => setForm((current) => ({ ...current, reminder_at: value }))}
                  />
                </div>

                <textarea
                  placeholder="Internal notes"
                  value={form.notes}
                  onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))}
                />
              </div>

              <div className="vilo-table-actions">
                <button type="button" className="vilo-btn vilo-btn--secondary" onClick={() => updateSearchParam("edit", null)}>Cancel</button>
                <button type="submit" className="vilo-btn vilo-btn--primary" disabled={saving}>{saving ? "Saving..." : "Save Task"}</button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </section>
  );
}
