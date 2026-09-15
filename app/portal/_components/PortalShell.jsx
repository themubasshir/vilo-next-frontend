"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { apiRequest } from "../../../lib/api";
import { formatViloDateTime } from "../../../lib/dateFormat";
import { clearAuth, getCachedUser, getToken, setCachedUser } from "../../../lib/auth";
import { portalNav } from "./nav";

export default function PortalShell({ children }) {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState(getCachedUser());
  const [openNotifications, setOpenNotifications] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    async function load() {
      if (!getToken()) {
        router.replace("/login");
        return;
      }
      try {
        const me = await apiRequest("/api/v1/auth/me");
        setCachedUser(me);
        setUser(me);
        if (me.role !== "client") router.replace("/dashboard");
      } catch {
        router.replace("/login");
      }
    }
    load();
  }, [router]);

  useEffect(() => {
    async function loadNotifications() {
      if (!getToken()) return;
      try {
        const data = await apiRequest("/api/v1/notifications?page=1&page_size=10");
        setNotifications(data.items || []);
        setUnreadCount(data.unread_count || 0);
      } catch {
        setNotifications([]);
        setUnreadCount(0);
      }
    }
    loadNotifications();
    const id = setInterval(loadNotifications, 25000);
    return () => clearInterval(id);
  }, []);

  async function markRead(id) {
    await apiRequest("/api/v1/notifications/mark-read", {
      method: "POST",
      body: JSON.stringify({ notification_ids: [id] }),
    });
    const data = await apiRequest("/api/v1/notifications?page=1&page_size=10");
    setNotifications(data.items || []);
    setUnreadCount(data.unread_count || 0);
  }

  async function markAllRead() {
    await apiRequest("/api/v1/notifications/mark-all-read", { method: "POST" });
    const data = await apiRequest("/api/v1/notifications?page=1&page_size=10");
    setNotifications(data.items || []);
    setUnreadCount(data.unread_count || 0);
  }

  function logout() {
    clearAuth();
    router.push("/login");
  }

  return (
    <div className="portal-shell">
      <aside className="portal-sidebar">
        <div className="portal-brand">VILO Client Portal</div>
        <nav className="portal-nav">
          {portalNav.map((item) => (
            <Link key={item.href} href={item.href} className={pathname === item.href ? "is-active" : ""}>
              {item.label}
            </Link>
          ))}
        </nav>
      </aside>
      <main className="portal-main">
        <div className="portal-topbar">
          <div>
            <strong>{user?.name || "Loading..."}</strong>
            <span>{user?.email || ""}</span>
          </div>
          <div className="portal-topbar__actions">
            <button className="portal-topbar__notify vilo-btn vilo-btn--secondary vilo-btn--xs" onClick={() => setOpenNotifications((prev) => !prev)}>
              Notifications
              {unreadCount > 0 ? <b>{unreadCount}</b> : null}
            </button>
            {openNotifications ? (
              <div className="portal-topbar__dropdown">
                <div className="portal-topbar__dropdown-head">
                  <strong>Notifications</strong>
                  <button type="button" onClick={markAllRead}>Mark all read</button>
                </div>
                {notifications.length === 0 ? <p>No notifications yet.</p> : null}
                {notifications.map((item) => (
                  <button key={item.id} type="button" className="portal-topbar__dropdown-item" onClick={() => markRead(item.id)}>
                    <strong>{item.title}</strong>
                    {item.body ? <span>{item.body}</span> : null}
                    <small>{formatViloDateTime(item.created_at)}</small>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <button className="vilo-btn vilo-btn--secondary vilo-btn--xs" onClick={logout}>Logout</button>
        </div>
        {children}
      </main>
    </div>
  );
}
