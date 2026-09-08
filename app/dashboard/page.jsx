"use client";

import { useEffect, useState } from "react";
import { apiRequest } from "../../lib/api";
import { ActiveFilesTable } from "../../components/dashboard/ActiveFilesTable";
import { BillingOverview } from "../../components/dashboard/BillingOverview";
import { CalendarOverview } from "../../components/dashboard/CalendarOverview";
import { FinancialOverview } from "../../components/dashboard/FinancialOverview";
import { FirmSnapshot } from "../../components/dashboard/FirmSnapshot";
import { TodaysOverview } from "../../components/dashboard/TodaysOverview";
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

  useEffect(() => {
    let mounted = true;
    async function load() {
      setLoading(true);
      setError("");
      try {
        const summaryRes = await apiRequest("/api/v1/reports/dashboard/widgets");
        if (mounted) {
          setWidgets(summaryRes);
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
    { label: "Messages", value: Math.max(0, Number(today?.unread_messages_count ?? 9)), href: "/dashboard/messages" },
  ];

  const timelineRows = (today?.priority_timeline || []).slice(0, 3).map((task) => ({
    id: task.id,
    label: task.title || `Task #${task.id}`,
    priority: task.priority || "medium",
    tone: task.priority === "high" ? "is-high" : task.priority === "low" ? "is-low" : "is-normal",
    href: taskHref(task),
  }));

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
