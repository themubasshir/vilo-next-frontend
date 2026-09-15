"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { apiRequest } from "../../lib/api";
import { formatViloDateTime } from "../../lib/dateFormat";
import { motionEase, createHoverLift, createItemVariants } from "../motion";

const billingChildren = [
  { label: "Billing Reports", href: "/dashboard/billing" },
  { label: "Invoices", href: "/dashboard/invoices" },
  { label: "Time Entries", href: "/dashboard/time-entries" },
];

const financeChildren = [
  { label: "Trust", href: "/dashboard/trust" },
  { label: "Expenses", href: "/dashboard/expenses" },
];

const navigationItems = [
  { label: "Dashboard", icon: HomeIcon, href: "/dashboard" },
  { label: "Clients", icon: UsersIcon, href: "/dashboard/clients" },
  { label: "Files", icon: FileStackIcon, href: "/dashboard/cases" },
  { label: "Calendar", icon: CalendarIcon, href: "/dashboard/calendar" },
  { label: "Tasks", icon: ClipboardListIcon, href: "/dashboard/tasks" },
  { label: "Documents", icon: FileStackIcon, href: "/dashboard/documents" },
  { label: "Precedents", icon: ListIcon, href: "/dashboard/precedents" },
  { label: "Messages", icon: MessageCircleIcon, href: "/dashboard/messages" },
  { label: "Billing", icon: DollarSignIcon, children: billingChildren },
  { label: "Finance", icon: TrustIcon, children: financeChildren },
  { label: "Team", icon: NetworkIcon, href: "/dashboard/team" },
  { label: "Reports", icon: ClipboardIcon, href: "/dashboard/reports" },
  { label: "Settings", icon: SettingsIcon, href: "/dashboard/settings" },
];

const createActions = [
  { label: "Case Management", href: "/dashboard/cases?create=1", icon: BriefcaseIcon },
  { label: "Client", href: "/dashboard/clients?create=1", icon: UserPlusIcon },
  { label: "Tasks", href: "/dashboard/tasks?create=1", icon: TaskPlusIcon },
  { label: "Documents", href: "/dashboard/documents?upload=1", icon: FileStackIcon },
  { label: "Invoice", href: "/dashboard/invoices?create=1", icon: DollarSignIcon },
  { label: "Time Entry", href: "/dashboard/time-entries?create=1", icon: ClockIcon },
  { label: "Expense", href: "/dashboard/expenses?create=1", icon: TrustIcon },
  { label: "Event", href: "/dashboard/calendar?create=1", icon: FlagIcon },
  { label: "Messages", href: "/dashboard/messages?create=1", icon: MessageCircleIcon },
];

