export interface LogEvent {
  id?: number; // Auto-increment for Dexie
  uniqueId?: string; // Composite key: `${transactionHash}-${logIndex}` for deduplication
  logIndex?: number;
  blockNumber: number;
  transactionHash: string;
  recipient: string;
  silenceAmount: string; // Stored as string to preserve BigInt precision
  usdtAmount: string; // Stored as string
  timestamp: number; // Approximate timestamp based on block
}

export interface AggregatedData {
  recipient: string;
  totalSilence: number; // Converted to float for display (LGNS)
  totalUsdt: number; // Converted to float for display (USDT)
  count: number;
}

export interface DailyData {
  date: string;
  total: number;
}

export enum SyncStatus {
  IDLE = 'IDLE',
  SYNCING = 'SYNCING',
  PAUSED = 'PAUSED',
  ERROR = 'ERROR',
  COMPLETED = 'COMPLETED'
}

export const CONTRACT_ADDRESS = "0x07Ff4e06865de4934409Aa6eCea503b08Cc1C78d";
export const TOPIC_0 = "0xaf38268b77f6114a774b9861310e0e0901459cd04dbcde707ad7137ed869d50c";
export const LGNS_DECIMALS = 9;
export const USDT_DECIMALS = 18;
// Approximate start block for Dec 1 2024 on Polygon
export const DEFAULT_START_BLOCK = 79700000; 
export const DEFAULT_RPC = "https://polygon-bor-rpc.publicnode.com";