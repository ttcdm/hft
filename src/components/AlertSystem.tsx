import React, { useState } from 'react';
import { AlertCircle, AlertTriangle, ShieldCheck, X } from 'lucide-react';
import { AlertEvent } from '../types';
import { orderAlerts } from '../utils/operatorAlerts';

/**
 * UI-2: alerts used to pile up three deep in the bottom-right corner and stay until dismissed, covering the Plug & Play footer
 * (ARM LIVE TRADING, PAPER SNIPE). INFO and WARNING now expire on their own; CRITICAL stays until the operator dismisses it.
 * The stack shows one alert, with "Show all" for the rest. R6-19: the one shown is the most severe (CRITICAL, then WARNING, then INFO),
 * newest first within a level, so a later INFO cannot hide a CRITICAL. R6-1: the server's operator alerts are in the same stack; a
 * sticky one (a server CRITICAL) has no dismiss button and leaves only when the server clears it.
 * R9-3: the stack was fixed over the bottom-right corner, on top of KILL AUTO, and a sticky CRITICAL cannot be dismissed, so it could
 * hold the auto emergency control under it for good. It is now docked in the page flow (sticky to the bottom of the screen, on the left,
 * with its own space at the end of the page, so scrolling always uncovers what is under it), and it can be minimized to its one-line
 * bar whatever it holds. A server CRITICAL that reports a past event (POSITION_GONE, SELL_ADOPTED, ...) used to stay until a restart;
 * it has an Acknowledge button that clears it on the server. R12-13: CRITICAL alerts are also in an assertive live region.
 */
export const ALERT_TTL_MS: Record<AlertEvent['level'], number | null> = { INFO: 8_000, WARNING: 20_000, CRITICAL: null };

export function isAlertExpired(alert: Pick<AlertEvent, 'level' | 'timestamp'>, now: number): boolean {
  const ttl = ALERT_TTL_MS[alert.level];
  return ttl !== null && now - alert.timestamp >= ttl;
}

export const COLLAPSED_ALERTS = 1;
/** R9-3: below this width (Tailwind's `sm`) the dock starts minimized. */
export const PHONE_MAX_WIDTH = 639;
function isPhoneWidth(): boolean {
  try { return typeof window !== 'undefined' && typeof window.innerWidth === 'number' && window.innerWidth > 0 && window.innerWidth <= PHONE_MAX_WIDTH; } catch { return false; }
}
/** R10-9: "Show all" shows all of them (it was capped at 3 while the counter said "+8"); the list scrolls inside the dock. */
export const EXPANDED_ALERTS = Infinity;

interface AlertSystemProps {
  alerts: AlertEvent[];
  onDismissAlert: (id: string) => void;
  onClearAll: () => void;
  /** A server alert with `serverAck` (one only the operator clears) gets an Acknowledge button that calls this. */
  onAcknowledgeAlert?: (alert: AlertEvent) => void;
}

