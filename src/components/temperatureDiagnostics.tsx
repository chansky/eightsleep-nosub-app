"use client";

import { useEffect, useState } from "react";
import { apiR } from "~/trpc/react";
import { type DiagnosticProfile, type TemperatureDiagnostic } from "~/lib/temperature-diagnostics";
import { getTemperatureSchedule } from "~/lib/temperature-schedule";
import { Button } from "./ui/button";

function formatTime(value: string, timezone: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  try {
    return `${new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "long",
      timeZone: timezone,
    }).format(date)} (${timezone})`;
  } catch {
    return date.toISOString();
  }
}

function getStatus(run: TemperatureDiagnostic, now: number) {
  if (run.outcome === "error") {
    return { label: "Check failed", style: "bg-red-100 text-red-800" };
  }
  if (run.outcome === "ok") {
    return { label: "Check finished", style: "bg-emerald-100 text-emerald-800" };
  }
  if (now - new Date(run.startedAt).getTime() > 2 * 60 * 1000) {
    return { label: "Incomplete", style: "bg-amber-100 text-amber-900" };
  }
  return { label: "In progress", style: "bg-blue-100 text-blue-800" };
}

function sourceLabel(source: TemperatureDiagnostic["source"]) {
  return source === "cron" ? "Scheduled check"
    : source === "profile-save" ? "Profile save" : "Test";
}

function level(value: number) {
  const display = value / 10;
  return display > 0 ? `+${display}` : String(display);
}

function finalStageLabel(profile: DiagnosticProfile) {
  try {
    const time = getTemperatureSchedule(profile).finalStageTime;
    return `${time} (${profile.finalStageStartTime == null ? "automatic: two hours before wake-up" : "custom start"})`;
  } catch {
    return "Unavailable: recorded schedule is invalid";
  }
}

function runSummary(run: TemperatureDiagnostic) {
  const latestEvents = [...run.events].reverse();
  for (const event of latestEvents) {
    const error = event.details.error;
    const nestedStatus = error && typeof error === "object" && "status" in error ? error.status : undefined;
    const status = event.details.status ?? nestedStatus;
    if (typeof status === "number" && status >= 400) {
      if (run.outcome === "ok") return `A request returned HTTP ${status}; the check later finished. Open details to inspect retries and the final decision.`;
      if (status === 401) return "Eight Sleep rejected authentication (HTTP 401). Sign out and sign back in with this account to renew its credentials, then review the next scheduled check.";
      return `Eight Sleep returned HTTP ${status}. Open details to see which request failed.`;
    }
  }
  if (run.outcome === "error") return "This check failed. Open details to see the last operation and error type.";
  const readback = latestEvents.find((event) => event.event === "heating-status-readback");
  if (readback?.details.reportedTargetMatchesCommand === false) {
    return "The API accepted a command, but its immediate reported target did not match. Open details to compare the requested and reported levels.";
  }
  const skipped = latestEvents.find((event) => event.event === "temperature-change-skipped");
  if (skipped?.details.reason === "missed-final-window") return "The final-stage change was skipped because this check missed the 15-minute transition window.";
  if (skipped) return "No temperature command was sent: this check was outside the transition windows.";
  const accepted = latestEvents.find((event) => event.event === "set-level-accepted");
  if (accepted && typeof accepted.details.targetLevel === "number") return `Eight Sleep accepted level ${level(accepted.details.targetLevel)} (API ${accepted.details.targetLevel}). This confirms the API response, not the physical bed temperature.`;
  if (latestEvents.some((event) => event.event === "turn-off-accepted")) return "Eight Sleep accepted the command to turn this side off.";
  const matched = latestEvents.find((event) => event.event === "set-level-skipped");
  if (matched?.details.reason === "level-already-matches") return "The scheduler skipped a level change because the reported current level already matched. Open details to compare it with the reported target.";
  return "Open details to see the last recorded operation and temperature decision.";
}

function RunDetails({ run, now }: { run: TemperatureDiagnostic; now: number }) {
  const status = getStatus(run, now);
  return (
    <details className="rounded-lg border border-slate-200 bg-white">
      <summary className="cursor-pointer p-4 text-sm marker:text-slate-400">
        <span className="font-semibold">{sourceLabel(run.source)}</span>
        <span className={`ml-2 inline-block rounded-full px-2 py-1 text-xs font-medium ${status.style}`}>
          {status.label}
        </span>
        <span className="mt-1 block text-xs leading-relaxed text-slate-600">
          {formatTime(run.startedAt, run.profile.timezone)}
        </span>
        <span className="mt-2 block text-sm leading-relaxed text-slate-700">{runSummary(run)}</span>
      </summary>
      <div className="space-y-4 border-t border-slate-100 p-4 text-xs">
        {status.label === "Incomplete" && (
          <p className="rounded-md bg-amber-50 p-3 text-amber-900">
            This check started more than two minutes ago without a recorded finish.
            It may have timed out or failed to save its final result. Check the last event and deployment logs.
          </p>
        )}
        <dl className="space-y-1 text-slate-600">
          <div><dt className="inline font-semibold">Run: </dt><dd className="inline break-all">{run.id}</dd></div>
          <div><dt className="inline font-semibold">Finished: </dt><dd className="inline">{run.finishedAt ? formatTime(run.finishedAt, run.profile.timezone) : "No finish recorded"}</dd></div>
          <div><dt className="inline font-semibold">Profile saved: </dt><dd className="inline">{formatTime(run.profile.updatedAt, run.profile.timezone)}</dd></div>
          <div><dt className="inline font-semibold">Final stage: </dt><dd className="inline">{finalStageLabel(run.profile)}</dd></div>
        </dl>
        <details>
          <summary className="cursor-pointer font-semibold">Profile used for this check</summary>
          <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-slate-50 p-3 text-slate-700">{JSON.stringify(run.profile, null, 2)}</pre>
        </details>
        {run.events.length === 0 ? (
          <p className="text-slate-600">No events were recorded for this check.</p>
        ) : (
          <ol className="space-y-3">
            {run.events.map((event, index) => (
              <li key={`${event.at}-${index}`} className="border-l-2 border-indigo-200 pl-3">
                <p className="break-words font-semibold text-slate-800">{event.event}</p>
                <p className="mt-1 text-slate-500">{formatTime(event.at, run.profile.timezone)}</p>
                <pre className="mt-2 max-h-80 overflow-auto rounded-md bg-slate-50 p-3 text-slate-700">{JSON.stringify(event.details, null, 2)}</pre>
              </li>
            ))}
          </ol>
        )}
      </div>
    </details>
  );
}

