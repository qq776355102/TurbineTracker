import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Settings, Play, Pause, AlertCircle, Database, Download, RefreshCw, Activity, Users, Wallet, Layers, Calendar, Clock, RotateCcw, Coins } from 'lucide-react';
import { LogEvent, SyncStatus, AggregatedData, DailyData, DEFAULT_RPC, LGNS_DECIMALS, USDT_DECIMALS } from './types';
import { db, saveEvents, getAllEvents, clearDatabase, getLatestStoredBlock } from './services/db';
import { RPCService } from './services/rpc';
import { StatsCard } from './components/StatsCard';
import { ChartSection } from './components/ChartSection';
import { ethers } from 'ethers';

const BLOCK_TIME_SEC = 2; 

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
  const [endDateInput, setEndDateInput] = useState<string>('');
  const [statThreshold, setStatThreshold] = useState<number>(1);
  const [displayThreshold, setDisplayThreshold] = useState<number>(100);
  const [batchSize, setBatchSize] = useState<number>(1000); 
  
  // Calculated Blocks
  const [calculatedStartBlock, setCalculatedStartBlock] = useState<number>(0);
  const [calculatedEndBlock, setCalculatedEndBlock] = useState<number>(0);
  
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
  
  // Logic Refs
  const isSyncingRef = useRef(false);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rpcRef = useRef<RPCService>(new RPCService(DEFAULT_RPC));
  
  // Derived Raw Data
  const [rawAggregated, setRawAggregated] = useState<AggregatedData[]>([]);
  const [rawToday, setRawToday] = useState<AggregatedData[]>([]);
  const [dailyData, setDailyData] = useState<DailyData[]>([]);

  // --- Initialization ---
  useEffect(() => {
    loadDataFromDB();
    fetchChainInfo();
    
    const interval = setInterval(() => {
      fetchChainInfo();
    }, 4 * 60 * 60 * 1000);

    return () => clearInterval(interval);
  }, []);

  // Re-calculate blocks when date or chain info changes
  useEffect(() => {
    if (currentBlock > 0 && chainTimestamp > 0) {
      calculateBlockRanges();
    }
  }, [currentBlock, chainTimestamp, startDateInput, endDateInput]);

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

  const calculateBlockRanges = () => {
    if (currentBlock === 0 || chainTimestamp === 0) return;

    // Start Block
    if (startDateInput) {
      const startTime = new Date(startDateInput).getTime();
      const diffS = (chainTimestamp - startTime) / 1000;
      const blocksAgo = Math.floor(diffS / BLOCK_TIME_SEC);
      setCalculatedStartBlock(Math.max(0, currentBlock - blocksAgo));
    }

    // End Block
    if (endDateInput) {
      const endTime = new Date(endDateInput).getTime();
      const diffS = (chainTimestamp - endTime) / 1000;
      const blocksAgo = Math.floor(diffS / BLOCK_TIME_SEC);
      setCalculatedEndBlock(Math.max(0, currentBlock - blocksAgo));
    } else {
      setCalculatedEndBlock(0);
    }
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
    const aggMap = new Map<string, { silence: bigint, usdt: bigint, count: number }>();
    const todayAggMap = new Map<string, { silence: bigint, usdt: bigint, count: number }>();
    const dayMap = new Map<string, bigint>();

    const now = new Date();
    const localMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

    events.forEach(ev => {
      const silenceAmt = BigInt(ev.silenceAmount);
      const usdtAmt = BigInt(ev.usdtAmount || '0');

      // Aggregate All Time
      const current = aggMap.get(ev.recipient) || { silence: 0n, usdt: 0n, count: 0 };
      aggMap.set(ev.recipient, {
        silence: current.silence + silenceAmt,
        usdt: current.usdt + usdtAmt,
        count: current.count + 1
      });

      // Aggregate Daily (Chart)
      const dateObj = new Date(ev.timestamp);
      const dateKey = dateObj.toISOString().split('T')[0];
      const dayTotal = dayMap.get(dateKey) || 0n;
      dayMap.set(dateKey, dayTotal + silenceAmt);

      // Aggregate Today
      if (ev.timestamp >= localMidnight) {
         const tCurrent = todayAggMap.get(ev.recipient) || { silence: 0n, usdt: 0n, count: 0 };
         todayAggMap.set(ev.recipient, {
            silence: tCurrent.silence + silenceAmt,
            usdt: tCurrent.usdt + usdtAmt,
            count: tCurrent.count + 1
         });
      }
    });

    const toAggArray = (map: Map<string, { silence: bigint, usdt: bigint, count: number }>) => {
        return Array.from(map.entries()).map(([recipient, data]) => ({
          recipient,
          totalSilence: parseFloat(ethers.formatUnits(data.silence, LGNS_DECIMALS)),
          totalUsdt: parseFloat(ethers.formatUnits(data.usdt, USDT_DECIMALS)),
          count: data.count
        }));
    };

    const chartData: DailyData[] = Array.from(dayMap.entries()).map(([date, total]) => ({
      date,
      total: parseFloat(ethers.formatUnits(total, LGNS_DECIMALS))
    })).sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    setRawAggregated(toAggArray(aggMap));
    setRawToday(toAggArray(todayAggMap));
    setDailyData(chartData);
  };

  // Threshold Filtering
  const activeList = useMemo(() => {
    const list = viewMode === 'ALL' ? rawAggregated : rawToday;
    return list
      .filter(item => item.totalSilence >= displayThreshold)
      .sort((a, b) => b.totalSilence - a.totalSilence);
  }, [viewMode, rawAggregated, rawToday, displayThreshold]);

  const activeWalletsCount = useMemo(() => {
    const list = viewMode === 'ALL' ? rawAggregated : rawToday;
    return list.filter(item => item.totalSilence >= statThreshold).length;
  }, [viewMode, rawAggregated, rawToday, statThreshold]);

  const totalSilenceVolume = useMemo(() => {
    const list = viewMode === 'ALL' ? rawAggregated : rawToday;
    return list.reduce((acc, curr) => acc + curr.totalSilence, 0);
  }, [viewMode, rawAggregated, rawToday]);

  const totalUsdtVolume = useMemo(() => {
    const list = viewMode === 'ALL' ? rawAggregated : rawToday;
    return list.reduce((acc, curr) => acc + curr.totalUsdt, 0);
  }, [viewMode, rawAggregated, rawToday]);

  // --- Indexing Loop ---
  const startSync = useCallback(async (isRetry = false) => {
    if (status === SyncStatus.SYNCING && !isRetry) return;
    if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);

    try {
      setStatus(SyncStatus.SYNCING);
      if (!isRetry) setErrorMsg(null);
      
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
        const blocksAgo = Math.max(0, Math.floor(diffMs / 1000 / BLOCK_TIME_SEC));
        currentPointer = Math.max(0, head - blocksAgo);
      }

      const syncLimit = calculatedEndBlock > 0 ? Math.min(head, calculatedEndBlock) : head;
      
      if (currentPointer >= syncLimit) {
        setStatus(SyncStatus.COMPLETED);
        return;
      }

      isSyncingRef.current = true;
      
      while (isSyncingRef.current && currentPointer < syncLimit) {
        const toBlock = Math.min(currentPointer + batchSize, syncLimit);
        
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
          await new Promise(r => setTimeout(r, 200));
        } catch (err: any) {
          throw err;
        }
      }

      if (currentPointer >= syncLimit && isSyncingRef.current) {
        setStatus(SyncStatus.COMPLETED);
      }

    } catch (err: any) {
      setErrorMsg(`RPC Error: ${err.message || "Unknown"}. Retrying in 5s...`);
      setStatus(SyncStatus.ERROR);
      if (isSyncingRef.current) {
          retryTimeoutRef.current = setTimeout(() => startSync(true), 5000);
      }
    }
  }, [scannedBlock, startDateInput, calculatedEndBlock, batchSize, status]);

  const stopSync = () => {
    isSyncingRef.current = false;
    if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
    setStatus(SyncStatus.PAUSED);
  };

  const handleRpcChange = (e: React.ChangeEvent<HTMLInputElement>) => setRpcUrl(e.target.value);

  const applyRpc = () => {
    rpcRef.current = new RPCService(rpcUrl);
    setErrorMsg(null);
    fetchChainInfo();
    if (status === SyncStatus.ERROR || status === SyncStatus.SYNCING || status === SyncStatus.COMPLETED) {
       if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
       isSyncingRef.current = false; 
       setTimeout(() => startSync(), 500);
    }
  };

  const handleExport = () => {
    const headers = "Recipient,Total LGNS,Total USDT,Transaction Count\n";
    const rows = activeList.map(d => `${d.recipient},${d.totalSilence.toFixed(4)},${d.totalUsdt.toFixed(4)},${d.count}`).join("\n");
    const blob = new Blob([headers + rows], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `turbine-stats-${viewMode.toLowerCase()}-${new Date().toISOString()}.csv`;
    a.click();
  };

  const handleReset = async () => {
    if (confirm("Reset local database?")) {
      stopSync();
      await clearDatabase();
      setLogs([]); setRawAggregated([]); setRawToday([]); setDailyData([]);
      setScannedBlock(0); setCalculatedStartBlock(0); setCalculatedEndBlock(0);
      setStatus(SyncStatus.IDLE);
      fetchChainInfo(); 
    }
  };

  const progressTotal = (calculatedEndBlock || currentBlock) - calculatedStartBlock;
  const progressCurrent = scannedBlock - calculatedStartBlock;
  const progressPercent = progressTotal > 0 ? Math.min((progressCurrent / progressTotal) * 100, 100) : 0;

  return (
    <div className="min-h-screen bg-slate-900 text-slate-200 font-sans selection:bg-blue-500/30">
      
      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-900/50 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="bg-blue-600 p-2 rounded-lg"><Activity size={20} className="text-white" /></div>
            <h1 className="text-xl font-bold text-white tracking-tight">Turbine<span className="text-blue-500">Tracker</span></h1>
          </div>
          
          <div className="flex items-center gap-4">
            <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold uppercase tracking-wider ${
              status === SyncStatus.SYNCING ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20' :
              status === SyncStatus.ERROR ? 'bg-red-500/10 text-red-400 border border-red-500/20' :
              status === SyncStatus.COMPLETED ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' :
              'bg-slate-700/50 text-slate-400'
            }`}>
              <span className={`w-2 h-2 rounded-full ${status === SyncStatus.SYNCING ? 'bg-blue-400 animate-pulse' : status === SyncStatus.ERROR ? 'bg-red-400' : status === SyncStatus.COMPLETED ? 'bg-emerald-400' : 'bg-slate-400'}`}></span>
              {status === SyncStatus.ERROR && retryTimeoutRef.current ? 'RETRYING...' : status}
            </div>
            <button onClick={handleExport} className="flex items-center gap-2 text-sm text-slate-400 hover:text-white transition-colors">
              <Download size={16} /> Export CSV
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
              <button onClick={() => { if(retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current); startSync(); }} className="mt-3 flex items-center gap-1 text-xs bg-red-500 hover:bg-red-600 text-white px-3 py-1.5 rounded transition-colors">
                <RotateCcw size={12} /> Retry Now
              </button>
            </div>
          </div>
        )}

        {/* Configuration Panel */}
        <section className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-6 space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            <div className="space-y-2">
              <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-2"><Settings size={14} /> RPC Endpoint</label>
              <div className="flex gap-2">
                <input type="text" value={rpcUrl} onChange={handleRpcChange} className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:ring-2 focus:ring-blue-500 outline-none" placeholder="https://..." />
                <button onClick={applyRpc} className="px-3 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-xs font-medium transition-colors">Set</button>
              </div>
            </div>

            <div className="space-y-2">
               <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-2"><Calendar size={14} /> Start Time (Local)</label>
               <input type="datetime-local" value={startDateInput} onChange={(e) => setStartDateInput(e.target.value)} disabled={status === SyncStatus.SYNCING || scannedBlock > 0} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:ring-2 focus:ring-blue-500 outline-none disabled:opacity-50" />
            </div>

            <div className="space-y-2">
               <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-2"><Clock size={14} /> End Time (Optional)</label>
               <input type="datetime-local" value={endDateInput} onChange={(e) => setEndDateInput(e.target.value)} disabled={status === SyncStatus.SYNCING} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:ring-2 focus:ring-blue-500 outline-none disabled:opacity-50" />
            </div>

            <div className="space-y-2">
               <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-2"><Layers size={14} /> Batch Size</label>
               <input type="number" value={batchSize} onChange={(e) => setBatchSize(Number(e.target.value))} disabled={status === SyncStatus.SYNCING} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:ring-2 focus:ring-blue-500 outline-none disabled:opacity-50" />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 items-end pt-2 border-t border-slate-700/50">
            <div className="space-y-2">
               <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Stat Threshold (LGNS)</label>
               <input type="number" value={statThreshold} onChange={(e) => setStatThreshold(Number(e.target.value))} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:ring-2 focus:ring-blue-500 outline-none" />
            </div>
            <div className="space-y-2">
               <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Display Threshold (LGNS)</label>
               <input type="number" value={displayThreshold} onChange={(e) => setDisplayThreshold(Number(e.target.value))} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:ring-2 focus:ring-blue-500 outline-none" />
            </div>
            <div className="lg:col-span-2 flex justify-end gap-3">
              {status === SyncStatus.SYNCING ? (
                <button onClick={stopSync} className="flex items-center gap-2 px-8 py-2 bg-amber-500/10 hover:bg-amber-500/20 text-amber-500 border border-amber-500/20 rounded-lg text-sm font-semibold transition-all"><Pause size={16} fill="currentColor" /> Pause</button>
              ) : (
                <button onClick={() => startSync()} className="flex items-center gap-2 px-8 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-semibold shadow-lg shadow-blue-500/20 transition-all"><Play size={16} fill="currentColor" /> {status === SyncStatus.IDLE ? 'Start Sync' : 'Resume'}</button>
              )}
              <button onClick={handleReset} className="p-2 text-slate-400 hover:text-red-400 hover:bg-red-400/10 rounded-lg transition-colors" title="Reset Database"><Database size={20} /></button>
            </div>
          </div>
          
          <div className="pt-4 border-t border-slate-700/50">
             <div className="flex justify-between text-xs text-slate-400 mb-2">
                <span className="flex flex-wrap gap-x-4">
                   <span>Progress: {scannedBlock.toLocaleString()} / {(calculatedEndBlock || currentBlock).toLocaleString()}</span>
                   {calculatedStartBlock > 0 && <span className="text-blue-400">Start Block: #{calculatedStartBlock}</span>}
                   {calculatedEndBlock > 0 && <span className="text-amber-400">End Block: #{calculatedEndBlock}</span>}
                </span>
                <span>Updated: {lastUpdated.toLocaleTimeString()}</span>
             </div>
             <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
                <div className="h-full bg-blue-500 transition-all duration-500 ease-out" style={{ width: `${progressPercent}%` }}></div>
             </div>
          </div>
        </section>

        {/* Statistics Overview */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          <StatsCard title={`LGNS Vol (${viewMode === 'ALL' ? 'Total' : 'Today'})`} value={`${totalSilenceVolume.toLocaleString(undefined, { maximumFractionDigits: 2 })}`} icon={<Wallet size={20} className="text-emerald-400" />} color="bg-emerald-500/10 text-emerald-400" />
          <StatsCard title={`USDT Vol (${viewMode === 'ALL' ? 'Total' : 'Today'})`} value={`${totalUsdtVolume.toLocaleString(undefined, { maximumFractionDigits: 2 })}`} icon={<Coins size={20} className="text-amber-400" />} color="bg-amber-500/10 text-amber-400" />
          <StatsCard title={`Active Wallets (>=${statThreshold})`} value={activeWalletsCount} icon={<Users size={20} className="text-violet-400" />} color="bg-violet-500/10 text-violet-400" />
          <StatsCard title="Events Scanned" value={logs.length} icon={<RefreshCw size={20} className="text-blue-400" />} color="bg-blue-500/10 text-blue-400" />
        </div>

        <ChartSection data={dailyData} />

        {/* Leaderboard */}
        <div className="bg-slate-800 border border-slate-700 rounded-xl shadow-lg overflow-hidden">
          <div className="p-6 border-b border-slate-700 flex flex-col sm:flex-row justify-between items-center gap-4">
            <h3 className="text-lg font-semibold text-white flex items-center gap-2">
              Top Recipients (>{displayThreshold} LGNS)
            </h3>
            
            <div className="flex items-center bg-slate-900 rounded-lg p-1 border border-slate-700">
               <button onClick={() => setViewMode('ALL')} className={`px-4 py-1.5 text-xs font-medium rounded-md transition-all ${viewMode === 'ALL' ? 'bg-blue-600 text-white shadow' : 'text-slate-400 hover:text-white'}`}>All Time</button>
               <button onClick={() => setViewMode('TODAY')} className={`px-4 py-1.5 text-xs font-medium rounded-md transition-all flex items-center gap-1 ${viewMode === 'TODAY' ? 'bg-blue-600 text-white shadow' : 'text-slate-400 hover:text-white'}`}><Clock size={12} /> Today</button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-slate-400">
              <thead className="bg-slate-900/50 text-slate-200 uppercase text-xs font-semibold tracking-wider">
                <tr>
                  <th className="px-6 py-4">Rank</th>
                  <th className="px-6 py-4">Address</th>
                  <th className="px-6 py-4 text-right">Total LGNS</th>
                  <th className="px-6 py-4 text-right">Total USDT</th>
                  <th className="px-6 py-4 text-right">Tx Count</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/50">
                {activeList.map((row, index) => (
                  <tr key={row.recipient} className="hover:bg-slate-700/30 transition-colors">
                    <td className="px-6 py-4 font-mono text-slate-500">#{index + 1}</td>
                    <td className="px-6 py-4 font-mono text-blue-400">{row.recipient}</td>
                    <td className="px-6 py-4 text-right font-medium text-white">{row.totalSilence.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                    <td className="px-6 py-4 text-right font-medium text-amber-400">{row.totalUsdt.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                    <td className="px-6 py-4 text-right">{row.count}</td>
                  </tr>
                ))}
                {activeList.length === 0 && (
                  <tr><td colSpan={5} className="px-6 py-12 text-center text-slate-500">No data matching display threshold.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

      </main>
    </div>
  );
}