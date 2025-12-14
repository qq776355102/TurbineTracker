import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Settings, Play, Pause, AlertCircle, Database, Download, RefreshCw, Activity, Users, Wallet, Layers, Calendar, Clock, RotateCcw } from 'lucide-react';
import { LogEvent, SyncStatus, AggregatedData, DailyData, DEFAULT_RPC, LGNS_DECIMALS } from './types';
import { db, saveEvents, getAllEvents, clearDatabase, getLatestStoredBlock } from './services/db';
import { RPCService } from './services/rpc';
import { StatsCard } from './components/StatsCard';
import { ChartSection } from './components/ChartSection';
import { ethers } from 'ethers';

const BLOCK_TIME_SEC = 2; 

// Helper to get the Local ISO string for Today's UTC 00:00
const getDefaultStartDate = () => {
  const now = new Date();
  const utcMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  
  const year = utcMidnight.getFullYear();
  const month = String(utcMidnight.getMonth() + 1).padStart(2, '0');
  const day = String(utcMidnight.getDate()).padStart(2, '0');
  const hours = String(utcMidnight.getHours()).padStart(2, '0');
  const minutes = String(utcMidnight.getMinutes()).padStart(2, '0');
  
  return `${year}-${month}-${day}T${hours}:${minutes}`;
};

