import React from 'react';
import { AlertCircle, AlertTriangle, ShieldCheck, X } from 'lucide-react';
import { AlertEvent } from '../types';

interface AlertSystemProps {
  alerts: AlertEvent[];
  onDismissAlert: (id: string) => void;
  onClearAll: () => void;
}

export const AlertSystem: React.FC<AlertSystemProps> = ({
  alerts,
  onDismissAlert,
  onClearAll,
}) => {
  if (alerts.length === 0) return null;

  return (
    <div
      id="alerts-notification-panel"
      className="fixed bottom-4 right-4 z-50 max-w-sm w-full space-y-2 pointer-events-none"
    >
      <div className="flex items-center justify-between pointer-events-auto bg-[#0D131F] border border-[#1E293B] px-3 py-1.5 rounded-lg shadow-xl text-[11px] font-mono">
        <span className="text-amber-400 font-bold flex items-center space-x-1">
          <AlertTriangle className="w-3.5 h-3.5 mr-1" />
          <span>Active Risk Alerts ({alerts.length})</span>
        </span>
        <button
          onClick={onClearAll}
          className="text-slate-400 hover:text-white text-[10px]"
        >
          Clear All
        </button>
      </div>

      {alerts.slice(0, 3).map((alert) => (
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
              </div>
              <p className="text-[11px] opacity-90 mt-0.5 leading-tight">
                {alert.message}
              </p>
            </div>
          </div>

          <button
            onClick={() => onDismissAlert(alert.id)}
            className="text-slate-400 hover:text-white p-0.5 ml-2"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
};
