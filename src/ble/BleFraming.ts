/* eslint-disable no-bitwise */
import { Buffer } from 'buffer';

export const FRAME_MAGIC_BYTE = 0xac;
export const FRAME_VERSION_BYTE = 0x01;
export const BINARY_HEADER_SIZE = 6;
export const DEFAULT_MAX_CHUNK_BYTES = 14; // Default chunk size for MTU 23 (20 ATT payload - 6 header)
export const MAX_ALLOWED_PAYLOAD_BYTES = 2048;

export interface FramePacket {
  txId: number;
  seq: number;
  total: number;
  chunk: Uint8Array;
}

export class BleFraming {
  /**
   * Split a UTF-8 string payload into binary framed packets adhering to MTU limits.
   */
  public static framePayload(
    payload: string,
    txId: number,
    usableChunkSize = DEFAULT_MAX_CHUNK_BYTES,
  ): Uint8Array[] {
    const rawData = Buffer.from(payload, 'utf-8');
    if (rawData.length > MAX_ALLOWED_PAYLOAD_BYTES) {
      throw new Error(
        `PAYLOAD_EXCEEDS_MAX_SIZE: Payload ${rawData.length} bytes exceeds ${MAX_ALLOWED_PAYLOAD_BYTES} bytes limit`,
      );
    }

    const chunkCapacity = Math.max(8, usableChunkSize);
    const totalChunks = Math.ceil(rawData.length / chunkCapacity) || 1;

    if (totalChunks > 255) {
      throw new Error(
        `CHUNK_OVERFLOW: Calculated total chunks ${totalChunks} exceeds 8-bit frame field`,
      );
    }

    const frames: Uint8Array[] = [];
    const txIdUint16 = txId & 0xffff;

    for (let seq = 1; seq <= totalChunks; seq++) {
      const offset = (seq - 1) * chunkCapacity;
      const end = Math.min(offset + chunkCapacity, rawData.length);
      const chunkBytes = rawData.subarray(offset, end);

      const frame = new Uint8Array(BINARY_HEADER_SIZE + chunkBytes.length);
      frame[0] = FRAME_MAGIC_BYTE;
      frame[1] = FRAME_VERSION_BYTE;
      frame[2] = (txIdUint16 >> 8) & 0xff;
      frame[3] = txIdUint16 & 0xff;
      frame[4] = seq;
      frame[5] = totalChunks;
      frame.set(chunkBytes, BINARY_HEADER_SIZE);

      frames.push(frame);
    }

    return frames;
  }

  /**
   * Parse a single incoming raw frame packet.
   */
  public static parseFrame(rawFrame: Uint8Array): FramePacket {
    if (rawFrame.length < BINARY_HEADER_SIZE) {
      throw new Error(
        `FRAME_TOO_SHORT: Expected at least ${BINARY_HEADER_SIZE} bytes, got ${rawFrame.length}`,
      );
    }

    if (rawFrame[0] !== FRAME_MAGIC_BYTE) {
      throw new Error(
        `INVALID_MAGIC_BYTE: Expected 0x${FRAME_MAGIC_BYTE.toString(16)}, got 0x${rawFrame[0].toString(16)}`,
      );
    }

    if (rawFrame[1] !== FRAME_VERSION_BYTE) {
      throw new Error(
        `UNSUPPORTED_FRAME_VERSION: Expected version 0x${FRAME_VERSION_BYTE.toString(16)}, got 0x${rawFrame[1].toString(16)}`,
      );
    }

    const txId = (rawFrame[2] << 8) | rawFrame[3];
    const seq = rawFrame[4];
    const total = rawFrame[5];

    if (seq < 1 || seq > total) {
      throw new Error(
        `INVALID_FRAME_SEQUENCE: Sequence ${seq} out of bounds for total ${total}`,
      );
    }

    const chunk = rawFrame.subarray(BINARY_HEADER_SIZE);
    return { txId, seq, total, chunk };
  }
}

export class FrameReassembler {
  private chunks: (Uint8Array | null)[] = [];
  private expectedTotal = 0;
  private currentTxId: number | null = null;
  private lastChunkTime = 0;
  private totalPayloadBytes = 0;
  private readonly timeoutMs: number;

  constructor(timeoutMs = 15000) {
    this.timeoutMs = timeoutMs;
  }

  public reset(): void {
    this.chunks = [];
    this.expectedTotal = 0;
    this.currentTxId = null;
    this.lastChunkTime = 0;
    this.totalPayloadBytes = 0;
  }

  /**
   * Feed an incoming raw packet. If this frame completes the message, returns
   * the reassembled UTF-8 string; otherwise returns null.
   */
  public processChunk(rawFrame: Uint8Array): string | null {
    const now = Date.now();
    if (this.currentTxId !== null && now - this.lastChunkTime > this.timeoutMs) {
      this.reset();
    }
    this.lastChunkTime = now;

    const frame = BleFraming.parseFrame(rawFrame);

    // Initialise or handle new transaction
    if (this.currentTxId === null || this.currentTxId !== frame.txId) {
      this.reset();
      this.currentTxId = frame.txId;
      this.expectedTotal = frame.total;
      this.chunks = new Array(frame.total).fill(null);
      this.lastChunkTime = now;
    }

    if (frame.total !== this.expectedTotal) {
      throw new Error(
        `FRAME_TOTAL_MISMATCH: Frame reports total ${frame.total}, but transaction expects ${this.expectedTotal}`,
      );
    }

    const idx = frame.seq - 1;
    if (this.chunks[idx] !== null) {
      // Duplicate chunk
      return null;
    }

    this.totalPayloadBytes += frame.chunk.length;
    if (this.totalPayloadBytes > MAX_ALLOWED_PAYLOAD_BYTES) {
      this.reset();
      throw new Error(
        `REASSEMBLY_OVERFLOW: Total bytes ${this.totalPayloadBytes} exceeds limit of ${MAX_ALLOWED_PAYLOAD_BYTES}`,
      );
    }

    this.chunks[idx] = frame.chunk;

    // Check completeness
    const isComplete = this.chunks.every((c) => c !== null);
    if (!isComplete) {
      return null;
    }

    // Assemble all chunks
    const fullBuffer = Buffer.concat(
      (this.chunks as Uint8Array[]).map((c) => Buffer.from(c)),
    );
    const resultText = fullBuffer.toString('utf-8');
    this.reset();
    return resultText;
  }
}
