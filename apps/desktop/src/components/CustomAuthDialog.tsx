import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

export function CustomAuthDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return createPortal(<div className="modal-backdrop custom-auth-backdrop" onMouseDown={event => {
    event.stopPropagation();
    if (event.target === event.currentTarget) onClose();
  }}>
    <section className="custom-auth-dialog" ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} onKeyDown={event => {
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      if (event.key === "Tab") {
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]'));
        const first = controls[0], last = controls[controls.length - 1];
        if (!first) { event.preventDefault(); return; }
        if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === event.currentTarget)) { event.preventDefault(); first.focus(); }
      }
    }}>
      <header><h3>{title}</h3><button type="button" className="modal-close" aria-label={`关闭${title}`} onClick={onClose}><X size={18} /></button></header>
      {children}
    </section>
  </div>, document.body);
}
