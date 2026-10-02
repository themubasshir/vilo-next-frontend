"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// Portal is necessary because the document table must retain horizontal scrolling.
export default function DocumentActionsMenu({ open, onToggle, onClose, label, children }) {
  const trigger = useRef(null);
  const menu = useRef(null);
  const [position, setPosition] = useState(null);

  useLayoutEffect(() => {
    if (!open) { setPosition(null); return undefined; }
    const place = () => {
      if (!trigger.current || !menu.current) return;
      const rect = trigger.current.getBoundingClientRect();
      const width = menu.current.offsetWidth;
      const height = menu.current.offsetHeight;
      const below = window.innerHeight - rect.bottom - 8;
      const upward = below < height && rect.top > below;
      setPosition({
        left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
        top: Math.max(8, upward ? rect.top - height - 6 : rect.bottom + 6),
        maxHeight: Math.max(40, upward ? rect.top - 14 : below - 6),
      });
    };
    const outside = (event) => {
      if (!trigger.current?.contains(event.target) && !menu.current?.contains(event.target)) onClose();
    };
    const escape = (event) => {
      if (event.key === "Escape") { onClose(); trigger.current?.focus(); }
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(menu.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open, onClose]);

  return <>
    <button ref={trigger} type="button" className="vilo-btn vilo-btn--ghost vilo-btn--xs documents-actions__trigger" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={onToggle}>Actions</button>
    {open ? createPortal(
      <div ref={menu} className="case-actions-menu documents-actions-menu documents-actions-menu--portal" role="menu" aria-label={label} style={{ ...position, visibility: position ? "visible" : "hidden" }} onClick={onClose}>
        {children}
      </div>, document.body
    ) : null}
  </>;
}