export function TemperatureDiagnostics() {
  const [now, setNow] = useState(() => Date.now());
  const [visibleCount, setVisibleCount] = useState(24);
  const history = apiR.user.getTemperatureDiagnostics.useQuery(undefined, {
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const runs = history.data?.runs ?? [];
  const latest = runs[0];
  const latestCron = runs.find((run) => run.source === "cron");
  const recentCronMissing = latestCron
    ? now - new Date(latestCron.startedAt).getTime() > 75 * 60 * 1000
    : true;
  const latestStatus = latest ? getStatus(latest, now) : null;

  return (
    <section aria-labelledby="temperature-history-title" className="mx-auto mt-6 w-full min-w-0 max-w-md rounded-lg bg-white p-6 text-slate-800 shadow-xl">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="temperature-history-title" className="text-xl font-bold">Temperature history</h2>
          <p className="mt-1 text-sm text-slate-600">See what each temperature check did.</p>
        </div>
        <Button type="button" variant="outline" size="sm" disabled={history.isFetching} onClick={() => void history.refetch()}>
          {history.isFetching ? "Loading…" : "Refresh"}
        </Button>
      </div>

      {history.data && (
        <div className="mt-4 rounded-md bg-indigo-50 p-3 text-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-indigo-700">Signed in as</p>
          <p className="mt-1 break-all font-semibold text-indigo-950">{history.data.email}</p>
          <p className="mt-1 text-xs text-indigo-800">This history belongs to this account. Each bed partner has a separate schedule.</p>
        </div>
      )}

      {history.isError ? (
        <div role="alert" className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-800">
          <p className="font-semibold">Temperature history is unavailable</p>
          <p className="mt-1">{history.error.message}</p>
          {history.data && <p className="mt-1">The history below is from the last successful load and may be out of date.</p>}
        </div>
      ) : history.isPending ? (
        <p className="mt-4 text-sm text-slate-600" role="status">Loading temperature history…</p>
      ) : runs.length === 0 ? (
        <p className="mt-4 rounded-md bg-slate-50 p-3 text-sm text-slate-600">
          No checks have been recorded for this account in the last seven days.
          New history appears after the next scheduled check or profile save.
          If none appears, check the scheduler and deployment logs.
        </p>
      ) : null}

      {latest && latestStatus && (
        <div className="mt-5 space-y-4">
          <div>
            <span className={`inline-block rounded-full px-3 py-1 text-xs font-semibold ${latestStatus.style}`}>{latestStatus.label}</span>
            <p className="mt-2 text-sm font-medium">Latest: {sourceLabel(latest.source)}</p>
            <p className="mt-1 text-xs leading-relaxed text-slate-600">{formatTime(latest.startedAt, latest.profile.timezone)}</p>
            <p className="mt-2 text-sm leading-relaxed text-slate-700">{runSummary(latest)}</p>
          </div>

          <div className="rounded-md bg-slate-50 p-3 text-sm">
            <p className="font-semibold">Profile used by latest check</p>
            <p className="mt-1">Bed {latest.profile.bedTime.slice(0, 5)} · Wake {latest.profile.wakeupTime.slice(0, 5)}</p>
            <p className="mt-1">Final stage {finalStageLabel(latest.profile)}</p>
            <p className="text-xs text-slate-600">{latest.profile.timezone}</p>
            <dl className="mt-3 grid grid-cols-3 gap-2">
              {([
                ["Initial", latest.profile.initialSleepLevel],
                ["Mid-stage", latest.profile.midStageSleepLevel],
                ["Final", latest.profile.finalSleepLevel],
              ] as const).map(([label, value]) => (
                <div key={label}>
                  <dt className="text-xs text-slate-500">{label}</dt>
                  <dd className="text-lg font-semibold">{level(value)}</dd>
                  <dd className="text-xs text-slate-500">API: {value}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-2 text-xs text-slate-500">App levels are the raw API levels divided by 10.</p>
          </div>

          {recentCronMissing && !history.isError && (
            <p className="rounded-md bg-amber-50 p-3 text-xs text-amber-900">
              No scheduled check is recorded in the past 75 minutes. Check the scheduler, deployment and logging.
              This alone does not establish whether the bed changed temperature.
            </p>
          )}

          <div className="space-y-2">
            {runs.slice(0, visibleCount).map((run) => <RunDetails key={run.id} run={run} now={now} />)}
          </div>
          {runs.length > visibleCount && (
            <Button type="button" variant="outline" className="w-full" onClick={() => setVisibleCount((count) => count + 24)}>
              Show older checks ({runs.length - visibleCount} more)
            </Button>
          )}
        </div>
      )}
      <p className="mt-5 text-xs leading-relaxed text-slate-500">
        History is limited to the latest 100 checks from the past seven days, newest first.
        Records expire after seven days.
        Refresh only reads history; it does not change the bed.
      </p>
    </section>
  );
}
