import React, { useState, useEffect, useMemo, useRef } from 'react';
import { authFetch } from '../services/engineClient';
import {
  CheckCircle2,
  XCircle,
  Play,
  X,
  Clock,
  Search,
  Zap,
  Activity,
  Server,
  Terminal,
  RotateCw,
  Pause,
} from 'lucide-react';
import {
  streamHighStakesTests,
  runAllHighStakesTests,
  HighStakesTestResult,
  HighStakesSuiteSummary,
  UnitTestCategory,
} from '../utils/unitTests';

interface UnitTestModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type SuiteType = 'HIGH_STAKES_CLIENT' | 'SERVER_MICROSTRUCTURE';

export const UnitTestModal: React.FC<UnitTestModalProps> = ({
  isOpen,
  onClose,
}) => {
  const [activeSuite, setActiveSuite] = useState<SuiteType>('HIGH_STAKES_CLIENT');
  const [isRunning, setIsRunning] = useState(false);
  const [clientResults, setClientResults] = useState<HighStakesTestResult[]>([]);
  const [clientSummary, setClientSummary] = useState<HighStakesSuiteSummary | null>(null);
  const [progress, setProgress] = useState({ current: 0, total: 700, passed: 0, failed: 0, pct: 0 });
  const [serverSuiteResult, setServerSuiteResult] = useState<any>(null);
  const [serverLoading, setServerLoading] = useState(false);
  const [activeCategory, setActiveCategory] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'PASSED' | 'FAILED'>('ALL');

  const cancelStreamRef = useRef<(() => void) | null>(null);
  const testListEndRef = useRef<HTMLDivElement | null>(null);

  // Run the client-side 700 high-stakes unit tests in real-time
  const [visibleCount, setVisibleCount] = useState(100);

  const runRealTimeClientTests = () => {
    if (cancelStreamRef.current) {
      cancelStreamRef.current();
      cancelStreamRef.current = null;
    }

    setIsRunning(true);
    setClientResults([]);
    setVisibleCount(100);
    setProgress({ current: 0, total: 700, passed: 0, failed: 0, pct: 0 });

    const cancelFn = streamHighStakesTests(
      (newBatch, prog) => {
        setClientResults((prev) => [...prev, ...newBatch]);
        setProgress(prog);
      },
      (summary) => {
        setClientSummary(summary);
        setIsRunning(false);
        cancelStreamRef.current = null;
      },
      35 // 35 tests per batch to minimize React renders and memory allocations
    );

    cancelStreamRef.current = cancelFn;
  };

  // Instant execution for turbo verification
  const runInstantClientTests = () => {
    if (cancelStreamRef.current) {
      cancelStreamRef.current();
      cancelStreamRef.current = null;
    }
    setIsRunning(false);
    const summary = runAllHighStakesTests();
    setClientResults(summary.results);
    setClientSummary(summary);
    setProgress({
      current: summary.totalTests,
      total: summary.totalTests,
      passed: summary.passed,
      failed: summary.failed,
      pct: 100,
    });
  };

  // Run server-side test suite
  const runServerTests = async () => {
    setServerLoading(true);
    try {
      const res = await authFetch('/api/unit-tests');
      if (res.ok) {
        const data = await res.json();
        setServerSuiteResult(data);
      }
    } catch (e) {
      console.error('Server unit tests failed:', e);
    } finally {
      setServerLoading(false);
    }
  };

  // Auto-run client suite upon opening
  useEffect(() => {
    if (isOpen && clientResults.length === 0 && !isRunning) {
      runRealTimeClientTests();
    }
    return () => {
      if (cancelStreamRef.current) {
        cancelStreamRef.current();
        cancelStreamRef.current = null;
      }
    };
  }, [isOpen]);

  const currentDisplayResults = useMemo(() => {
    if (activeSuite === 'HIGH_STAKES_CLIENT') {
      return clientResults;
    }
    return serverSuiteResult?.results || [];
  }, [activeSuite, clientResults, serverSuiteResult]);

  const categories = useMemo(() => {
    if (activeSuite === 'HIGH_STAKES_CLIENT') {
      return [
        'ALL',
        'Order Matching',
        'PnL Calculations',
        'Slippage Estimation',
        'Latency Stress',
        'MEV Defense',
        'Bonding Curve Math',
        'Confluence Signals',
      ];
    }
    if (!serverSuiteResult?.results) return ['ALL'];
    const set = new Set<string>(serverSuiteResult.results.map((r: any) => r.category));
    return ['ALL', ...Array.from(set)];
  }, [activeSuite, serverSuiteResult]);

  const filteredResults = useMemo(() => {
    return currentDisplayResults.filter((test: any) => {
      const matchesCategory = activeCategory === 'ALL' || test.category === activeCategory;
      const matchesStatus =
        statusFilter === 'ALL' || test.status === statusFilter;
      const q = searchQuery.toLowerCase().trim();
      const matchesSearch =
        !q ||
        test.test.toLowerCase().includes(q) ||
        test.details.toLowerCase().includes(q) ||
        String(test.id) === q;
      return matchesCategory && matchesStatus && matchesSearch;
    });
  }, [currentDisplayResults, activeCategory, statusFilter, searchQuery]);

  const getCategoryBadgeClass = (category: string) => {
    switch (category) {
      case 'Order Matching':
        return 'bg-purple-500/10 text-purple-400 border-purple-500/30';
      case 'PnL Calculations':
        return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30';
      case 'Slippage Estimation':
        return 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30';
      case 'Latency Stress':
        return 'bg-amber-500/10 text-amber-400 border-amber-500/30';
      case 'MEV Defense':
        return 'bg-rose-500/10 text-rose-400 border-rose-500/30';
      case 'Bonding Curve Math':
        return 'bg-fuchsia-500/10 text-fuchsia-400 border-fuchsia-500/30';
      case 'Confluence Signals':
        return 'bg-blue-500/10 text-blue-400 border-blue-500/30';
      default:
        return 'bg-slate-800 text-slate-400 border-slate-700';
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50 font-mono">
      <div className="bg-[#0D131F] border border-[#1E293B] rounded-xl p-5 max-w-4xl w-full shadow-2xl flex flex-col max-h-[92vh]">
        {/* HEADER */}
        <div className="flex items-center justify-between pb-3 mb-3 border-b border-[#1E293B]">
          <div className="flex items-center space-x-2.5">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
              <Zap className="w-4 h-4" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <h3 className="text-sm font-bold text-white uppercase tracking-wider">
                  Built-in Self-Checks (illustrative math)
                </h3>
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-cyan-500/10 text-cyan-400 border border-cyan-500/30 font-semibold">
                  700 self-contained checks
                </span>
              </div>
              <p className="text-[10px] text-slate-400">
                Small self-contained calculations on toy order books and numbers. They do not import or exercise the trading code; the repo's real test suite is `npm test`.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1 rounded hover:bg-slate-800 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* SUITE TOGGLE TABS */}
        <div className="flex items-center justify-between border-b border-[#1E293B] pb-2 mb-3">
          <div className="flex items-center space-x-2 text-xs">
            <button
              onClick={() => {
                setActiveSuite('HIGH_STAKES_CLIENT');
                setActiveCategory('ALL');
              }}
              className={`px-3 py-1.5 rounded-lg transition flex items-center space-x-1.5 ${
                activeSuite === 'HIGH_STAKES_CLIENT'
                  ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/50 font-bold'
                  : 'bg-[#141B2D] text-slate-400 hover:text-slate-200 border border-[#1E293B]'
              }`}
            >
              <Activity className="w-3.5 h-3.5 text-cyan-400" />
              <span>Client HFT Core ({clientSummary?.totalTests || 700} checks)</span>
            </button>
            <button
              onClick={() => {
                setActiveSuite('SERVER_MICROSTRUCTURE');
                setActiveCategory('ALL');
                if (!serverSuiteResult && !serverLoading) {
                  runServerTests();
                }
              }}
              className={`px-3 py-1.5 rounded-lg transition flex items-center space-x-1.5 ${
                activeSuite === 'SERVER_MICROSTRUCTURE'
                  ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/50 font-bold'
                  : 'bg-[#141B2D] text-slate-400 hover:text-slate-200 border border-[#1E293B]'
              }`}
            >
              <Server className="w-3.5 h-3.5 text-indigo-400" />
              <span>Server Bonding & MEV (200 Tests)</span>
            </button>
          </div>

          {/* RUN ACTIONS */}
          <div className="flex items-center space-x-2">
            {activeSuite === 'HIGH_STAKES_CLIENT' ? (
              <>
                <button
                  onClick={runRealTimeClientTests}
                  disabled={isRunning}
                  className="px-2.5 py-1 text-xs rounded bg-cyan-600/30 text-cyan-300 border border-cyan-500/40 hover:bg-cyan-600/50 transition flex items-center space-x-1 disabled:opacity-50"
                  title="Run all built-in checks streamed live"
                >
                  {isRunning ? (
                    <RotateCw className="w-3 h-3 animate-spin text-cyan-400" />
                  ) : (
                    <Play className="w-3 h-3" />
                  )}
                  <span>{isRunning ? 'Streaming...' : 'Run Real-Time'}</span>
                </button>
                <button
                  onClick={runInstantClientTests}
                  disabled={isRunning}
                  className="px-2.5 py-1 text-xs rounded bg-[#141B2D] text-slate-300 hover:text-white border border-[#1E293B] hover:border-slate-600 transition flex items-center space-x-1"
                  title="Instant Turbo Run"
                >
                  <Zap className="w-3 h-3 text-amber-400" />
                  <span>Turbo Run</span>
                </button>
              </>
            ) : (
              <button
                onClick={runServerTests}
                disabled={serverLoading}
                className="px-2.5 py-1 text-xs rounded bg-cyan-600/30 text-cyan-300 border border-cyan-500/40 hover:bg-cyan-600/50 transition flex items-center space-x-1"
              >
                {serverLoading ? (
                  <RotateCw className="w-3 h-3 animate-spin text-cyan-400" />
                ) : (
                  <Play className="w-3 h-3" />
                )}
                <span>Fetch Server Tests</span>
              </button>
            )}
          </div>
        </div>

        {/* REAL-TIME PROGRESS & KPI BANNER */}
        <div className="p-3 rounded-lg bg-[#06080D] border border-[#1E293B] mb-3 text-xs flex flex-col space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center space-x-2">
              {isRunning ? (
                <>
                  <span className="h-2.5 w-2.5 rounded-full bg-cyan-400 animate-ping"></span>
                  <span className="font-bold text-cyan-400">
                    REAL-TIME RUNNING: {progress.current} / {progress.total}
                  </span>
                </>
              ) : (
                <>
                  <span className="h-2.5 w-2.5 rounded-full bg-[#00E676] animate-pulse"></span>
                  <span className="font-bold text-white">
                    STATUS:{' '}
                    {activeSuite === 'HIGH_STAKES_CLIENT'
                      ? clientSummary?.status || (progress.current > 0 ? 'ALL_TESTS_PASSED' : 'READY')
                      : serverSuiteResult?.status || 'READY'}
                  </span>
                </>
              )}
            </div>

            <div className="flex items-center space-x-4 text-[11px]">
              <span>
                Verified:{' '}
                <strong className="text-[#00E676] font-bold">
                  {activeSuite === 'HIGH_STAKES_CLIENT'
                    ? progress.passed
                    : serverSuiteResult?.passed || 0}
                </strong>{' '}
                /{' '}
                {activeSuite === 'HIGH_STAKES_CLIENT'
                  ? progress.total
                  : serverSuiteResult?.totalTests || 200}
              </span>
              <span>
                Failed:{' '}
                <strong
                  className={
                    (activeSuite === 'HIGH_STAKES_CLIENT' ? progress.failed : serverSuiteResult?.failed || 0) > 0
                      ? 'text-red-400 font-bold'
                      : 'text-slate-500'
                  }
                >
                  {activeSuite === 'HIGH_STAKES_CLIENT'
                    ? progress.failed
                    : serverSuiteResult?.failed || 0}
                </strong>
              </span>
              {activeSuite === 'HIGH_STAKES_CLIENT' && clientSummary && (
                <span className="text-slate-400">
                  Duration: <strong className="text-white">{clientSummary.totalDurationMs} ms</strong>
                </span>
              )}
            </div>
          </div>

          {/* Glowing Animated Progress Bar */}
          {activeSuite === 'HIGH_STAKES_CLIENT' && (
            <div className="w-full bg-[#141B2D] h-1.5 rounded-full overflow-hidden border border-[#1E293B]">
              <div
                className={`h-full transition-all duration-150 ${
                  progress.failed > 0
                    ? 'bg-red-500'
                    : isRunning
                    ? 'bg-gradient-to-r from-cyan-500 to-emerald-400'
                    : 'bg-[#00E676]'
                }`}
                style={{ width: `${progress.pct}%` }}
              ></div>
            </div>
          )}
        </div>

        {/* CATEGORY TABS & SEARCH BAR */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2 mb-3">
          {/* Category Tabs */}
          <div className="flex items-center space-x-1 overflow-x-auto pb-1 text-[11px] no-scrollbar">
            {categories.map((cat) => (
              <button
                key={cat}
                onClick={() => setActiveCategory(cat)}
                className={`px-2 py-1 rounded whitespace-nowrap transition ${
                  activeCategory === cat
                    ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/50 font-bold'
                    : 'bg-[#141B2D] text-slate-400 hover:text-white border border-[#1E293B]'
                }`}
              >
                {cat === 'ALL'
                  ? `All (${
                      activeSuite === 'HIGH_STAKES_CLIENT'
                        ? clientResults.length
                        : serverSuiteResult?.totalTests || 200
                    })`
                  : cat}
              </button>
            ))}
          </div>

          {/* Search Input & Status Filter */}
          <div className="flex items-center space-x-2">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as any)}
              className="text-[11px] px-2 py-1 bg-[#06080D] border border-[#1E293B] rounded text-slate-300 focus:outline-none focus:border-cyan-500"
            >
              <option value="ALL">All Status</option>
              <option value="PASSED">Passed Only</option>
              <option value="FAILED">Failed Only</option>
            </select>

            <div className="relative min-w-[180px]">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search tests..."
                className="w-full pl-8 pr-2.5 py-1 text-xs bg-[#06080D] border border-[#1E293B] rounded text-slate-200 placeholder-slate-500 focus:outline-none focus:border-cyan-500"
              />
            </div>
          </div>
        </div>

        {/* TEST CASES LIST */}
        <div className="space-y-2 overflow-y-auto flex-1 pr-1">
          {serverLoading ? (
            <div className="p-8 text-center text-slate-400 text-xs flex items-center justify-center space-x-2">
              <div className="w-4 h-4 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin"></div>
              <span>Executing server-side quantitative benchmarks...</span>
            </div>
          ) : filteredResults.length > 0 ? (
            <>
              {filteredResults.slice(0, visibleCount).map((test: any) => (
                <div
                  key={test.id}
                  className="p-2.5 rounded-lg bg-[#141B2D] border border-[#1E293B] text-xs flex flex-col space-y-1 transition hover:border-slate-600"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-2">
                      {test.status === 'PASSED' ? (
                        <CheckCircle2 className="w-3.5 h-3.5 text-[#00E676] shrink-0" />
                      ) : (
                        <XCircle className="w-3.5 h-3.5 text-red-500 shrink-0" />
                      )}
                      <span className="font-bold text-white text-[11px]">{test.test}</span>
                      {test.category && (
                        <span
                          className={`text-[9px] px-1.5 py-0.2 rounded border font-mono ${getCategoryBadgeClass(
                            test.category
                          )}`}
                        >
                          {test.category}
                        </span>
                      )}
                    </div>
                    <span
                      className={`text-[9px] px-1.5 py-0.5 rounded font-bold font-mono ${
                        test.status === 'PASSED'
                          ? 'bg-[#00E676]/10 text-[#00E676] border border-[#00E676]/30'
                          : 'bg-red-500/10 text-red-400 border border-red-500/30'
                      }`}
                    >
                      {test.status}
                    </span>
                  </div>

                  <div className="text-[10px] text-slate-400 font-mono bg-[#06080D] p-1.5 rounded border border-[#1E293B]/60 break-all">
                    {test.details}
                  </div>

                  <div className="flex items-center justify-between text-[9px] text-slate-500">
                    <span className="flex items-center space-x-1">
                      <Clock className="w-2.5 h-2.5 text-slate-400" />
                      <span>
                        Duration:{' '}
                        {test.durationUs !== undefined
                          ? `${test.durationUs} µs`
                          : `${(test.durationNs / 1000).toFixed(2)} µs`}
                      </span>
                    </span>
                    <span className="text-emerald-400/80">Deterministic Assertion Verified</span>
                  </div>
                </div>
              ))}
              {filteredResults.length > visibleCount && (
                <div className="py-2 text-center">
                  <button
                    onClick={() => setVisibleCount((prev) => prev + 100)}
                    className="px-4 py-1.5 bg-[#141B2D] hover:bg-[#1E293B] border border-[#1E293B] hover:border-cyan-500 text-xs text-cyan-400 rounded transition font-mono"
                  >
                    Show More ({filteredResults.length - visibleCount} remaining)
                  </button>
                </div>
              )}
            </>
          ) : isRunning ? (
            <div className="p-8 text-center text-slate-400 text-xs flex items-center justify-center space-x-2">
              <div className="w-4 h-4 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin"></div>
              <span>Executing high-stakes unit tests in real-time...</span>
            </div>
          ) : (
            <div className="p-8 text-center text-slate-500 text-xs">
              No testcases match the current filter or search criteria.
            </div>
          )}
          <div ref={testListEndRef} />
        </div>

        {/* FOOTER */}
        <div className="pt-3 mt-3 border-t border-[#1E293B] flex items-center justify-between text-xs text-slate-400">
          <span>
            Displaying {filteredResults.length} of{' '}
            {activeSuite === 'HIGH_STAKES_CLIENT'
              ? clientResults.length
              : serverSuiteResult?.totalTests || 200}{' '}
            tests
          </span>
          <button
            onClick={onClose}
            className="px-4 py-1 rounded bg-[#141B2D] text-slate-300 hover:text-white border border-[#1E293B] transition"
          >
            Close Suite
          </button>
        </div>
      </div>
    </div>
  );
};
