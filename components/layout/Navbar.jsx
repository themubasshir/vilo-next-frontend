"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiRequest } from "../../lib/api";
import UserAvatar from "../UserAvatar";
import { formatViloDateTime } from "../../lib/dateFormat";

const NEW_ACTIONS = [
  ["New Case", "/dashboard/cases?create=1"],
  ["New Client", "/dashboard/clients?create=1"],
  ["New Task", "/dashboard/tasks?create=1"],
  ["New Calendar Event", "/dashboard/calendar?create=1"],
  ["New Time Entry", "/dashboard/time-entries?create=1"],
  ["New Invoice", "/dashboard/invoices?create=1"],
  ["Upload File", "/dashboard/documents?upload=1"],
];

export function Navbar({ onMenuClick, user, onLogout }) {
  const router = useRouter();
  const navRef = useRef(null);
  const searchRef = useRef(null);
  const [openMenu, setOpenMenu] = useState("");
  const [items, setItems] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState({});
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeResult, setActiveResult] = useState(-1);
  const [timer, setTimer] = useState(null);
  const [timerReceivedAt, setTimerReceivedAt] = useState(0);
  const [timerCases, setTimerCases] = useState([]);
  const [timerForm, setTimerForm] = useState({ case_id: "", description: "", billable: true });
  const [timerError, setTimerError] = useState("");
  const [timerSaving, setTimerSaving] = useState(false);
  const [, setTick] = useState(0);

  const flattenedResults = useMemo(() => Object.entries(searchResults).flatMap(([group, rows]) => rows.map((row) => ({ ...row, group }))), [searchResults]);
  const elapsedSeconds = timer ? Math.max(0, timer.elapsed_seconds + (timer.is_paused ? 0 : Math.floor((Date.now() - timerReceivedAt) / 1000))) : 0;

  function acceptTimer(active) {
    setTimer(active);
    setTimerReceivedAt(Date.now());
    if (active) setTimerForm((value) => ({ ...value, description: active.description || "", billable: active.billable }));
  }

  async function loadNotifications() {
    try {
      const data = await apiRequest("/api/v1/notifications?page=1&page_size=10");
      setItems(data.items || []);
      setUnreadCount(data.unread_count || 0);
    } catch {
      setItems([]);
      setUnreadCount(0);
    }
  }

  async function loadTimer() {
    try {
      const active = await apiRequest("/api/v1/time-entries/active-timer");
      acceptTimer(active);
    } catch (err) {
      setTimerError(err.message || "Could not load timer");
    }
  }

  useEffect(() => {
    loadNotifications();
    loadTimer();
    const notificationsId = window.setInterval(loadNotifications, 25000);
    const timerId = window.setInterval(loadTimer, 15000);
    const tickId = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => {
      window.clearInterval(notificationsId);
      window.clearInterval(timerId);
      window.clearInterval(tickId);
    };
  }, []);

  useEffect(() => {
    function handlePointerDown(event) {
      if (navRef.current && !navRef.current.contains(event.target)) setOpenMenu("");
      if (openMenu && !event.target.closest(".dashboard-navbar__dropdown, .dashboard-navbar__notifications, .dashboard-navbar__icon-button, .dashboard-navbar__new-button")) setOpenMenu("");
      if (searchRef.current && !searchRef.current.contains(event.target)) setSearchOpen(false);
    }
    function handleKeyDown(event) {
      if (event.key === "Escape") {
        setOpenMenu("");
        setSearchOpen(false);
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [openMenu]);

  useEffect(() => {
    if (search.trim().length < 2) {
      setSearchResults({});
      setSearchOpen(false);
      setSearchError("");
      return undefined;
    }
    let cancelled = false;
    const timeout = window.setTimeout(async () => {
      setSearchLoading(true);
      setSearchError("");
      try {
        const data = await apiRequest(`/api/v1/search?q=${encodeURIComponent(search.trim())}&limit=5`);
        if (!cancelled) {
          setSearchResults(data.groups || {});
          setSearchOpen(true);
          setActiveResult(-1);
        }
      } catch (err) {
        if (!cancelled) {
          setSearchError(err.message || "Search failed");
          setSearchOpen(true);
        }
      } finally {
        if (!cancelled) setSearchLoading(false);
      }
    }, 300);
    return () => { cancelled = true; window.clearTimeout(timeout); };
  }, [search]);

  function toggleMenu(name) {
    setSearchOpen(false);
    setOpenMenu((current) => current === name ? "" : name);
    if (name === "timer" && !timer && !timerCases.length) {
      apiRequest("/api/v1/cases").then(setTimerCases).catch((err) => setTimerError(err.message));
    }
  }

  async function markRead(id) {
    await apiRequest("/api/v1/notifications/mark-read", { method: "POST", body: JSON.stringify({ notification_ids: [id] }) });
    loadNotifications();
  }

  async function openNotification(item) {
    await markRead(item.id);
    setOpenMenu("");
    const href = resolveNotificationHref(item);
    if (href) router.push(href);
  }

  async function startTimer(event) {
    event.preventDefault();
    if (timerSaving) return;
    setTimerSaving(true);
    setTimerError("");
    try {
      const created = await apiRequest("/api/v1/time-entries/timer/start", {
        method: "POST",
        body: JSON.stringify({ case_id: timerForm.case_id ? Number(timerForm.case_id) : null, description: timerForm.description || null, billable: timerForm.billable }),
      });
      acceptTimer(created);
    } catch (err) {
      setTimerError(err.message || "Could not start timer");
      await loadTimer();
    } finally {
      setTimerSaving(false);
    }
  }

  async function timerAction(action, payload) {
    if (timerSaving) return;
    setTimerSaving(true);
    setTimerError("");
    try {
      const response = await apiRequest(`/api/v1/time-entries/timer/${action}`, { method: "POST", ...(payload ? { body: JSON.stringify(payload) } : {}) });
      if (action === "stop") {
        setTimer(null);
        setOpenMenu("");
        setTimerForm({ case_id: "", description: "", billable: true });
      } else {
        acceptTimer(response);
      }
    } catch (err) {
      setTimerError(err.message || `Could not ${action} timer`);
    } finally {
      setTimerSaving(false);
    }
  }

  function chooseResult(result) {
    setSearchOpen(false);
    setSearch("");
    router.push(result.href);
  }

  function handleSearchKeyDown(event) {
    if (!searchOpen || !flattenedResults.length) return;
    if (event.key === "ArrowDown") { event.preventDefault(); setActiveResult((value) => (value + 1) % flattenedResults.length); }
    if (event.key === "ArrowUp") { event.preventDefault(); setActiveResult((value) => value <= 0 ? flattenedResults.length - 1 : value - 1); }
    if (event.key === "Enter" && activeResult >= 0) { event.preventDefault(); chooseResult(flattenedResults[activeResult]); }
  }

  return (
    <header ref={navRef} className="dashboard-navbar" aria-label="Top navigation">
      <div ref={searchRef} className="dashboard-navbar__search">
        <button type="button" className="dashboard-navbar__mobile-menu" aria-label="Open sidebar menu" onClick={onMenuClick}><MenuIcon /></button>
        <SearchIcon />
        <input className="dashboard-navbar__search-input" type="search" placeholder="Search VILO" aria-label="Search cases, clients, documents, tasks, invoices, and staff" value={search} onChange={(event) => setSearch(event.target.value)} onFocus={() => { setOpenMenu(""); if (search.trim().length >= 2) setSearchOpen(true); }} onKeyDown={handleSearchKeyDown} aria-expanded={searchOpen} aria-controls="global-search-results" />
        {searchOpen ? (
          <div id="global-search-results" className="dashboard-navbar__search-results" role="listbox">
            {searchLoading ? <p>Searching...</p> : null}
            {searchError ? <p className="is-error">{searchError}</p> : null}
            {!searchLoading && !searchError && !flattenedResults.length ? <p>No accessible results found.</p> : null}
            {Object.entries(searchResults).map(([group, rows]) => <section key={group}><h3>{group}</h3>{rows.map((row) => { const index = flattenedResults.findIndex((item) => item.group === group && item.id === row.id); return <button key={`${group}-${row.id}`} type="button" role="option" aria-selected={activeResult === index} className={activeResult === index ? "is-active" : ""} onMouseEnter={() => setActiveResult(index)} onClick={() => chooseResult(row)}><strong>{row.label}</strong>{row.context ? <span>{row.context}</span> : null}</button>; })}</section>)}
          </div>
        ) : null}
      </div>

      <div className="dashboard-navbar__actions">
        <button type="button" className="vilo-btn vilo-btn--primary vilo-btn--xs dashboard-navbar__new-button" aria-expanded={openMenu === "new"} onClick={() => toggleMenu("new")}>+ New</button>
        {openMenu === "new" ? <div className="dashboard-navbar__dropdown dashboard-navbar__new-menu" role="menu">{NEW_ACTIONS.map(([label, href]) => <button key={href} type="button" role="menuitem" onClick={() => { setOpenMenu(""); router.push(href); }}>{label}</button>)}</div> : null}
        <button type="button" className={`dashboard-navbar__icon-button dashboard-navbar__timer-button${timer ? " is-running" : ""}`} aria-label={timer ? `Time tracker running, ${formatElapsed(elapsedSeconds)}` : "Start time tracker"} aria-expanded={openMenu === "timer"} onClick={() => toggleMenu("timer")}><ClockIcon />{timer ? <span>{formatElapsed(elapsedSeconds)}</span> : null}</button>
        {openMenu === "timer" ? (
          <div className="dashboard-navbar__dropdown dashboard-navbar__timer-popover">
            <div className="dashboard-navbar__dropdown-header"><strong>{timer ? "Active timer" : "Start timer"}</strong><button type="button" aria-label="Close time tracker" onClick={() => setOpenMenu("")}>×</button></div>
            {timer ? <form onSubmit={(event) => { event.preventDefault(); timerAction("stop", { description: timerForm.description || timer.description, billable: timerForm.billable }); }}><b className="dashboard-navbar__timer-elapsed">{formatElapsed(elapsedSeconds)}</b><span>{timer.case_title || "General time"}</span><input aria-label="Timer description" placeholder="Description" value={timerForm.description || timer.description || ""} onChange={(event) => setTimerForm((value) => ({ ...value, description: event.target.value }))} /><label><input type="checkbox" checked={timerForm.billable} onChange={(event) => setTimerForm((value) => ({ ...value, billable: event.target.checked }))} /> Billable</label><div className="dashboard-navbar__timer-actions"><button type="button" className="vilo-btn vilo-btn--secondary vilo-btn--xs" onClick={() => timerAction(timer.is_paused ? "resume" : "pause")} disabled={timerSaving}>{timer.is_paused ? "Resume" : "Pause"}</button><button type="submit" className="vilo-btn vilo-btn--primary vilo-btn--xs" disabled={timerSaving}>Stop & save</button></div></form> : <form onSubmit={startTimer}><select aria-label="Timer case" value={timerForm.case_id} onChange={(event) => setTimerForm((value) => ({ ...value, case_id: event.target.value }))}><option value="">General / no case</option>{timerCases.filter((row) => row.status !== "archived").map((row) => <option key={row.id} value={row.id}>{row.title}</option>)}</select><input aria-label="Timer description" placeholder="What are you working on?" value={timerForm.description} onChange={(event) => setTimerForm((value) => ({ ...value, description: event.target.value }))} /><label><input type="checkbox" checked={timerForm.billable} onChange={(event) => setTimerForm((value) => ({ ...value, billable: event.target.checked }))} /> Billable</label><button type="submit" className="vilo-btn vilo-btn--primary vilo-btn--xs" disabled={timerSaving}>{timerSaving ? "Starting..." : "Start timer"}</button></form>}
            {timerError ? <p className="vilo-state vilo-state--error">{timerError}</p> : null}
          </div>
        ) : null}
        <button type="button" className="dashboard-navbar__icon-button is-notification" aria-label="Notifications" aria-expanded={openMenu === "notifications"} onClick={() => toggleMenu("notifications")}><BellIcon />{unreadCount > 0 ? <span className="dashboard-navbar__alert-dot" aria-hidden="true" /> : null}</button>
        {openMenu === "notifications" ? <div className="dashboard-navbar__notifications"><div className="dashboard-navbar__notifications-header"><strong>Notifications</strong><div><button type="button" onClick={() => apiRequest("/api/v1/notifications/mark-all-read", { method: "POST" }).then(loadNotifications)}>Mark all read</button><button type="button" className="dashboard-navbar__notifications-close" aria-label="Close notifications" onClick={() => setOpenMenu("")}>×</button></div></div><div className="dashboard-navbar__notifications-list">{items.length === 0 ? <p>No notifications yet.</p> : null}{items.map((item) => <button key={item.id} type="button" className="dashboard-navbar__notification-item" onClick={() => openNotification(item)}><div><strong>{item.title}</strong>{item.body ? <span>{item.body}</span> : null}<small>{formatViloDateTime(item.created_at)}</small></div>{!item.is_read ? <em>New</em> : null}</button>)}</div></div> : null}
        <button type="button" className="dashboard-navbar__avatar-button" aria-label="Profile Settings" onClick={() => router.push("/dashboard/settings")}><UserAvatar user={user} size="sm" /><span className="dashboard-navbar__online-dot" /></button>
        <button type="button" className="dashboard-navbar__identity dashboard-navbar__identity--button" onClick={() => router.push("/dashboard/settings")}><strong>{user?.name || "Loading..."}</strong><span>{user?.role || ""}</span></button>
        <button type="button" className="vilo-btn vilo-btn--secondary vilo-btn--xs" onClick={onLogout}>Logout</button>
      </div>
    </header>
  );
}

function formatElapsed(seconds) { const safe = Math.max(0, Number(seconds || 0)); const hours = String(Math.floor(safe / 3600)).padStart(2, "0"); const minutes = String(Math.floor((safe % 3600) / 60)).padStart(2, "0"); const secs = String(safe % 60).padStart(2, "0"); return `${hours}:${minutes}:${secs}`; }
function resolveNotificationHref(item) { const meta = item?.metadata || {}; if (meta.link) return meta.link; if (meta.task_id) return `/dashboard/tasks/${meta.task_id}`; if (meta.calendar_event_id) return `/dashboard/calendar?event_id=${meta.calendar_event_id}`; if (meta.case_id) return `/dashboard/cases/${meta.case_id}`; if (meta.client_id) return `/dashboard/clients/${meta.client_id}`; return ""; }
function IconBase({ children }) { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>; }
function MenuIcon() { return <IconBase><path d="M4 7h16M4 12h16M4 17h16" /></IconBase>; }
function SearchIcon() { return <IconBase><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></IconBase>; }
function ClockIcon() { return <IconBase><circle cx="12" cy="12" r="8.5" /><path d="M12 7.8v4.6M12 12.4h3.3" /></IconBase>; }
function BellIcon() { return <IconBase><path d="M8.2 17h7.6M10 19.4a2.3 2.3 0 0 0 4 0M18 17c-1-1.1-1.6-2.7-1.6-4.7 0-2.8-1.8-5-4.4-5s-4.4 2.2-4.4 5C7.6 14.3 7 15.9 6 17" /></IconBase>; }
