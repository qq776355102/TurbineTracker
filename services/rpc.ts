import { ethers } from 'ethers';
import { LogEvent, TOPIC_0, CONTRACT_ADDRESS } from '../types';

export class RPCService {
  private provider: ethers.JsonRpcProvider;
  private anchorBlock: number = 80308548; // Fallback
  private anchorTimestamp: number = 1734213600000; // Fallback

  constructor(rpcUrl: string) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
  }

  updateAnchor(block: number, timestamp: number) {
    this.anchorBlock = block;
    this.anchorTimestamp = timestamp;
  }

  async getBlockNumber(): Promise<number> {
    return await this.provider.getBlockNumber();
  }

  async getBlockTimestamp(blockNumber?: number): Promise<number> {
    const block = await this.provider.getBlock(blockNumber || 'latest');
    if (!block) throw new Error("Failed to fetch block");
    // block.timestamp is in seconds, convert to ms
    return block.timestamp * 1000;
  }

  // Polygon blocks are ~2s. We can estimate timestamp to avoid fetching block headers for every event (too slow)
  // We align the anchor to the approximate current state for list display estimation
  estimateTimestamp(blockNumber: number): number {
    const diff = (blockNumber - this.anchorBlock) * 2000; // 2s * 1000ms
    return this.anchorTimestamp + diff;
  }

  async fetchLogs(fromBlock: number, toBlock: number): Promise<LogEvent[]> {
    const logs = await this.provider.getLogs({
      address: CONTRACT_ADDRESS,
      topics: [TOPIC_0],
      fromBlock,
      toBlock
    });

    return logs.map(log => {
      const recipient = ethers.getAddress("0x" + log.topics[1].slice(26));
      const silenceAmount = BigInt(log.topics[2]).toString();
      const usdtAmount = BigInt(log.topics[3]).toString();

      return {
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
        logIndex: log.index,
        uniqueId: `${log.transactionHash}-${log.index}`,
        recipient,
        silenceAmount,
        usdtAmount,
        timestamp: this.estimateTimestamp(log.blockNumber)
      } as LogEvent;
    });
  }
}