export const AlertSystem: React.FC<AlertSystemProps> = ({
  alerts,
  onDismissAlert,
  onClearAll,
  onAcknowledgeAlert,
}) => {
  const [expanded, setExpanded] = useState(false);
  // R9-3 at phone width: one CRITICAL card plus the bar took a large band of a 390 px screen and covered KILL AUTO while it scrolled
  // through it. Below PHONE_MAX_WIDTH the dock opens as its bar, which names the most severe alert; "Show" opens the cards.
  const [minimized, setMinimized] = useState(() => isPhoneWidth());
  // R12-13: CRITICAL alerts are announced to assistive tech. The live region is on the page before any alert arrives (a region added
  // together with its text is often not read) and stays when the dock is minimized; it changes only when the set of CRITICALs does.
  const liveRegion = (
    <div role="alert" aria-live="assertive" aria-atomic="true" className="sr-only" data-testid="alerts-live-critical">
      {orderAlerts(alerts.filter((a) => a.level === 'CRITICAL')).map((a) => `${a.title}: ${a.message}`).join(' ')}
    </div>
  );
  if (alerts.length === 0) return liveRegion;
  const ordered = orderAlerts(alerts);
  const shown = minimized ? [] : expanded ? ordered : ordered.slice(0, COLLAPSED_ALERTS);
  const hidden = alerts.length - shown.length;
  const critical = alerts.filter((a) => a.level === 'CRITICAL').length;

  return (
    <>
    {liveRegion}
    <div
      id="alerts-notification-panel"
      data-testid="alerts-dock"
      className="sticky bottom-0 z-50 self-start max-w-sm w-full p-4 pt-0 space-y-2 pointer-events-none"
    >
      <div className="pointer-events-auto bg-[#0D131F] border border-[#1E293B] px-3 py-1.5 rounded-lg shadow-xl text-[11px] font-mono">
      <div className="flex items-center justify-between">
        <span className="text-amber-400 font-bold flex items-center space-x-1">
          <AlertTriangle className="w-3.5 h-3.5 mr-1" />
          <span>Active Risk Alerts ({alerts.length}{critical ? `, ${critical} critical` : ''})</span>
        </span>
        <span className="flex items-center space-x-3">
          <button
            onClick={() => setMinimized(!minimized)}
            className="text-slate-400 hover:text-white text-[10px]"
            data-testid="alerts-minimize"
          >
            {minimized ? 'Show' : 'Minimize'}
          </button>
          {!minimized && alerts.length > COLLAPSED_ALERTS && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="text-slate-400 hover:text-white text-[10px]"
              data-testid="alerts-toggle"
            >
              {expanded ? 'Show less' : `Show all (+${hidden})`}
            </button>
          )}
          <button
            onClick={onClearAll}
            className="text-slate-400 hover:text-white text-[10px]"
          >
            Clear All
          </button>
        </span>
      </div>
      {minimized && (
        <div data-testid="alerts-top-title" className={`truncate font-bold ${ordered[0].level === 'CRITICAL' ? 'text-red-300' : ordered[0].level === 'WARNING' ? 'text-amber-300' : 'text-cyan-300'}`}>
          {ordered[0].title}
        </div>
      )}
      </div>

      <div data-testid="alerts-list" className="space-y-2 max-h-[40vh] sm:max-h-[60vh] overflow-y-auto pointer-events-auto">
      {shown.map((alert) => (
        <div
          key={alert.id}
          className={`pointer-events-auto p-3 rounded-lg border shadow-xl flex items-start justify-between backdrop-blur-md transition-all duration-300 font-mono text-xs ${
            alert.level === 'CRITICAL'
              ? 'bg-red-950/90 border-red-500/60 text-red-200'
              : alert.level === 'WARNING'
              ? 'bg-amber-950/90 border-amber-500/60 text-amber-200'
              : 'bg-[#141B2D]/90 border-cyan-500/60 text-cyan-200'
          }`}
        >
          <div className="flex items-start space-x-2">
            {alert.level === 'CRITICAL' ? (
              <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
            ) : alert.level === 'WARNING' ? (
              <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
            ) : (
              <ShieldCheck className="w-4 h-4 text-cyan-400 flex-shrink-0 mt-0.5" />
            )}

            <div>
              <div className="font-bold text-[11px] uppercase tracking-wider flex items-center space-x-2">
                <span>{alert.title}</span>
                <span className="text-[9px] opacity-70">[{alert.timeStr}]</span>
                {alert.source === 'server' && <span className="text-[9px] opacity-70">server</span>}
              </div>
              <p className="text-[11px] opacity-90 mt-0.5 leading-tight">
                {alert.message}
              </p>
            </div>
          </div>

          <div className="flex items-start ml-2 space-x-1">
            {alert.serverAck && onAcknowledgeAlert && (
              <button
                onClick={() => onAcknowledgeAlert(alert)}
                className="text-[9px] border border-current/60 rounded px-1.5 py-0.5 whitespace-nowrap opacity-90 hover:opacity-100"
                data-testid="alert-acknowledge"
                title="It reports something that already happened; acknowledging clears it on the server"
              >
                Acknowledge
              </button>
            )}
            {alert.sticky ? (
              !(alert.serverAck && onAcknowledgeAlert) && (
                <span className="text-[9px] text-red-300/80 whitespace-nowrap" data-testid="alert-sticky" title="Held by the server: it leaves when the server clears it">
                  until cleared
                </span>
              )
            ) : (
              <button
                onClick={() => onDismissAlert(alert.id)}
                className="text-slate-400 hover:text-white p-0.5"
                aria-label="Dismiss alert"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      ))}
      </div>
    </div>
    </>
  );
};
