"use client";

import { useEffect, useState } from "react";
import { apiRequest } from "../../lib/api";
import { ActiveFilesTable } from "../../components/dashboard/ActiveFilesTable";
import { BillingOverview } from "../../components/dashboard/BillingOverview";
import { CalendarOverview } from "../../components/dashboard/CalendarOverview";
import { FinancialOverview } from "../../components/dashboard/FinancialOverview";
import { FirmSnapshot } from "../../components/dashboard/FirmSnapshot";
import { TodaysOverview } from "../../components/dashboard/TodaysOverview";
import { getCachedUser } from "../../lib/auth";
import { formatViloDate } from "../../lib/dateFormat";

function fmtCurrency(value) {
  const n = Number(value || 0);
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(n);
}

function fmtShortDate(value) {
  return formatViloDate(value);
}

function taskHref(task) {
  if (task?.id) return `/dashboard/tasks/${task.id}`;
  if (task?.case_id) return `/dashboard/cases/${task.case_id}`;
  return "";
}

export default function DashboardPage() {
  const [widgets, setWidgets] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [accessibleCaseIds, setAccessibleCaseIds] = useState(new Set());
  const [currentUser, setCurrentUser] = useState(getCachedUser());
  const [completingTaskId, setCompletingTaskId] = useState(null);

  useEffect(() => {
    let mounted = true;
    async function load() {
      setLoading(true);
      setError("");
      try {
        const [summaryRes, caseRows] = await Promise.all([
          apiRequest("/api/v1/reports/dashboard/widgets"),
          apiRequest("/api/v1/cases").catch(() => []),
        ]);
        if (mounted) {
          setWidgets(summaryRes);
          setAccessibleCaseIds(new Set((caseRows || []).map((row) => Number(row.id))));
        }
      } catch (err) {
        if (mounted) setError(err.message || "Failed to load dashboard summary");
      } finally {
        if (mounted) setLoading(false);
      }
    }
    load();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    function handleUserUpdated(event) {
      setCurrentUser(event.detail || getCachedUser());
    }
    window.addEventListener("vilo:user-updated", handleUserUpdated);
    return () => window.removeEventListener("vilo:user-updated", handleUserUpdated);
  }, []);

  async function completeTask(taskId) {
    setCompletingTaskId(taskId);
    setActionMessage("");
    try {
      await apiRequest(`/api/v1/tasks/${taskId}/complete`, { method: "POST" });
      setWidgets((current) => ({
        ...current,
        today_overview: {
          ...current.today_overview,
          priority_timeline: (current.today_overview?.priority_timeline || [])
            .filter((task) => Number(task.id) !== Number(taskId)),
        },
      }));
      setActionMessage("Task marked complete.");
      return true;
    } catch (err) {
      setActionMessage(err.message || "Unable to complete task.");
      return false;
    } finally {
      setCompletingTaskId(null);
    }
  }

  const today = widgets?.today_overview;
  const firm = widgets?.firm_snapshot;
  const calendar = widgets?.calendar_overview;
  const financial = widgets?.financial_overview;
  const billing = widgets?.billing_overview;
  const calendarEvents = (calendar?.upcoming_events || []).map((item) => ({
    ...item,
    href: item.id ? `/dashboard/calendar?event_id=${item.id}` : "/dashboard/calendar",
  }));

  const todaysStats = [
    { label: "Due Today", value: Math.max(0, Number(today?.due_today_count ?? 12)), href: "/dashboard/tasks?filter=due_today" },
    { label: "Overdue", value: Math.max(0, Number(today?.overdue_count ?? 4)), href: "/dashboard/tasks?filter=overdue" },
    { label: "New Messages", value: Math.max(0, Number(today?.unread_messages_count ?? 0)), href: "/dashboard/messages?filter=unread" },
  ];

  const role = currentUser?.role;
  const canEditTask = role === "admin" || role === "partner";
  const canCompleteTask = ["admin", "partner", "lawyer", "paralegal"].includes(role);
  const timelineRows = (today?.priority_timeline || []).slice(0, 3).map((task) => {
    const taskIsComplete = task.status === "completed" || task.status === "cancelled";
    const linkedCaseId = Number(task.related_case_id || 0);
    return {
      id: task.id,
      label: task.title || `Task #${task.id}`,
      priority: task.priority || "medium",
      tone: task.priority === "high" ? "is-high" : task.priority === "low" ? "is-low" : "is-normal",
      href: taskHref(task),
      actions: [
        { id: "view", label: "View Task", href: `/dashboard/tasks/${task.id}` },
        ...(canEditTask ? [{ id: "edit", label: "Edit Task", href: `/dashboard/tasks/${task.id}?edit=1` }] : []),
        ...(canCompleteTask && !taskIsComplete ? [{
          id: "complete",
          label: "Mark Complete",
          onSelect: () => completeTask(task.id),
          disabled: Number(completingTaskId) === Number(task.id),
        }] : []),
        ...(linkedCaseId && accessibleCaseIds.has(linkedCaseId) ? [{
          id: "file",
          label: "Open File",
          href: `/dashboard/cases/${linkedCaseId}`,
        }] : []),
      ],
    };
  });

  const snapshotStats = [
    { label: "Total Cases", value: Number(firm?.total_cases ?? 100), tone: "is-violet", href: "/dashboard/cases" },
    { label: "High Priority", value: Number(firm?.high_priority_cases ?? 15), tone: "is-orange", href: "/dashboard/cases" },
    { label: "Tasks", value: Number(firm?.total_tasks ?? 88), tone: "is-green", href: "/dashboard/tasks" },
    { label: "Stalled Cases", value: Number(firm?.stalled_cases ?? 10), tone: "is-red", href: "/dashboard/cases" },
  ];

  const financialSummaryItems = [
    { label: "Monthly expenses", value: fmtCurrency(financial?.monthly_expenses), tone: "is-green", href: "/dashboard/expenses" },
    { label: "Net Profit", value: fmtCurrency(financial?.net_profit), tone: "is-orange", href: "/dashboard/finance" },
    { label: "Trust Account", value: fmtCurrency(financial?.trust_account_balance), tone: "is-violet", href: "/dashboard/trust" },
  ];

  const activeCaseRows = (widgets?.active_cases || []).slice(0, 4).map((item) => ({
    id: item.case_id,
    caseId: item.display_number || `C-${item.case_id}`,
    client: item.client_name || "-",
    clientId: item.client_id || null,
    matter: item.matter || "Case matter",
    lead: item.lead || "Team",
    status: item.status || "active",
    due: fmtShortDate(item.due_date),
    href: item.case_id ? `/dashboard/cases/${item.case_id}` : "",
    clientHref: item.client_id ? `/dashboard/clients/${item.client_id}` : "",
  }));

  return (
    <section className="dashboard-home">
      <div className="dashboard-page-heading"><h1>Dashboard</h1></div>

      {loading ? <div className="vilo-state-block"><p className="vilo-state vilo-state--loading">Loading dashboard metrics...</p></div> : null}
      {error ? <div className="vilo-state-block"><p className="vilo-state vilo-state--error">{error}</p></div> : null}
      {actionMessage ? <div className="vilo-state-block"><p className="vilo-state" role="status">{actionMessage}</p></div> : null}

      {!loading && !error ? (
        <>
          <div className="dashboard-row-grid dashboard-row-grid--secondary">
            <TodaysOverview stats={todaysStats} timelineRows={timelineRows.length ? timelineRows : undefined} />
            <FirmSnapshot
              snapshotStats={snapshotStats}
              caseStatusPercent={Number(firm?.case_status_percentage ?? 72)}
              caseStatusCounts={{
                active: Number(firm?.active_cases ?? 0),
                court: Number(firm?.court_cases ?? 0),
                closed: Number(firm?.closed_cases ?? 0),
                pending: Number(firm?.pending_cases ?? 0),
              }}
            />
          </div>

          <div className="dashboard-row-grid dashboard-row-grid--tertiary">
            <CalendarOverview
              events={calendarEvents}
              month={Number(calendar?.month || 0)}
              year={Number(calendar?.year || 0)}
            />
            {financial ? (
              <FinancialOverview
                revenueText={fmtCurrency(financial.monthly_revenue)}
                summaryItems={financialSummaryItems}
              />
            ) : null}
          </div>

          <div className="dashboard-row-grid dashboard-row-grid--tertiary">
            <ActiveFilesTable rows={activeCaseRows.length ? activeCaseRows : undefined} />
            {billing ? <BillingOverview series={billing.chart_series || []} /> : null}
          </div>
        </>
      ) : null}
    </section>
  );
}