function isPathMatch(pathname, href) {
  if (!href) return false;
  return href === "/dashboard" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

function hasActiveChild(pathname, children = []) {
  return children.some((child) => isPathMatch(pathname, child.href));
}

export function Sidebar({ isMobileOpen = false, onClose = () => {}, user = null }) {
  const router = useRouter();
  const pathname = usePathname();
  const [createOpen, setCreateOpen] = useState(true);
  const [billingOpen, setBillingOpen] = useState(hasActiveChild(pathname, billingChildren));
  const [financeOpen, setFinanceOpen] = useState(hasActiveChild(pathname, financeChildren));
  const [activityItems, setActivityItems] = useState([]);
  const shouldReduceMotion = useReducedMotion();
  const itemVariants = createItemVariants(shouldReduceMotion, "y", 10);
  const hoverLift = createHoverLift(shouldReduceMotion, -2, 1.01);
  const sidebarVariants = shouldReduceMotion
    ? {
        hidden: { opacity: 1 },
        show: { opacity: 1 },
      }
    : {
        hidden: { opacity: 0 },
        show: {
          opacity: 1,
          transition: {
            duration: 0.3,
            ease: motionEase,
            when: "beforeChildren",
            staggerChildren: 0.04,
          },
        },
      };
  const activeHover = shouldReduceMotion
    ? {}
    : {
        scale: 1.015,
        boxShadow: "0 10px 24px rgba(67, 44, 241, 0.35)",
        transition: { duration: 0.18 },
      };

  const visibleNavigationItems = useMemo(() => {
    if (user?.role !== "client") return navigationItems;
    return navigationItems.filter((item) => item.label !== "Precedents");
  }, [user?.role]);

  useEffect(() => {
    let cancelled = false;

    async function loadActivity() {
      try {
        const data = await apiRequest("/api/v1/notifications?page=1&page_size=5");
        if (cancelled) return;
        setActivityItems((data.items || []).map((item) => ({
          id: item.id,
          title: item.title || "Activity",
          timestamp: formatShortTimestamp(item.created_at),
          module: prettyType(item.type),
          href: resolveNotificationHref(item),
        })));
      } catch {
        if (!cancelled) setActivityItems([]);
      }
    }

    loadActivity();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (hasActiveChild(pathname, billingChildren)) {
      setBillingOpen(true);
    }
    if (hasActiveChild(pathname, financeChildren)) {
      setFinanceOpen(true);
    }
  }, [pathname]);

  function navigateTo(href) {
    router.push(href);
    onClose();
  }

  return (
    <motion.aside
      className={`sidebar vilo-sidebar${isMobileOpen ? " is-mobile-open" : ""}`}
      initial="hidden"
      animate="show"
      variants={sidebarVariants}
    >
      <div className="vilo-sidebar__inner">
        <Link
          href="/dashboard"
          className="vilo-sidebar__brand"
          aria-label="Go to dashboard"
          title="Go to dashboard"
          onClick={onClose}
        >
          <Image src="/assets/vilo-logo.png" alt="VILO" width={120} height={36} className="vilo-brand-logo" priority />
        </Link>

        <div className="vilo-sidebar__block">
          <p className="vilo-sidebar__eyebrow">APPS &amp; PAGES</p>

          <nav className="vilo-sidebar__nav" aria-label="Sidebar navigation">
            {visibleNavigationItems.map((item) => {
              const Icon = item.icon;
              const active = item.children ? hasActiveChild(pathname, item.children) : isPathMatch(pathname, item.href);

              if (item.children) {
                const forcedOpen = hasActiveChild(pathname, item.children);
                const open = forcedOpen || (item.label === "Billing" ? billingOpen : financeOpen);
                const toggle = item.label === "Billing" ? setBillingOpen : setFinanceOpen;

                return (
                  <motion.div key={item.label} className="vilo-sidebar__group" variants={itemVariants}>
                    <motion.button
                      type="button"
                      className={`vilo-sidebar__item vilo-sidebar__item--group${active ? " is-active" : ""}`}
                      whileHover={active ? {} : hoverLift}
                      aria-expanded={open}
                      aria-controls={`sidebar-group-${item.label.toLowerCase()}`}
                      onClick={() => toggle((prev) => (forcedOpen ? true : !prev))}
                    >
                      <span className="vilo-sidebar__item-main">
                        <span className="vilo-sidebar__icon-wrap">
                          <Icon />
                        </span>
                        <span>{item.label}</span>
                      </span>
                      <ChevronDownIcon className={open ? "is-open" : ""} />
                    </motion.button>

                    {open ? (
                      <div id={`sidebar-group-${item.label.toLowerCase()}`} className="vilo-sidebar__subnav">
                        {item.children.map((child) => {
                          const childActive = isPathMatch(pathname, child.href);

                          return (
                            <motion.button
                              key={child.label}
                              type="button"
                              className={`vilo-sidebar__subitem${childActive ? " is-active" : ""}`}
                              variants={itemVariants}
                              whileHover={hoverLift}
                              onClick={() => navigateTo(child.href)}
                            >
                              <span>{child.label}</span>
                            </motion.button>
                          );
                        })}
                      </div>
                    ) : null}
                  </motion.div>
                );
              }

              return (
                <motion.button
                  key={item.label}
                  type="button"
                  className={`vilo-sidebar__item${active ? " is-active" : ""}`}
                  variants={itemVariants}
                  whileHover={active ? activeHover : hoverLift}
                  onClick={() => navigateTo(item.href)}
                >
                  <span className="vilo-sidebar__item-main">
                    <span className="vilo-sidebar__icon-wrap">
                      <Icon />
                    </span>
                    <span>{item.label}</span>
                  </span>
                </motion.button>
              );
            })}
          </nav>
        </div>

        <div className="vilo-sidebar__divider" />

        <motion.button
          type="button"
          className={`vilo-sidebar__new-row${createOpen ? " is-open" : ""}`}
          variants={itemVariants}
          whileHover={hoverLift}
          aria-expanded={createOpen}
          aria-controls="vilo-create-menu"
          onClick={() => setCreateOpen((prev) => !prev)}
        >
          <span className="vilo-sidebar__item-main">
            <span className="vilo-sidebar__icon-wrap">
              <PlusIcon />
            </span>
            <span>New</span>
          </span>
          <ChevronDownIcon className={createOpen ? "is-open" : ""} />
        </motion.button>

        {createOpen ? (
          <div id="vilo-create-menu" className="vilo-sidebar__create-menu" role="menu" aria-label="Create new">
            {createActions.map((action) => {
              const Icon = action.icon;

              return (
                <motion.button
                  key={action.label}
                  type="button"
                  className="vilo-sidebar__create-action"
                  variants={itemVariants}
                  whileHover={hoverLift}
                  role="menuitem"
                  onClick={() => {
                    setCreateOpen(false);
                    navigateTo(action.href);
                  }}
                >
                  <span className="vilo-sidebar__icon-wrap">
                    <Icon />
                  </span>
                  <span>{action.label}</span>
                </motion.button>
              );
            })}
          </div>
        ) : null}

        <section className="vilo-sidebar__block vilo-sidebar__activity-block">
          <p className="vilo-sidebar__eyebrow">RECENT ACTIVITY</p>

          <div className="vilo-activity">
            {activityItems.length === 0 ? <div className="vilo-activity__empty">No recent activity yet.</div> : null}
            {activityItems.map((item) => (
              <motion.div key={item.id} variants={itemVariants} whileHover={hoverLift}>
                {item.href ? (
                  <Link href={item.href} className="vilo-activity__item" onClick={onClose}>
                    <span className="vilo-activity__status">
                      <CheckCircleIcon />
                    </span>
                    <span className="vilo-activity__copy">
                      <span className="vilo-activity__title">{item.title}</span>
                      <span className="vilo-activity__time">{item.module} · {item.timestamp}</span>
                    </span>
                    <ChevronRightIcon />
                  </Link>
                ) : (
                  <div className="vilo-activity__item is-static">
                    <span className="vilo-activity__status">
                      <CheckCircleIcon />
                    </span>
                    <span className="vilo-activity__copy">
                      <span className="vilo-activity__title">{item.title}</span>
                      <span className="vilo-activity__time">{item.module} · {item.timestamp}</span>
                    </span>
                  </div>
                )}
              </motion.div>
            ))}
          </div>
        </section>
      </div>
    </motion.aside>
  );
}

function resolveNotificationHref(item) {
  const meta = item?.metadata || {};
  if (meta.conversation_id) return `/dashboard/messages?conversation=${meta.conversation_id}`;
  if (meta.message_id) return "/dashboard/messages";
  if (meta.document_id) return `/dashboard/documents?document_id=${encodeURIComponent(meta.document_id)}`;
  if (meta.invoice_id) return `/dashboard/invoices/${meta.invoice_id}`;
  if (meta.task_id) return `/dashboard/tasks/${meta.task_id}`;
  if (meta.calendar_event_id) return `/dashboard/calendar?event_id=${meta.calendar_event_id}`;
  if (meta.case_id) return `/dashboard/cases/${meta.case_id}`;
  if (meta.client_id) return `/dashboard/clients/${meta.client_id}`;
  if (item?.type?.includes("message")) return "/dashboard/messages";
  return "";
}

function prettyType(value) {
  const text = String(value || "activity").replace(/[_-]+/g, " ").trim();
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : "Activity";
}

function formatShortTimestamp(value) {
  if (!value) return "Just now";
  return formatViloDateTime(value, "Just now");
}

function IconBase({ children, className = "" }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {children}
    </svg>
  );
}

