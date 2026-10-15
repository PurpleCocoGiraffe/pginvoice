import React, { useRef } from "react";

// Accessible tab strip: roving tabindex, Left/Right (and Home/End) move between tabs and
// select them. Each tab controls the panel rendered with tabPanelProps(idBase, key).
export function TabBar({ tabs, active, onChange, idBase, label }) {
  const refs = useRef({});
  const onKeyDown = (e) => {
    const i = tabs.findIndex((t) => t.key === active);
    let n = null;
    if (e.key === "ArrowRight") n = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") n = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") n = 0;
    else if (e.key === "End") n = tabs.length - 1;
    if (n == null) return;
    e.preventDefault();
    onChange(tabs[n].key);
    refs.current[tabs[n].key]?.focus();
  };
  return (
    <div className="pg-tabs" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {tabs.map((t) => {
        const selected = t.key === active;
        const Icon = t.icon;
        return (
          <button key={t.key} ref={(el) => { refs.current[t.key] = el; }} type="button" role="tab"
            id={`${idBase}-tab-${t.key}`} aria-selected={selected} aria-controls={`${idBase}-panel-${t.key}`} tabIndex={selected ? 0 : -1}
            className={"pg-tab" + (selected ? " pg-tab--active" : "")} onClick={() => onChange(t.key)}>
            {Icon && <Icon size={13} aria-hidden="true" />} {t.label}
          </button>
        );
      })}
    </div>
  );
}
export const tabPanelProps = (idBase, key) => ({ role: "tabpanel", id: `${idBase}-panel-${key}`, "aria-labelledby": `${idBase}-tab-${key}`, tabIndex: 0 });
