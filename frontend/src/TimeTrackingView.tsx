import { useEffect, useState } from "react";
import { VaultService } from "../bindings/cipherleaf/internal/app";
import type { TimeEntry, TimeTrackingCatalog } from "../bindings/cipherleaf/internal/vault/models";
import { errorText } from "./errors";
import { initialTimeTrackingTab, TIME_TRACKING_TABS, type TimeTrackingTab } from "./timeTracking";

const TAB_LABELS: Record<TimeTrackingTab, string> = {
  week: "Week",
  month: "Month",
  dashboard: "Dashboard",
  projects: "Projects",
  tags: "Tags",
};

export default function TimeTrackingView() {
  const [tab, setTab] = useState<TimeTrackingTab>(initialTimeTrackingTab);
  const [catalog, setCatalog] = useState<TimeTrackingCatalog | null>(null);
  const [activeEntry, setActiveEntry] = useState<TimeEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    Promise.all([VaultService.GetTimeTrackingCatalog(), VaultService.GetActiveTimeEntry()])
      .then(([nextCatalog, nextActiveEntry]) => {
        if (!cancelled) {
          setCatalog(nextCatalog);
          setActiveEntry(nextActiveEntry);
        }
      })
      .catch((reason) => {
        if (!cancelled) setError(errorText(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="time-tracking-view">
      <header className="time-tracking-header">
        <div>
          <p className="eyebrow">Local-first activity</p>
          <h2>Time tracking</h2>
        </div>
        {activeEntry && <span className="time-tracking-active">Running: {activeEntry.name}</span>}
      </header>
      <nav className="time-tracking-tabs" aria-label="Time tracking views" role="tablist">
        {TIME_TRACKING_TABS.map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={tab === item}
            className={tab === item ? "active" : ""}
            onClick={() => setTab(item)}
          >
            {TAB_LABELS[item]}
          </button>
        ))}
      </nav>
      <div className="time-tracking-panel" role="tabpanel">
        {loading ? (
          <div className="settings-loading" role="status">Loading time tracking...</div>
        ) : error ? (
          <div className="time-tracking-error" role="alert">{error}</div>
        ) : (
          <div className="time-tracking-empty">
            <h3>{TAB_LABELS[tab]}</h3>
            <p>
              {tab === "projects"
                ? `${catalog?.projects?.length ?? 0} projects`
                : tab === "tags"
                  ? `${catalog?.tags?.length ?? 0} tags`
                  : activeEntry
                    ? `${activeEntry.name} is currently running.`
                    : `No time tracked for this ${tab === "week" ? "week" : "view"}.`}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