function HomeIcon() {
  return (
    <IconBase>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5.5 9.5V20h13V9.5" />
    </IconBase>
  );
}

function UsersIcon() {
  return (
    <IconBase>
      <path d="M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2" />
      <circle cx="9.5" cy="7" r="3" />
      <path d="M21 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16.5 4.1a3 3 0 0 1 0 5.8" />
    </IconBase>
  );
}

function CalendarIcon() {
  return (
    <IconBase>
      <rect x="3" y="5" width="18" height="16" rx="3" />
      <path d="M16 3v4" />
      <path d="M8 3v4" />
      <path d="M3 10h18" />
      <path d="M8 14h0.01" />
      <path d="M12 14h0.01" />
    </IconBase>
  );
}

function ClipboardListIcon() {
  return (
    <IconBase>
      <rect x="5" y="4" width="14" height="17" rx="3" />
      <path d="M9 4.5h6" />
      <path d="M9 10h6" />
      <path d="M9 14h6" />
      <path d="M9 18h4" />
    </IconBase>
  );
}

function FileStackIcon() {
  return (
    <IconBase>
      <path d="M14 2H8a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v5h5" />
      <path d="M4 8H3a1 1 0 0 0-1 1v10a2 2 0 0 0 2 2h9a1 1 0 0 0 1-1v-1" />
    </IconBase>
  );
}

function ListIcon() {
  return (
    <IconBase>
      <path d="M9 6h11" />
      <path d="M9 12h11" />
      <path d="M9 18h11" />
      <path d="M4 6h0.01" />
      <path d="M4 12h0.01" />
      <path d="M4 18h0.01" />
    </IconBase>
  );
}

function MessageCircleIcon() {
  return (
    <IconBase>
      <path d="M21 11.5a8.5 8.5 0 1 1-4-7.2" />
      <path d="m9 12 2 2 4-4" />
    </IconBase>
  );
}