export default function App() {
  // Config State
  const [rpcUrl, setRpcUrl] = useState<string>(DEFAULT_RPC);
  const [startDateInput, setStartDateInput] = useState<string>(getDefaultStartDate());
  const [calculatedStartBlock, setCalculatedStartBlock] = useState<number>(0);
  const [batchSize, setBatchSize] = useState<number>(1000); 
  
  // Chain State
  const [currentBlock, setCurrentBlock] = useState<number>(0); 
  const [chainTimestamp, setChainTimestamp] = useState<number>(0); 
  const [scannedBlock, setScannedBlock] = useState<number>(0); 
  
  // App State
  const [status, setStatus] = useState<SyncStatus>(SyncStatus.IDLE);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEvent[]>([]);
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());
  const [viewMode, setViewMode] = useState<'ALL' | 'TODAY'>('ALL');
  const [retryCount, setRetryCount] = useState<number>(0);
  
  // Logic Refs
  const isSyncingRef = useRef(false);
  const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const rpcRef = useRef<RPCService>(new RPCService(DEFAULT_RPC));
  
  // Derived Data
  const [aggregatedData, setAggregatedData] = useState<AggregatedData[]>([]);
  const [todayData, setTodayData] = useState<AggregatedData[]>([]);
  const [dailyData, setDailyData] = useState<DailyData[]>([]);

  // --- Initialization ---
  useEffect(() => {
    loadDataFromDB();
    fetchChainInfo();
    
    // Auto-refresh stats every 4 hours as requested (visual only, sync is manual/continuous)
    const interval = setInterval(() => {
      fetchChainInfo();
    }, 4 * 60 * 60 * 1000);

    return () => clearInterval(interval);
  }, []);

  // Re-calculate start block when date or chain info changes
  useEffect(() => {
    if (currentBlock > 0 && chainTimestamp > 0 && startDateInput) {
      calculateStartBlock();
    }
  }, [currentBlock, chainTimestamp, startDateInput]);

  const fetchChainInfo = async () => {
    try {
      const blockNum = await rpcRef.current.getBlockNumber();
      const blockTs = await rpcRef.current.getBlockTimestamp(blockNum);
      
      rpcRef.current.updateAnchor(blockNum, blockTs);
      
      setCurrentBlock(blockNum);
      setChainTimestamp(blockTs);
    } catch (e: any) {
      console.warn("Could not fetch chain info", e);
      setErrorMsg(`Chain Info Error: ${e.message}`);
    }
  };

  const calculateStartBlock = () => {
    if (!startDateInput || currentBlock === 0 || chainTimestamp === 0) return;

    const targetTime = new Date(startDateInput).getTime();
    const diffMs = chainTimestamp - targetTime;
    const diffSeconds = diffMs / 1000;
    
    if (diffSeconds < 0) {
      setCalculatedStartBlock(currentBlock);
      return;
    }

    const blocksAgo = Math.floor(diffSeconds / BLOCK_TIME_SEC);
    const start = Math.max(0, currentBlock - blocksAgo);
    
    setCalculatedStartBlock(start);
  };

  const getCalculatedBlockTime = () => {
    if (calculatedStartBlock === 0 || currentBlock === 0 || chainTimestamp === 0) return null;
    const blocksAgo = currentBlock - calculatedStartBlock;
    const timeAgoMs = blocksAgo * BLOCK_TIME_SEC * 1000;
    const estTime = new Date(chainTimestamp - timeAgoMs);
    return estTime.toLocaleString();
  };

  const loadDataFromDB = async () => {
    const events = await getAllEvents();
    setLogs(events);
    processData(events);
    
    const lastBlock = await getLatestStoredBlock();
    if (lastBlock > 0) {
      setScannedBlock(lastBlock);
    }
  };

  const processData = (events: LogEvent[]) => {
    const aggMap = new Map<string, { total: bigint, count: number }>();
    const todayAggMap = new Map<string, { total: bigint, count: number }>();
    const dayMap = new Map<string, bigint>();

    const now = new Date();
    const localMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

    events.forEach(ev => {
      const amount = BigInt(ev.silenceAmount);

      const current = aggMap.get(ev.recipient) || { total: 0n, count: 0 };
      aggMap.set(ev.recipient, {
        total: current.total + amount,
        count: current.count + 1
      });

      const dateObj = new Date(ev.timestamp);
      const dateKey = dateObj.toISOString().split('T')[0];
      const dayTotal = dayMap.get(dateKey) || 0n;
      dayMap.set(dateKey, dayTotal + amount);

      if (ev.timestamp >= localMidnight) {
         const tCurrent = todayAggMap.get(ev.recipient) || { total: 0n, count: 0 };
         todayAggMap.set(ev.recipient, {
            total: tCurrent.total + amount,
            count: tCurrent.count + 1
         });
      }
    });

    const formatList = (map: Map<string, { total: bigint, count: number }>) => {
        return Array.from(map.entries()).map(([recipient, data]) => {
          const amountFloat = parseFloat(ethers.formatUnits(data.total, LGNS_DECIMALS));
          return {
            recipient,
            totalSilence: amountFloat,
            count: data.count
          };
        })
        .filter(item => item.totalSilence > 100)
        .sort((a, b) => b.totalSilence - a.totalSilence);
    };

    const chartData: DailyData[] = Array.from(dayMap.entries()).map(([date, total]) => ({
      date,
      total: parseFloat(ethers.formatUnits(total, LGNS_DECIMALS))
    })).sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    setAggregatedData(formatList(aggMap));
    setTodayData(formatList(todayAggMap));
    setDailyData(chartData);
  };

  // --- Indexing Loop ---
  const startSync = useCallback(async (isRetry = false) => {
    // If we are already syncing and this isn't a retry call, ignore.
    if (status === SyncStatus.SYNCING && !isRetry) return;
    
    // Clear previous retry timeouts
    if (retryTimeoutRef.current) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
    }

    try {
      setStatus(SyncStatus.SYNCING);
      if (!isRetry) setErrorMsg(null); // Keep error msg visible during retry wait, clear on actual start
      
      const head = await rpcRef.current.getBlockNumber();
      const headTs = await rpcRef.current.getBlockTimestamp(head);
      
      rpcRef.current.updateAnchor(head, headTs);
      setCurrentBlock(head);
      setChainTimestamp(headTs);
      
      let currentPointer: number;
      if (scannedBlock > 0) {
        currentPointer = scannedBlock;
      } else {
        const targetTime = new Date(startDateInput).getTime();
        const diffMs = headTs - targetTime;
        const diffSeconds = diffMs / 1000;
        const blocksAgo = Math.max(0, Math.floor(diffSeconds / BLOCK_TIME_SEC));
        currentPointer = Math.max(0, head - blocksAgo);
        setCalculatedStartBlock(currentPointer);
      }
      
      // If caught up, stay in COMPLETED state but don't error
      if (currentPointer >= head) {
        setStatus(SyncStatus.COMPLETED);
        // Reset retry count on success
        setRetryCount(0); 
        return;
      }

      isSyncingRef.current = true;
      setRetryCount(0); // Reset retry count once we successfully start the loop
      
      while (isSyncingRef.current && currentPointer < head) {
        const safeBatch = Math.max(1, batchSize);
        const toBlock = Math.min(currentPointer + safeBatch, head);
        
        try {
          const newLogs = await rpcRef.current.fetchLogs(currentPointer + 1, toBlock);
          
          if (newLogs.length > 0) {
            const savedEvents = await saveEvents(newLogs);
            if (savedEvents.length > 0) {
              setLogs(prev => {
                const updated = [...prev, ...savedEvents];
                processData(updated);
                return updated;
              });
            }
          }
          
          currentPointer = toBlock;
          setScannedBlock(toBlock);
          setLastUpdated(new Date());

          // Small delay to be nice to RPC
          await new Promise(r => setTimeout(r, 200));

        } catch (err: any) {
          console.error("Sync error:", err);
          throw err; // Re-throw to be caught by outer handler
        }
      }

      if (currentPointer >= head && isSyncingRef.current) {
        setStatus(SyncStatus.COMPLETED);
      }

    } catch (err: any) {
      // Error Recovery Mechanism
      const msg = err.message || "Unknown Error";
      setErrorMsg(`RPC Error: ${msg}. Retrying in 5s...`);
      setStatus(SyncStatus.ERROR);
      
      // Auto-Retry Logic
      if (isSyncingRef.current) {
          const timeout = setTimeout(() => {
             setRetryCount(prev => prev + 1);
             startSync(true);
          }, 5000);
          retryTimeoutRef.current = timeout;
      } else {
          isSyncingRef.current = false;
      }
    }
  }, [scannedBlock, startDateInput, status, batchSize]);

  const stopSync = () => {
    isSyncingRef.current = false;
    if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
    setStatus(SyncStatus.PAUSED);
  };

  // --- Handlers ---
  const handleRpcChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setRpcUrl(e.target.value);
  };

  const applyRpc = () => {
    // 1. Update Service
    rpcRef.current = new RPCService(rpcUrl);
    
    // 2. Clear Errors
    setErrorMsg(null);
    setRetryCount(0);
    
    // 3. Refresh Chain Info
    fetchChainInfo();

    // 4. Auto-Resume if we were stuck or syncing
    if (status === SyncStatus.ERROR || status === SyncStatus.SYNCING || status === SyncStatus.COMPLETED) {
       // Ensure we stop any pending retries
       if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
       // Force restart
       isSyncingRef.current = false; 
       setTimeout(() => {
         startSync();
       }, 500);
    }
  };

  const handleExport = () => {
    const dataToExport = viewMode === 'ALL' ? aggregatedData : todayData;
    const filenamePrefix = viewMode === 'ALL' ? 'turbine-stats-all' : 'turbine-stats-today';
    const headers = "Recipient,Total LGNS,Transaction Count\n";
    const rows = dataToExport.map(d => `${d.recipient},${d.totalSilence.toFixed(4)},${d.count}`).join("\n");
    const blob = new Blob([headers + rows], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filenamePrefix}-${new Date().toISOString()}.csv`;
    a.click();
  };

  const handleReset = async () => {
    if (confirm("Are you sure? This will delete all local data.")) {
      stopSync();
      await clearDatabase();
      setLogs([]);
      setAggregatedData([]);
      setTodayData([]);
      setDailyData([]);
      setScannedBlock(0);
      setCalculatedStartBlock(0);
      setStatus(SyncStatus.IDLE);
      fetchChainInfo(); 
    }
  };

  const activeList = viewMode === 'ALL' ? aggregatedData : todayData;
  const totalVolume = activeList.reduce((acc, curr) => acc + curr.totalSilence, 0);
  const totalUsers = activeList.length;

  return (
    <div className="min-h-screen bg-slate-900 text-slate-200 font-sans selection:bg-blue-500/30">
      
      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-900/50 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="bg-blue-600 p-2 rounded-lg">
              <Activity size={20} className="text-white" />
            </div>
            <h1 className="text-xl font-bold text-white tracking-tight">Turbine<span className="text-blue-500">Tracker</span></h1>
          </div>
          
          <div className="flex items-center gap-4">
            <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold uppercase tracking-wider ${
              status === SyncStatus.SYNCING ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20' :
              status === SyncStatus.ERROR ? 'bg-red-500/10 text-red-400 border border-red-500/20' :
              status === SyncStatus.COMPLETED ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' :
              'bg-slate-700/50 text-slate-400'
            }`}>
              <span className={`w-2 h-2 rounded-full ${
                status === SyncStatus.SYNCING ? 'bg-blue-400 animate-pulse' :
                status === SyncStatus.ERROR ? 'bg-red-400' :
                status === SyncStatus.COMPLETED ? 'bg-emerald-400' :
                'bg-slate-400'
              }`}></span>
              {status === SyncStatus.ERROR && retryTimeoutRef.current ? 'RETRYING...' : status}
            </div>
            <button onClick={handleExport} className="flex items-center gap-2 text-sm text-slate-400 hover:text-white transition-colors">
              <Download size={16} /> Export {viewMode === 'TODAY' ? 'Today' : 'All'}
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-8 space-y-8">
        
        {/* Error Banner */}
        {errorMsg && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 flex items-start gap-3 animate-fade-in">
            <AlertCircle className="text-red-400 shrink-0 mt-0.5" size={20} />
            <div className="flex-1">
              <h3 className="text-red-400 font-semibold text-sm">Synchronization Error</h3>
              <p className="text-red-300/80 text-sm mt-1">{errorMsg}</p>
              <div className="flex gap-3 mt-3">
                 <button 
                  onClick={() => {
                      if(retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
                      startSync();
                  }}
                  className="flex items-center gap-1 text-xs bg-red-500 hover:bg-red-600 text-white px-3 py-1.5 rounded transition-colors"
                >
                  <RotateCcw size={12} /> Retry Now
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Controls & Config */}
        <section className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-5">
          <div className="flex flex-col md:flex-row gap-4 md:items-end">
            <div className="flex-1 space-y-2">
              <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-2">
                <Settings size={14} /> RPC Endpoint
              </label>
              <div className="flex gap-2">
                <input 
                  type="text" 
                  value={rpcUrl} 
                  onChange={handleRpcChange}
                  className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="https://polygon-rpc.com"
                />
                <button 
                  onClick={applyRpc}
                  className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-sm font-medium transition-colors"
                >
                  Set & Resume
                </button>
              </div>
            </div>

            <div className="w-full md:w-32 space-y-2">
               <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-2">
                 <Layers size={14} /> Batch Size
               </label>
               <input 
                  type="number" 
                  value={batchSize} 
                  onChange={(e) => setBatchSize(Number(e.target.value))}
                  disabled={status === SyncStatus.SYNCING}
                  min="1"
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
                />
            </div>

            <div className="w-full md:w-56 space-y-2">
               <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-2">
                 <Calendar size={14} /> Start Time (Local)
               </label>
               <input 
                  type="datetime-local" 
                  value={startDateInput} 
                  onChange={(e) => setStartDateInput(e.target.value)}
                  disabled={status === SyncStatus.SYNCING || scannedBlock > 0} 
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
                />
            </div>

            <div className="flex gap-2">
              {status === SyncStatus.SYNCING ? (
                <button 
                  onClick={stopSync}
                  className="flex items-center gap-2 px-6 py-2 bg-amber-500/10 hover:bg-amber-500/20 text-amber-500 border border-amber-500/20 rounded-lg text-sm font-semibold transition-all"
                >
                  <Pause size={16} fill="currentColor" /> Pause
                </button>
              ) : (
                <button 
                  onClick={() => startSync()}
                  className="flex items-center gap-2 px-6 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-semibold shadow-lg shadow-blue-500/20 transition-all"
                >
                  <Play size={16} fill="currentColor" /> {status === SyncStatus.PAUSED || status === SyncStatus.ERROR ? 'Resume' : 'Start Sync'}
                </button>
              )}
              
              <button 
                onClick={handleReset}
                className="p-2 text-slate-400 hover:text-red-400 hover:bg-red-400/10 rounded-lg transition-colors"
                title="Reset Database"
              >
                <Database size={20} />
              </button>
            </div>
          </div>
          
          {/* Progress Bar & Info */}
          <div className="mt-6">
             <div className="flex justify-between text-xs text-slate-400 mb-2">
                <span>
                   Progress: {scannedBlock.toLocaleString()} / {currentBlock > 0 ? currentBlock.toLocaleString() : '...'}
                   {calculatedStartBlock > 0 && scannedBlock === 0 && (
                     <span className="text-blue-400 ml-2">
                       (Est. Start: #{calculatedStartBlock} {getCalculatedBlockTime() ? `~ ${getCalculatedBlockTime()}` : ''})
                     </span>
                   )}
                </span>
                <span>Last Update: {lastUpdated.toLocaleTimeString()}</span>
             </div>
             <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                <div 
                  className="h-full bg-blue-500 transition-all duration-500 ease-out"
                  style={{ width: `${currentBlock > 0 ? Math.min(((scannedBlock - calculatedStartBlock) / (currentBlock - calculatedStartBlock)) * 100, 100) : 0}%` }}
                ></div>
             </div>
          </div>
        </section>

        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <StatsCard 
            title={viewMode === 'ALL' ? "Total Volume (All Time)" : "Total Volume (Today Local)"}
            value={`${totalVolume.toLocaleString(undefined, { maximumFractionDigits: 2 })} LGNS`} 
            icon={<Wallet size={24} className="text-emerald-400" />}
            color="bg-emerald-500/10 text-emerald-400"
          />
          <StatsCard 
            title={viewMode === 'ALL' ? "Active Wallets" : "Active Wallets (Today)"}
            value={totalUsers} 
            icon={<Users size={24} className="text-violet-400" />}
            color="bg-violet-500/10 text-violet-400"
          />
          <StatsCard 
            title="Total Events Logged" 
            value={logs.length} 
            icon={<RefreshCw size={24} className="text-blue-400" />}
            color="bg-blue-500/10 text-blue-400"
          />
        </div>

        {/* Chart */}
        <ChartSection data={dailyData} />

        {/* Leaderboard Table */}
        <div className="bg-slate-800 border border-slate-700 rounded-xl shadow-lg overflow-hidden">
          <div className="p-6 border-b border-slate-700 flex flex-col sm:flex-row justify-between items-center gap-4">
            <h3 className="text-lg font-semibold text-white flex items-center gap-2">
              {viewMode === 'ALL' ? 'Top Recipients (All Time)' : 'Top Recipients (Today Local)'}
              <span className="text-sm font-normal text-slate-500 ml-2">{'>'}100 LGNS</span>
            </h3>
            
            <div className="flex items-center bg-slate-900 rounded-lg p-1 border border-slate-700">
               <button 
                onClick={() => setViewMode('ALL')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${viewMode === 'ALL' ? 'bg-blue-600 text-white shadow' : 'text-slate-400 hover:text-white'}`}
               >
                 All Time
               </button>
               <button 
                onClick={() => setViewMode('TODAY')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all flex items-center gap-1 ${viewMode === 'TODAY' ? 'bg-blue-600 text-white shadow' : 'text-slate-400 hover:text-white'}`}
               >
                 <Clock size={12} /> Today (Local)
               </button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-slate-400">
              <thead className="bg-slate-900/50 text-slate-200 uppercase text-xs font-semibold tracking-wider">
                <tr>
                  <th className="px-6 py-4">Rank</th>
                  <th className="px-6 py-4">Address</th>
                  <th className="px-6 py-4 text-right">Total LGNS</th>
                  <th className="px-6 py-4 text-right">Tx Count</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/50">
                {activeList.map((row, index) => (
                  <tr key={row.recipient} className="hover:bg-slate-700/30 transition-colors">
                    <td className="px-6 py-4 font-mono text-slate-500">#{index + 1}</td>
                    <td className="px-6 py-4 font-mono text-blue-400">{row.recipient}</td>
                    <td className="px-6 py-4 text-right font-medium text-white">
                      {row.totalSilence.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </td>
                    <td className="px-6 py-4 text-right">{row.count}</td>
                  </tr>
                ))}
                {activeList.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-6 py-12 text-center text-slate-500">
                      No data found matching criteria yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

      </main>
    </div>
  );
}