function DollarSignIcon() {
  return (
    <IconBase>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v10" />
      <path d="M15 9.5c0-1.1-1.3-2-3-2s-3 0.9-3 2 1 1.8 3 2 3 0.9 3 2-1.3 2-3 2-3-0.9-3-2" />
    </IconBase>
  );
}

function TrustIcon() {
  return (
    <IconBase>
      <circle cx="8" cy="15.5" r="4" />
      <circle cx="16.5" cy="8.5" r="4" />
      <path d="M11.2 13.1 13.4 10.9" />
      <path d="M5.8 18.3 4.5 19.5" />
    </IconBase>
  );
}

function NetworkIcon() {
  return (
    <IconBase>
      <circle cx="12" cy="5" r="2.5" />
      <circle cx="5" cy="17" r="2.5" />
      <circle cx="19" cy="17" r="2.5" />
      <path d="M12 7.5v4.5" />
      <path d="M7.2 15.5 10 13" />
      <path d="M16.8 15.5 14 13" />
      <path d="M8 19.5h8" />
    </IconBase>
  );
}

function ClipboardIcon() {
  return (
    <IconBase>
      <rect x="6" y="4" width="12" height="17" rx="3" />
      <path d="M9 4h6v3H9z" />
    </IconBase>
  );
}

function SettingsIcon() {
  return (
    <IconBase>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 0.34 1.87l0.06 0.06a2 2 0 1 1-2.83 2.83l-0.06-0.06a1.7 1.7 0 0 0-1.87-0.34 1.7 1.7 0 0 0-1 1.54V21a2 2 0 1 1-4 0v-0.09a1.7 1.7 0 0 0-1-1.54 1.7 1.7 0 0 0-1.87 0.34l-0.06 0.06a2 2 0 1 1-2.83-2.83l0.06-0.06a1.7 1.7 0 0 0 0.34-1.87 1.7 1.7 0 0 0-1.54-1H3a2 2 0 1 1 0-4h0.09a1.7 1.7 0 0 0 1.54-1 1.7 1.7 0 0 0-0.34-1.87l-0.06-0.06a2 2 0 1 1 2.83-2.83l0.06 0.06a1.7 1.7 0 0 0 1.87 0.34H9a1.7 1.7 0 0 0 1-1.54V3a2 2 0 1 1 4 0v0.09a1.7 1.7 0 0 0 1 1.54 1.7 1.7 0 0 0 1.87-0.34l0.06-0.06a2 2 0 1 1 2.83 2.83l-0.06 0.06a1.7 1.7 0 0 0-0.34 1.87V9c0 0.67 0.39 1.28 1 1.54H21a2 2 0 1 1 0 4h-0.09a1.7 1.7 0 0 0-1.51 0.46Z" />
    </IconBase>
  );
}

function PlusIcon() {
  return (
    <IconBase>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </IconBase>
  );
}

function CheckCircleIcon() {
  return (
    <IconBase>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12 2.2 2.2L15.8 9" />
    </IconBase>
  );
}

function ChevronDownIcon({ className = "" }) {
  return (
    <IconBase className={`vilo-sidebar__chevron ${className}`.trim()}>
      <path d="m6 9 6 6 6-6" />
    </IconBase>
  );
}

function ChevronRightIcon() {
  return (
    <IconBase className="vilo-sidebar__activity-chevron">
      <path d="m9 6 6 6-6 6" />
    </IconBase>
  );
}

function UserPlusIcon() {
  return (
    <IconBase>
      <circle cx="10" cy="8" r="3" />
      <path d="M4 19a6 6 0 0 1 12 0" />
      <path d="M19 8v6" />
      <path d="M16 11h6" />
    </IconBase>
  );
}

function BriefcaseIcon() {
  return (
    <IconBase>
      <rect x="4" y="7" width="16" height="12" rx="3" />
      <path d="M9 7V5.8A1.8 1.8 0 0 1 10.8 4h2.4A1.8 1.8 0 0 1 15 5.8V7" />
      <path d="M4 12h16" />
    </IconBase>
  );
}

function TaskPlusIcon() {
  return (
    <IconBase>
      <rect x="5" y="4" width="14" height="17" rx="3" />
      <path d="M9 4.5h6" />
      <path d="M9 11h4" />
      <path d="M9 15h4" />
      <path d="M16.5 12.5v4" />
      <path d="M14.5 14.5h4" />
    </IconBase>
  );
}

function ClockIcon() {
  return (
    <IconBase>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.8v4.6" />
      <path d="M12 12.4h3.3" />
    </IconBase>
  );
}

function FlagIcon() {
  return (
    <IconBase>
      <path d="M6 20V4" />
      <path d="M6 4h9l-1.8 3L15 10H6" />
    </IconBase>
  );
}
